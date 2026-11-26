package catalog

import (
	"context"
	"encoding/json"
	"errors"

	"ai-gateway/internal/access"
	"ai-gateway/internal/platform"
	"ai-gateway/internal/protocol"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Store struct {
	DB  *pgxpool.Pool
	Key []byte
}

type Target struct {
	ModelID, AccountID, Base, Token, Upstream, PoolID string
	Protocol                                          protocol.Kind
	Capabilities                                      json.RawMessage
}

type queryRow interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

const targetFields = `m.id,a.id,a.base_url,a.execution_secret,m.upstream_model,a.protocol,a.pool_id,m.capabilities`
const modelsAndAccounts = ` FROM account_models m JOIN upstream_accounts a ON a.id=m.account_id `

func (s Store) resolve(row pgx.Row) (Target, error) {
	var target Target
	var secret []byte
	err := row.Scan(&target.ModelID, &target.AccountID, &target.Base, &secret, &target.Upstream,
		&target.Protocol, &target.PoolID, &target.Capabilities)
	if err == nil {
		target.Token, err = platform.Open(s.Key, secret, target.AccountID)
	}
	return target, err
}

// MediaTarget resolves the exact model selected when the job was created.
func (s Store) MediaTarget(ctx context.Context, project, modelID string, submitted bool) (Target, error) {
	return s.resolve(s.DB.QueryRow(ctx, `SELECT `+targetFields+modelsAndAccounts+`
 WHERE m.project_id=$1 AND m.id=$2 AND ($3 OR a.enabled) AND a.protocol=$4 AND account_credential_ready(a)`,
		project, modelID, submitted, protocol.Media))
}

func (s Store) Pick(ctx context.Context, who access.Identity, wire protocol.Kind, model string, previous Target, countTokens bool) (Target, error) {
	return s.resolve(pick(ctx, s.DB, who, wire, wire.DefaultOperation(), model, previous, countTokens))
}

var ErrUnsupportedMediaSpec = errors.New("unsupported_media_spec")

// PickMedia selects an account that can execute the input and records its use
// in the same transaction that creates the job.
func (s Store) PickMedia(ctx context.Context, tx pgx.Tx, who access.Identity, operation, model string, accepts func(json.RawMessage) bool) (string, error) {
	rows, err := tx.Query(ctx, `SELECT m.id,a.id,m.capabilities`+modelsAndAccounts+eligibleModels+`
 ORDER BY a.last_used_at NULLS FIRST,a.id FOR UPDATE OF a`,
		who.Project, operation, model, protocol.Media, false, who.KeyID, who.Principal, who.Role == "admin")
	if err != nil {
		return "", err
	}
	defer rows.Close()
	found := false
	for rows.Next() {
		found = true
		var id, accountID string
		var capabilities json.RawMessage
		if err := rows.Scan(&id, &accountID, &capabilities); err != nil {
			return "", err
		}
		if accepts(capabilities) {
			rows.Close()
			_, err := tx.Exec(ctx, "UPDATE upstream_accounts SET last_used_at=now() WHERE id=$1", accountID)
			return id, err
		}
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	if found {
		return "", ErrUnsupportedMediaSpec
	}
	return "", pgx.ErrNoRows
}

const eligibleModels = `
 WHERE m.project_id=$1 AND m.operation=$2 AND m.model=$3 AND a.enabled AND account_credential_ready(a)
 AND a.protocol=$4 AND (NOT $5 OR a.count_tokens) AND may_use_pool(a.pool_id,$6,$7,$8)`

func pick(ctx context.Context, db queryRow, who access.Identity, wire protocol.Kind, operation, model string, previous Target, countTokens bool) pgx.Row {
	return db.QueryRow(ctx, `WITH selected AS (
 SELECT m.id,m.account_id`+modelsAndAccounts+eligibleModels+`
 AND ($9='' OR (a.pool_id=nullif($9,'')::uuid AND a.id<>nullif($10,'')::uuid AND m.upstream_model=$11))
 ORDER BY a.last_used_at NULLS FIRST,a.id LIMIT 1 FOR UPDATE OF a
 ), touched AS (
 UPDATE upstream_accounts a SET last_used_at=now() FROM selected s WHERE a.id=s.account_id RETURNING s.id
 ) SELECT `+targetFields+modelsAndAccounts+` JOIN touched t ON t.id=m.id`,
		who.Project, operation, model, wire, countTokens, who.KeyID, who.Principal, who.Role == "admin",
		previous.PoolID, previous.AccountID, previous.Upstream)
}

type Model struct {
	ID           string          `json:"id"`
	Operation    string          `json:"operation"`
	Capabilities json.RawMessage `json:"capabilities"`
	Provider     string          `json:"provider"`
	ProviderName string          `json:"provider_name,omitempty"`
}

func (s Store) Models(ctx context.Context, who access.Identity, wire protocol.Kind) ([]Model, error) {
	rows, err := s.DB.Query(ctx, `SELECT DISTINCT ON (m.model,m.operation) m.model,m.operation,m.capabilities,p.provider`+modelsAndAccounts+`
 JOIN account_pools p ON p.id=a.pool_id
 WHERE m.project_id=$1 AND a.enabled AND account_credential_ready(a)
 AND ($2='' OR a.protocol=$2) AND may_use_pool(a.pool_id,$3,$4,$5)
 ORDER BY m.model,m.operation,a.verified_at DESC,m.id`, who.Project, wire, who.KeyID, who.Principal, who.Role == "admin")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	models := []Model{}
	for rows.Next() {
		var m Model
		if err := rows.Scan(&m.ID, &m.Operation, &m.Capabilities, &m.Provider); err != nil {
			return nil, err
		}
		models = append(models, m)
	}
	return models, rows.Err()
}
