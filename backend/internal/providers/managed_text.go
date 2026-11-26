package providers

import (
	"context"
	"encoding/json"
	"net/url"
	"regexp"
	"strconv"
	"time"
)

var awsRegion = regexp.MustCompile(`^[a-z]{2}(-[a-z0-9]+){1,4}-[0-9]{1,2}$`)

// Translate the supported credential fields explicitly. Executor-specific
// request headers, URLs and policy settings always come from deployment config.
func parseManagedCodex(raw string) (Credential, error) {
	var file struct {
		LastRefresh string `json:"last_refresh"`
		Tokens      struct {
			Access  string `json:"access_token"`
			Refresh string `json:"refresh_token"`
			IDToken string `json:"id_token"`
			Account string `json:"account_id"`
		} `json:"tokens"`
	}
	if json.Unmarshal([]byte(raw), &file) != nil {
		return Credential{}, ErrCredential
	}
	tokens := file.Tokens
	if tokens.Access == "" {
		return Credential{}, nil
	}
	if !validToken(tokens.Access) || !validToken(tokens.Refresh) ||
		!validToken(tokens.IDToken) || !validToken(tokens.Account) {
		return Credential{}, ErrCredential
	}
	upload, _ := json.Marshal(map[string]string{
		"type": "codex", "access_token": tokens.Access, "refresh_token": tokens.Refresh,
		"id_token": tokens.IDToken, "account_id": tokens.Account, "last_refresh": file.LastRefresh,
	})
	return Credential{Token: tokens.Access, Personal: true, ManagedImport: upload}, nil
}

func parseManagedKiro(raw string) (Credential, error) {
	var file struct {
		RefreshToken string `json:"refreshToken,omitempty"`
		AuthMethod   string `json:"authMethod,omitempty"`
		Provider     string `json:"provider,omitempty"`
		ClientID     string `json:"clientId,omitempty"`
		ClientSecret string `json:"clientSecret,omitempty"`
		ProfileARN   string `json:"profileArn,omitempty"`
		AuthRegion   string `json:"authRegion,omitempty"`
		APIRegion    string `json:"apiRegion,omitempty"`
	}
	if json.Unmarshal([]byte(raw), &file) != nil {
		return Credential{}, ErrCredential
	}
	if file.RefreshToken == "" {
		return Credential{}, ErrCredential
	}
	if !validToken(file.RefreshToken) ||
		(file.AuthRegion != "" && !awsRegion.MatchString(file.AuthRegion)) ||
		(file.APIRegion != "" && !awsRegion.MatchString(file.APIRegion)) ||
		((file.AuthMethod == "idc" || file.Provider == "idc" || file.Provider == "builder_id") &&
			(!validToken(file.ClientID) || !validToken(file.ClientSecret))) {
		return Credential{}, ErrCredential
	}
	upload, _ := json.Marshal(file)
	return Credential{Token: file.RefreshToken, Personal: true, ManagedImport: upload}, nil
}

type adminCall func(method, path string, data, result any) error
type importCredential func(call adminCall, payload json.RawMessage, id string) (removePath string, err error)

func textProvisioner(parse func(string) (Credential, error), importAccount importCredential) *provisioner {
	return &provisioner{
		parse: parse,
		validate: func(executor Executor) bool {
			return validToken(executor.ManagementKey) && validToken(executor.RuntimeKey) &&
				executor.ManagementKey != executor.RuntimeKey
		},
		run: func(r Registry, ctx context.Context, adapter Adapter, executor Executor, credential Credential, _, id string) (Prepared, error) {
			return r.provisionText(ctx, adapter, executor, credential.ManagedImport, id, importAccount)
		},
	}
}

func (r Registry) provisionText(ctx context.Context, adapter Adapter, executor Executor, payload json.RawMessage, id string, importAccount importCredential) (Prepared, error) {
	call := func(ctx context.Context, method, path string, data, result any) error {
		return executorCall(ctx, r.client, executor.URL, executor.ManagementKey, method, path, data, result)
	}
	target, err := importAccount(func(method, path string, data, result any) error {
		return call(ctx, method, path, data, result)
	}, payload, id)
	remove := func() {
		if target == "" {
			return
		}
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = call(cleanup, "DELETE", target, nil, nil)
	}
	if err != nil {
		remove()
		return Prepared{}, err
	}
	adapter.Base = executor.URL
	models, err := r.Discover(ctx, adapter, Credential{Token: executor.RuntimeKey})
	if err != nil {
		remove()
		return Prepared{}, err
	}
	return Prepared{Base: executor.URL, Token: executor.RuntimeKey, Models: models, Managed: true, Cleanup: remove}, nil
}

func importCodex(call adminCall, payload json.RawMessage, id string) (string, error) {
	const files = "/v8/management/credentials"
	var listed struct{ Files []json.RawMessage }
	if err := call("GET", files, nil, &listed); err != nil || listed.Files == nil {
		return "", ErrUpstream
	}
	if len(listed.Files) != 0 {
		return "", ErrNoExecutor
	}
	// The generated filename gives cleanup a precise target if upload times out.
	target := files + "?name=" + url.QueryEscape(id+".json")
	var uploaded struct{ Status string }
	if err := call("POST", target, payload, &uploaded); err != nil || uploaded.Status != "ok" {
		return target, ErrUpstream
	}
	return target, nil
}

func importKiro(call adminCall, payload json.RawMessage, _ string) (string, error) {
	const accounts = "/api/admin/credentials"
	var listed struct{ Credentials []json.RawMessage }
	if err := call("GET", accounts, nil, &listed); err != nil || listed.Credentials == nil {
		return "", ErrUpstream
	}
	if len(listed.Credentials) != 0 {
		return "", ErrNoExecutor
	}
	var uploaded struct {
		Success bool
		Results []struct {
			Status string
			ID     int64 `json:"credentialId"`
		}
	}
	if err := call("POST", accounts+"/batch-import", map[string]json.RawMessage{"data": payload}, &uploaded); err != nil ||
		!uploaded.Success || len(uploaded.Results) != 1 || uploaded.Results[0].Status != "added" || uploaded.Results[0].ID <= 0 {
		return "", ErrUpstream
	}
	target := accounts + "/" + strconv.FormatInt(uploaded.Results[0].ID, 10)
	var refreshed struct {
		Success bool
		Count   int
	}
	if err := call("POST", target+"/models/refresh", nil, &refreshed); err != nil || !refreshed.Success || refreshed.Count == 0 {
		return target, ErrCredential
	}
	return target, nil
}
