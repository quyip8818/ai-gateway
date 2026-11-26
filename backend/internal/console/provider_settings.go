package console

import (
	"errors"
	"net/http"

	"ai-gateway/internal/accounts"
	"ai-gateway/internal/media"
	"ai-gateway/internal/platform"
	"ai-gateway/internal/providers"
)

func (s Service) operator(r *http.Request) bool {
	if s.OperatorUsername == "" {
		return false
	}
	user, err := s.Store.User(r)
	if err != nil {
		return false
	}
	var allowed bool
	err = s.DB.QueryRow(r.Context(), "SELECT username=$2 FROM users WHERE id=$1", user, s.OperatorUsername).Scan(&allowed)
	return err == nil && allowed
}

func (s Service) ProviderSettings(w http.ResponseWriter, r *http.Request) {
	if !s.Origin(w, r) {
		return
	}
	if !s.operator(r) {
		platform.Error(w, 403, "operator_required")
		return
	}
	id := r.PathValue("provider")
	adapter, ok := s.AccountsService.Providers.Get(id)
	if !ok || !adapter.Configurable() {
		platform.Error(w, 404, "provider_not_found")
		return
	}
	ctx := r.Context()
	downloadHosts := media.DownloadHostStore{DB: s.DB}
	var err error
	switch r.Method {
	case http.MethodGet:
		setup, err := s.AccountsService.Setup(ctx, id)
		if err != nil {
			platform.Error(w, 503, "provider_settings_unavailable")
			return
		}
		setup.Callback = s.PublicBase + accountCallback
		response := struct {
			accounts.Setup
			DownloadHosts []string `json:"download_hosts"`
		}{Setup: setup}
		if id == "jimeng" {
			response.DownloadHosts, err = downloadHosts.List(ctx)
			if err != nil {
				platform.Error(w, 503, "provider_settings_unavailable")
				return
			}
		}
		platform.JSON(w, 200, response)
		return
	case http.MethodPost:
		var executor providers.Executor
		if !Decode(w, r, &executor) {
			return
		}
		executor.Provider = id
		err = s.AccountsService.AddExecutor(ctx, executor)
	case http.MethodPut:
		var settings accounts.ProviderUpdate
		if !Decode(w, r, &settings) {
			return
		}
		err = s.AccountsService.SetProvider(ctx, id, settings)
	case http.MethodPatch:
		if id != "jimeng" {
			platform.Error(w, 404, "provider_not_found")
			return
		}
		var settings struct {
			DownloadHosts *[]string `json:"download_hosts"`
		}
		if !Decode(w, r, &settings) {
			return
		}
		if settings.DownloadHosts == nil {
			platform.Error(w, 400, "invalid_download_hosts")
			return
		}
		err = downloadHosts.Replace(ctx, *settings.DownloadHosts)
		if errors.Is(err, media.ErrInvalidDownloadHosts) {
			platform.Error(w, 400, "invalid_download_hosts")
			return
		}
	case http.MethodDelete:
		err = s.AccountsService.RemoveExecutor(ctx, id, r.PathValue("executor"))
	}
	switch {
	case err == nil:
		w.WriteHeader(204)
	case errors.Is(err, providers.ErrDisabled):
		platform.Error(w, 400, "invalid_provider_settings")
	case errors.Is(err, providers.ErrNoExecutor):
		platform.Error(w, 409, "executor_not_empty")
	case errors.Is(err, providers.ErrUpstream):
		platform.Error(w, 502, "executor_unreachable")
	case errors.Is(err, accounts.ErrDuplicate):
		platform.Error(w, 409, "executor_duplicate")
	case errors.Is(err, accounts.ErrExecutorMissing):
		platform.Error(w, 404, "executor_not_found")
	case errors.Is(err, accounts.ErrSettingsInUse):
		platform.Error(w, 409, "provider_settings_in_use")
	default:
		platform.Error(w, 503, "provider_settings_unavailable")
	}
}
