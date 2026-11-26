package catalog

import (
	"net/http"
	"reflect"
	"testing"
)

func TestUpstreamAuth(t *testing.T) {
	client := http.Header{}
	client.Set("anthropic-version", "custom-version")
	client.Add("anthropic-beta", "one")
	client.Add("anthropic-beta", "two")

	for _, tt := range []struct {
		name, provider string
		input          http.Header
		want           http.Header
	}{
		{"openai", "openai", client, http.Header{"Authorization": {"Bearer test-token"}}},
		{"jimeng", "jimeng", nil, http.Header{"Authorization": {"Bearer test-token"}}},
		{"anthropic probe", "anthropic", nil, http.Header{"X-Api-Key": {"test-token"}, "Anthropic-Version": {"2023-06-01"}}},
		{"anthropic request", "anthropic", client, http.Header{"X-Api-Key": {"test-token"}, "Anthropic-Version": {"custom-version"}, "Anthropic-Beta": {"one", "two"}}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			headers := http.Header{}
			provider, ok := LookupProvider(tt.provider)
			if !ok {
				t.Fatalf("unknown provider %q", tt.provider)
			}
			provider.SetAuth(headers, "test-token", tt.input)
			if !reflect.DeepEqual(headers, tt.want) {
				t.Fatalf("headers = %v, want %v", headers, tt.want)
			}
		})
	}
}

func TestProviderBasePreservesAllowlist(t *testing.T) {
	const jimengBase = "http://jimeng:8000"
	for _, tt := range []struct {
		provider, base string
		allowed        bool
	}{
		{"openai", "https://api.openai.com", true},
		{"openai", "https://api.openai.com/", false},
		{"openai", jimengBase, false},
		{"anthropic", "https://api.anthropic.com", true},
		{"anthropic", "http://api.anthropic.com", false},
		{"jimeng", jimengBase, true},
		{"jimeng", jimengBase + "/v1", false},
		{"jimeng", jimengBase + "?probe=1", false},
		{"unknown", jimengBase, false},
	} {
		t.Run(tt.provider+"/"+tt.base, func(t *testing.T) {
			provider, ok := LookupProvider(tt.provider)
			allowed := ok && provider.ValidateBase(tt.base, jimengBase) == nil
			if allowed != tt.allowed {
				t.Errorf("allowed = %t, want %t", allowed, tt.allowed)
			}
		})
	}
}
