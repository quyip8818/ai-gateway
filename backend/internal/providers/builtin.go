package providers

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"ai-gateway/internal/protocol"
)

const openAIPlatform = "https://api.openai.com"

func builtins(config Config) []Adapter {
	return []Adapter{
		{ID: "jimeng", Label: "即梦", Format: "cookie", CredentialLabel: "账号 Cookie", Protocol: protocol.Media,
			Base: strings.TrimRight(config.Jimeng, "/"), parse: parseJimengCookie, model: jimengModel,
			provisioner: &provisioner{
				validate: func(executor Executor) bool { return executor.Username != "" && executor.Password != "" },
				run: func(r Registry, ctx context.Context, adapter Adapter, executor Executor, credential Credential, name, _ string) (Prepared, error) {
					return r.provisionJimeng(ctx, adapter, executor, credential.Token, name)
				},
			}},
		{ID: "codex", Label: "Codex", Format: "auth.json", CredentialLabel: "auth.json 授权文件", Protocol: protocol.Responses,
			Base: strings.TrimRight(config.Codex, "/"), parse: parseCodexFile,
			oauth:       func(a Adapter) bool { return a.Base != openAIPlatform },
			provisioner: textProvisioner(parseManagedCodex, importCodex)},
		{ID: "kiro", Label: "Kiro", Format: "auth.json", CredentialLabel: "Kiro 授权文件", Protocol: protocol.Messages,
			Base: strings.TrimRight(config.Kiro, "/"), parse: parseKiroFile,
			oauth:       func(Adapter) bool { return true },
			provisioner: textProvisioner(parseManagedKiro, importKiro)},
		{ID: "claude", Label: "Claude", Format: "platform_key", CredentialLabel: "Anthropic Console 密钥", Protocol: protocol.Messages,
			Base: strings.TrimRight(config.Claude, "/"), parse: parsePlatformKey, CountTokens: true},
	}
}

func parseJimengCookie(_ Adapter, raw string) (Credential, error) {
	for _, part := range strings.Split(raw, ";") {
		name, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		if ok && name == "sessionid" {
			return Credential{Token: value, Personal: true}, nil
		}
	}
	return Credential{}, ErrCredential
}

func parsePlatformKey(_ Adapter, raw string) (Credential, error) {
	return Credential{Token: strings.TrimSpace(raw)}, nil
}

func parseCodexFile(a Adapter, raw string) (Credential, error) {
	var file struct {
		APIKey    string `json:"OPENAI_API_KEY"`
		ExpiresAt string `json:"expiresAt"`
		Tokens    struct {
			AccessToken  string `json:"access_token"`
			RefreshToken string `json:"refresh_token"`
		} `json:"tokens"`
	}
	if json.Unmarshal([]byte(raw), &file) != nil {
		return Credential{}, ErrCredential
	}
	if file.Tokens.AccessToken == "" {
		return parsePlatformKey(a, file.APIKey)
	}
	if !a.SupportsOAuth() {
		return Credential{}, ErrDisabled
	}
	return sessionCredential(file.Tokens.AccessToken, file.Tokens.RefreshToken, file.ExpiresAt)
}

func parseKiroFile(_ Adapter, raw string) (Credential, error) {
	var file struct {
		AccessToken  string `json:"accessToken"`
		RefreshToken string `json:"refreshToken"`
		ExpiresAt    string `json:"expiresAt"`
	}
	if json.Unmarshal([]byte(raw), &file) != nil {
		return Credential{}, ErrCredential
	}
	return sessionCredential(file.AccessToken, file.RefreshToken, file.ExpiresAt)
}

func sessionCredential(token, refresh, expiry string) (Credential, error) {
	credential := Credential{Token: token, RefreshToken: refresh, Personal: true}
	if expiry != "" {
		when, err := time.Parse(time.RFC3339, expiry)
		if err != nil || !when.After(time.Now()) {
			return Credential{}, ErrCredential
		}
		credential.ExpiresAt = &when
	}
	return credential, nil
}

func jimengModel(model directoryModel) (string, json.RawMessage) {
	switch model.Owner {
	case "jimeng-image":
		return protocol.ImageGenerate, model.Capabilities
	case "jimeng-video":
		return protocol.VideoGenerate, model.Capabilities
	default:
		return "", nil
	}
}
