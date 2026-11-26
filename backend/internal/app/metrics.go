package app

import (
	"fmt"
	"net/http"
)

func (a App) metrics(w http.ResponseWriter, r *http.Request) {
	var queued, unknown, running, expired int64
	var oldest float64
	err := a.DB.QueryRow(r.Context(), `SELECT count(*) FILTER(WHERE status='queued'),count(*) FILTER(WHERE status='submit_unknown'),
 count(*) FILTER(WHERE status IN ('running','submitting','finalizing')),
 count(*) FILTER(WHERE lease_until<now() AND status IN ('running','submitting','finalizing')),
 coalesce(EXTRACT(epoch FROM now()-min(created_at) FILTER(WHERE status='queued')),0)::double precision
 FROM media_jobs`).Scan(&queued, &unknown, &running, &expired, &oldest)
	if err != nil {
		http.Error(w, "metrics unavailable", 503)
		return
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	fmt.Fprintf(w, "# TYPE gateway_media_jobs gauge\ngateway_media_jobs{state=\"queued\"} %d\ngateway_media_jobs{state=\"submit_unknown\"} %d\ngateway_media_jobs{state=\"active\"} %d\n# TYPE gateway_media_expired_leases gauge\ngateway_media_expired_leases %d\n# TYPE gateway_media_oldest_queued_seconds gauge\ngateway_media_oldest_queued_seconds %g\n", queued, unknown, running, expired, oldest)
}
