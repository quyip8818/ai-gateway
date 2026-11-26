package integration

import (
	"context"
	"errors"
	"os"
	"testing"

	"ai-gateway/internal/platform"
	"ai-gateway/internal/schema"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestSchemaVersionBoundary(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set TEST_DATABASE_URL to a dedicated test database")
	}
	ctx := context.Background()
	root, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	name := "schema_test_" + platform.ID()
	identifier := pgx.Identifier{name}.Sanitize()
	if _, err = root.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		db, err := pgxpool.New(ctx, dsn)
		if err != nil {
			t.Error(err)
			return
		}
		defer db.Close()
		if _, err = db.Exec(ctx, "DROP SCHEMA "+identifier+" CASCADE"); err != nil {
			t.Error(err)
		}
	})
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = identifier
	db, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	if err = schema.Check(ctx, db); !errors.Is(err, schema.ErrNotInitialized) {
		t.Fatalf("empty schema check: %v", err)
	}
	if _, err = db.Exec(ctx, "CREATE TABLE users (id integer PRIMARY KEY); INSERT INTO users VALUES(42)"); err != nil {
		t.Fatal(err)
	}
	if err = schema.Initialize(ctx, db); !errors.Is(err, schema.ErrIncompatible) {
		t.Fatalf("unversioned schema initialization: %v", err)
	}
	var existing int
	if err = db.QueryRow(ctx, "SELECT id FROM users").Scan(&existing); err != nil || existing != 42 {
		t.Fatalf("old data changed: %v", err)
	}
	if _, err = db.Exec(ctx, "DROP TABLE users"); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err = schema.Initialize(ctx, db); err != nil {
			t.Fatal(err)
		}
	}
	if err = schema.Check(ctx, db); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(ctx, "UPDATE gateway_schema SET version=999"); err != nil {
		t.Fatal(err)
	}
	if err = schema.Initialize(ctx, db); !errors.Is(err, schema.ErrIncompatible) {
		t.Fatalf("future schema initialization: %v", err)
	}
}
