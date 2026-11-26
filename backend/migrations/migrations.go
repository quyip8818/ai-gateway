package migrations

import (
	"bytes"
	"context"
	"crypto/sha256"
	"embed"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed *.sql
var files embed.FS

func Apply(ctx context.Context, database *pgxpool.Pool) error {
	tx, err := database.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(61912342); CREATE TABLE IF NOT EXISTS gateway_schema (name text PRIMARY KEY, installed_at timestamptz DEFAULT now()); ALTER TABLE gateway_schema ADD COLUMN IF NOT EXISTS checksum bytea;"); err != nil {
		return err
	}
	entries, err := files.ReadDir(".")
	if err != nil {
		return err
	}
	for _, entry := range entries {
		name := entry.Name()
		sql, err := files.ReadFile(name)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(sql)
		var previous []byte
		var installed bool
		if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM gateway_schema WHERE name=$1),(SELECT checksum FROM gateway_schema WHERE name=$1)", name).Scan(&installed, &previous); err != nil {
			return err
		}
		if installed {
			if previous == nil {
				if _, err := tx.Exec(ctx, "UPDATE gateway_schema SET checksum=$2 WHERE name=$1", name, sum[:]); err != nil {
					return err
				}
			} else if !bytes.Equal(previous, sum[:]) {
				return fmt.Errorf("migration %s checksum does not match installed version", name)
			}
			continue
		}
		if _, err := tx.Exec(ctx, string(sql)); err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		if _, err := tx.Exec(ctx, "INSERT INTO gateway_schema(name,checksum) VALUES($1,$2)", name, sum[:]); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
