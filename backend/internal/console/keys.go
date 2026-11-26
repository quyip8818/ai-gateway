package console

import (
	"errors"
	"net/http"
	"strings"

	"ai-gateway/internal/access"
	"ai-gateway/internal/platform"
	"github.com/jackc/pgx/v5"
)

func (s Service) Keys(w http.ResponseWriter, r *http.Request, who access.Identity) {
	switch r.Method {
	case "GET":
		s.query(w, r, `SELECT jsonb_build_object('id',id,'label',label,'prefix',prefix,'revoked_at',revoked_at,'pools',ARRAY(SELECT p.slug FROM key_grants g JOIN account_pools p ON p.id=g.pool_id WHERE g.key_id=api_keys.id ORDER BY p.slug))
 FROM api_keys WHERE project_id=$1 AND principal_id=$2 ORDER BY created_at DESC`, who.Project, who.Principal)
	case "POST":
		if who.Role != "admin" {
			platform.Error(w, 403, "admin_required")
			return
		}
		var input struct {
			Label string
			Pools []string
		}
		if !Decode(w, r, &input) {
			return
		}
		if strings.TrimSpace(input.Label) == "" || len(input.Label) > 100 {
			platform.Error(w, 400, "label_required")
			return
		}
		if len(input.Pools) < 1 || len(input.Pools) > 20 {
			platform.Error(w, 400, "pool_required")
			return
		}
		ctx := r.Context()
		tx, err := s.DB.Begin(ctx)
		if err != nil {
			platform.Error(w, 503, "key_create_failed")
			return
		}
		defer tx.Rollback(ctx)
		id, key, err := s.Store.Issue(ctx, tx, who, input.Label)
		if err != nil {
			platform.Error(w, 503, "key_create_failed")
			return
		}
		for _, pool := range input.Pools {
			tag, err := tx.Exec(ctx, `INSERT INTO key_grants(tenant_id,project_id,key_id,principal_id,pool_id)
 SELECT tenant_id,project_id,$3,$4,id FROM account_pools WHERE project_id=$1 AND id::text=$2 AND (owner_id IS NULL OR owner_id=$4) ON CONFLICT DO NOTHING`,
				who.Project, pool, id, who.Principal)
			if err != nil {
				platform.Error(w, 503, "key_create_failed")
				return
			}
			if tag.RowsAffected() != 1 {
				platform.Error(w, 400, "invalid_pool")
				return
			}
		}
		if err := tx.Commit(ctx); err != nil {
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
	id := r.PathValue("id")
	if rotate {
		var key string
		key, err = s.Store.Rotate(ctx, tx, who, id)
		if err == nil {
			if err = tx.Commit(ctx); err == nil {
				w.Header().Set("Cache-Control", "no-store")
				platform.JSON(w, 201, map[string]string{"id": id, "key": key})
				return
			}
		}
	} else {
		err = tx.QueryRow(ctx, `UPDATE api_keys SET revoked_at=now() WHERE id::text=$1 AND project_id=$2 AND principal_id=$3 AND revoked_at IS NULL RETURNING id`,
			id, who.Project, who.Principal).Scan(&id)
		if err == nil {
			if err = tx.Commit(ctx); err == nil {
				w.WriteHeader(204)
				return
			}
		}
	}
	if errors.Is(err, pgx.ErrNoRows) {
		platform.Error(w, 404, "key_not_found")
		return
	}
	platform.Error(w, 503, "key_store_unavailable")
}
