package console

import (
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"

	"ai-gateway/internal/access"
	"ai-gateway/internal/catalog"
	"ai-gateway/internal/platform"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

var modelID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$`)

type Service struct {
	DB                     *pgxpool.Pool
	Store                  access.Store
	Catalog                catalog.Store
	PublicBase, JimengBase string
}

func (s Service) Origin(w http.ResponseWriter, r *http.Request) bool {
	if r.Method == "GET" || r.Method == "HEAD" {
		return true
	}
	if r.Header.Get("Origin") != s.PublicBase || r.Header.Get("X-Gateway-CSRF") != "1" {
		platform.Error(w, 403, "invalid_origin")
		return false
	}
	return true
}
func Decode(w http.ResponseWriter, r *http.Request, v any) bool {
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	d.DisallowUnknownFields()
	if d.Decode(v) != nil {
		platform.Error(w, 400, "invalid_request")
		return false
	}
	return true
}

func (s Service) Session(w http.ResponseWriter, r *http.Request) {
	if !s.Origin(w, r) {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	switch r.Method {
	case "POST":
		var in struct{ Email, Password string }
		if !Decode(w, r, &in) {
			return
		}
		var user string
		var hash []byte
		err := s.DB.QueryRow(r.Context(), "SELECT id,password_hash FROM users WHERE email=$1 AND enabled", strings.ToLower(strings.TrimSpace(in.Email))).Scan(&user, &hash)
		if err != nil || bcrypt.CompareHashAndPassword(hash, []byte(in.Password)) != nil {
			platform.Error(w, 401, "invalid_login")
			return
		}
		token := platform.Random()
		_, err = s.DB.Exec(r.Context(), `INSERT INTO web_sessions(digest,user_id,expires_at) VALUES($1,$2,now()+interval '12 hours')`, platform.Digest(s.Store.Key, token), user)
		if err != nil {
			platform.Error(w, 503, "session_unavailable")
			return
		}
		http.SetCookie(w, &http.Cookie{Name: "gateway_session", Value: token, Path: "/", HttpOnly: true, Secure: s.Store.Secure, SameSite: http.SameSiteStrictMode, MaxAge: 43200})
		platform.JSON(w, 200, map[string]string{"user_id": user})
	case "GET":
		id, err := s.Store.User(r)
		if err != nil {
			platform.Error(w, access.HTTPStatus(err), "session_required")
			return
		}
		platform.JSON(w, 200, map[string]string{"user_id": id})
	case "DELETE":
		if c, err := r.Cookie("gateway_session"); err == nil {
			if _, err = s.DB.Exec(r.Context(), "DELETE FROM web_sessions WHERE digest=$1", platform.Digest(s.Store.Key, c.Value)); err != nil {
				platform.Error(w, 503, "session_store_unavailable")
				return
			}
		}
		http.SetCookie(w, &http.Cookie{Name: "gateway_session", Path: "/", HttpOnly: true, Secure: s.Store.Secure, SameSite: http.SameSiteStrictMode, MaxAge: -1})
		w.WriteHeader(204)
	}
}

func (s Service) query(w http.ResponseWriter, r *http.Request, q string, args ...any) {
	rows, err := s.DB.Query(r.Context(), q, args...)
	if err != nil {
		platform.Error(w, 503, "query_unavailable")
		return
	}
	defer rows.Close()
	data := []json.RawMessage{}
	for rows.Next() {
		var v json.RawMessage
		if rows.Scan(&v) != nil {
			platform.Error(w, 503, "query_unavailable")
			return
		}
		data = append(data, v)
	}
	if rows.Err() != nil {
		platform.Error(w, 503, "query_unavailable")
		return
	}
	platform.JSON(w, 200, map[string]any{"data": data})
}

func (s Service) Projects(w http.ResponseWriter, r *http.Request) {
	user, err := s.Store.User(r)
	if err != nil {
		platform.Error(w, access.HTTPStatus(err), "session_required")
		return
	}
	s.query(w, r, `SELECT jsonb_build_object('id',j.id,'name',j.name,'role',p.role) FROM project_principals p
 JOIN projects j ON j.id=p.project_id JOIN tenants t ON t.id=j.tenant_id
 WHERE p.user_id=$1 AND p.enabled AND j.enabled AND t.enabled ORDER BY j.name`, user)
}
func (s Service) Models(w http.ResponseWriter, r *http.Request, who access.Identity) {
	models, err := s.Catalog.Models(r.Context(), who.Project, "")
	if err != nil {
		platform.Error(w, 503, "models_unavailable")
		return
	}
	platform.JSON(w, 200, map[string]any{"data": models})
}
func (s Service) Keys(w http.ResponseWriter, r *http.Request, who access.Identity) {
	switch r.Method {
	case "GET":
		s.query(w, r, `SELECT jsonb_build_object('id',id,'label',label,'prefix',prefix,'revoked_at',revoked_at)
 FROM api_keys WHERE project_id=$1 AND principal_id=$2 ORDER BY created_at DESC`, who.Project, who.Principal)
	case "POST":
		var input struct{ Label string }
		if !Decode(w, r, &input) {
			return
		}
		if strings.TrimSpace(input.Label) == "" || len(input.Label) > 100 {
			platform.Error(w, 400, "label_required")
			return
		}
		id, key, err := s.Store.Issue(r.Context(), s.DB, who, input.Label)
		if err != nil {
			platform.Error(w, 503, "key_create_failed")
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		platform.JSON(w, 201, map[string]string{"id": id, "key": key})
	}
}

func (s Service) KeyAction(w http.ResponseWriter, r *http.Request, who access.Identity, rotate bool) {
	ctx := r.Context()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		platform.Error(w, 503, "key_store_unavailable")
		return
	}
	defer tx.Rollback(ctx)
	var label string
	err = tx.QueryRow(ctx, `UPDATE api_keys SET revoked_at=now() WHERE id::text=$1 AND project_id=$2 AND principal_id=$3 AND revoked_at IS NULL RETURNING label`, r.PathValue("id"), who.Project, who.Principal).Scan(&label)
	if errors.Is(err, pgx.ErrNoRows) {
		platform.Error(w, 404, "key_not_found")
		return
	}
	if err != nil {
		platform.Error(w, 503, "key_store_unavailable")
		return
	}
	var id, key string
	if rotate {
		id, key, err = s.Store.Issue(ctx, tx, who, label)
		if err != nil {
			platform.Error(w, 503, "key_store_unavailable")
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		platform.Error(w, 503, "key_store_unavailable")
		return
	}
	if rotate {
		w.Header().Set("Cache-Control", "no-store")
		platform.JSON(w, 201, map[string]string{"id": id, "key": key})
		return
	}
	w.WriteHeader(204)
}

func (s Service) Requests(w http.ResponseWriter, r *http.Request, who access.Identity) {
	q := r.URL.Query()
	scope := who.Project + ":" + who.Principal + ":requests:" + q.Get("id") + ":" + q.Get("model") + ":" + q.Get("status")
	limit, after, err := platform.Pagination(q, s.Store.Key, scope)
	if err != nil {
		platform.Error(w, 400, "invalid_pagination")
		return
	}
	rows, err := s.DB.Query(r.Context(), `SELECT jsonb_build_object('id',r.id,'model',r.model,'operation',r.operation,'status',coalesce(j.status,r.status),'failure_stage',r.failure_stage,'error_code',coalesce(j.error_code,r.error_code),'job_id',j.id,'created_at',r.created_at),r.created_at,r.id
 FROM requests r LEFT JOIN media_jobs j ON j.request_id=r.id
 WHERE r.project_id=$1 AND (r.principal_id=$2 OR $3) AND ($4='' OR r.id::text=$4) AND ($5='' OR r.model=$5)
 AND ($6='' OR coalesce(j.status,r.status)=$6) AND ($7='' OR (r.created_at,r.id)<($8,NULLIF($7,'')::uuid))
 ORDER BY r.created_at DESC,r.id DESC LIMIT $9`, who.Project, who.Principal, who.Role == "admin", q.Get("id"), q.Get("model"), q.Get("status"), after.ID, after.Created, limit+1)
	if err != nil {
		platform.Error(w, 503, "query_unavailable")
		return
	}
	defer rows.Close()
	data := []json.RawMessage{}
	var last platform.Cursor
	var next string
	for rows.Next() {
		if len(data) == limit {
			next = platform.PageToken(s.Store.Key, scope, last)
			break
		}
		var v json.RawMessage
		if err := rows.Scan(&v, &last.Created, &last.ID); err != nil {
			platform.Error(w, 503, "query_unavailable")
			return
		}
		data = append(data, v)
	}
	if rows.Err() != nil {
		platform.Error(w, 503, "query_unavailable")
		return
	}
	platform.JSON(w, 200, map[string]any{"data": data, "next_cursor": next})
}
func (s Service) Request(w http.ResponseWriter, r *http.Request, who access.Identity) {
	var result json.RawMessage
	err := s.DB.QueryRow(r.Context(), `SELECT jsonb_build_object('id',r.id,'model',r.model,'operation',r.operation,'status',coalesce(j.status,r.status),'failure_stage',r.failure_stage,'error_code',coalesce(j.error_code,r.error_code),'job_id',j.id,'route_version',mr.version,'created_at',r.created_at,
 'attempts',coalesce((SELECT jsonb_agg(jsonb_build_object('attempt_no',a.attempt_no,'status',a.state,'http_status',a.status_code,'upstream_id',CASE WHEN $4 THEN a.upstream_id END,
 'started_at',a.started_at,'first_output_at',a.first_output_at,'finished_at',a.finished_at,
 'usage',coalesce((SELECT jsonb_agg(jsonb_build_object('metric',u.metric,'unit',u.unit,'quantity',u.quantity,'source',u.source)) FROM usage_records u WHERE u.attempt_id=a.id),'[]'::jsonb)) ORDER BY a.attempt_no)
 FROM upstream_attempts a WHERE a.request_id=r.id),'[]'::jsonb))
 FROM requests r LEFT JOIN media_jobs j ON j.request_id=r.id LEFT JOIN model_routes mr ON mr.id=r.route_id
 WHERE r.id::text=$1 AND r.project_id=$2 AND (r.principal_id=$3 OR $4)`, r.PathValue("id"), who.Project, who.Principal, who.Role == "admin").Scan(&result)
	if errors.Is(err, pgx.ErrNoRows) {
		platform.Error(w, 404, "request_not_found")
		return
	}
	if err != nil {
		platform.Error(w, 503, "request_unavailable")
		return
	}
	platform.JSON(w, 200, result)
}

func (s Service) Usage(w http.ResponseWriter, r *http.Request, who access.Identity) {
	ctx := r.Context()
	var operations json.RawMessage
	err := s.DB.QueryRow(ctx, `SELECT coalesce(jsonb_agg(to_jsonb(items)),'[]'::jsonb) FROM (
 SELECT r.operation, count(*) AS requests,count(*) FILTER (WHERE coalesce(j.status,r.status)='succeeded') AS succeeded
 FROM requests r LEFT JOIN media_jobs j ON j.request_id=r.id WHERE r.project_id=$1 AND (r.principal_id=$2 OR $3)
 AND r.created_at>=now()-interval '30 days' GROUP BY r.operation) items`, who.Project, who.Principal, who.Role == "admin").Scan(&operations)
	if err != nil {
		platform.Error(w, 503, "usage_unavailable")
		return
	}
	var totals json.RawMessage
	err = s.DB.QueryRow(ctx, `SELECT coalesce(jsonb_agg(to_jsonb(items)),'[]'::jsonb) FROM (
 SELECT r.operation,u.metric,u.unit,u.source,sum(u.quantity) AS quantity FROM usage_records u
 JOIN upstream_attempts a ON a.id=u.attempt_id JOIN requests r ON r.id=a.request_id
 WHERE r.project_id=$1 AND (r.principal_id=$2 OR $3) AND r.created_at>=now()-interval '30 days'
 GROUP BY r.operation,u.metric,u.unit,u.source) items`, who.Project, who.Principal, who.Role == "admin").Scan(&totals)
	if err != nil {
		platform.Error(w, 503, "usage_unavailable")
		return
	}
	platform.JSON(w, 200, map[string]any{"operations": operations, "usage": totals, "days": 30})
}
