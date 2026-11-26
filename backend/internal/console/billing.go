package console

import (
	"errors"
	"net/http"

	"ai-gateway/internal/access"
	"ai-gateway/internal/billing"
	"ai-gateway/internal/platform"
)

func (s Service) Billing(w http.ResponseWriter, r *http.Request, who access.Identity) {
	if who.Role != "admin" {
		platform.Error(w, 403, "admin_required")
		return
	}
	s.query(w, r, `SELECT jsonb_build_object('id',id,'operation',operation,'model',model,'metric',metric,'unit',unit,'quantity',quantity::text,'amount',amount::text,'currency',currency)
 FROM billing_entries WHERE project_id=$1 ORDER BY booked_at DESC,id DESC LIMIT 100`, who.Project)
}
func (s Service) BillingPrice(w http.ResponseWriter, r *http.Request, who access.Identity) {
	if who.Role != "admin" {
		platform.Error(w, 403, "admin_required")
		return
	}
	if r.Method == "GET" {
		s.query(w, r, `SELECT jsonb_build_object('id',id,'operation',operation,'model',model,'metric',metric,'unit',unit,'amount_per_unit',amount_per_unit::text,'active_from',active_from)
  FROM billing_prices WHERE project_id=$1 ORDER BY active_from DESC LIMIT 100`, who.Project)
		return
	}
	var price billing.Price
	if !Decode(w, r, &price) {
		return
	}
	id, err := (billing.Store{DB: s.DB}).Publish(r.Context(), who.Project, who.Principal, price)
	if errors.Is(err, billing.ErrInvalidPrice) {
		platform.Error(w, 400, "invalid_price")
		return
	}
	if err != nil {
		platform.Error(w, 503, "price_store_unavailable")
		return
	}
	platform.JSON(w, 201, map[string]string{"id": id})
}
func (s Service) BillingReconcile(w http.ResponseWriter, r *http.Request, who access.Identity) {
	if who.Role != "admin" {
		platform.Error(w, 403, "admin_required")
		return
	}
	count, err := (billing.Store{DB: s.DB}).Reconcile(r.Context(), who.Project)
	if err != nil {
		platform.Error(w, 503, "reconcile_unavailable")
		return
	}
	platform.JSON(w, 200, map[string]int64{"booked": count})
}
