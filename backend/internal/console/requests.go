package console

import (
	"encoding/json"
	"errors"
	"net/http"

	"ai-gateway/internal/access"
	"ai-gateway/internal/platform"
	"github.com/jackc/pgx/v5"
)

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
	err := s.DB.QueryRow(r.Context(), `SELECT jsonb_build_object('id',r.id,'model',r.model,'operation',r.operation,'status',coalesce(j.status,r.status),'failure_stage',r.failure_stage,'error_code',coalesce(j.error_code,r.error_code),'job_id',j.id,'created_at',r.created_at,
 'attempts',coalesce((SELECT jsonb_agg(jsonb_build_object('attempt_no',a.attempt_no,'status',a.state,'http_status',a.status_code,'upstream_id',CASE WHEN $4 THEN a.upstream_id END,
 'started_at',a.started_at,'first_output_at',a.first_output_at,'finished_at',a.finished_at,
 'usage',coalesce((SELECT jsonb_agg(jsonb_build_object('metric',u.metric,'unit',u.unit,'quantity',u.quantity,'source',u.source)) FROM usage_records u WHERE u.attempt_id=a.id),'[]'::jsonb)) ORDER BY a.attempt_no)
 FROM upstream_attempts a WHERE a.request_id=r.id),'[]'::jsonb))
 FROM requests r LEFT JOIN media_jobs j ON j.request_id=r.id
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
