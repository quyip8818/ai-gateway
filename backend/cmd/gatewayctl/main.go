package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"ai-gateway/internal/access"
	"ai-gateway/internal/platform"
	"ai-gateway/migrations"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

func main() {
	if len(os.Args) < 2 {
		log.Fatal("usage: gatewayctl migrate up | gatewayctl bootstrap [--if-empty]")
	}
	ctx, stop := context.WithTimeout(context.Background(), 30*time.Second)
	defer stop()
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		log.Fatal("DATABASE_URL required")
	}
	db, err := pgxpool.New(ctx, dsn)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	switch os.Args[1] {
	case "migrate":
		if len(os.Args) != 3 || os.Args[2] != "up" {
			log.Fatal("usage: gatewayctl migrate up")
		}
		if err = migrations.Apply(ctx, db); err != nil {
			log.Fatal(err)
		}
	case "bootstrap":
		ifEmpty := len(os.Args) == 3 && os.Args[2] == "--if-empty"
		if len(os.Args) != 2 && !ifEmpty {
			log.Fatal("usage: gatewayctl bootstrap [--if-empty]")
		}
		if err = bootstrap(ctx, db, ifEmpty); err != nil {
			log.Fatal(err)
		}
	default:
		log.Fatal("unknown command")
	}
}
func bootstrap(ctx context.Context, db *pgxpool.Pool, ifEmpty bool) error {
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(61912343)"); err != nil {
		return err
	}
	var exists bool
	if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM users)").Scan(&exists); err != nil {
		return err
	}
	if exists {
		if ifEmpty {
			return nil
		}
		return fmt.Errorf("bootstrap is available only before the first user is created")
	}
	email := strings.ToLower(strings.TrimSpace(os.Getenv("BOOTSTRAP_EMAIL")))
	password, err := os.ReadFile(os.Getenv("BOOTSTRAP_PASSWORD_FILE"))
	if err != nil {
		return err
	}
	plain := strings.TrimRight(string(password), "\r\n")
	if !strings.Contains(email, "@") || len(plain) < 12 || len(plain) > 72 {
		return fmt.Errorf("email and password (12–72 bytes) required")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(plain), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	key, err := platform.Secret("KEY_DIGEST_SECRET")
	if err != nil {
		return err
	}
	var who access.Identity
	var user string
	if err = tx.QueryRow(ctx, "INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id", email, hash).Scan(&user); err != nil {
		return err
	}
	if err = tx.QueryRow(ctx, "INSERT INTO tenants(name) VALUES('Team') RETURNING id").Scan(&who.Tenant); err != nil {
		return err
	}
	if err = tx.QueryRow(ctx, "INSERT INTO projects(tenant_id,name) VALUES($1,'Default') RETURNING id", who.Tenant).Scan(&who.Project); err != nil {
		return err
	}
	if err = tx.QueryRow(ctx, "INSERT INTO project_principals(tenant_id,project_id,user_id,role) VALUES($1,$2,$3,'admin') RETURNING id", who.Tenant, who.Project, user).Scan(&who.Principal); err != nil {
		return err
	}
	_, raw, err := (access.Store{Key: key}).Issue(ctx, tx, who, "Bootstrap")
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	fmt.Printf("Project: %s\nGateway Key: %s\n", who.Project, raw)
	return nil
}
