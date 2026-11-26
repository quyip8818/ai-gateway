package metering

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"

	"ai-gateway/internal/access"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Store struct{ DB *pgxpool.Pool }

func (s Store) Start(ctx context.Context, who access.Identity, requestID, modelID, accountID, op, model string) (string, error) {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `INSERT INTO requests(id,tenant_id,project_id,principal_id,key_id,account_model_id,operation,model,status)
 VALUES($1,$2,$3,$4,nullif($5,'')::uuid,$6,$7,$8,'running')`, requestID, who.Tenant, who.Project, who.Principal, who.KeyID, modelID, op, model); err != nil {
		return "", err
	}
	var attempt string
	err = tx.QueryRow(ctx, `INSERT INTO upstream_attempts(tenant_id,project_id,request_id,account_id,attempt_no) VALUES($1,$2,$3,$4,1) RETURNING id`, who.Tenant, who.Project, requestID, accountID).Scan(&attempt)
	if err != nil {
		return "", err
	}
	return attempt, tx.Commit(ctx)
}

func (s Store) Finish(request, attempt, status, stage, code, upstream string, httpStatus int, first time.Time, usage map[string]json.Number) error {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `UPDATE requests SET status=$2,failure_stage=nullif($3,''),error_code=nullif($4,''),finished_at=now() WHERE id=$1`, request, status, stage, code); err != nil {
		return err
	}
	firstOutput := sql.NullTime{Time: first, Valid: !first.IsZero()}
	if _, err = tx.Exec(ctx, `UPDATE upstream_attempts SET upstream_id=nullif($2,''),status_code=nullif($3,0),state=$4,finished_at=now(),first_output_at=$5 WHERE id=$1`, attempt, upstream, httpStatus, status, firstOutput); err != nil {
		return err
	}
	for k, v := range usage {
		if _, err = tx.Exec(ctx, `INSERT INTO usage_records(attempt_id,metric,unit,source,quantity) VALUES($1,$2,'token','reported',$3::text::numeric)
 ON CONFLICT (attempt_id,metric,unit,source) DO UPDATE SET quantity=excluded.quantity`, attempt, k, string(v)); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// Retry records the first attempt as not dispatched before a safe second attempt.
func (s Store) Retry(ctx context.Context, request, previous, accountID string) (string, error) {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "UPDATE upstream_attempts SET state='not_accepted',finished_at=now() WHERE id=$1", previous); err != nil {
		return "", err
	}
	var next string
	err = tx.QueryRow(ctx, `INSERT INTO upstream_attempts(tenant_id,project_id,request_id,account_id,attempt_no)
 SELECT tenant_id,project_id,id,$2,2 FROM requests WHERE id=$1 RETURNING id`, request, accountID).Scan(&next)
	if err != nil {
		return "", err
	}
	return next, tx.Commit(ctx)
}
