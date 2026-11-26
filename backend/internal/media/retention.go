package media

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type Retention struct {
	SessionsBefore    time.Time
	AssetsBefore      time.Time
	OrphansBefore     time.Time
	IdempotencyBefore time.Time
	RequestsBefore    time.Time
	AuditBefore       time.Time
}

// Sweep removes retained data in a bounded pass. Valid provider usage keeps its request lineage.
func (s *Service) Sweep(ctx context.Context, p Retention) error {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	scripts := []struct {
		query  string
		before time.Time
	}{
		{"DELETE FROM web_sessions WHERE expires_at<$1", p.SessionsBefore},
		{"DELETE FROM setup_checks WHERE expires_at<$1::timestamptz - interval '1 day'", p.SessionsBefore},
		{"DELETE FROM account_authorizations WHERE expires_at<$1::timestamptz - interval '1 day'", p.SessionsBefore},
		{"DELETE FROM audit_events WHERE created_at<$1", p.AuditBefore},
		{`UPDATE media_jobs SET idempotency_key=NULL WHERE updated_at<$1 AND status IN ('succeeded','failed','canceled') AND idempotency_key IS NOT NULL`, p.IdempotencyBefore},
		{`DELETE FROM media_job_assets ma USING media_jobs j WHERE j.id=ma.job_id AND j.updated_at<$1 AND j.status IN ('succeeded','failed','canceled')`, p.AssetsBefore},
		{`DELETE FROM artifacts a USING media_jobs j WHERE j.id=a.job_id AND j.updated_at<$1 AND j.status='succeeded'`, p.AssetsBefore},
		{`DELETE FROM assets a WHERE a.created_at<$1 AND NOT EXISTS(SELECT 1 FROM media_job_assets ma WHERE ma.asset_id=a.id)
  AND NOT EXISTS(SELECT 1 FROM artifacts z WHERE z.asset_id=a.id)`, p.AssetsBefore},
	}
	for _, x := range scripts {
		if _, err = tx.Exec(ctx, x.query, x.before); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(ctx, `WITH expired AS MATERIALIZED (
  SELECT r.id FROM requests r WHERE r.created_at<$1 AND r.finished_at IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM media_jobs j WHERE j.request_id=r.id)
  AND NOT EXISTS(SELECT 1 FROM upstream_attempts a JOIN usage_records u ON u.attempt_id=a.id WHERE a.request_id=r.id)
 ) DELETE FROM upstream_attempts a USING expired e WHERE a.request_id=e.id`, p.RequestsBefore); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM requests r WHERE r.created_at<$1 AND r.finished_at IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM media_jobs j WHERE j.request_id=r.id)
 AND NOT EXISTS(SELECT 1 FROM upstream_attempts a WHERE a.request_id=r.id)`, p.RequestsBefore); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	entries, err := os.ReadDir(s.Dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if err = ctx.Err(); err != nil {
			return err
		}
		if entry.IsDir() || (invalidID(entry.Name()) && !strings.HasPrefix(entry.Name(), ".upload-")) {
			continue
		}
		info, err := entry.Info()
		if err != nil || !info.ModTime().Before(p.OrphansBefore) {
			continue
		}
		var referenced bool
		if err = s.DB.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM assets WHERE object_key=$1)", entry.Name()).Scan(&referenced); err != nil {
			return err
		}
		if !referenced {
			if err = os.Remove(filepath.Join(s.Dir, entry.Name())); err != nil && !os.IsNotExist(err) {
				return err
			}
		}
	}
	return nil
}
