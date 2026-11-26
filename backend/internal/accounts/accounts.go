// Package accounts owns credential enrollment and projects verified models into the executor catalog.
package accounts

import (
	"context"
	"errors"
	"time"

	"ai-gateway/internal/access"
	"ai-gateway/internal/platform"
	"ai-gateway/internal/providers"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrDuplicate = errors.New("account_credential_already_imported")

type Service struct {
	DB        *pgxpool.Pool
	Key       []byte
	Providers providers.Registry
}

type Account struct {
	ID, PoolID string
}

func (s Service) Enroll(ctx context.Context, who access.Identity, adapter providers.Adapter, name, raw string) (Account, error) {
	credential, err := adapter.Parse(raw)
	if err != nil {
		return Account{}, err
	}
	return s.Save(ctx, who, adapter, name, credential)
}

func (s Service) Save(ctx context.Context, who access.Identity, adapter providers.Adapter, name string, credential providers.Credential) (Account, error) {
	ctx, cancel := context.WithTimeout(ctx, 35*time.Second)
	defer cancel()
	id := platform.ID()
	if name == "" {
		name = adapter.Label + " · " + id[:8]
	}
	var tx pgx.Tx
	var reserved map[string]bool
	var err error
	lookup := rowQuerier(s.DB)
	if adapter.UsesManagedExecutor(credential) {
		tx, err = s.DB.Begin(ctx)
		if err != nil {
			return Account{}, err
		}
		defer tx.Rollback(ctx)
		reserved, err = reserveExecutors(ctx, tx)
		if err != nil {
			return Account{}, err
		}
		lookup = tx
	}

	fingerprint := platform.Digest(s.Key, adapter.ID+"\x00"+credential.Token)
	var duplicate bool
	if err := lookup.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM upstream_accounts WHERE credential_fingerprint=$1)", fingerprint).Scan(&duplicate); err != nil {
		return Account{}, err
	}
	if duplicate {
		return Account{}, ErrDuplicate
	}
	var registry providers.Registry
	if tx != nil {
		registry, err = s.registry(ctx, tx)
	} else {
		registry, err = s.Registry(ctx)
	}
	if err != nil {
		return Account{}, err
	}
	if !registry.MatchesSettings(adapter) {
		return Account{}, ErrSettingsInUse
	}
	prepared, err := registry.Prepare(ctx, adapter, credential, name, id, reserved)
	if err != nil {
		return Account{}, err
	}
	keepExecutor := false
	defer func() {
		if !keepExecutor && prepared.Cleanup != nil {
			prepared.Cleanup()
		}
		if keepExecutor && prepared.Finish != nil {
			prepared.Finish()
		}
	}()
	sealed, err := platform.Seal(s.Key, id, prepared.Token)
	if err != nil {
		return Account{}, err
	}
	var refresh []byte
	if prepared.Managed {
		credential.ExpiresAt = nil
	} else if credential.RefreshToken != "" {
		refresh, err = platform.Seal(s.Key, id+"/refresh", credential.RefreshToken)
		if err != nil {
			return Account{}, err
		}
	}
	if tx == nil {
		tx, err = s.DB.Begin(ctx)
		if err != nil {
			return Account{}, err
		}
		defer tx.Rollback(ctx)
	}
	if !prepared.Managed {
		registry, err = s.LockedRegistry(ctx, tx)
		if err != nil {
			return Account{}, err
		}
		if !registry.MatchesSettings(adapter) {
			return Account{}, ErrSettingsInUse
		}
	}
	var project string
	if err = tx.QueryRow(ctx, "SELECT id FROM projects WHERE id=$1 AND enabled FOR UPDATE", who.Project).Scan(&project); err != nil {
		return Account{}, err
	}
	account := Account{ID: id}
	var slug string
	owner := ""
	if credential.Personal {
		owner = who.Principal
	}
	if err = tx.QueryRow(ctx, `INSERT INTO account_pools(tenant_id,project_id,provider,slug,owner_id)
 SELECT $1,$2,$3,CASE WHEN EXISTS(SELECT 1 FROM account_pools WHERE project_id=$2 AND slug=$3) THEN $3||'-'||$5 ELSE $3 END,nullif($4,'')::uuid
 ON CONFLICT(project_id,provider,owner_id) DO UPDATE SET provider=EXCLUDED.provider RETURNING id,slug`,
		who.Tenant, who.Project, adapter.ID, owner, id[:8]).Scan(&account.PoolID, &slug); err != nil {
		return Account{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO upstream_accounts(
 id,tenant_id,project_id,pool_id,protocol,label,base_url,execution_secret,managed,credential_fingerprint,refresh_secret,expires_at,count_tokens)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, id, who.Tenant, who.Project, account.PoolID,
		adapter.Protocol, name, prepared.Base, sealed, prepared.Managed, fingerprint, refresh, credential.ExpiresAt, adapter.CountTokens); err != nil {
		var conflict *pgconn.PgError
		if errors.As(err, &conflict) && conflict.Code == "23505" {
			return Account{}, ErrDuplicate
		}
		return Account{}, err
	}
	for _, model := range prepared.Models {
		public := slug + "/" + model.ID
		if _, err = tx.Exec(ctx, `INSERT INTO account_models(tenant_id,project_id,operation,model,upstream_model,account_id,capabilities)
 VALUES($1,$2,$3,$4,$5,$6,$7)`,
			who.Tenant, who.Project, model.Operation, public, model.ID, id, model.Capabilities); err != nil {
			return Account{}, err
		}
	}
	if _, err = tx.Exec(ctx, "INSERT INTO audit_events(project_id,actor_id,action,target_id) VALUES($1,$2,'account.enroll',$3)", who.Project, who.Principal, id); err != nil {
		return Account{}, err
	}
	// A lost commit response cannot prove local state rolled back, so keep any
	// provisioned upstream resources for inspection after COMMIT was attempted.
	keepExecutor = true
	return account, tx.Commit(ctx)
}

type rowQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func reserveExecutors(ctx context.Context, tx pgx.Tx) (map[string]bool, error) {
	// Serialize dedicated runtime assignments across projects, including cleanup.
	if _, err := tx.Exec(ctx, executorLock); err != nil {
		return nil, err
	}
	return occupiedExecutors(ctx, tx)
}

func occupiedExecutors(ctx context.Context, db queryer) (map[string]bool, error) {
	rows, err := db.Query(ctx, "SELECT base_url FROM upstream_accounts WHERE managed")
	if err != nil {
		return nil, err
	}
	urls, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, err
	}
	reserved := make(map[string]bool, len(urls))
	for _, address := range urls {
		reserved[providers.NormalizeExecutorURL(address)] = true
	}
	return reserved, nil
}
