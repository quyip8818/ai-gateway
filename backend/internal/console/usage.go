package console

import (
	"encoding/csv"
	"encoding/json"
	"net/http"

	"ai-gateway/internal/access"
	"ai-gateway/internal/platform"
)

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
