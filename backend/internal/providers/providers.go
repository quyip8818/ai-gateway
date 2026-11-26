// Package providers validates credentials against deployment-owned execution endpoints.
package providers

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"

	"ai-gateway/internal/protocol"
)

var (
	ErrCredential = errors.New("invalid_account_credential")
	ErrDisabled   = errors.New("provider_unconfigured")
	ErrUpstream   = errors.New("account_validation_unavailable")
	modelID       = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$`)
)

type Adapter struct {
	ID, Label, Format, CredentialLabel string
	Base                               string
	Protocol                           protocol.Kind
	CountTokens                        bool
	OAuth                              OAuthClient

	parse       func(Adapter, string) (Credential, error)
	model       func(directoryModel) (string, json.RawMessage)
	oauth       func(Adapter) bool
	provisioner *provisioner
	managed     bool
}

type directoryModel struct {
	ID           string          `json:"id"`
	Owner        string          `json:"owned_by"`
	Capabilities json.RawMessage `json:"capabilities"`
}

type Model struct {
	ID, Operation string
	Capabilities  json.RawMessage
}

type Credential struct {
	Token         string
	RefreshToken  string
	ExpiresAt     *time.Time
	Personal      bool
	ManagedImport json.RawMessage `json:"-"`
}

type Registry struct {
	adapters  []Adapter
	client    *http.Client
	executors []Executor
}

type Config struct {
	Codex, Kiro, Jimeng, Claude string
}

func New(config Config) Registry {
	if config.Codex == "" {
		config.Codex = openAIPlatform
	}
	if config.Claude == "" {
		config.Claude = "https://api.anthropic.com"
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	return Registry{
		adapters: builtins(config),
		client: &http.Client{Transport: transport, Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		}},
	}
}

func (r Registry) All() []Adapter { return slices.Clone(r.adapters) }

func (r Registry) Get(id string) (Adapter, bool) {
	for _, adapter := range r.adapters {
		if adapter.ID == id {
			return adapter, true
		}
	}
	return Adapter{}, false
}

func (a Adapter) Configured() bool {
	return a.managed || validBase(a.Base)
}

func validBase(base string) bool {
	u, err := url.Parse(base)
	return err == nil && u.Host != "" && u.User == nil && u.RawQuery == "" && u.Fragment == "" &&
		(u.Scheme == "https" || u.Scheme == "http")
}

func (a Adapter) Parse(raw string) (Credential, error) {
	if a.parse == nil {
		return Credential{}, ErrDisabled
	}
	if a.managed && a.provisioner.parse != nil {
		credential, err := a.provisioner.parse(raw)
		if err != nil || credential.ManagedImport != nil {
			return credential, err
		}
	}
	credential, err := a.parse(a, raw)
	if err != nil {
		return Credential{}, err
	}
	if !validToken(credential.Token) || (credential.RefreshToken != "" && !validToken(credential.RefreshToken)) {
		return Credential{}, ErrCredential
	}
	if !a.OAuth.Configured() || credential.ExpiresAt == nil || !credential.Personal {
		credential.RefreshToken = ""
	}
	return credential, nil
}

func validToken(token string) bool {
	return token != "" && len(token) <= 16384 && strings.IndexFunc(token, func(r rune) bool {
		return r < '!' || r > '~' || r == ',' || r == ';'
	}) < 0
}

func (r Registry) Discover(ctx context.Context, a Adapter, credential Credential) ([]Model, error) {
	if !validBase(a.Base) || r.client == nil {
		return nil, ErrDisabled
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.Base+"/v1/models", nil)
	if err != nil {
		return nil, ErrDisabled
	}
	a.Protocol.Authorize(req.Header, credential.Token, nil)
	response, err := r.client.Do(req)
	if err != nil {
		return nil, ErrUpstream
	}
	defer response.Body.Close()
	if response.StatusCode == 401 || response.StatusCode == 403 {
		return nil, ErrCredential
	}
	if response.StatusCode != 200 {
		return nil, ErrUpstream
	}
	var result struct {
		Data []directoryModel `json:"data"`
	}
	if err = json.NewDecoder(io.LimitReader(response.Body, 2<<20)).Decode(&result); err != nil {
		return nil, ErrUpstream
	}
	models := []Model{}
	seen := map[string]bool{}
	for _, item := range result.Data {
		if !modelID.MatchString(item.ID) {
			continue
		}
		operation, capabilities := a.Protocol.DefaultOperation(), item.Capabilities
		if a.model != nil {
			operation, capabilities = a.model(item)
		}
		match := operation + ":" + item.ID
		if operation == "" || seen[match] {
			continue
		}
		seen[match] = true
		if len(capabilities) == 0 || string(capabilities) == "null" {
			capabilities = json.RawMessage(`{}`)
		}
		models = append(models, Model{item.ID, operation, capabilities})
	}
	if len(models) == 0 {
		return nil, ErrUpstream
	}
	return models, nil
}
