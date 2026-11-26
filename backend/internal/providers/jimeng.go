package providers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strconv"
	"time"
)

func (r Registry) provisionJimeng(ctx context.Context, adapter Adapter, executor Executor, session, name string) (Prepared, error) {
	adapter.Base = executor.URL
	if !adapter.Configured() || executor.Username == "" || executor.Password == "" {
		return Prepared{}, ErrDisabled
	}
	client, logout, err := r.jimengSession(ctx, executor)
	if err != nil {
		return Prepared{}, err
	}
	if err := freeJimeng(ctx, client, executor.URL); err != nil {
		logout()
		return Prepared{}, err
	}
	var status struct{ Live bool }
	if err := executorCall(ctx, client, adapter.Base, "", "POST", "/token/check", map[string]string{"token": session}, &status); err != nil {
		logout()
		return Prepared{}, err
	}
	if !status.Live {
		logout()
		return Prepared{}, ErrCredential
	}

	var account struct{ ID string }
	var issued struct {
		Key    string
		APIKey struct{ ID int }
	}
	cleanup := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if issued.APIKey.ID > 0 {
			_ = executorCall(ctx, client, adapter.Base, "", "DELETE", "/dashboard/keys/"+strconv.Itoa(issued.APIKey.ID), nil, nil)
		}
		if account.ID != "" {
			_ = executorCall(ctx, client, adapter.Base, "", "DELETE", "/account-pool/"+url.PathEscape(account.ID), nil, nil)
		}
		logout()
	}
	if err := executorCall(ctx, client, adapter.Base, "", "POST", "/account-pool/", map[string]string{
		"name": name, "sessionId": session,
	}, &account); err != nil || account.ID == "" {
		cleanup()
		return Prepared{}, ErrUpstream
	}
	if err := executorCall(ctx, client, adapter.Base, "", "POST", "/dashboard/keys", map[string]string{"name": name}, &issued); err != nil ||
		issued.APIKey.ID <= 0 || issued.Key == "" {
		cleanup()
		return Prepared{}, ErrUpstream
	}
	models, err := r.Discover(ctx, adapter, Credential{Token: issued.Key})
	if err != nil {
		cleanup()
		return Prepared{}, err
	}
	for i, model := range models {
		if model.Operation == "image.generate" {
			models[i].Capabilities = json.RawMessage(`{"input_roles":["reference_image"]}`)
		} else {
			models[i].Capabilities = json.RawMessage(`{"input_roles":["first_frame"]}`)
		}
	}
	return Prepared{Base: adapter.Base, Token: issued.Key, Models: models, Cleanup: cleanup, Finish: logout, Managed: true}, nil
}

func (r Registry) jimengSession(ctx context.Context, executor Executor) (*http.Client, func(), error) {
	jar, _ := cookiejar.New(nil)
	client := *r.client
	client.Jar = jar
	base, _ := url.Parse(executor.URL)
	var ok struct{ Success bool }
	if err := executorCall(ctx, &client, executor.URL, "", "POST", "/dashboard/login", map[string]string{
		"username": executor.Username, "password": executor.Password,
	}, &ok); err != nil || !ok.Success || len(jar.Cookies(base)) == 0 {
		return nil, nil, ErrUpstream
	}
	logout := func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = executorCall(cleanup, &client, executor.URL, "", "POST", "/dashboard/logout", nil, nil)
	}
	return &client, logout, nil
}

func (r Registry) probeJimeng(ctx context.Context, _ Adapter, executor Executor) error {
	client, logout, err := r.jimengSession(ctx, executor)
	if err != nil {
		return err
	}
	defer logout()
	return freeJimeng(ctx, client, executor.URL)
}

func freeJimeng(ctx context.Context, client *http.Client, base string) error {
	for _, path := range []string{"/account-pool/", "/dashboard/keys"} {
		var entries []json.RawMessage
		if err := executorCall(ctx, client, base, "", "GET", path, nil, &entries); err != nil || entries == nil {
			return ErrUpstream
		}
		if len(entries) > 0 {
			return ErrNoExecutor
		}
	}
	return nil
}
