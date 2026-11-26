package console

import (
	"testing"

	"ai-gateway/internal/access"
	"ai-gateway/internal/accounts"
	"ai-gateway/internal/providers"
)

func TestAuthorizationClientBinding(t *testing.T) {
	client := providers.OAuthClient{
		AuthorizeURL: "https://issuer.example/authorize",
		TokenURL:     "https://issuer.example/token",
		ClientID:     "deployment-client",
	}
	deployment := providers.New(providers.Config{Codex: "https://models.example"}).
		WithOAuthClients(map[string]providers.OAuthClient{"codex": client})
	service := Service{
		Store:           access.Store{Key: make([]byte, 32)},
		AccountsService: accounts.Service{Providers: deployment},
	}
	deployed, _ := deployment.Get("codex")
	digest := service.authorizationClientDigest(deployed)

	client.ClientID = "different-client"
	registry, err := deployment.WithSettings("codex", providers.Settings{Base: deployed.Base, OAuth: client})
	if err != nil {
		t.Fatal(err)
	}
	configured, _ := registry.Get("codex")
	for _, tc := range []struct {
		name    string
		adapter providers.Adapter
		digest  []byte
		want    bool
	}{
		{"deployment settings with old state", deployed, nil, true},
		{"deployment settings with new state", deployed, digest, true},
		{"console override with old state", configured, nil, false},
		{"changed client with new state", configured, digest, false},
		{"console settings with new state", configured, service.authorizationClientDigest(configured), true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := service.matchesAuthorizationClient(tc.adapter, tc.digest); got != tc.want {
				t.Fatalf("matchesAuthorizationClient() = %t, want %t", got, tc.want)
			}
		})
	}
}
