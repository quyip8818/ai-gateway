package console

import (
	"ai-gateway/internal/access"
	"ai-gateway/internal/platform"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"net/http"
	"time"
)

func (s Service) StartSetup(w http.ResponseWriter, r *http.Request, who access.Identity) {
	var input struct {
		Key       string `json:"key_id"`
		Model     string `json:"model"`
		Operation string `json:"operation"`
	}
	if !Decode(w, r, &input) {
		return
	}
	if (input.Operation != "responses" && input.Operation != "messages") || !modelID.MatchString(input.Model) {
		platform.Error(w, 400, "invalid_setup_check")
		return
	}
	var id string
	err := s.DB.QueryRow(r.Context(), `INSERT INTO setup_checks(tenant_id,project_id,principal_id,key_id,operation,model)
 SELECT k.tenant_id,k.project_id,k.principal_id,k.id,$4,$5 FROM api_keys k
 WHERE k.id::text=$1 AND k.project_id=$2 AND k.principal_id=$3 AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>now())
 AND EXISTS(SELECT 1 FROM model_routes m JOIN connections c ON c.id=m.connection_id WHERE m.project_id=k.project_id AND m.operation=$4 AND m.model=$5 AND m.active AND c.enabled)
 RETURNING id`, input.Key, who.Project, who.Principal, input.Operation, input.Model).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		platform.Error(w, 400, "invalid_setup_check")
		return
	}
	if err != nil {
		platform.Error(w, 503, "setup_unavailable")
		return
	}
	platform.JSON(w, 201, map[string]string{"id": id})
}

func (s Service) Setup(w http.ResponseWriter, r *http.Request, who access.Identity) {
	var key, model, operation string
	var since time.Time
	var expired bool
	err := s.DB.QueryRow(r.Context(), `SELECT key_id,model,operation,started_at,expires_at<=now() FROM setup_checks
 WHERE id::text=$1 AND project_id=$2 AND principal_id=$3`, r.PathValue("id"), who.Project, who.Principal).Scan(&key, &model, &operation, &since, &expired)
	if errors.Is(err, pgx.ErrNoRows) {
		platform.Error(w, 404, "setup_check_not_found")
		return
	}
	if err != nil {
		platform.Error(w, 503, "setup_unavailable")
		return
	}
	if expired {
		platform.Error(w, 410, "setup_check_expired")
		return
	}
	s.setupResult(w, r, who, key, model, operation, since)
}

// LegacySetup supports console pages loaded before durable setup checks were deployed.
func (s Service) LegacySetup(w http.ResponseWriter, r *http.Request, who access.Identity) {
	query := r.URL.Query()
	since, err := time.Parse(time.RFC3339Nano, query.Get("since"))
	operation := query.Get("operation")
	if err != nil || since.Before(time.Now().Add(-time.Hour)) || (operation != "responses" && operation != "messages") {
		platform.Error(w, 400, "invalid_setup_check")
		return
	}
	s.setupResult(w, r, who, query.Get("key_id"), query.Get("model"), operation, since)
}

func (s Service) setupResult(w http.ResponseWriter, r *http.Request, who access.Identity, key, model, operation string, since time.Time) {
	var result json.RawMessage
	err := s.DB.QueryRow(r.Context(), `SELECT jsonb_build_object('id',id,'status',status,'error_code',error_code) FROM requests
 WHERE project_id=$1 AND principal_id=$2 AND key_id::text=$3 AND operation=$4 AND model=$5 AND created_at>=$6 AND status<>'running'
 ORDER BY (status='succeeded') DESC,created_at DESC LIMIT 1`, who.Project, who.Principal, key, operation, model, since).Scan(&result)
	if errors.Is(err, pgx.ErrNoRows) {
		platform.JSON(w, 200, map[string]string{"status": "waiting"})
		return
	}
	if err != nil {
		platform.Error(w, 503, "setup_unavailable")
		return
	}
	platform.JSON(w, 200, result)
}
