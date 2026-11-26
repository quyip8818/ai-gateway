package catalog

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"

	"ai-gateway/internal/platform"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Store struct {
	DB  *pgxpool.Pool
	Key []byte
}
type Route struct {
	ID, Connection, Base, Token, Model, Upstream, Operation, Provider, Quota string
	Capabilities                                                             json.RawMessage
}

const fields = `r.id,c.id,c.base_url,c.token,r.model,r.upstream_model,r.operation,c.provider,c.quota_scope,r.capabilities`

func (s Store) Get(ctx context.Context, project, operation, model, route string, existing bool) (Route, error) {
	var r Route
	var secret []byte
	err := s.DB.QueryRow(ctx, `SELECT `+fields+` FROM model_routes r JOIN connections c ON c.id=r.connection_id
 WHERE r.project_id=$1 AND
 (($4='' AND r.operation=$2 AND r.model=$3 AND r.active AND c.enabled) OR
  ($4<>'' AND r.id::text=$4 AND ($5 OR (c.enabled AND EXISTS(SELECT 1 FROM model_routes active WHERE active.project_id=r.project_id AND active.operation=r.operation AND active.model=r.model AND active.active)))))`, project, operation, model, route, existing).
		Scan(&r.ID, &r.Connection, &r.Base, &secret, &r.Model, &r.Upstream, &r.Operation, &r.Provider, &r.Quota, &r.Capabilities)
	if err != nil {
		return r, err
	}
	r.Token, err = platform.Open(s.Key, secret, r.Connection)
	return r, err
}

type Model struct {
	ID           string          `json:"id"`
	Operation    string          `json:"operation"`
	Capabilities json.RawMessage `json:"capabilities"`
}

func (s Store) Models(ctx context.Context, project, op string) ([]Model, error) {
	rows, err := s.DB.Query(ctx, `SELECT r.model,r.operation,r.capabilities FROM model_routes r JOIN connections c ON c.id=r.connection_id WHERE r.project_id=$1 AND r.active AND c.enabled AND ($2='' OR r.operation=$2) ORDER BY r.model,r.operation`, project, op)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	models := []Model{}
	for rows.Next() {
		var m Model
		if err := rows.Scan(&m.ID, &m.Operation, &m.Capabilities); err != nil {
			return nil, err
		}
		models = append(models, m)
	}
	return models, rows.Err()
}

func ValidateBase(provider, value, jimengBase string) error {
	u, err := url.Parse(value)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("invalid upstream base URL")
	}
	switch provider {
	case "openai":
		if value == "https://api.openai.com" {
			return nil
		}
	case "anthropic":
		if value == "https://api.anthropic.com" {
			return nil
		}
	case "jimeng":
		if value == jimengBase && (u.Scheme == "http" || u.Scheme == "https") {
			return nil
		}
	}
	return errors.New("upstream base URL is outside the deployment allowlist")
}

// Backup returns the one approved equivalent target for the same route version.
func (s Store) Backup(ctx context.Context, primary Route) (Route, error) {
	backup := primary
	var secret []byte
	err := s.DB.QueryRow(ctx, `SELECT c.id,c.base_url,c.token,c.quota_scope
 FROM model_route_backups b JOIN connections c ON c.id=b.connection_id
 JOIN model_routes r ON r.id=b.route_id JOIN connections p ON p.id=r.connection_id
 WHERE b.route_id=$1 AND c.enabled AND c.provider=p.provider AND c.region=p.region AND c.quota_scope=p.quota_scope AND c.id<>p.id`,
		primary.ID).Scan(&backup.Connection, &backup.Base, &secret, &backup.Quota)
	if err != nil {
		return Route{}, err
	}
	backup.Token, err = platform.Open(s.Key, secret, backup.Connection)
	return backup, err
}
