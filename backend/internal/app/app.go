package app

import (
	"io/fs"
	"net/http"
	"strings"

	"ai-gateway/internal/access"
	"ai-gateway/internal/app/ui"
	"ai-gateway/internal/coding"
	"ai-gateway/internal/console"
	"ai-gateway/internal/media"
	"ai-gateway/internal/platform"
	"ai-gateway/internal/protocol"
	"github.com/jackc/pgx/v5/pgxpool"
)

type App struct {
	DB      *pgxpool.Pool
	Access  access.Store
	Coding  *coding.Service
	Media   *media.Service
	Console console.Service
}

type bound func(http.ResponseWriter, *http.Request, access.Identity)

func (a App) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /metrics", a.metrics)
	mux.HandleFunc("GET /livez", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		if a.DB.Ping(r.Context()) != nil {
			platform.Error(w, 503, "database_unavailable")
			return
		}
		w.WriteHeader(204)
	})
	mux.HandleFunc("POST /openai/v1/responses", func(w http.ResponseWriter, r *http.Request) {
		a.Coding.Invoke(w, r, protocol.Responses, "/v1/responses")
	})
	mux.HandleFunc("POST /anthropic/v1/messages", func(w http.ResponseWriter, r *http.Request) {
		a.Coding.Invoke(w, r, protocol.Messages, "/v1/messages")
	})
	mux.HandleFunc("POST /anthropic/v1/messages/count_tokens", func(w http.ResponseWriter, r *http.Request) {
		a.Coding.Invoke(w, r, protocol.Messages, "/v1/messages/count_tokens")
	})
	mux.HandleFunc("GET /openai/v1/models", func(w http.ResponseWriter, r *http.Request) { a.Coding.Models(w, r, protocol.Responses) })
	mux.HandleFunc("GET /anthropic/v1/models", func(w http.ResponseWriter, r *http.Request) { a.Coding.Models(w, r, protocol.Messages) })
	for _, method := range []string{"GET", "POST", "DELETE"} {
		mux.HandleFunc(method+" /console/v1/session", a.Console.Session)
	}
	mux.HandleFunc("GET /console/v1/projects", a.Console.Projects)
	mux.HandleFunc("GET /console/v1/oauth/callback", a.Console.AuthorizationCallback)
	const p = "/console/v1/projects/{project}"
	auth := func(method, path string, fn bound) {
		mux.HandleFunc(method+" "+p+path, func(w http.ResponseWriter, r *http.Request) {
			if !a.Console.Origin(w, r) {
				return
			}
			who, err := a.Access.Project(r, r.PathValue("project"))
			if err != nil {
				platform.Error(w, access.HTTPStatus(err), "access_denied")
				return
			}
			fn(w, r, who)
		})
	}
	auth("GET", "/models", a.Console.Models)
	auth("GET", "/keys", a.Console.Keys)
	auth("POST", "/keys", a.Console.Keys)
	auth("POST", "/keys/{id}/revoke", func(w http.ResponseWriter, r *http.Request, who access.Identity) {
		a.Console.KeyAction(w, r, who, false)
	})
	auth("POST", "/keys/{id}/rotate", func(w http.ResponseWriter, r *http.Request, who access.Identity) {
		a.Console.KeyAction(w, r, who, true)
	})
	auth("POST", "/setup/checks", a.Console.StartSetup)
	auth("GET", "/setup/checks/{id}", a.Console.Setup)
	auth("GET", "/requests", a.Console.Requests)
	auth("GET", "/requests/{id}", a.Console.Request)
	auth("GET", "/usage", a.Console.Usage)
	auth("GET", "/usage/export", a.Console.ExportUsage)
	auth("GET", "/members", a.Console.Members)
	auth("PATCH", "/members/{id}", a.Console.Members)
	auth("GET", "/audit-events", a.Console.Audit)
	auth("GET", "/providers", a.Console.Providers)
	auth("GET", "/pools", a.Console.Pools)
	auth("GET", "/accounts", a.Console.Accounts)
	auth("POST", "/account-enrollments", a.Console.EnrollAccount)
	auth("POST", "/account-authorizations", a.Console.StartAuthorization)
	auth("GET", "/account-authorizations/{id}", a.Console.AuthorizationResult)
	auth("PATCH", "/accounts/{id}", a.Console.UpdateAccount)
	for _, endpoint := range []struct {
		method, path, scope string
		fn                  bound
	}{
		{"GET", "/models", "models:read", a.Media.Models}, {"POST", "/assets", "media:submit", a.Media.Upload},
		{"GET", "/jobs", "media:read", a.Media.List}, {"POST", "/jobs", "media:submit", a.Media.Create},
		{"GET", "/jobs/{id}", "media:read", a.Media.Get}, {"POST", "/jobs/{id}/cancel", "media:submit", a.Media.Cancel},
		{"GET", "/jobs/{id}/artifacts/{artifact}", "media:read", a.Media.Artifact},
	} {
		auth(endpoint.method, "/media"+endpoint.path, endpoint.fn)
		mux.HandleFunc(endpoint.method+" /media/v1"+endpoint.path, func(w http.ResponseWriter, r *http.Request) {
			who, err := a.Access.API(r, endpoint.scope)
			if err != nil {
				platform.Error(w, access.HTTPStatus(err), "access_denied")
				return
			}
			endpoint.fn(w, r, who)
		})
	}
	files := ui.Files()
	static := http.FileServerFS(files)
	mux.Handle("GET /assets/", static)
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/app/", http.StatusTemporaryRedirect)
	})
	mux.HandleFunc("GET /app/", func(w http.ResponseWriter, r *http.Request) {
		data, err := fs.ReadFile(files, "index.html")
		if err != nil {
			data, err = fs.ReadFile(files, "placeholder.html")
		}
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write(data)
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Request-Id", platform.ID())
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		if strings.HasPrefix(r.URL.Path, "/console/") {
			w.Header().Set("Cache-Control", "no-store")
		}
		mux.ServeHTTP(w, r)
	})
}
