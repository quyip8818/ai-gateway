package schema

import (
	"context"
	_ "embed"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed schema.sql
var definition string

//go:embed provider_settings.sql
var providerSettings string

const (
	coreVersion    = 1
	previewVersion = 2
)

var (
	ErrNotInitialized          = errors.New("gateway database is empty; run gatewayctl init-db")
	ErrIncompatible            = errors.New("incompatible gateway schema; use a fresh database for the account-pool release")
	errProviderSettingsMissing = errors.New("gateway provider settings schema is missing; run gatewayctl init-db")
)

type querier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

// Check verifies the database without changing it.
func Check(ctx context.Context, db *pgxpool.Pool) error {
	v, err := version(ctx, db)
	if err != nil {
		return err
	}
	if v != coreVersion {
		return fmt.Errorf("%w (found version %d, expected %d)", ErrIncompatible, v, coreVersion)
	}
	available, err := hasProviderSettings(ctx, db)
	if err != nil {
		return err
	}
	if !available {
		return errProviderSettingsMissing
	}
	return nil
}

func version(ctx context.Context, db querier) (int, error) {
	var versioned, existing bool
	err := db.QueryRow(ctx, `SELECT to_regclass('gateway_schema') IS NOT NULL,
 to_regclass('tenants') IS NOT NULL OR to_regclass('users') IS NOT NULL OR to_regclass('upstream_accounts') IS NOT NULL`).
		Scan(&versioned, &existing)
	if err != nil {
		return 0, err
	}
	if !versioned {
		if existing {
			return 0, ErrIncompatible
		}
		return 0, ErrNotInitialized
	}
	var v int
	err = db.QueryRow(ctx, "SELECT version FROM gateway_schema WHERE singleton").Scan(&v)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrIncompatible
	}
	return v, err
}

func hasProviderSettings(ctx context.Context, db querier) (bool, error) {
	var available bool
	err := db.QueryRow(ctx, `SELECT to_regclass('provider_settings') IS NOT NULL
 AND to_regclass('provider_executors') IS NOT NULL
 AND to_regclass('media_download_hosts') IS NOT NULL
 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('account_authorizations')
    AND attname='client_digest' AND NOT attisdropped)`).Scan(&available)
	return available, err
}

// Initialize installs the core schema and its additive provider settings in one transaction.
func Initialize(ctx context.Context, db *pgxpool.Pool) error {
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(61912342)"); err != nil {
		return err
	}
	v, err := version(ctx, tx)
	switch {
	case errors.Is(err, ErrNotInitialized):
		if _, err = tx.Exec(ctx, definition); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, "INSERT INTO gateway_schema(version) VALUES($1)", coreVersion); err != nil {
			return err
		}
		v = coreVersion
	case err != nil:
		return err
	}
	if v != coreVersion && v != previewVersion {
		return fmt.Errorf("%w (found version %d, expected %d)", ErrIncompatible, v, coreVersion)
	}
	available, err := hasProviderSettings(ctx, tx)
	if err != nil {
		return err
	}
	if !available {
		if _, err = tx.Exec(ctx, providerSettings); err != nil {
			return err
		}
	}
	// The extension does not change the schema contract used by the previous release.
	// Restore its core version marker for databases already upgraded by a preview build.
	if v == previewVersion {
		if _, err = tx.Exec(ctx, "UPDATE gateway_schema SET version=$1", coreVersion); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
