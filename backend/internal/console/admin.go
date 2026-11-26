package console

import (
	"net/http"

	"ai-gateway/internal/access"
	"ai-gateway/internal/platform"
)

func (s Service) Members(w http.ResponseWriter, r *http.Request, who access.Identity) {
	if who.Role != "admin" {
		platform.Error(w, 403, "admin_required")
		return
	}
	if r.Method == "GET" {
		s.query(w, r, `SELECT jsonb_build_object('id',p.id,'username',u.username,'role',p.role,'enabled',p.enabled)
 FROM project_principals p LEFT JOIN users u ON u.id=p.user_id WHERE p.project_id=$1 ORDER BY u.username`, who.Project)
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

func (s Service) Audit(w http.ResponseWriter, r *http.Request, who access.Identity) {
	if who.Role != "admin" {
		platform.Error(w, 403, "admin_required")
		return
	}
	s.query(w, r, `SELECT jsonb_build_object('id',id,'action',action,'actor_id',actor_id,'target_id',target_id,'created_at',created_at)
 FROM audit_events WHERE project_id=$1 ORDER BY created_at DESC LIMIT 100`, who.Project)
}
