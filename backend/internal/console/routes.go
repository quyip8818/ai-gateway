package console

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"ai-gateway/internal/access"
	"ai-gateway/internal/catalog"
	"ai-gateway/internal/media"
	"ai-gateway/internal/platform"
	"github.com/jackc/pgx/v5"
)

func (s Service) Connections(w http.ResponseWriter, r *http.Request, who access.Identity) {
	if who.Role != "admin" {
		platform.Error(w, 403, "admin_required")
		return
	}
	if r.Method == "GET" {
		s.query(w, r, `SELECT jsonb_build_object('id',id,'label',label,'provider',provider,'enabled',enabled,'base_url',base_url,'probe_state',probe_state,'probed_at',probed_at) FROM connections WHERE project_id=$1 ORDER BY label`, who.Project)
		return
	}
	var in connectionDraft
	if !Decode(w, r, &in) {
		return
	}
	provider, ok := catalog.LookupProvider(in.Provider)
	if !ok || !in.prepare(provider, s.JimengBase) {
		platform.Error(w, 400, "invalid_connection")
		return
	}
	id := platform.ID()
	enc, err := platform.Seal(s.Catalog.Key, id, in.Token)
	if err == nil {
		_, err = s.DB.Exec(r.Context(), `INSERT INTO connections(id,tenant_id,project_id,provider,label,base_url,token,quota_scope,region,video_idempotency_verified) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, id, who.Tenant, who.Project, in.Provider, in.Label, in.Base, enc, in.Quota, in.Region, provider.SupportsVideoIdempotency && in.VideoIdempotencyVerified)
	}
	if err != nil {
		platform.Error(w, 503, "connection_create_failed")
		return
	}
	platform.JSON(w, 201, map[string]string{"id": id})
}

type connectionDraft struct {
	Provider, Label, Base, Token, Quota, Region string
	VideoIdempotencyVerified                    bool
}

func (in *connectionDraft) prepare(provider catalog.Provider, jimengBase string) bool {
	if provider.ID == "jimeng" {
		if in.Label == "" {
			in.Label = "即梦"
		}
		if in.Base == "" {
			in.Base = jimengBase
		}
		if in.Quota == "" {
			in.Quota = provider.ID
		}
	}
	return in.Label != "" && in.Token != "" && in.Quota != "" &&
		provider.ValidateBase(in.Base, jimengBase) == nil
}

func (s Service) Routes(w http.ResponseWriter, r *http.Request, who access.Identity) {
	if who.Role != "admin" {
		platform.Error(w, 403, "admin_required")
		return
	}
	if r.Method == "GET" {
		s.query(w, r, `SELECT jsonb_build_object('id',id,'model',model,'upstream_model',upstream_model,'operation',operation,'version',version,'active',active)
 FROM model_routes WHERE project_id=$1 ORDER BY model,version DESC`, who.Project)
		return
	}
	var in routeDraft
	if !decodeRouteDraft(w, r, &in) {
		return
	}
	s.publishRoute(w, r, who, in)
}

type routeDraft struct {
	Model, Upstream, Operation, Connection, Backup string
	Capabilities                                   map[string]json.RawMessage
}

func decodeRouteDraft(w http.ResponseWriter, r *http.Request, in *routeDraft) bool {
	if !Decode(w, r, in) {
		return false
	}
	if in.Operation == "image.generate" {
		if in.Capabilities == nil {
			in.Capabilities = make(map[string]json.RawMessage)
		}
		if version := in.Capabilities["image_api"]; len(version) == 0 || bytes.Equal(version, []byte("null")) {
			in.Capabilities["image_api"] = json.RawMessage(`"openai"`)
		}
	}
	raw, err := json.Marshal(in.Capabilities)
	if err != nil || media.ValidateCapabilities(in.Operation, raw) != nil {
		platform.Error(w, 400, "invalid_media_capabilities")
		return false
	}
	return true
}

type routeQuery interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func routeError(ctx context.Context, q routeQuery, project string, in routeDraft) (string, error) {
	provider, ok := catalog.ProviderForOperation(in.Operation)
	if !ok || !modelID.MatchString(in.Model) || !modelID.MatchString(in.Upstream) || in.Connection == "" {
		return "invalid_route", nil
	}
	var valid bool
	err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM connections WHERE id::text=$1 AND project_id=$2 AND provider=$3 AND enabled)`, in.Connection, project, provider.ID).Scan(&valid)
	if err != nil {
		return "", err
	}
	if !valid {
		return "invalid_connection", nil
	}
	if in.Backup == "" {
		return "", nil
	}
	if !provider.AllowBackup {
		return "invalid_backup", nil
	}
	err = q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM connections p JOIN connections c ON c.project_id=p.project_id WHERE p.id::text=$1 AND c.id::text=$2
	AND p.id<>c.id AND c.enabled AND c.provider=p.provider AND c.region=p.region AND c.quota_scope=p.quota_scope)`, in.Connection, in.Backup).Scan(&valid)
	if err != nil {
		return "", err
	}
	if !valid {
		return "invalid_backup", nil
	}
	return "", nil
}

func (s Service) ValidateRoute(w http.ResponseWriter, r *http.Request, who access.Identity) {
	if who.Role != "admin" {
		platform.Error(w, 403, "admin_required")
		return
	}
	var in routeDraft
	if !decodeRouteDraft(w, r, &in) {
		return
	}
	code, err := routeError(r.Context(), s.DB, who.Project, in)
	if err != nil {
		platform.Error(w, 503, "route_store_unavailable")
		return
	}
	if code != "" {
		platform.Error(w, 400, code)
		return
	}
	platform.JSON(w, 200, map[string]bool{"valid": true})
}

func (s Service) RestoreRoute(w http.ResponseWriter, r *http.Request, who access.Identity) {
	if who.Role != "admin" {
		platform.Error(w, 403, "admin_required")
		return
	}
	var in routeDraft
	err := s.DB.QueryRow(r.Context(), `SELECT r.model,r.upstream_model,r.operation,r.connection_id,coalesce(b.connection_id::text,''),r.capabilities
	FROM model_routes r LEFT JOIN model_route_backups b ON b.route_id=r.id WHERE r.project_id=$1 AND r.id::text=$2`, who.Project, r.PathValue("id")).
		Scan(&in.Model, &in.Upstream, &in.Operation, &in.Connection, &in.Backup, &in.Capabilities)
	if errors.Is(err, pgx.ErrNoRows) {
		platform.Error(w, 404, "route_not_found")
		return
	}
	if err != nil {
		platform.Error(w, 503, "route_store_unavailable")
		return
	}
	s.publishRoute(w, r, who, in)
}

func (s Service) publishRoute(w http.ResponseWriter, r *http.Request, who access.Identity, in routeDraft) {
	ctx := r.Context()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		platform.Error(w, 503, "route_store_unavailable")
		return
	}
	defer tx.Rollback(ctx)
	var lock string
	err = tx.QueryRow(ctx, "SELECT id FROM projects WHERE id=$1 FOR UPDATE", who.Project).Scan(&lock)
	if err != nil {
		platform.Error(w, 503, "route_store_unavailable")
		return
	}
	code, err := routeError(ctx, tx, who.Project, in)
	if err != nil {
		platform.Error(w, 503, "route_store_unavailable")
		return
	}
	if code != "" {
		platform.Error(w, 400, code)
		return
	}
	connection := in.Connection
	_, err = tx.Exec(ctx, `UPDATE model_routes SET active=false WHERE project_id=$1 AND operation=$2 AND model=$3 AND active`, who.Project, in.Operation, in.Model)
	if err != nil {
		platform.Error(w, 503, "route_store_unavailable")
		return
	}
	if in.Capabilities == nil {
		in.Capabilities = map[string]json.RawMessage{}
	}
	var id string
	err = tx.QueryRow(ctx, `INSERT INTO model_routes(tenant_id,project_id,operation,model,upstream_model,connection_id,version,capabilities)
 VALUES($1,$2,$3,$4,$5,$6,(SELECT coalesce(max(version),0)+1 FROM model_routes WHERE project_id=$2 AND operation=$3 AND model=$4),$7) RETURNING id`, who.Tenant, who.Project, in.Operation, in.Model, in.Upstream, connection, in.Capabilities).Scan(&id)
	if err == nil && in.Backup != "" {
		tag, backupErr := tx.Exec(ctx, `INSERT INTO model_route_backups(tenant_id,project_id,route_id,connection_id)
		SELECT p.tenant_id,p.project_id,$1,c.id FROM connections p JOIN connections c ON c.project_id=p.project_id
		WHERE p.id=$2 AND c.id::text=$3 AND c.id<>p.id AND c.enabled AND c.provider=p.provider AND c.region=p.region AND c.quota_scope=p.quota_scope`, id, connection, in.Backup)
		if backupErr != nil {
			platform.Error(w, 503, "backup_store_unavailable")
			return
		}
		if tag.RowsAffected() != 1 {
			platform.Error(w, 400, "invalid_backup")
			return
		}
	}

	if err == nil {
		_, err = tx.Exec(ctx, "INSERT INTO audit_events(project_id,actor_id,action,target_id) VALUES($1,$2,'route.publish',$3)", who.Project, who.Principal, id)
	}
	if err != nil || tx.Commit(ctx) != nil {
		platform.Error(w, 503, "route_publish_failed")
		return
	}
	platform.JSON(w, 201, map[string]string{"id": id})
}
