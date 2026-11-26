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

const currentVersion = 1

var (
	ErrNotInitialized = errors.New("gateway database is empty; run gatewayctl init-db")
	ErrIncompatible   = errors.New("incompatible gateway schema; use a fresh database for the account-pool release")
)

type querier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

// Check verifies the database without changing it.
func Check(ctx context.Context, db *pgxpool.Pool) error {
	return check(ctx, db)
}

func check(ctx context.Context, db querier) error {
	var versioned, existing bool
	err := db.QueryRow(ctx, `SELECT to_regclass('gateway_schema') IS NOT NULL,
 to_regclass('tenants') IS NOT NULL OR to_regclass('users') IS NOT NULL OR to_regclass('upstream_accounts') IS NOT NULL`).
		Scan(&versioned, &existing)
	if err != nil {
		return err
	}
	if !versioned {
		if existing {
			return ErrIncompatible
		}
		return ErrNotInitialized
	}
	var version int
	err = db.QueryRow(ctx, "SELECT version FROM gateway_schema WHERE singleton").Scan(&version)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrIncompatible
	}
	if err != nil {
		return err
	}
	if version != currentVersion {
		return fmt.Errorf("%w (found version %d, expected %d)", ErrIncompatible, version, currentVersion)
	}
	return nil
}

// Initialize creates an empty gateway database atomically.
func Initialize(ctx context.Context, db *pgxpool.Pool) error {
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(61912342)"); err != nil {
		return err
	}
	switch err = check(ctx, tx); {
	case err == nil:
	case errors.Is(err, ErrNotInitialized):
		if _, err = tx.Exec(ctx, definition); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, "INSERT INTO gateway_schema(version) VALUES($1)", currentVersion); err != nil {
			return err
		}
	default:
		return err
	}
	return tx.Commit(ctx)
}
