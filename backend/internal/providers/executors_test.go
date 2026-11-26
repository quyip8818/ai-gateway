package providers

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"ai-gateway/internal/protocol"
)

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func response(status int, body string) (*http.Response, error) {
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body))}, nil
}

func TestManagedTextImport(t *testing.T) {
	for _, test := range []struct {
		provider, file, path, listed, upload, managedField, model, removal string
	}{
		{
			provider: "codex",
			file:     `{"tokens":{"access_token":"access-fixture","refresh_token":"refresh-fixture","id_token":"id-fixture","account_id":"account-fixture"},"proxy_url":"https://unexpected.invalid"}`,
			path:     "/v8/management/credentials", listed: `{"files":[]}`, upload: `{"status":"ok"}`,
			managedField: "access_token", model: "gpt-fixture",
			removal: "/v8/management/credentials?name=account.json",
		},
		{
			provider: "kiro",
			file:     `{"refreshToken":"refresh-fixture","provider":"builder_id","clientId":"client-fixture","clientSecret":"client-secret-fixture","proxy_url":"https://unexpected.invalid"}`,
			path:     "/api/admin/credentials", listed: `{"credentials":[]}`,
			upload:       `{"success":true,"results":[{"index":1,"status":"added","credentialId":31}]}`,
			managedField: "refreshToken", model: "claude-fixture", removal: "/api/admin/credentials/31",
		},
	} {
		t.Run(test.provider, func(t *testing.T) {
			registry, err := New(Config{}).WithExecutors([]Executor{{
				Provider: test.provider, URL: "https://executor.invalid", RuntimeKey: "runtime-fixture", ManagementKey: "management-fixture",
			}})
			if err != nil {
				t.Fatal(err)
			}
			adapter, _ := registry.Get(test.provider)
			credential, err := adapter.Parse(test.file)
			if err != nil || !credential.Personal || !adapter.UsesManagedExecutor(credential) {
				t.Fatalf("parse failed: %v", err)
			}
			var removed bool
			registry.client.Transport = roundTrip(func(r *http.Request) (*http.Response, error) {
				if r.URL.Path != "/v1/models" && r.Header.Get("Authorization") != "Bearer management-fixture" {
					t.Fatalf("missing management authentication for %s", r.URL.Path)
				}
				switch {
				case r.Method == "GET" && r.URL.Path == test.path:
					return response(200, test.listed)
				case r.Method == "POST" && strings.HasPrefix(r.URL.Path, test.path) && !strings.HasSuffix(r.URL.Path, "/models/refresh"):
					if test.provider == "codex" && r.URL.Query().Get("name") != "account.json" {
						t.Fatal("missing stable executor credential filename")
					}
					var payload map[string]json.RawMessage
					if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
						t.Fatal(err)
					}
					if test.provider == "kiro" {
						if err := json.Unmarshal(payload["data"], &payload); err != nil {
							t.Fatal(err)
						}
					}
					if payload[test.managedField] == nil || payload["proxy_url"] != nil {
						t.Fatal("credential was not allowlisted")
					}
					return response(200, test.upload)
				case r.Method == "POST" && r.URL.Path == test.removal+"/models/refresh":
					return response(200, `{"success":true,"count":1}`)
				case r.Method == "GET" && r.URL.Path == "/v1/models":
					if test.provider == "codex" && r.Header.Get("Authorization") != "Bearer runtime-fixture" ||
						test.provider == "kiro" && r.Header.Get("x-api-key") != "runtime-fixture" {
						t.Fatal("incorrect runtime credential")
					}
					return response(200, `{"data":[{"id":"`+test.model+`"}]}`)
				case r.Method == "DELETE" && r.URL.RequestURI() == test.removal:
					removed = true
					return response(204, "")
				}
				t.Fatalf("unexpected executor call %s %s", r.Method, r.URL.RequestURI())
				return nil, nil
			})
			result, err := registry.Prepare(context.Background(), adapter, credential, "test", "account", nil)
			if err != nil || !result.Managed || result.Token != "runtime-fixture" || len(result.Models) != 1 || result.Models[0].ID != test.model {
				t.Fatalf("executor provisioning failed: %v", err)
			}
			result.Cleanup()
			if !removed {
				t.Fatal("rollback did not remove provisioned credential")
			}
			_, err = registry.Prepare(context.Background(), adapter, credential, "test", "account", map[string]bool{"https://executor.invalid": true})
			if err != ErrNoExecutor {
				t.Fatalf("reserved executor reused, error = %v", err)
			}
		})
	}
}

func TestRegisteredOAuthCodeAndRefresh(t *testing.T) {
	client := OAuthClient{AuthorizeURL: "https://issuer.invalid/authorize", TokenURL: "https://issuer.invalid/token",
		ClientID: "gateway-fixture", Resource: "https://resource.invalid", Scope: "offline_access"}
	registry := New(Config{Codex: "https://resource.invalid"}).WithOAuthClients(map[string]OAuthClient{"codex": client})
	adapter, _ := registry.Get("codex")
	const callback = "https://gateway.invalid/console/v1/oauth/callback"
	target, err := client.AuthorizationURL(callback, "state-fixture", "challenge-fixture")
	if err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(target)
	if err != nil {
		t.Fatal(err)
	}
	values := u.Query()
	if values.Get("state") != "state-fixture" || values.Get("code_challenge_method") != "S256" ||
		values.Get("code_challenge") != "challenge-fixture" || values.Get("redirect_uri") != callback {
		t.Fatal("authorization did not bind state, redirect and S256 challenge")
	}
	registry.client.Transport = roundTrip(func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != client.TokenURL || r.Method != "POST" || r.ParseForm() != nil ||
			r.Form.Get("client_id") != client.ClientID || r.Form.Get("resource") != client.Resource {
			t.Fatal("invalid token endpoint request")
		}
		switch r.Form.Get("grant_type") {
		case "authorization_code":
			if r.Form.Get("code") != "code-fixture" || r.Form.Get("code_verifier") != "verifier-fixture" || r.Form.Get("redirect_uri") != callback {
				t.Fatal("missing code exchange binding")
			}
			return response(200, `{"access_token":"new-token","refresh_token":"new-refresh","token_type":"Bearer","expires_in":3600}`)
		case "refresh_token":
			if r.Form.Get("refresh_token") != "new-refresh" {
				t.Fatal("wrong refresh token")
			}
			return response(200, `{"access_token":"next-token","refresh_token":"next-refresh","token_type":"Bearer","expires_in":3600}`)
		}
		t.Fatal("invalid grant type")
		return nil, nil
	})
	first, err := registry.Exchange(context.Background(), adapter, "code-fixture", callback, "verifier-fixture")
	if err != nil || first.Token != "new-token" || !first.Personal || first.ExpiresAt == nil {
		t.Fatalf("exchange failed: %v", err)
	}
	next, err := registry.Refresh(context.Background(), adapter, first)
	if err != nil || next.Token != "next-token" || next.RefreshToken != "next-refresh" || !next.Personal {
		t.Fatalf("refresh failed: %v", err)
	}
}

func TestCompatibleMediaDirectory(t *testing.T) {
	registry, err := New(Config{}).WithCompatible([]Compatible{{
		ID: "studio", Label: "Studio", Base: "https://studio.invalid", Protocol: protocol.Media,
		MediaModels: map[string]string{"image-1": protocol.ImageGenerate, "video-1": protocol.VideoGenerate},
	}})
	if err != nil {
		t.Fatal(err)
	}
	adapter, _ := registry.Get("studio")
	registry.client.Transport = roundTrip(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path != "/v1/models" || request.Header.Get("Authorization") != "Bearer fixture-key" {
			t.Fatal("unexpected media discovery request")
		}
		return response(200, `{"data":[{"id":"image-1"},{"id":"video-1"},{"id":"unlisted"}]}`)
	})
	credential, err := adapter.Parse("fixture-key")
	if err != nil || credential.Personal {
		t.Fatalf("invalid credential result: %v", err)
	}
	models, err := registry.Discover(context.Background(), adapter, credential)
	if err != nil || len(models) != 2 || models[0].Operation != protocol.ImageGenerate ||
		string(models[0].Capabilities) != `{}` || models[1].Operation != protocol.VideoGenerate {
		t.Fatalf("unexpected registered media catalog: %v %v", models, err)
	}
}
