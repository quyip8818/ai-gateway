package schema

import (
	"context"
	_ "embed"
	"errors"

	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed schema.sql
var definition string

// Initialize creates the schema atomically and can run on every startup.
func Initialize(ctx context.Context, db *pgxpool.Pool) error {
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(61912342)"); err != nil {
		return err
	}
	var exists, initialized bool
	err = tx.QueryRow(ctx, `SELECT to_regclass('users') IS NOT NULL, EXISTS (
		SELECT 1 FROM pg_attribute
		WHERE attrelid=to_regclass('users') AND attname='username' AND NOT attisdropped
	)`).Scan(&exists, &initialized)
	if err != nil {
		return err
	}
	if exists && !initialized {
		return errors.New("existing database has an obsolete schema; reset it or use a fresh database")
	}
	if !initialized {
		if _, err = tx.Exec(ctx, definition); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
