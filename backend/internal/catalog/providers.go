package catalog

import (
	"errors"
	"net/http"
	"net/url"
	"slices"
)

type Provider struct {
	ID                       string
	AllowBackup              bool
	SupportsVideoIdempotency bool

	operations    []string
	base          string
	anthropicAuth bool
}

var providers = []Provider{
	{ID: "openai", operations: []string{"responses"}, base: "https://api.openai.com", AllowBackup: true},
	{ID: "anthropic", operations: []string{"messages"}, base: "https://api.anthropic.com", AllowBackup: true, anthropicAuth: true},
	{ID: "jimeng", operations: []string{"image.generate", "video.generate"}, SupportsVideoIdempotency: true},
}

func LookupProvider(id string) (Provider, bool) {
	for _, provider := range providers {
		if provider.ID == id {
			return provider, true
		}
	}
	return Provider{}, false
}

func ProviderForOperation(operation string) (Provider, bool) {
	for _, provider := range providers {
		if slices.Contains(provider.operations, operation) {
			return provider, true
		}
	}
	return Provider{}, false
}

func (p Provider) ValidateBase(value, jimengBase string) error {
	u, err := url.Parse(value)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("invalid upstream base URL")
	}
	base := p.base
	if p.ID == "jimeng" {
		base = jimengBase
	}
	if value == base && (u.Scheme == "http" || u.Scheme == "https") {
		return nil
	}
	return errors.New("upstream base URL is outside the deployment allowlist")
}

// SetAuth applies the upstream credential and any provider-specific protocol headers.
func (p Provider) SetAuth(headers http.Header, token string, clientHeaders http.Header) {
	if !p.anthropicAuth {
		headers.Set("Authorization", "Bearer "+token)
		return
	}
	headers.Set("x-api-key", token)
	version := clientHeaders.Get("anthropic-version")
	if version == "" {
		version = "2023-06-01"
	}
	headers.Set("anthropic-version", version)
	for _, beta := range clientHeaders.Values("anthropic-beta") {
		headers.Add("anthropic-beta", beta)
	}
}
