package billing

import (
	"context"
	"errors"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Store struct{ DB *pgxpool.Pool }
type Price struct {
	Operation     string `json:"operation"`
	Model         string `json:"model"`
	Metric        string `json:"metric"`
	Unit          string `json:"unit"`
	AmountPerUnit string `json:"amount_per_unit"`
}

var ErrInvalidPrice = errors.New("invalid_price")
var decimal = regexp.MustCompile(`^(0|[1-9][0-9]{0,11})(\.[0-9]{1,12})?$`)

func (s Store) Publish(ctx context.Context, project, actor string, p Price) (string, error) {
	allowed := map[string]bool{"input_tokens": true, "output_tokens": true, "cache_creation_input_tokens": true, "cache_read_input_tokens": true}
	if (p.Operation != "responses" && p.Operation != "messages") || p.Unit != "token" || !allowed[p.Metric] || !decimal.MatchString(p.AmountPerUnit) || strings.TrimSpace(p.Model) == "" || len(p.Model) > 128 {
		return "", ErrInvalidPrice
	}
	if p.Operation == "responses" && strings.HasPrefix(p.Metric, "cache_") {
		return "", ErrInvalidPrice
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	var id string
	err = tx.QueryRow(ctx, `INSERT INTO billing_prices(project_id,operation,model,metric,unit,amount_per_unit)
 VALUES($1,$2,$3,$4,$5,$6::text::numeric) RETURNING id`, project, p.Operation, p.Model, p.Metric, p.Unit, p.AmountPerUnit).Scan(&id)
	if err != nil {
		return "", err
	}
	if _, err = tx.Exec(ctx, "INSERT INTO audit_events(project_id,actor_id,action,target_id) VALUES($1,$2,'billing.price.publish',$3)", project, actor, id); err != nil {
		return "", err
	}
	return id, tx.Commit(ctx)
}

// Reconcile rates confirmed, reported use against the price already effective at request creation.
// Entries are shadow credits. This path never charges a payment instrument.
func (s Store) Reconcile(ctx context.Context, project string) (int64, error) {
	tag, err := s.DB.Exec(ctx, `INSERT INTO billing_entries(project_id,attempt_id,price_id,operation,model,metric,unit,quantity,amount)
 SELECT r.project_id,a.id,p.id,r.operation,r.model,u.metric,u.unit,u.quantity,u.quantity*p.amount_per_unit
 FROM usage_records u JOIN upstream_attempts a ON a.id=u.attempt_id JOIN requests r ON r.id=a.request_id
 JOIN LATERAL (
 SELECT id,amount_per_unit FROM billing_prices
 WHERE project_id=r.project_id AND operation=r.operation AND model=r.model AND metric=u.metric AND unit=u.unit AND active_from<=r.created_at
 ORDER BY active_from DESC LIMIT 1
 ) p ON true
 WHERE r.project_id=$1 AND r.status='succeeded' AND a.state='succeeded' AND u.source='reported'
 ON CONFLICT(attempt_id,metric,unit) DO NOTHING`, project)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
