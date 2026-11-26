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
		return Credential{}, nil
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

func textProvisioner(parse func(string) (Credential, error), free func(adminCall) error, importAccount importCredential) *provisioner {
	return &provisioner{
		parse: parse,
		validate: func(executor Executor) bool {
			return validToken(executor.ManagementKey) && validToken(executor.RuntimeKey) &&
				executor.ManagementKey != executor.RuntimeKey
		},
		probe: func(r Registry, ctx context.Context, adapter Adapter, executor Executor) error {
			if err := free(r.textAdmin(ctx, executor)); err != nil {
				return err
			}
			adapter.Base = executor.URL
			_, err := r.modelDirectory(ctx, adapter, executor.RuntimeKey)
			if err == ErrCredential {
				return ErrUpstream
			}
			return err
		},
		run: func(r Registry, ctx context.Context, adapter Adapter, executor Executor, credential Credential, _, id string) (Prepared, error) {
			if err := free(r.textAdmin(ctx, executor)); err != nil {
				return Prepared{}, err
			}
			return r.provisionText(ctx, adapter, executor, credential.ManagedImport, id, importAccount)
		},
	}
}

func (r Registry) textAdmin(ctx context.Context, executor Executor) adminCall {
	return func(method, path string, data, result any) error {
		return executorCall(ctx, r.client, executor.URL, executor.ManagementKey, method, path, data, result)
	}
}

func (r Registry) provisionText(ctx context.Context, adapter Adapter, executor Executor, payload json.RawMessage, id string, importAccount importCredential) (Prepared, error) {
	target, err := importAccount(r.textAdmin(ctx, executor), payload, id)
	remove := func() {
		if target == "" {
			return
		}
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = r.textAdmin(cleanup, executor)("DELETE", target, nil, nil)
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

const (
	codexFiles   = "/v8/management/credentials"
	kiroAccounts = "/api/admin/credentials"
)

func freeCodex(call adminCall) error {
	var listed struct{ Files []json.RawMessage }
	if err := call("GET", codexFiles, nil, &listed); err != nil || listed.Files == nil {
		return ErrUpstream
	}
	if len(listed.Files) != 0 {
		return ErrNoExecutor
	}
	return nil
}

func importCodex(call adminCall, payload json.RawMessage, id string) (string, error) {
	// The generated filename gives cleanup a precise target if upload times out.
	target := codexFiles + "?name=" + url.QueryEscape(id+".json")
	var uploaded struct{ Status string }
	if err := call("POST", target, payload, &uploaded); err != nil || uploaded.Status != "ok" {
		return target, ErrUpstream
	}
	return target, nil
}

func freeKiro(call adminCall) error {
	var listed struct{ Credentials []json.RawMessage }
	if err := call("GET", kiroAccounts, nil, &listed); err != nil || listed.Credentials == nil {
		return ErrUpstream
	}
	if len(listed.Credentials) != 0 {
		return ErrNoExecutor
	}
	return nil
}

func importKiro(call adminCall, payload json.RawMessage, _ string) (string, error) {
	var uploaded struct {
		Success bool
		Results []struct {
			Status string
			ID     int64 `json:"credentialId"`
		}
	}
	if err := call("POST", kiroAccounts+"/batch-import", map[string]json.RawMessage{"data": payload}, &uploaded); err != nil ||
		!uploaded.Success || len(uploaded.Results) != 1 || uploaded.Results[0].Status != "added" || uploaded.Results[0].ID <= 0 {
		return "", ErrUpstream
	}
	target := kiroAccounts + "/" + strconv.FormatInt(uploaded.Results[0].ID, 10)
	var refreshed struct {
		Success bool
		Count   int
	}
	if err := call("POST", target+"/models/refresh", nil, &refreshed); err != nil || !refreshed.Success || refreshed.Count == 0 {
		return target, ErrCredential
	}
	return target, nil
}
