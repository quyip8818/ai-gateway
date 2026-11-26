package access

import (
	"context"
	"crypto/subtle"
	"errors"
	"net/http"
	"strings"

	"ai-gateway/internal/platform"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Store struct {
	DB     *pgxpool.Pool
	Key    []byte
	Secure bool
}
type Identity struct{ Tenant, Project, Principal, KeyID, Role string }

var ErrUnauthorized = errors.New("unauthorized")
var ErrForbidden = errors.New("forbidden")
var Scopes = []string{"coding:invoke", "models:read", "media:submit", "media:read"}

func (s Store) API(r *http.Request, scope string) (Identity, error) {
	var who Identity
	bearer := r.Header.Get("Authorization")
	raw := strings.TrimPrefix(bearer, "Bearer ")
	if bearer != "" && raw == bearer {
		return who, ErrUnauthorized
	}
	if strings.HasPrefix(r.URL.Path, "/anthropic/") {
		if k := r.Header.Get("x-api-key"); k != "" {
			if raw != "" && raw != k {
				return who, ErrUnauthorized
			}
			raw = k
		}
	}
	parts := strings.Split(raw, ".")
	if len(parts) != 2 || !strings.HasPrefix(parts[0], "ag_") {
		return who, ErrUnauthorized
	}
	var digest []byte
	var scopes []string
	err := s.DB.QueryRow(r.Context(), `SELECT p.tenant_id,p.project_id,p.id,k.id,p.role,k.digest,k.scopes
 FROM api_keys k JOIN project_principals p ON p.id=k.principal_id JOIN projects j ON j.id=p.project_id
 JOIN tenants t ON t.id=j.tenant_id LEFT JOIN users u ON u.id=p.user_id
 WHERE k.prefix=$1 AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>now())
 AND p.enabled AND j.enabled AND t.enabled AND (p.user_id IS NULL OR u.enabled)`, parts[0]).
		Scan(&who.Tenant, &who.Project, &who.Principal, &who.KeyID, &who.Role, &digest, &scopes)
	if errors.Is(err, pgx.ErrNoRows) {
		return who, ErrUnauthorized
	}
	if err != nil {
		return who, err
	}
	if subtle.ConstantTimeCompare(digest, platform.Digest(s.Key, raw)) != 1 {
		return Identity{}, ErrUnauthorized
	}
	for _, allowed := range scopes {
		if allowed == scope {
			return who, nil
		}
	}
	return who, ErrForbidden
}

func (s Store) User(r *http.Request) (string, error) {
	c, err := r.Cookie("gateway_session")
	if err != nil {
		return "", ErrUnauthorized
	}
	var id string
	err = s.DB.QueryRow(r.Context(), "SELECT u.id FROM web_sessions s JOIN users u ON u.id=s.user_id WHERE s.digest=$1 AND s.expires_at>now() AND u.enabled", platform.Digest(s.Key, c.Value)).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrUnauthorized
	}
	return id, err
}

func (s Store) Project(r *http.Request, project string) (Identity, error) {
	user, err := s.User(r)
	var who Identity
	if err != nil {
		return who, err
	}
	err = s.DB.QueryRow(r.Context(), `SELECT p.tenant_id,p.project_id,p.id,p.role FROM project_principals p
 JOIN projects j ON j.id=p.project_id JOIN tenants t ON t.id=j.tenant_id
 WHERE p.user_id=$1 AND p.project_id=$2 AND p.enabled AND j.enabled AND t.enabled`, user, project).Scan(&who.Tenant, &who.Project, &who.Principal, &who.Role)
	if errors.Is(err, pgx.ErrNoRows) {
		return who, ErrForbidden
	}
	return who, err
}

type Querier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func keyMaterial() (string, string) {
	prefix := "ag_" + platform.Random()[:16]
	return prefix, prefix + "." + platform.Random()
}

func (s Store) Rotate(ctx context.Context, q Querier, who Identity, id string) (string, error) {
	prefix, raw := keyMaterial()
	err := q.QueryRow(ctx, `UPDATE api_keys SET prefix=$4,digest=$5
 WHERE id::text=$1 AND project_id=$2 AND principal_id=$3 AND revoked_at IS NULL RETURNING id`,
		id, who.Project, who.Principal, prefix, platform.Digest(s.Key, raw)).Scan(&id)
	return raw, err
}

func (s Store) Issue(ctx context.Context, q Querier, who Identity, label string) (id, stringKey string, err error) {
	prefix, raw := keyMaterial()
	err = q.QueryRow(ctx, `INSERT INTO api_keys(tenant_id,project_id,principal_id,label,prefix,digest,scopes)
 VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`, who.Tenant, who.Project, who.Principal, label, prefix, platform.Digest(s.Key, raw), Scopes).Scan(&id)
	return id, raw, err
}

func HTTPStatus(err error) int {
	switch {
	case errors.Is(err, ErrUnauthorized):
		return 401
	case errors.Is(err, ErrForbidden):
		return 403
	default:
		return 503
	}
}
