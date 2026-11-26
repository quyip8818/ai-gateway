package accounts

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"ai-gateway/internal/platform"
	"ai-gateway/internal/providers"
	"github.com/jackc/pgx/v5"
)

const executorLock = "SELECT pg_advisory_xact_lock(61912343)"

var ErrSettingsInUse = errors.New("provider_settings_in_use")
var ErrExecutorMissing = errors.New("executor_not_found")

type ExecutorStatus struct {
	ID       string `json:"id,omitempty"`
	URL      string `json:"url"`
	Occupied bool   `json:"occupied"`
}

type Setup struct {
	Base      string           `json:"base_url,omitempty"`
	OAuth     bool             `json:"oauth_configured"`
	Executors []ExecutorStatus `json:"executors"`
	Callback  string           `json:"callback_url,omitempty"`
}

type queryer interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

func (s Service) Registry(ctx context.Context) (providers.Registry, error) {
	return s.registry(ctx, s.DB)
}

// LockedRegistry serializes a new authorization with executor configuration changes.
func (s Service) LockedRegistry(ctx context.Context, tx pgx.Tx) (providers.Registry, error) {
	if _, err := tx.Exec(ctx, executorLock); err != nil {
		return providers.Registry{}, err
	}
	return s.registry(ctx, tx)
}

func (s Service) registry(ctx context.Context, db queryer) (providers.Registry, error) {
	r := s.Providers
	rows, err := db.Query(ctx, "SELECT provider,settings FROM provider_settings")
	if err != nil {
		return r, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var sealed []byte
		var options providers.Settings
		if err = rows.Scan(&id, &sealed); err == nil {
			err = s.openSettings("provider/"+id, sealed, &options)
		}
		if err != nil {
			return r, err
		}
		r, err = r.WithSettings(id, options)
		if err != nil {
			return r, err
		}
	}
	if err = rows.Err(); err != nil {
		return r, err
	}
	rows, err = db.Query(ctx, "SELECT id,settings FROM provider_executors ORDER BY id")
	if err != nil {
		return r, err
	}
	defer rows.Close()
	executors := r.Executors()
	byURL := make(map[string]int, len(executors))
	for i, executor := range executors {
		byURL[executor.URL] = i
	}
	for rows.Next() {
		var id string
		var sealed []byte
		var executor providers.Executor
		if err = rows.Scan(&id, &sealed); err == nil {
			err = s.openSettings("executor/"+id, sealed, &executor)
		}
		if err != nil {
			return r, err
		}
		if i, exists := byURL[executor.URL]; exists {
			executors[i] = executor
		} else {
			executors = append(executors, executor)
		}
	}
	if err = rows.Err(); err != nil {
		return r, err
	}
	return r.WithExecutors(executors)
}

func (s Service) FreeExecutors(ctx context.Context, r providers.Registry) (map[string]int, error) {
	used, err := occupiedExecutors(ctx, s.DB)
	if err != nil {
		return nil, err
	}
	free := map[string]int{}
	for _, item := range r.Executors() {
		if !used[item.URL] {
			free[item.Provider]++
		}
	}
	return free, nil
}

func (s Service) Setup(ctx context.Context, provider string) (Setup, error) {
	r, err := s.Registry(ctx)
	if err != nil {
		return Setup{}, err
	}
	adapter, _ := r.Get(provider)
	result := Setup{Base: adapter.Base, OAuth: adapter.CanAuthorize(), Executors: []ExecutorStatus{}}
	rows, err := s.DB.Query(ctx, "SELECT id,base_url FROM provider_executors WHERE provider=$1", provider)
	if err != nil {
		return result, err
	}
	ids, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (ExecutorStatus, error) {
		var entry ExecutorStatus
		err := row.Scan(&entry.ID, &entry.URL)
		return entry, err
	})
	if err != nil {
		return result, err
	}
	byURL := map[string]string{}
	for _, entry := range ids {
		byURL[entry.URL] = entry.ID
	}
	used, err := occupiedExecutors(ctx, s.DB)
	if err != nil {
		return result, err
	}
	for _, item := range r.Executors() {
		if item.Provider == provider {
			result.Executors = append(result.Executors, ExecutorStatus{ID: byURL[item.URL], URL: item.URL, Occupied: used[item.URL]})
		}
	}
	return result, nil
}

func (s Service) AddExecutor(ctx context.Context, executor providers.Executor) error {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	executor.URL = providers.NormalizeExecutorURL(executor.URL)
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, executorLock); err != nil {
		return err
	}
	r, err := s.registry(ctx, tx)
	if err != nil {
		return err
	}
	for _, current := range r.Executors() {
		if current.URL == executor.URL {
			return ErrDuplicate
		}
	}
	if err = r.ProbeExecutor(ctx, executor); err != nil {
		return err
	}
	id := platform.ID()
	sealed, err := s.sealSettings("executor/"+id, executor)
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "INSERT INTO provider_executors(id,provider,base_url,settings) VALUES($1,$2,$3,$4)", id, executor.Provider, executor.URL, sealed); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s Service) RemoveExecutor(ctx context.Context, provider, id string) error {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, executorLock); err != nil {
		return err
	}
	var base string
	err = tx.QueryRow(ctx, "SELECT base_url FROM provider_executors WHERE id::text=$1 AND provider=$2", id, provider).Scan(&base)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrExecutorMissing
	}
	if err != nil {
		return err
	}
	used, err := occupiedExecutors(ctx, tx)
	if err != nil {
		return err
	}
	if used[base] {
		return ErrSettingsInUse
	}
	if _, err = tx.Exec(ctx, "DELETE FROM provider_executors WHERE id=$1", id); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

type ProviderUpdate struct {
	Base       string                 `json:"base_url"`
	OAuth      *providers.OAuthClient `json:"oauth"`
	ClearOAuth bool                   `json:"clear_oauth"`
}

func (s Service) SetProvider(ctx context.Context, id string, update ProviderUpdate) error {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	registry, err := s.LockedRegistry(ctx, tx)
	if err != nil {
		return err
	}
	current, ok := registry.Get(id)
	if !ok || (update.OAuth != nil && update.ClearOAuth) {
		return providers.ErrDisabled
	}
	options := providers.Settings{Base: strings.TrimRight(strings.TrimSpace(update.Base), "/"), OAuth: current.OAuth}
	if update.OAuth != nil {
		if !update.OAuth.CanAuthorize() {
			return providers.ErrDisabled
		}
		options.OAuth = *update.OAuth
	}
	if update.ClearOAuth {
		options.OAuth = providers.OAuthClient{}
	}
	updated, err := registry.WithSettings(id, options)
	if err != nil {
		return err
	}
	if options.Base == current.Base && options.OAuth == current.OAuth {
		return nil
	}
	var active bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM upstream_accounts a JOIN account_pools p ON p.id=a.pool_id
 WHERE NOT a.managed AND p.provider=$1 AND ($2 OR a.refresh_secret IS NOT NULL))
 OR EXISTS(SELECT 1 FROM account_authorizations WHERE provider=$1 AND phase IN ('waiting','verifying') AND expires_at>now())`,
		id, options.Base != current.Base).Scan(&active); err != nil {
		return err
	}
	if active {
		return ErrSettingsInUse
	}
	adapter, _ := updated.Get(id)
	if err = updated.ProbeBase(ctx, adapter); err != nil {
		return err
	}
	sealed, err := s.sealSettings("provider/"+id, options)
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO provider_settings(provider,settings) VALUES($1,$2)
 ON CONFLICT(provider) DO UPDATE SET settings=EXCLUDED.settings`, id, sealed); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s Service) sealSettings(id string, value any) ([]byte, error) {
	bytes, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return platform.Seal(s.Key, id, string(bytes))
}

func (s Service) openSettings(id string, value []byte, dest any) error {
	clear, err := platform.Open(s.Key, value, id)
	if err != nil {
		return err
	}
	return json.Unmarshal([]byte(clear), dest)
}
