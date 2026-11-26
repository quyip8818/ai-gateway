package console

import (
	"errors"
	"net/http"
	"strings"

	"ai-gateway/internal/access"
	"ai-gateway/internal/accounts"
	"ai-gateway/internal/platform"
	"ai-gateway/internal/providers"
	"github.com/jackc/pgx/v5"
)

func (s Service) Providers(w http.ResponseWriter, _ *http.Request, _ access.Identity) {
	data := []map[string]any{}
	for _, adapter := range s.AccountsService.Providers.All() {
		data = append(data, map[string]any{
			"id": adapter.ID, "name": adapter.Label, "format": adapter.Format, "configured": adapter.Configured(), "authorize": adapter.CanAuthorize(),
			"credential_label": adapter.CredentialLabel, "protocol": adapter.Protocol,
		})
	}
	platform.JSON(w, http.StatusOK, map[string]any{"data": data})
}

func (s Service) Pools(w http.ResponseWriter, r *http.Request, who access.Identity) {
	s.query(w, r, `SELECT jsonb_build_object('id',p.id,'provider',p.provider,'slug',p.slug,
 'available',(SELECT count(*) FROM upstream_accounts a
 WHERE a.pool_id=p.id AND a.enabled AND account_credential_ready(a)))
 FROM account_pools p WHERE p.project_id=$1 AND may_use_pool(p.id,'',$2,$3) ORDER BY p.slug`, who.Project, who.Principal, who.Role == "admin")
}

func (s Service) Accounts(w http.ResponseWriter, r *http.Request, who access.Identity) {
	if who.Role != "admin" {
		platform.Error(w, 403, "admin_required")
		return
	}
	s.query(w, r, `SELECT jsonb_build_object('id',a.id,'label',a.label,'provider',p.provider,
 'enabled',a.enabled,'refresh_state',a.refresh_state,'expires_at',a.expires_at,'last_used_at',a.last_used_at,'verified_at',a.verified_at,
 'models',(SELECT count(*) FROM account_models m WHERE m.account_id=a.id))
 FROM upstream_accounts a
 JOIN account_pools p ON p.id=a.pool_id WHERE a.project_id=$1 ORDER BY a.created_at DESC`, who.Project)
}

func (s Service) EnrollAccount(w http.ResponseWriter, r *http.Request, who access.Identity) {
	if who.Role != "admin" {
		platform.Error(w, 403, "admin_required")
		return
	}
	var input struct {
		Provider, Label, Credential string
	}
	if !Decode(w, r, &input) {
		return
	}
	adapter, ok := s.AccountsService.Providers.Get(input.Provider)
	if !ok || !adapter.Configured() {
		platform.Error(w, 400, "provider_unconfigured")
		return
	}
	label := strings.TrimSpace(input.Label)
	if len(label) > 120 {
		platform.Error(w, 400, "invalid_account_label")
		return
	}
	enrolled, err := s.AccountsService.Enroll(r.Context(), who, adapter, label, input.Credential)
	switch {
	case errors.Is(err, providers.ErrCredential):
		platform.Error(w, 400, "invalid_account_credential")
	case errors.Is(err, providers.ErrDisabled):
		platform.Error(w, 400, "credential_adapter_unavailable")
	case errors.Is(err, providers.ErrNoExecutor):
		platform.Error(w, 409, "no_available_account_executor")
	case errors.Is(err, providers.ErrUpstream):
		platform.Error(w, 502, "account_validation_unavailable")
	case errors.Is(err, accounts.ErrDuplicate):
		platform.Error(w, 409, "account_already_imported")
	case err != nil:
		platform.Error(w, 503, "account_store_unavailable")
	default:
		platform.JSON(w, 201, map[string]string{"id": enrolled.ID, "pool_id": enrolled.PoolID})
	}
}

func (s Service) UpdateAccount(w http.ResponseWriter, r *http.Request, who access.Identity) {
	if who.Role != "admin" {
		platform.Error(w, 403, "admin_required")
		return
	}
	var v struct{ Enabled *bool }
	if !Decode(w, r, &v) {
		return
	}
	if v.Enabled == nil {
		platform.Error(w, 400, "invalid_request")
		return
	}
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		platform.Error(w, 503, "account_update_failed")
		return
	}
	defer tx.Rollback(r.Context())
	var id string
	err = tx.QueryRow(r.Context(), "UPDATE upstream_accounts SET enabled=$3 WHERE project_id=$1 AND id::text=$2 RETURNING id", who.Project, r.PathValue("id"), *v.Enabled).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		platform.Error(w, 404, "account_not_found")
		return
	}
	if err == nil {
		_, err = tx.Exec(r.Context(), "INSERT INTO audit_events(project_id,actor_id,action,target_id) VALUES($1,$2,'account.status',$3)", who.Project, who.Principal, id)
	}
	if err != nil || tx.Commit(r.Context()) != nil {
		platform.Error(w, 503, "account_update_failed")
		return
	}
	w.WriteHeader(204)
}
