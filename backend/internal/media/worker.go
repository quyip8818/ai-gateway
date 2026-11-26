package media

import (
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"ai-gateway/internal/access"
	"ai-gateway/internal/catalog"
	"github.com/jackc/pgx/v5"
)

type work struct {
	ID, Request, ModelID, State string
	Who                         access.Identity
	Version                     int64
	Input                       Input
	Attempt, Upstream           sql.NullString
	Created                     time.Time
}

func (s *Service) Run(ctx context.Context) {
	var workers sync.WaitGroup
	workers.Go(func() { s.loop(ctx, true) })
	workers.Go(func() { s.loop(ctx, false) })
	workers.Wait()
}
func (s *Service) loop(ctx context.Context, submit bool) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		w, err := s.claim(ctx, submit)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			if ctx.Err() == nil {
				log.Printf("media claim: %v", err)
			}
			continue
		}
		s.process(ctx, w)
	}
}

func (s *Service) claim(ctx context.Context, submit bool) (work, error) {
	var w work
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return w, err
	}
	defer tx.Rollback(ctx)
	if submit {
		if _, err = tx.Exec(ctx, `UPDATE media_jobs SET status='submit_unknown',error_code='submission_unconfirmed',lease_until=NULL,updated_at=now()
 WHERE status='submitting' AND lease_until<=now()`); err != nil {
			return w, err
		}
	}
	var raw []byte
	err = tx.QueryRow(ctx, `SELECT j.id,j.request_id,r.account_model_id,j.tenant_id,j.project_id,j.principal_id,coalesce(r.key_id::text,''),
 j.status,j.input,j.attempt_id,j.upstream_job_id,j.lease_version,j.created_at
 FROM media_jobs j JOIN requests r ON r.id=j.request_id
 WHERE (($1 AND j.status='queued') OR (NOT $1 AND j.status IN ('running','finalizing')))
 AND j.run_after<=now() AND (j.lease_until IS NULL OR j.lease_until<=now())
 ORDER BY j.run_after,j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED`, submit).
		Scan(&w.ID, &w.Request, &w.ModelID, &w.Who.Tenant, &w.Who.Project, &w.Who.Principal, &w.Who.KeyID,
			&w.State, &raw, &w.Attempt, &w.Upstream, &w.Version, &w.Created)
	if errors.Is(err, pgx.ErrNoRows) {
		if err = tx.Commit(ctx); err != nil {
			return w, err
		}
		return w, pgx.ErrNoRows
	}
	if err != nil {
		return w, err
	}
	w.Version++
	next := w.State
	if w.State == "queued" {
		if err = json.Unmarshal(raw, &w.Input); err != nil {
			return w, err
		}
		var account string
		err = tx.QueryRow(ctx, `SELECT m.account_id FROM account_models m JOIN upstream_accounts a ON a.id=m.account_id
 JOIN projects p ON p.id=m.project_id JOIN tenants t ON t.id=p.tenant_id
 JOIN project_principals principal ON principal.project_id=p.id AND principal.id=$2 LEFT JOIN users u ON u.id=principal.user_id
 WHERE m.id=$1 AND a.enabled AND account_credential_ready(a) AND p.enabled AND t.enabled
 AND principal.enabled AND (principal.user_id IS NULL OR u.enabled)`, w.ModelID, w.Who.Principal).Scan(&account)
		if errors.Is(err, pgx.ErrNoRows) {
			if _, err = tx.Exec(ctx, `UPDATE media_jobs SET status='failed',error_code='route_unavailable',input=NULL,updated_at=now() WHERE id=$1`, w.ID); err != nil {
				return w, err
			}
			if err = tx.Commit(ctx); err != nil {
				return w, err
			}
			return w, pgx.ErrNoRows
		}
		if err != nil {
			return w, err
		}
		var attempt string
		err = tx.QueryRow(ctx, `INSERT INTO upstream_attempts(tenant_id,project_id,request_id,account_id,attempt_no)
 VALUES($1,$2,$3,$4,1) RETURNING id`, w.Who.Tenant, w.Who.Project, w.Request, account).Scan(&attempt)
		if err != nil {
			return w, err
		}
		w.Attempt = sql.NullString{String: attempt, Valid: true}
		next = "submitting"
	}
	_, err = tx.Exec(ctx, `UPDATE media_jobs SET status=$2,lease_version=$3,lease_until=now()+interval '45 seconds',attempt_id=$4,input=NULL
 WHERE id=$1`, w.ID, next, w.Version, w.Attempt)
	if err != nil {
		return w, err
	}
	return w, tx.Commit(ctx)
}

func (s *Service) process(parent context.Context, w work) {
	if time.Since(w.Created) > 2*time.Hour {
		if w.State == "running" {
			s.transition(w, "submit_unknown", "poll_deadline_exceeded", "", 0)
		} else {
			s.transition(w, "failed", "job_deadline_exceeded", "", 0)
		}
		return
	}
	ctx, cancel := context.WithTimeout(parent, 8*time.Minute)
	defer cancel()
	done := make(chan struct{})
	defer close(done)
	go func() {
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
			renewal, stop := context.WithTimeout(ctx, 4*time.Second)
			tag, err := s.DB.Exec(renewal, `UPDATE media_jobs SET lease_until=now()+interval '45 seconds' WHERE id=$1 AND lease_version=$2 AND lease_until>now()`, w.ID, w.Version)
			stop()
			if err != nil || tag.RowsAffected() == 0 {
				cancel()
				return
			}
		}
	}()
	route, err := s.Catalog.MediaTarget(ctx, w.Who.Project, w.ModelID, w.State != "queued")
	if err != nil {
		if w.State == "queued" {
			s.transition(w, "failed", "route_unavailable", "", 0)
		} else {
			s.transition(w, w.State, "connection_unavailable", "", 15*time.Second)
		}
		return
	}
	switch w.State {
	case "queued":
		s.submit(ctx, w, route)
	case "running":
		s.poll(ctx, w, route)
	case "finalizing":
		s.download(ctx, w, route)
	}
}

func (s *Service) transition(w work, state, code, upstream string, delay time.Duration, credits ...json.Number) {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `UPDATE media_jobs SET status=$3,error_code=nullif($4,''),upstream_job_id=coalesce(nullif($5,''),upstream_job_id),
 run_after=now()+($6::int*interval '1 second'),lease_until=NULL,updated_at=now()
 WHERE id=$1 AND lease_version=$2 AND lease_until>now()`, w.ID, w.Version, state, code, upstream, int(delay.Seconds()))
	if err != nil || tag.RowsAffected() == 0 {
		return
	}
	if w.State == "queued" {
		_, err = tx.Exec(ctx, `UPDATE upstream_attempts SET state=$2,upstream_id=nullif($3,''),finished_at=now() WHERE id=$1`, w.Attempt.String, state, upstream)
		if err != nil {
			return
		}
	}
	if err = recordCredits(ctx, tx, w.Attempt.String, credits); err != nil {
		return
	}

	if err = tx.Commit(ctx); err != nil {
		log.Printf("media transition %s failed", w.ID)
	}
}

func (s *Service) request(ctx context.Context, route catalog.Target, method, path string, payload any, idempotencyKey string) (*http.Response, error) {
	var body io.Reader
	if payload != nil {
		raw, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		body = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, route.Base+path, body)
	if err != nil {
		return nil, err
	}
	req.GetBody = nil
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	route.Protocol.Authorize(req.Header, route.Token, nil)
	if idempotencyKey != "" {
		req.Header.Set("Idempotency-Key", idempotencyKey)
	}
	client := s.Client
	if s.ImageClient != nil && strings.HasPrefix(path, "/v1/images/") {
		client = s.ImageClient
	}
	return client.Do(req)
}

func (s *Service) submit(ctx context.Context, w work, r catalog.Target) {
	input := w.Input
	caps, err := loadCapabilities(r.Capabilities)
	if err != nil || !caps.allows(input) {
		s.transition(w, "failed", "unsupported_media_spec", "", 0)
		return
	}
	var reference string
	if len(input.Inputs) > 0 {
		ref := input.Inputs[0]
		var key, mime string
		err := s.DB.QueryRow(ctx, `SELECT a.object_key,a.mime FROM assets a JOIN media_job_assets ja ON ja.asset_id=a.id WHERE ja.job_id=$1 AND a.id=$2`, w.ID, ref.ID).Scan(&key, &mime)
		if err != nil || invalidID(key) {
			s.transition(w, "failed", "reference_unavailable", "", 0)
			return
		}
		data, err := os.ReadFile(filepath.Join(s.Dir, key))
		if err != nil {
			s.transition(w, "failed", "reference_unavailable", "", 0)
			return
		}
		reference = "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data)
	}
	path, payload := buildSubmission(input, caps, r.Upstream, reference)
	key := ""
	if input.Operation == "video.generate" {
		key = w.ID
	}
	resp, err := s.request(ctx, r, "POST", path, payload, key)
	if err != nil {
		s.transition(w, "submit_unknown", "submission_unconfirmed", "", 0)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if resp.StatusCode == 400 || resp.StatusCode == 401 || resp.StatusCode == 403 || resp.StatusCode == 404 || resp.StatusCode == 422 {
			s.transition(w, "failed", "upstream_rejected", "", 0)
		} else {
			s.transition(w, "submit_unknown", "submission_unconfirmed", "", 0)
		}
		return
	}
	if input.Operation == "video.generate" {
		var out struct {
			ID string `json:"id"`
		}
		if json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&out) != nil || !validVideo(out.ID) {
			s.transition(w, "submit_unknown", "submission_unconfirmed", "", 0)
			return
		}
		s.transition(w, "running", "", out.ID, 3*time.Second)
		return
	}
	out, err := decodeImageResponse(resp.Body)
	if err != nil {
		s.transition(w, "submit_unknown", "image_result_unconfirmed", "", 0)
		return
	}
	data, err := base64.StdEncoding.DecodeString(out.Data[0].B64)
	if err != nil || len(data) > maxImageSize {
		s.transition(w, "failed", "invalid_result", "", 0)
		return
	}
	mime := http.DetectContentType(data)
	if !strings.HasPrefix(mime, "image/") {
		s.transition(w, "failed", "invalid_result", "", 0)
		return
	}
	if err = s.finish(w, bytes.NewReader(data), mime, maxImageSize, out.Usage.Credits); err != nil {
		s.transition(w, "submit_unknown", "image_delivery_unconfirmed", "", 0)
	}
}

func validVideo(id string) bool {
	return len(id) < 190 && strings.HasPrefix(id, "video_") && strings.IndexFunc(id, func(r rune) bool {
		return !strings.ContainsRune("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_", r)
	}) < 0
}

func (s *Service) poll(ctx context.Context, w work, r catalog.Target) {
	if !w.Upstream.Valid || !validVideo(w.Upstream.String) {
		s.transition(w, "submit_unknown", "invalid_upstream_id", "", 0)
		return
	}
	resp, err := s.request(ctx, r, "GET", "/v1/videos/"+w.Upstream.String, nil, "")
	if err != nil {
		s.transition(w, "running", "upstream_unreachable", "", 15*time.Second)
		return
	}
	defer resp.Body.Close()
	var out struct {
		Status   string        `json:"status"`
		Progress int           `json:"progress"`
		Usage    reportedUsage `json:"usage"`
	}
	if resp.StatusCode != 200 || json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&out) != nil {
		s.transition(w, "running", "poll_unavailable", "", 15*time.Second)
		return
	}
	switch out.Status {
	case "completed":
		s.transition(w, "finalizing", "", "", 0, out.Usage.Credits)
	case "failed":
		s.transition(w, "failed", "upstream_generation_failed", "", 0)
	default:
		if out.Progress > 99 {
			out.Progress = 99
		}
		if out.Progress > 0 {
			_, _ = s.DB.Exec(ctx, `UPDATE media_jobs SET progress=greatest(progress,$3) WHERE id=$1 AND lease_version=$2 AND lease_until>now()`, w.ID, w.Version, out.Progress)
		}
		s.transition(w, "running", "", "", 5*time.Second)
	}
}

func (s *Service) download(ctx context.Context, w work, r catalog.Target) {
	if !validVideo(w.Upstream.String) {
		s.transition(w, "failed", "invalid_upstream_id", "", 0)
		return
	}
	resp, err := s.request(ctx, r, "GET", "/v1/videos/"+w.Upstream.String+"/content", nil, "")
	if err != nil {
		s.transition(w, "finalizing", "download_unavailable", "", 15*time.Second)
		return
	}
	if resp.StatusCode == 302 || resp.StatusCode == 303 || resp.StatusCode == 307 {
		dst, err := resp.Location()
		resp.Body.Close()
		if err != nil || !s.downloadAllowed(ctx, dst) {
			if err == nil {
				log.Printf("media job %s: video download redirect blocked for host %q", w.ID, dst.Hostname())
			}
			s.transition(w, "finalizing", "download_host_not_allowed", "", 30*time.Second)
			return
		}
		request, err := http.NewRequestWithContext(ctx, "GET", dst.String(), nil)
		if err != nil {
			return
		}
		resp, err = s.Client.Do(request)
		if err != nil {
			s.transition(w, "finalizing", "download_unavailable", "", 15*time.Second)
			return
		}
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		s.transition(w, "finalizing", "result_not_ready", "", 15*time.Second)
		return
	}
	body := bufio.NewReader(resp.Body)
	signature, _ := body.Peek(512)
	mime := http.DetectContentType(signature)
	if mime != "video/mp4" {
		s.transition(w, "finalizing", "invalid_video_content", "", 15*time.Second)
		return
	}
	if err = s.finish(w, body, mime, 256<<20); err != nil {
		s.transition(w, "finalizing", "delivery_failed", "", 15*time.Second)
	}
}

func (s *Service) downloadAllowed(ctx context.Context, u *url.URL) bool {
	if u == nil || u.Scheme != "https" || u.User != nil || (u.Port() != "" && u.Port() != "443") {
		return false
	}
	host := strings.ToLower(u.Hostname())
	if s.DownloadHosts[host] {
		return true
	}
	return (DownloadHostStore{DB: s.DB}).Allows(ctx, host)
}

func (s *Service) finish(w work, body io.Reader, mime string, max int64, credits ...json.Number) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	asset, err := s.save(ctx, s.DB, w.Who, body, mime, max)
	if err != nil {
		return err
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `UPDATE media_jobs SET status='succeeded',progress=100,error_code=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_version=$2 AND lease_until>now()`, w.ID, w.Version)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return fmt.Errorf("lost media lease")
	}
	_, err = tx.Exec(ctx, `INSERT INTO artifacts(tenant_id,project_id,job_id,asset_id,position) VALUES($1,$2,$3,$4,0)`, w.Who.Tenant, w.Who.Project, w.ID, asset)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE upstream_attempts SET state='succeeded',finished_at=now() WHERE id=$1`, w.Attempt.String)
	if err != nil {
		return err
	}
	if err = recordCredits(ctx, tx, w.Attempt.String, credits); err != nil {
		return err
	}

	return tx.Commit(ctx)
}

type reportedUsage struct {
	Credits json.Number `json:"credits_used"`
}

var creditQuantity = regexp.MustCompile(`^(0|[1-9][0-9]{0,15})(\.[0-9]{1,8})?$`)

func recordCredits(ctx context.Context, tx pgx.Tx, attempt string, credits []json.Number) error {
	if attempt == "" || len(credits) == 0 || !creditQuantity.MatchString(string(credits[0])) {
		return nil
	}
	_, err := tx.Exec(ctx, `INSERT INTO usage_records(attempt_id,metric,unit,source,quantity)
 VALUES($1,'credits_used','credit','reported',$2::text::numeric)
 ON CONFLICT(attempt_id,metric,unit,source) DO NOTHING`, attempt, string(credits[0]))
	return err
}
