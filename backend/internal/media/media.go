package media

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"ai-gateway/internal/access"
	"ai-gateway/internal/catalog"
	"ai-gateway/internal/platform"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Service struct {
	DB            *pgxpool.Pool
	Catalog       catalog.Store
	Dir           string
	Client        *http.Client
	ImageClient   *http.Client
	DownloadHosts map[string]bool
	CursorKey     []byte
}

type Input struct {
	Model     string `json:"model"`
	Operation string `json:"operation"`
	Prompt    string `json:"prompt"`
	Spec      struct {
		Ratio    string `json:"aspect_ratio,omitempty"`
		Duration int    `json:"duration_seconds,omitempty"`
	} `json:"spec"`
	Inputs []struct {
		ID   string `json:"asset_id"`
		Role string `json:"role"`
	} `json:"inputs,omitempty"`
}

func invalidID(s string) bool {
	if len(s) != 36 {
		return true
	}
	for i, c := range s {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return true
			}
			continue
		}
		if !strings.ContainsRune("0123456789abcdef", c) {
			return true
		}
	}
	return false
}

func (s *Service) Models(w http.ResponseWriter, r *http.Request, who access.Identity) {
	models, err := s.Catalog.Models(r.Context(), who.Project, "")
	if err != nil {
		platform.Error(w, 503, "models_unavailable")
		return
	}
	list := []catalog.Model{}
	for _, m := range models {
		if m.Operation == "image.generate" || m.Operation == "video.generate" {
			list = append(list, m)
		}
	}
	platform.JSON(w, 200, map[string]any{"data": list})
}

func (s *Service) Create(w http.ResponseWriter, r *http.Request, who access.Identity) {
	var input Input
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 128<<10))
	d.DisallowUnknownFields()
	if d.Decode(&input) != nil || d.Decode(new(any)) != io.EOF || input.Model == "" || strings.TrimSpace(input.Prompt) == "" || len(input.Prompt) > 32000 || (input.Operation != "image.generate" && input.Operation != "video.generate") {
		platform.Error(w, 400, "invalid_media_request")
		return
	}
	idem := r.Header.Get("Idempotency-Key")
	if len(idem) > 128 || strings.IndexFunc(idem, func(c rune) bool { return c < 33 || c > 126 }) >= 0 {
		platform.Error(w, 400, "invalid_idempotency_key")
		return
	}
	normalized, _ := json.Marshal(input)
	hash := sha256.Sum256(normalized)
	ctx := r.Context()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		platform.Error(w, 503, "database_unavailable")
		return
	}
	defer tx.Rollback(ctx)
	var project string
	if err = tx.QueryRow(ctx, "SELECT id FROM projects WHERE id=$1 AND enabled FOR UPDATE", who.Project).Scan(&project); err != nil {
		platform.Error(w, 503, "project_unavailable")
		return
	}
	if idem != "" {
		var id string
		var saved []byte
		err = tx.QueryRow(ctx, `SELECT id,input_hash FROM media_jobs WHERE project_id=$1 AND principal_id=$2 AND operation=$3 AND idempotency_key=$4`, who.Project, who.Principal, input.Operation, idem).Scan(&id, &saved)
		if err == nil {
			if !bytes.Equal(saved, hash[:]) {
				platform.Error(w, 409, "idempotency_conflict")
				return
			}
			_ = tx.Rollback(ctx)
			w.Header().Set("Location", jobLocation(r, id))
			s.get(w, r, who, id, 200)
			return
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			platform.Error(w, 503, "database_unavailable")
			return
		}
	}
	var route string
	var caps json.RawMessage
	err = tx.QueryRow(ctx, `SELECT r.id,r.capabilities FROM model_routes r JOIN connections c ON c.id=r.connection_id
 WHERE r.project_id=$1 AND r.operation=$2 AND r.model=$3 AND r.active AND c.enabled AND c.provider='jimeng'`, who.Project, input.Operation, input.Model).Scan(&route, &caps)
	if errors.Is(err, pgx.ErrNoRows) {
		platform.Error(w, 404, "model_not_found")
		return
	}
	if err != nil {
		platform.Error(w, 503, "database_unavailable")
		return
	}
	if !allowed(input, caps) {
		platform.Error(w, 400, "unsupported_media_spec")
		return
	}
	var count int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM media_jobs WHERE project_id=$1 AND status IN ('queued','running','submitting','finalizing')`, who.Project).Scan(&count); err != nil {
		platform.Error(w, 503, "database_unavailable")
		return
	}
	if count >= 32 {
		platform.Error(w, 429, "media_queue_full")
		return
	}
	id, requestID := platform.ID(), w.Header().Get("X-Request-Id")
	_, err = tx.Exec(ctx, `INSERT INTO requests(id,tenant_id,project_id,principal_id,key_id,route_id,operation,model,status)
 VALUES($1,$2,$3,$4,nullif($5,'')::uuid,$6,$7,$8,'media')`, requestID, who.Tenant, who.Project, who.Principal, who.KeyID, route, input.Operation, input.Model)
	if err == nil {
		_, err = tx.Exec(ctx, `INSERT INTO media_jobs(id,request_id,tenant_id,project_id,principal_id,operation,idempotency_key,input_hash,input,status)
 VALUES($1,$2,$3,$4,$5,$6,nullif($7,''),$8,$9,'queued')`, id, requestID, who.Tenant, who.Project, who.Principal, input.Operation, idem, hash[:], normalized)
	}
	if err != nil {
		platform.Error(w, 503, "could_not_create_job")
		return
	}
	for pos, asset := range input.Inputs {
		if invalidID(asset.ID) {
			platform.Error(w, 404, "asset_not_found")
			return
		}
		tag, err := tx.Exec(ctx, `INSERT INTO media_job_assets(tenant_id,project_id,job_id,asset_id,role,position)
   SELECT tenant_id,project_id,$1,id,$2,$3 FROM assets WHERE project_id=$4 AND id=$5 AND principal_id=$6 AND mime LIKE 'image/%'`,
			id, asset.Role, pos, who.Project, asset.ID, who.Principal)
		if err != nil {
			platform.Error(w, 503, "asset_lookup_failed")
			return
		}
		if tag.RowsAffected() == 0 {
			platform.Error(w, 404, "asset_not_found")
			return
		}
	}
	if err = tx.Commit(ctx); err != nil {
		platform.Error(w, 503, "could_not_create_job")
		return
	}
	w.Header().Set("Location", jobLocation(r, id))
	s.get(w, r, who, id, 202)
}

func jobLocation(r *http.Request, id string) string {
	if project := r.PathValue("project"); project != "" {
		return "/console/v1/projects/" + project + "/media/jobs/" + id
	}
	return "/media/v1/jobs/" + id
}

type jobView struct {
	RecoveryPending bool              `json:"recovery_pending"`
	ID              string            `json:"id"`
	Request         string            `json:"request_id"`
	Model           string            `json:"model"`
	Operation       string            `json:"operation"`
	Status          string            `json:"status"`
	Created         time.Time         `json:"created_at"`
	Updated         time.Time         `json:"updated_at"`
	Credits         *string           `json:"credits_used"`
	Progress        *int              `json:"progress,omitempty"`
	Artifacts       []string          `json:"artifacts"`
	Error           map[string]string `json:"error,omitempty"`
}

const selection = `j.id,j.request_id,r.model,j.operation,j.status,j.created_at,j.updated_at,j.progress,j.error_code,
 (SELECT u.quantity::text FROM usage_records u WHERE u.attempt_id=j.attempt_id AND u.metric='credits_used' AND u.unit='credit' AND u.source='reported'),
 coalesce(j.status='submit_unknown' AND j.replay_allowed AND j.submission_replays=0 AND j.error_code='submission_unconfirmed',false),
 ARRAY(SELECT asset_id::text FROM artifacts WHERE job_id=j.id ORDER BY position)`

type scanner interface{ Scan(...any) error }

func scanJob(row scanner) (jobView, error) {
	var v jobView
	var code sql.NullString
	err := row.Scan(&v.ID, &v.Request, &v.Model, &v.Operation, &v.Status, &v.Created, &v.Updated, &v.Progress, &code, &v.Credits, &v.RecoveryPending, &v.Artifacts)
	if code.Valid {
		v.Error = map[string]string{"code": code.String}
	}
	return v, err
}
func (s *Service) Get(w http.ResponseWriter, r *http.Request, who access.Identity) {
	s.get(w, r, who, r.PathValue("id"), 200)
}
func (s *Service) get(w http.ResponseWriter, r *http.Request, who access.Identity, id string, status int) {
	if invalidID(id) {
		platform.Error(w, 404, "job_not_found")
		return
	}
	v, err := scanJob(s.DB.QueryRow(r.Context(), `SELECT `+selection+` FROM media_jobs j JOIN requests r ON r.id=j.request_id WHERE j.id=$1 AND j.project_id=$2 AND (j.principal_id=$3 OR $4)`, id, who.Project, who.Principal, who.Role == "admin" && who.KeyID == ""))
	if errors.Is(err, pgx.ErrNoRows) {
		platform.Error(w, 404, "job_not_found")
		return
	}
	if err != nil {
		platform.Error(w, 503, "job_unavailable")
		return
	}
	platform.JSON(w, status, v)
}
func (s *Service) List(w http.ResponseWriter, r *http.Request, who access.Identity) {
	q := r.URL.Query()
	scope := who.Project + ":" + who.Principal + ":media:" + q.Get("status") + ":" + q.Get("operation")
	limit, after, err := platform.Pagination(q, s.CursorKey, scope)
	if err != nil {
		platform.Error(w, 400, "invalid_pagination")
		return
	}
	rows, err := s.DB.Query(r.Context(), `SELECT `+selection+` FROM media_jobs j JOIN requests r ON r.id=j.request_id
 WHERE j.project_id=$1 AND (j.principal_id=$2 OR $3) AND ($4='' OR j.status=$4) AND ($5='' OR j.operation=$5)
 AND ($6='' OR (j.created_at,j.id)<($7,NULLIF($6,'')::uuid))
 ORDER BY j.created_at DESC,j.id DESC LIMIT $8`, who.Project, who.Principal, who.Role == "admin" && who.KeyID == "", q.Get("status"), q.Get("operation"), after.ID, after.Created, limit+1)
	if err != nil {
		platform.Error(w, 503, "jobs_unavailable")
		return
	}
	defer rows.Close()
	data := []jobView{}
	var next string
	for rows.Next() {
		if len(data) == limit {
			last := data[len(data)-1]
			next = platform.PageToken(s.CursorKey, scope, platform.Cursor{Created: last.Created, ID: last.ID})
			break
		}
		v, err := scanJob(rows)
		if err != nil {
			platform.Error(w, 503, "jobs_unavailable")
			return
		}
		data = append(data, v)
	}
	if rows.Err() != nil {
		platform.Error(w, 503, "jobs_unavailable")
		return
	}
	platform.JSON(w, 200, map[string]any{"data": data, "next_cursor": next})
}
func (s *Service) Cancel(w http.ResponseWriter, r *http.Request, who access.Identity) {
	id := r.PathValue("id")
	if invalidID(id) {
		platform.Error(w, 404, "job_not_found")
		return
	}
	tag, err := s.DB.Exec(r.Context(), `UPDATE media_jobs SET status='canceled',input=NULL,updated_at=now() WHERE id=$1 AND project_id=$2
 AND (principal_id=$3 OR $4) AND status IN ('queued','canceled')`, id, who.Project, who.Principal, who.Role == "admin" && who.KeyID == "")
	if err != nil {
		platform.Error(w, 503, "cancel_unavailable")
		return
	}
	if tag.RowsAffected() == 0 {
		var one int
		err = s.DB.QueryRow(r.Context(), `SELECT 1 FROM media_jobs WHERE id=$1 AND project_id=$2 AND (principal_id=$3 OR $4)`, id, who.Project, who.Principal, who.Role == "admin" && who.KeyID == "").Scan(&one)
		if errors.Is(err, pgx.ErrNoRows) {
			platform.Error(w, 404, "job_not_found")
			return
		}
		if err != nil {
			platform.Error(w, 503, "cancel_unavailable")
			return
		}
		platform.Error(w, 409, "job_not_cancelable")
		return
	}
	s.get(w, r, who, id, 200)
}

func (s *Service) Upload(w http.ResponseWriter, r *http.Request, who access.Identity) {
	const max = 12 << 20
	r.Body = http.MaxBytesReader(w, r.Body, max+(64<<10))
	form, err := r.MultipartReader()
	if err != nil {
		platform.Error(w, 400, "invalid_multipart")
		return
	}
	part, err := form.NextPart()
	if err != nil || part.FormName() != "file" {
		platform.Error(w, 400, "file_required")
		return
	}
	data, err := io.ReadAll(io.LimitReader(part, max+1))
	part.Close()
	if err != nil || len(data) > max {
		platform.Error(w, 413, "file_too_large")
		return
	}
	mime := http.DetectContentType(data)
	if mime != "image/png" && mime != "image/jpeg" && mime != "image/webp" {
		platform.Error(w, 415, "unsupported_asset")
		return
	}
	if extra, err := form.NextPart(); err != io.EOF {
		if extra != nil {
			extra.Close()
		}
		platform.Error(w, 400, "exactly_one_file_required")
		return
	}
	id, err := s.save(r.Context(), s.DB, who, bytes.NewReader(data), mime, max)
	if err != nil {
		platform.Error(w, 503, "asset_store_unavailable")
		return
	}
	platform.JSON(w, 201, map[string]any{"asset_id": id, "mime_type": mime, "byte_size": len(data)})
}

type executor interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

func (s *Service) save(ctx context.Context, db executor, who access.Identity, data io.Reader, mime string, max int64) (string, error) {
	id := platform.ID()
	f, err := os.CreateTemp(s.Dir, ".upload-")
	if err != nil {
		return "", err
	}
	defer os.Remove(f.Name())
	n, err := io.Copy(f, io.LimitReader(data, max+1))
	if err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return "", err
	}
	if n == 0 || n > max {
		return "", errors.New("invalid asset size")
	}
	path := filepath.Join(s.Dir, id)
	if err = os.Rename(f.Name(), path); err != nil {
		return "", err
	}
	_, err = db.Exec(ctx, `INSERT INTO assets(id,tenant_id,project_id,principal_id,object_key,mime,bytes) VALUES($1,$2,$3,$4,$1::uuid::text,$5,$6)`,
		id, who.Tenant, who.Project, who.Principal, mime, n)
	if err != nil {
		return "", err
	}
	return id, nil
}

func (s *Service) Artifact(w http.ResponseWriter, r *http.Request, who access.Identity) {
	id, artifact := r.PathValue("id"), r.PathValue("artifact")
	if invalidID(id) || invalidID(artifact) {
		platform.Error(w, 404, "artifact_not_found")
		return
	}
	var key, mime string
	err := s.DB.QueryRow(r.Context(), `SELECT a.object_key,a.mime FROM artifacts f JOIN assets a ON a.id=f.asset_id JOIN media_jobs j ON j.id=f.job_id
 WHERE j.id=$1 AND a.id=$2 AND j.project_id=$3 AND (j.principal_id=$4 OR $5) AND j.status='succeeded'`,
		id, artifact, who.Project, who.Principal, who.Role == "admin" && who.KeyID == "").Scan(&key, &mime)
	if errors.Is(err, pgx.ErrNoRows) {
		platform.Error(w, 404, "artifact_not_found")
		return
	}
	if err != nil || invalidID(key) {
		platform.Error(w, 503, "artifact_unavailable")
		return
	}
	f, err := os.Open(filepath.Join(s.Dir, key))
	if err != nil {
		platform.Error(w, 503, "artifact_unavailable")
		return
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil {
		platform.Error(w, 503, "artifact_unavailable")
		return
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Cache-Control", "private, no-store")
	http.ServeContent(w, r, artifact, stat.ModTime(), f)
}
