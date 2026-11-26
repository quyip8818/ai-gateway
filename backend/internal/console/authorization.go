package console

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/http"
	"time"

	"ai-gateway/internal/access"
	"ai-gateway/internal/platform"
	"github.com/jackc/pgx/v5"
)

const accountCallback = "/console/v1/oauth/callback"

func (s Service) StartAuthorization(w http.ResponseWriter, r *http.Request, who access.Identity) {
	if who.Role != "admin" {
		platform.Error(w, 403, "admin_required")
		return
	}
	var input struct{ Provider string }
	if !Decode(w, r, &input) {
		return
	}
	adapter, ok := s.AccountsService.Providers.Get(input.Provider)
	if !ok || !adapter.CanAuthorize() {
		platform.Error(w, 400, "credential_adapter_unavailable")
		return
	}
	id, state, verifier := platform.ID(), platform.Random(), platform.Random()
	hash := sha256.Sum256([]byte(verifier))
	target, err := adapter.OAuth.AuthorizationURL(s.PublicBase+accountCallback, state, base64.RawURLEncoding.EncodeToString(hash[:]))
	if err != nil {
		platform.Error(w, 503, "authorization_unavailable")
		return
	}
	sealed, err := platform.Seal(s.AccountsService.Key, id+"/verifier", verifier)
	if err == nil {
		_, err = s.DB.Exec(r.Context(), `INSERT INTO account_authorizations(id,tenant_id,project_id,principal_id,provider,state_digest,verifier_ciphertext)
 VALUES($1,$2,$3,$4,$5,$6,$7)`, id, who.Tenant, who.Project, who.Principal, input.Provider, platform.Digest(s.Store.Key, state), sealed)
	}
	if err != nil {
		platform.Error(w, 503, "authorization_unavailable")
		return
	}
	platform.JSON(w, 201, map[string]string{"id": id, "authorization_url": target})
}

func (s Service) AuthorizationResult(w http.ResponseWriter, r *http.Request, who access.Identity) {
	var phase, result string
	err := s.DB.QueryRow(r.Context(), `SELECT CASE WHEN expires_at<=now() AND phase IN ('waiting','verifying') THEN 'expired' ELSE phase END,
 coalesce(result_id::text,'') FROM account_authorizations WHERE id::text=$1 AND project_id=$2 AND principal_id=$3`,
		r.PathValue("id"), who.Project, who.Principal).Scan(&phase, &result)
	if errors.Is(err, pgx.ErrNoRows) {
		platform.Error(w, 404, "authorization_not_found")
		return
	}
	if err != nil {
		platform.Error(w, 503, "authorization_unavailable")
		return
	}
	platform.JSON(w, 200, map[string]string{"status": phase, "account_id": result})
}

func (s Service) AuthorizationCallback(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Cache-Control", "no-store")
	state, code := r.URL.Query().Get("state"), r.URL.Query().Get("code")
	if len(state) != base64.RawURLEncoding.EncodedLen(32) || len(code) > 4096 {
		platform.Error(w, 400, "authorization_state_invalid")
		return
	}
	ctx := r.Context()
	digest := platform.Digest(s.Store.Key, state)
	var id, project, principal, provider string
	var sealed []byte
	err := s.DB.QueryRow(ctx, `SELECT id,project_id,principal_id,provider,verifier_ciphertext
 FROM account_authorizations WHERE state_digest=$1 AND phase='waiting' AND expires_at>now()`, digest).
		Scan(&id, &project, &principal, &provider, &sealed)
	if errors.Is(err, pgx.ErrNoRows) {
		platform.Error(w, 400, "authorization_state_invalid")
		return
	}
	if err != nil {
		platform.Error(w, 503, "authorization_unavailable")
		return
	}
	who, err := s.Store.Project(r, project)
	if err != nil || who.Principal != principal || who.Role != "admin" {
		platform.Error(w, 403, "authorization_owner_required")
		return
	}
	tag, err := s.DB.Exec(ctx, `UPDATE account_authorizations SET phase='verifying',verifier_ciphertext=NULL
 WHERE id=$1 AND phase='waiting' AND expires_at>now()`, id)
	if err != nil || tag.RowsAffected() != 1 {
		platform.Error(w, 409, "authorization_state_invalid")
		return
	}
	result, phase := "", "failed"
	adapter, ok := s.AccountsService.Providers.Get(provider)
	if ok && code != "" && r.URL.Query().Get("error") == "" {
		if verifier, err := platform.Open(s.AccountsService.Key, sealed, id+"/verifier"); err == nil {
			// Do not lose the result if the browser navigates away after the callback.
			exchange, cancel := context.WithTimeout(context.WithoutCancel(ctx), 35*time.Second)
			if credential, err := s.AccountsService.Providers.Exchange(exchange, adapter, code, s.PublicBase+accountCallback, verifier); err == nil {
				if account, err := s.AccountsService.Save(exchange, who, adapter, "", credential); err == nil {
					result, phase = account.ID, "succeeded"
				}
			}
			cancel()
		}
	}
	final, stop := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer stop()
	if _, err = s.DB.Exec(final, `UPDATE account_authorizations SET phase=$2,result_id=nullif($3,'')::uuid WHERE id=$1`, id, phase, result); err != nil {
		platform.Error(w, 503, "authorization_unavailable")
		return
	}
	http.Redirect(w, r, s.PublicBase+"/app/projects/"+project+"/admin?authorization="+id, http.StatusSeeOther)
}
