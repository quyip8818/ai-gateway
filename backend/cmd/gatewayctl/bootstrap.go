package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"unicode"

	"ai-gateway/internal/access"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

const maxBootstrapPasswordBytes = 72

func bootstrap(ctx context.Context, db *pgxpool.Pool, username string, input io.Reader) error {
	username = access.NormalizeUsername(username)
	// Reserve room for a line ending and one byte to detect oversized input.
	password, err := io.ReadAll(io.LimitReader(input, maxBootstrapPasswordBytes+3))
	if err != nil {
		return err
	}
	password = bytes.TrimSuffix(bytes.TrimSuffix(password, []byte("\n")), []byte("\r"))
	if username == "" || strings.ContainsFunc(username, unicode.IsSpace) || len(password) < 12 || len(password) > maxBootstrapPasswordBytes || bytes.ContainsAny(password, "\r\n\x00") {
		return errors.New("username without whitespace and single-line password (12–72 bytes) required")
	}
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(61912343)"); err != nil {
		return err
	}
	var exists bool
	var hash []byte
	err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users), (
 SELECT u.password_hash FROM users u
 WHERE u.username=$1 AND u.enabled AND EXISTS (
  SELECT 1 FROM project_principals p WHERE p.user_id=u.id AND p.role='admin' AND p.enabled
 )
)`, username).Scan(&exists, &hash)
	if err != nil {
		return err
	}
	if exists {
		if bcrypt.CompareHashAndPassword(hash, password) != nil {
			return errors.New("configured administrator credentials do not match this database; use its configured credentials or initialize an empty database")
		}
		return nil
	}
	hash, err = bcrypt.GenerateFromPassword(password, bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	var who access.Identity
	var user string
	if err = tx.QueryRow(ctx, "INSERT INTO users(username,password_hash) VALUES($1,$2) RETURNING id", username, hash).Scan(&user); err != nil {
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
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	fmt.Printf("Project: %s\n", who.Project)
	return nil
}
