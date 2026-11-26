package providers

import (
	"context"
	"errors"
	"net/url"
	"strings"
)

type Settings struct {
	Base  string      `json:"base_url"`
	OAuth OAuthClient `json:"oauth"`
}

func (r Registry) WithSettings(id string, input Settings) (Registry, error) {
	input.Base = strings.TrimRight(strings.TrimSpace(input.Base), "/")
	if input.Base == "" || !validBase(input.Base) {
		return r, ErrDisabled
	}
	r.adapters = r.All()
	for i, adapter := range r.adapters {
		if adapter.ID != id || !adapter.Configurable() {
			continue
		}
		adapter.Base = input.Base
		adapter.OAuth = input.OAuth
		if input.OAuth != (OAuthClient{}) && (!adapter.SupportsOAuth() || !input.OAuth.Configured()) {
			return r, ErrDisabled
		}
		r.adapters[i] = adapter
		return r, nil
	}
	return r, ErrDisabled
}

func (r Registry) Executors() []Executor {
	return append([]Executor(nil), r.executors...)
}

func (r Registry) MatchesSettings(adapter Adapter) bool {
	current, ok := r.Get(adapter.ID)
	return ok && current.Base == adapter.Base && current.OAuth == adapter.OAuth
}

// NormalizeExecutorURL canonicalizes the executor base while keeping any path prefix.
func NormalizeExecutorURL(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || !validBase(u.String()) {
		return ""
	}
	u.Host = strings.ToLower(u.Host)
	if (u.Scheme == "http" && u.Port() == "80") || (u.Scheme == "https" && u.Port() == "443") {
		u.Host = strings.TrimSuffix(u.Host, ":"+u.Port())
	}
	return strings.TrimRight(u.String(), "/")
}

// ProbeBase checks a compatible model directory without sending an account secret.
func (r Registry) ProbeBase(ctx context.Context, adapter Adapter) error {
	_, err := r.modelDirectory(ctx, adapter, "")
	if errors.Is(err, ErrCredential) {
		return nil
	}
	return err
}
