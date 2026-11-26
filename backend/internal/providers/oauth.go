package providers

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// OAuthClient belongs to the registered gateway integration, never to the caller.
type OAuthClient struct {
	AuthorizeURL string `json:"authorize_url,omitempty"`
	TokenURL     string `json:"token_url"`
	ClientID     string `json:"client_id"`
	ClientSecret string `json:"client_secret,omitempty"`
	Resource     string `json:"resource,omitempty"`
	Scope        string `json:"scope,omitempty"`
}

func trustedOAuthURL(raw string) (*url.URL, bool) {
	target, err := url.Parse(raw)
	if err != nil || target.Scheme != "https" || target.Host == "" || target.User != nil || target.RawQuery != "" || target.Fragment != "" {
		return nil, false
	}
	return target, true
}

func (c OAuthClient) Configured() bool {
	_, ok := trustedOAuthURL(c.TokenURL)
	return ok && c.ClientID != ""
}

func (c OAuthClient) CanAuthorize() bool {
	_, ok := trustedOAuthURL(c.AuthorizeURL)
	return ok && c.Configured()
}

func (a Adapter) CanAuthorize() bool {
	return a.SupportsOAuth() && validBase(a.Base) && a.OAuth.CanAuthorize()
}

func (a Adapter) SupportsOAuth() bool {
	return a.oauth != nil && a.oauth(a)
}

func (c OAuthClient) AuthorizationURL(redirect, state, challenge string) (string, error) {
	target, ok := trustedOAuthURL(c.AuthorizeURL)
	if !ok || !c.Configured() {
		return "", ErrDisabled
	}
	query := url.Values{
		"response_type": {"code"}, "client_id": {c.ClientID}, "redirect_uri": {redirect},
		"state": {state}, "code_challenge": {challenge}, "code_challenge_method": {"S256"},
	}
	if c.Scope != "" {
		query.Set("scope", c.Scope)
	}
	if c.Resource != "" {
		query.Set("resource", c.Resource)
	}
	target.RawQuery = query.Encode()
	return target.String(), nil
}

func (r Registry) WithOAuthClients(clients map[string]OAuthClient) Registry {
	r.adapters = r.All()
	for i := range r.adapters {
		if !r.adapters[i].SupportsOAuth() {
			continue
		}
		if client, ok := clients[r.adapters[i].ID]; ok {
			r.adapters[i].OAuth = client
		}
	}
	return r
}

func (r Registry) Exchange(ctx context.Context, adapter Adapter, code, redirect, verifier string) (Credential, error) {
	if !adapter.OAuth.CanAuthorize() {
		return Credential{}, ErrDisabled
	}
	return r.requestToken(ctx, adapter.OAuth, url.Values{
		"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {redirect}, "code_verifier": {verifier},
	}, Credential{Personal: true})
}

func (r Registry) Refresh(ctx context.Context, adapter Adapter, credential Credential) (Credential, error) {
	if credential.RefreshToken == "" {
		return Credential{}, ErrDisabled
	}
	return r.requestToken(ctx, adapter.OAuth, url.Values{
		"grant_type": {"refresh_token"}, "refresh_token": {credential.RefreshToken},
	}, credential)
}

func (r Registry) requestToken(ctx context.Context, client OAuthClient, form url.Values, credential Credential) (Credential, error) {
	if !client.Configured() {
		return Credential{}, ErrDisabled
	}
	if client.ClientSecret == "" {
		form.Set("client_id", client.ClientID)
	}
	if client.Resource != "" {
		form.Set("resource", client.Resource)
	}
	req, err := http.NewRequestWithContext(ctx, "POST", client.TokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return Credential{}, ErrDisabled
	}
	if client.ClientSecret != "" {
		req.SetBasicAuth(url.QueryEscape(client.ClientID), url.QueryEscape(client.ClientSecret))
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	response, err := r.client.Do(req)
	if err != nil {
		return Credential{}, ErrUpstream
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return Credential{}, ErrUpstream
	}
	var result struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		TokenType    string `json:"token_type"`
		ExpiresIn    int64  `json:"expires_in"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&result) != nil ||
		!validToken(result.AccessToken) || !strings.EqualFold(result.TokenType, "Bearer") ||
		result.ExpiresIn < 30 || result.ExpiresIn > 31*24*60*60 {
		return Credential{}, ErrUpstream
	}
	next := time.Now().Add(time.Duration(result.ExpiresIn) * time.Second)
	credential.Token = result.AccessToken
	credential.ExpiresAt = &next
	if result.RefreshToken != "" {
		if !validToken(result.RefreshToken) {
			return Credential{}, ErrUpstream
		}
		credential.RefreshToken = result.RefreshToken
	}
	return credential, nil
}
