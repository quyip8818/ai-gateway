package main

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"

	"ai-gateway/internal/providers"
)

func loadProviders() (providers.Registry, error) {
	registry := providers.New(providers.Config{
		Codex: os.Getenv("CODEX_ACCOUNT_BASE_URL"), Kiro: os.Getenv("KIRO_ACCOUNT_BASE_URL"),
		Jimeng: os.Getenv("JIMENG_ACCOUNT_BASE_URL"), Claude: os.Getenv("CLAUDE_ACCOUNT_BASE_URL"),
	})
	var compatible []providers.Compatible
	if err := accountConfig("ACCOUNT_PROVIDERS_FILE", "providers.json", &compatible); err != nil {
		return registry, err
	}
	registry, err := registry.WithCompatible(compatible)
	if err != nil {
		return registry, err
	}
	var executors []providers.Executor
	if err := accountConfig("ACCOUNT_EXECUTORS_FILE", "executors.json", &executors); err != nil {
		return registry, err
	}
	registry, err = registry.WithExecutors(executors)
	if err != nil {
		return registry, errors.New("invalid account executor configuration")
	}
	var clients map[string]providers.OAuthClient
	if err := accountConfig("ACCOUNT_OAUTH_CLIENTS_FILE", "oauth-clients.json", &clients); err != nil {
		return registry, err
	}
	for name, client := range clients {
		adapter, ok := registry.Get(name)
		if !ok || !adapter.SupportsOAuth() || !client.Configured() ||
			(client.AuthorizeURL != "" && !client.CanAuthorize()) {
			return registry, errors.New("invalid account OAuth client configuration")
		}
	}
	return registry.WithOAuthClients(clients), nil
}

func accountConfig(env, filename string, value any) error {
	path := os.Getenv(env)
	explicit := path != ""
	if !explicit {
		dir := os.Getenv("ACCOUNT_CONFIG_DIR")
		if dir == "" {
			return nil
		}
		path = filepath.Join(dir, filename)
	}
	file, err := os.Open(path)
	if !explicit && errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return errors.New("could not read " + filename)
	}
	defer file.Close()
	d := json.NewDecoder(io.LimitReader(file, 1<<20))
	d.DisallowUnknownFields()
	if d.Decode(value) != nil || d.Decode(new(any)) != io.EOF {
		return errors.New("invalid " + filename)
	}
	return nil
}
