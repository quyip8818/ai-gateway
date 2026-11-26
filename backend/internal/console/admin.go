package console

import (
	"ai-gateway/internal/catalog"
	"context"
	"encoding/csv"
	"errors"
	"net/http"
	"strings"
	"time"

	"ai-gateway/internal/access"
	"ai-gateway/internal/platform"
	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"
)

func (s Service) Members(w http.ResponseWriter, r *http.Request, who access.Identity) {
	if who.Role != "admin" {
		platform.Error(w, 403, "admin_required")
		return
	}
	if r.Method == "GET" {
		s.query(w, r, `SELECT jsonb_build_object('id',p.id,'email',u.email,'role',p.role,'enabled',p.enabled)
 FROM project_principals p LEFT JOIN users u ON u.id=p.user_id WHERE p.project_id=$1 ORDER BY u.email`, who.Project)
		return
	}
	var v struct{ Enabled bool }
	if !Decode(w, r, &v) {
		return
	}
	tag, err := s.DB.Exec(r.Context(), `UPDATE project_principals SET enabled=$3 WHERE project_id=$1 AND id::text=$2 AND id<>$4`, who.Project, r.PathValue("id"), v.Enabled, who.Principal)
	if err != nil {
		platform.Error(w, 503, "member_update_failed")
		return
	}
	if tag.RowsAffected() == 0 {
		platform.Error(w, 404, "member_not_found")
		return
	}
	w.WriteHeader(204)
}

func (s Service) Invitations(w http.ResponseWriter, r *http.Request, who access.Identity) {
	if who.Role != "admin" {
		platform.Error(w, 403, "admin_required")
		return
	}
	if r.Method == "GET" {
		s.query(w, r, `SELECT jsonb_build_object('id',id,'email',email,'expires_at',expires_at,'used_at',used_at)
 FROM project_invitations WHERE project_id=$1 ORDER BY expires_at DESC LIMIT 100`, who.Project)
		return
	}
	var in struct{ Email string }
	if !Decode(w, r, &in) {
		return
	}
	in.Email = strings.ToLower(strings.TrimSpace(in.Email))
	if len(in.Email) > 254 || !strings.Contains(in.Email, "@") {
		platform.Error(w, 400, "invalid_email")
		return
	}
	token := platform.Random()
	_, err := s.DB.Exec(r.Context(), `INSERT INTO project_invitations(tenant_id,project_id,email,digest) VALUES($1,$2,$3,$4)`, who.Tenant, who.Project, in.Email, platform.Digest(s.Store.Key, token))
	if err != nil {
		platform.Error(w, 503, "invitation_create_failed")
		return
	}
	platform.JSON(w, 201, map[string]string{"token": token})
}

func (s Service) AcceptInvitation(w http.ResponseWriter, r *http.Request) {
	if !s.Origin(w, r) {
		return
	}
	var in struct{ Token, Password string }
	if !Decode(w, r, &in) {
		return
	}
	if len(in.Password) < 12 || len(in.Password) > 72 {
		platform.Error(w, 400, "invalid_password")
		return
	}
	ctx := r.Context()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		platform.Error(w, 503, "invitation_unavailable")
		return
	}
	defer tx.Rollback(ctx)
	var id, tenant, project, email string
	err = tx.QueryRow(ctx, `SELECT id,tenant_id,project_id,email FROM project_invitations
 WHERE digest=$1 AND expires_at>now() AND used_at IS NULL FOR UPDATE`, platform.Digest(s.Store.Key, in.Token)).Scan(&id, &tenant, &project, &email)
	if errors.Is(err, pgx.ErrNoRows) {
		platform.Error(w, 404, "invitation_not_found")
		return
	}
	if err != nil {
		platform.Error(w, 503, "invitation_unavailable")
		return
	}
	var user string
	var stored []byte
	err = tx.QueryRow(ctx, `SELECT id,password_hash FROM users WHERE email=$1 AND enabled`, email).Scan(&user, &stored)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		var hash []byte
		hash, err = bcrypt.GenerateFromPassword([]byte(in.Password), bcrypt.DefaultCost)
		if err == nil {
			err = tx.QueryRow(ctx, "INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id", email, hash).Scan(&user)
		}
	case err == nil:
		if bcrypt.CompareHashAndPassword(stored, []byte(in.Password)) != nil {
			platform.Error(w, 401, "invalid_login")
			return
		}
	}
	if err != nil {
		platform.Error(w, 503, "invitation_unavailable")
		return
	}
	_, err = tx.Exec(ctx, `INSERT INTO project_principals(tenant_id,project_id,user_id,role) VALUES($1,$2,$3,'member')
 ON CONFLICT (project_id,user_id) DO NOTHING`, tenant, project, user)
	if err == nil {
		_, err = tx.Exec(ctx, "UPDATE project_invitations SET used_at=now() WHERE id=$1", id)
	}
	if err != nil || tx.Commit(ctx) != nil {
		platform.Error(w, 503, "invitation_unavailable")
		return
	}
	w.WriteHeader(204)
}

func (s Service) Audit(w http.ResponseWriter, r *http.Request, who access.Identity) {
	if who.Role != "admin" {
		platform.Error(w, 403, "admin_required")
		return
	}
	s.query(w, r, `SELECT jsonb_build_object('id',id,'action',action,'actor_id',actor_id,'target_id',target_id,'created_at',created_at)
 FROM audit_events WHERE project_id=$1 ORDER BY created_at DESC LIMIT 100`, who.Project)
}
func (s Service) ExportUsage(w http.ResponseWriter, r *http.Request, who access.Identity) {
	rows, err := s.DB.Query(r.Context(), `SELECT r.operation,u.metric,u.unit,u.source,sum(u.quantity)::text FROM usage_records u
 JOIN upstream_attempts a ON a.id=u.attempt_id JOIN requests r ON r.id=a.request_id
 WHERE r.project_id=$1 AND (r.principal_id=$2 OR $3) AND r.created_at>=now()-interval '30 days'
 GROUP BY r.operation,u.metric,u.unit,u.source ORDER BY r.operation,u.metric`, who.Project, who.Principal, who.Role == "admin")
	if err != nil {
		platform.Error(w, 503, "usage_unavailable")
		return
	}
	defer rows.Close()
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", "attachment; filename=gateway-usage.csv")
	writer := csv.NewWriter(w)
	_ = writer.Write([]string{"operation", "metric", "unit", "source", "quantity"})
	for rows.Next() {
		r := make([]string, 5)
		if rows.Scan(&r[0], &r[1], &r[2], &r[3], &r[4]) != nil {
			break
		}
		if writer.Write(r) != nil {
			break
		}
	}
	writer.Flush()
}

func (s Service) UpdateConnection(w http.ResponseWriter, r *http.Request, who access.Identity) {
	if who.Role != "admin" {
		platform.Error(w, 403, "admin_required")
		return
	}
	var v struct{ Enabled bool }
	if !Decode(w, r, &v) {
		return
	}
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		platform.Error(w, 503, "connection_update_failed")
		return
	}
	defer tx.Rollback(r.Context())
	var id string
	err = tx.QueryRow(r.Context(), "UPDATE connections SET enabled=$3 WHERE project_id=$1 AND id::text=$2 RETURNING id", who.Project, r.PathValue("id"), v.Enabled).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		platform.Error(w, 404, "connection_not_found")
		return
	}
	if err == nil {
		_, err = tx.Exec(r.Context(), "INSERT INTO audit_events(project_id,actor_id,action,target_id) VALUES($1,$2,'connection.status',$3)", who.Project, who.Principal, id)
	}
	if err != nil || tx.Commit(r.Context()) != nil {
		platform.Error(w, 503, "connection_update_failed")
		return
	}
	w.WriteHeader(204)
}

func (s Service) ProbeConnection(w http.ResponseWriter, r *http.Request, who access.Identity) {
	if who.Role != "admin" {
		platform.Error(w, 403, "admin_required")
		return
	}
	id := r.PathValue("id")
	var base, provider string
	var cipher []byte
	err := s.DB.QueryRow(r.Context(), "SELECT provider,base_url,token FROM connections WHERE project_id=$1 AND id::text=$2", who.Project, id).Scan(&provider, &base, &cipher)
	if errors.Is(err, pgx.ErrNoRows) {
		platform.Error(w, 404, "connection_not_found")
		return
	}
	if err != nil || catalog.ValidateBase(provider, base, s.JimengBase) != nil {
		platform.Error(w, 503, "connection_unavailable")
		return
	}
	token, err := platform.Open(s.Catalog.Key, cipher, id)
	if err != nil {
		platform.Error(w, 503, "connection_unavailable")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, "GET", base+"/v1/models", nil)
	if err != nil {
		platform.Error(w, 503, "connection_unavailable")
		return
	}
	if provider == "anthropic" {
		request.Header.Set("x-api-key", token)
		request.Header.Set("anthropic-version", "2023-06-01")
	} else {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	defer transport.CloseIdleConnections()
	client := http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	result, err := client.Do(request)
	state := "unreachable"
	if err == nil {
		result.Body.Close()
		switch {
		case result.StatusCode == 200:
			state = "reachable"
		case result.StatusCode == 401 || result.StatusCode == 403:
			state = "credential_rejected"
		case result.StatusCode == 429:
			state = "rate_limited"
		default:
			state = "upstream_error"
		}
	}
	_, err = s.DB.Exec(r.Context(), "UPDATE connections SET probe_state=$3,probed_at=now() WHERE project_id=$1 AND id::text=$2", who.Project, id, state)
	if err != nil {
		platform.Error(w, 503, "probe_store_unavailable")
		return
	}
	platform.JSON(w, 200, map[string]string{"state": state})
}
