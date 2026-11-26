package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"
)

// Executor binds a private open-source runtime to one enrolled account.
type Executor struct {
	Provider      string `json:"provider"`
	URL           string `json:"url"`
	Username      string `json:"username,omitempty"`
	Password      string `json:"password,omitempty"`
	ManagementKey string `json:"management_key,omitempty"`
	RuntimeKey    string `json:"runtime_key,omitempty"`
}

type provisioner struct {
	parse    func(string) (Credential, error)
	validate func(Executor) bool
	probe    func(Registry, context.Context, Adapter, Executor) error
	run      func(Registry, context.Context, Adapter, Executor, Credential, string, string) (Prepared, error)
}

var ErrNoExecutor = errors.New("no_available_account_executor")

type Prepared struct {
	Base, Token string
	Models      []Model
	Managed     bool
	Cleanup     func()
	Finish      func()
}

func (r Registry) WithExecutors(executors []Executor) (Registry, error) {
	seen := make(map[string]bool)
	r.adapters = append([]Adapter(nil), r.adapters...)
	r.executors = append([]Executor(nil), executors...)
	for i := range r.adapters {
		r.adapters[i].managed = false
	}
	for i, executor := range r.executors {
		executor.URL = NormalizeExecutorURL(executor.URL)
		r.executors[i] = executor
		if seen[executor.URL] || !validBase(executor.URL) {
			return Registry{}, ErrDisabled
		}
		seen[executor.URL] = true
		adapter, ok := r.Get(executor.Provider)
		if !ok || adapter.provisioner == nil || !adapter.provisioner.validate(executor) {
			return Registry{}, ErrDisabled
		}
		for j := range r.adapters {
			if r.adapters[j].ID == executor.Provider {
				r.adapters[j].managed = true
				break
			}
		}
	}
	return r, nil
}

func (r Registry) ProbeExecutor(ctx context.Context, e Executor) error {
	adapter, ok := r.Get(e.Provider)
	if !ok || !adapter.Configurable() || !adapter.provisioner.validate(e) || !validBase(e.URL) {
		return ErrDisabled
	}
	return adapter.provisioner.probe(r, ctx, adapter, e)
}

func (a Adapter) UsesManagedExecutor(credential Credential) bool {
	return a.managed && (a.provisioner.parse == nil || credential.ManagedImport != nil)
}

func (r Registry) Prepare(ctx context.Context, adapter Adapter, credential Credential, name, id string, reserved map[string]bool) (Prepared, error) {
	if adapter.UsesManagedExecutor(credential) {
		for _, executor := range r.executors {
			if executor.Provider != adapter.ID || reserved[executor.URL] {
				continue
			}
			slot, cancel := context.WithTimeout(ctx, 30*time.Second)
			prepared, err := adapter.provisioner.run(r, slot, adapter, executor, credential, name, id)
			cancel()
			if !errors.Is(err, ErrNoExecutor) {
				return prepared, err
			}
		}
		return Prepared{}, ErrNoExecutor
	}
	models, err := r.Discover(ctx, adapter, credential)
	return Prepared{Base: adapter.Base, Token: credential.Token, Models: models}, err
}

func executorCall(ctx context.Context, client *http.Client, base, key, method, path string, payload, output any) error {
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return ErrUpstream
		}
		body = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, base+path, body)
	if err != nil {
		return ErrUpstream
	}
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	response, err := client.Do(req)
	if err != nil {
		return ErrUpstream
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return ErrUpstream
	}
	if output != nil && json.NewDecoder(io.LimitReader(response.Body, 2<<20)).Decode(output) != nil {
		return ErrUpstream
	}
	return nil
}
