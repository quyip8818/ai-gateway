package providers

import (
	"context"
	"encoding/json"
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
	jar, _ := cookiejar.New(nil)
	client := *r.client
	client.Jar = jar
	base, _ := url.Parse(adapter.Base)
	var ok struct{ Success bool }
	if err := executorCall(ctx, &client, adapter.Base, "", "POST", "/dashboard/login", map[string]string{
		"username": executor.Username, "password": executor.Password,
	}, &ok); err != nil || !ok.Success || len(jar.Cookies(base)) == 0 {
		return Prepared{}, ErrUpstream
	}
	logout := func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = executorCall(cleanup, &client, adapter.Base, "", "POST", "/dashboard/logout", nil, nil)
	}
	var pool []json.RawMessage
	var keys []json.RawMessage
	if err := executorCall(ctx, &client, adapter.Base, "", "GET", "/account-pool/", nil, &pool); err != nil {
		logout()
		return Prepared{}, err
	}
	if err := executorCall(ctx, &client, adapter.Base, "", "GET", "/dashboard/keys", nil, &keys); err != nil {
		logout()
		return Prepared{}, err
	}
	if len(pool) != 0 || len(keys) != 0 {
		logout()
		return Prepared{}, ErrNoExecutor
	}
	var status struct{ Live bool }
	if err := executorCall(ctx, &client, adapter.Base, "", "POST", "/token/check", map[string]string{"token": session}, &status); err != nil {
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
			_ = executorCall(ctx, &client, adapter.Base, "", "DELETE", "/dashboard/keys/"+strconv.Itoa(issued.APIKey.ID), nil, nil)
		}
		if account.ID != "" {
			_ = executorCall(ctx, &client, adapter.Base, "", "DELETE", "/account-pool/"+url.PathEscape(account.ID), nil, nil)
		}
		logout()
	}
	if err := executorCall(ctx, &client, adapter.Base, "", "POST", "/account-pool/", map[string]string{
		"name": name, "sessionId": session,
	}, &account); err != nil || account.ID == "" {
		cleanup()
		return Prepared{}, ErrUpstream
	}
	if err := executorCall(ctx, &client, adapter.Base, "", "POST", "/dashboard/keys", map[string]string{"name": name}, &issued); err != nil ||
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
