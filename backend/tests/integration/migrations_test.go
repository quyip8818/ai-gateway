package integration

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"ai-gateway/internal/platform"
	"ai-gateway/migrations"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestMigrationUpgrade(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set TEST_DATABASE_URL to a dedicated test database")
	}
	ctx := context.Background()
	db, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	schema := "upgrade_" + strings.ReplaceAll(platform.ID(), "-", "")
	if _, err = db.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	defer db.Exec(ctx, "DROP SCHEMA "+schema+" CASCADE")
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	old, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer old.Close()
	if _, err = old.Exec(ctx, `CREATE TABLE gateway_schema(name text PRIMARY KEY,installed_at timestamptz DEFAULT now())`); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"00001_identity.sql", "00002_catalog.sql", "00003_execution.sql", "00004_observability.sql", "00005_console_auth.sql", "00006_connection_health.sql", "00007_recovery.sql", "00008_billing.sql"} {
		raw, err := os.ReadFile(filepath.Join("..", "..", "migrations", name))
		if err != nil {
			t.Fatal(err)
		}
		if _, err = old.Exec(ctx, string(raw)); err != nil {
			t.Fatal(err)
		}
		if _, err = old.Exec(ctx, "INSERT INTO gateway_schema(name) VALUES($1)", name); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = old.Exec(ctx, `WITH t AS (INSERT INTO tenants(name) VALUES('Existing workspace') RETURNING id),
 p AS (INSERT INTO projects(tenant_id,name) SELECT id,'Existing project' FROM t RETURNING id,tenant_id),
 c AS (INSERT INTO connections(tenant_id,project_id,provider,label,base_url,token,quota_scope)
  SELECT tenant_id,id,'jimeng','Existing connection','http://localhost:8000',decode('00','hex'),'test' FROM p RETURNING id,tenant_id,project_id)
 INSERT INTO model_routes(tenant_id,project_id,operation,model,upstream_model,connection_id,version,capabilities)
 SELECT tenant_id,project_id,'image.generate','existing-image','existing-image',id,1,'{"aspect_ratios":["1:1"]}' FROM c`); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err = migrations.Apply(ctx, old); err != nil {
			t.Fatal(err)
		}
	}
	var existing, checksums int
	var setupChecksInstalled bool
	if err = old.QueryRow(ctx, `SELECT
 (SELECT count(*) FROM model_routes WHERE model='existing-image' AND active AND capabilities='{"aspect_ratios":["1:1"]}'),
 (SELECT count(*) FROM gateway_schema WHERE octet_length(checksum)=32),
 to_regclass('setup_checks') IS NOT NULL`).Scan(&existing, &checksums, &setupChecksInstalled); err != nil || existing != 1 || checksums < 9 || !setupChecksInstalled {
		t.Fatalf("lost existing data or migration history: %d/%d (%v)", existing, checksums, err)
	}
	if _, err = old.Exec(ctx, `UPDATE gateway_schema SET checksum=decode('00','hex') WHERE name='00001_identity.sql'`); err != nil {
		t.Fatal(err)
	}
	if err = migrations.Apply(ctx, old); err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("drift was accepted: %v", err)
	}
}
