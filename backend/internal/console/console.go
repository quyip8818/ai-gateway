package console

import (
	"encoding/json"
	"io"
	"net/http"

	"ai-gateway/internal/access"
	"ai-gateway/internal/accounts"
	"ai-gateway/internal/catalog"
	"ai-gateway/internal/platform"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

type Service struct {
	AccountsService  accounts.Service
	DB               *pgxpool.Pool
	Store            access.Store
	Catalog          catalog.Store
	PublicBase       string
	OperatorUsername string
}

func (s Service) Origin(w http.ResponseWriter, r *http.Request) bool {
	if r.Method == "GET" || r.Method == "HEAD" {
		return true
	}
	if r.Header.Get("Origin") != s.PublicBase || r.Header.Get("X-Gateway-CSRF") != "1" {
		platform.Error(w, 403, "invalid_origin")
		return false
	}
	return true
}
func Decode(w http.ResponseWriter, r *http.Request, v any) bool {
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	d.DisallowUnknownFields()
	if d.Decode(v) != nil || d.Decode(new(any)) != io.EOF {
		platform.Error(w, 400, "invalid_request")
		return false
	}
	return true
}

func (s Service) Session(w http.ResponseWriter, r *http.Request) {
	if !s.Origin(w, r) {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	switch r.Method {
	case "POST":
		var in struct{ Username, Password string }
		if !Decode(w, r, &in) {
			return
		}
		var user string
		var hash []byte
		username := access.NormalizeUsername(in.Username)
		err := s.DB.QueryRow(r.Context(), "SELECT id,password_hash FROM users WHERE username=$1 AND enabled", username).Scan(&user, &hash)
		if err != nil || bcrypt.CompareHashAndPassword(hash, []byte(in.Password)) != nil {
			platform.Error(w, 401, "invalid_login")
			return
		}
		token := platform.Random()
		_, err = s.DB.Exec(r.Context(), `INSERT INTO web_sessions(digest,user_id,expires_at) VALUES($1,$2,now()+interval '12 hours')`, platform.Digest(s.Store.Key, token), user)
		if err != nil {
			platform.Error(w, 503, "session_unavailable")
			return
		}
		http.SetCookie(w, &http.Cookie{Name: "gateway_session", Value: token, Path: "/", HttpOnly: true, Secure: s.Store.Secure, SameSite: http.SameSiteLaxMode, MaxAge: 43200})
		platform.JSON(w, 200, map[string]string{"user_id": user})
	case "GET":
		id, err := s.Store.User(r)
		if err != nil {
			platform.Error(w, access.HTTPStatus(err), "session_required")
			return
		}
		platform.JSON(w, 200, map[string]string{"user_id": id})
	case "DELETE":
		if c, err := r.Cookie("gateway_session"); err == nil {
			if _, err = s.DB.Exec(r.Context(), "DELETE FROM web_sessions WHERE digest=$1", platform.Digest(s.Store.Key, c.Value)); err != nil {
				platform.Error(w, 503, "session_store_unavailable")
				return
			}
		}
		http.SetCookie(w, &http.Cookie{Name: "gateway_session", Path: "/", HttpOnly: true, Secure: s.Store.Secure, SameSite: http.SameSiteLaxMode, MaxAge: -1})
		w.WriteHeader(204)
	}
}

func (s Service) query(w http.ResponseWriter, r *http.Request, q string, args ...any) {
	rows, err := s.DB.Query(r.Context(), q, args...)
	if err != nil {
		platform.Error(w, 503, "query_unavailable")
		return
	}
	defer rows.Close()
	data := []json.RawMessage{}
	for rows.Next() {
		var v json.RawMessage
		if rows.Scan(&v) != nil {
			platform.Error(w, 503, "query_unavailable")
			return
		}
		data = append(data, v)
	}
	if rows.Err() != nil {
		platform.Error(w, 503, "query_unavailable")
		return
	}
	platform.JSON(w, 200, map[string]any{"data": data})
}

func (s Service) Projects(w http.ResponseWriter, r *http.Request) {
	user, err := s.Store.User(r)
	if err != nil {
		platform.Error(w, access.HTTPStatus(err), "session_required")
		return
	}
	s.query(w, r, `SELECT jsonb_build_object('id',j.id,'name',j.name,'role',p.role) FROM project_principals p
 JOIN projects j ON j.id=p.project_id JOIN tenants t ON t.id=j.tenant_id
 WHERE p.user_id=$1 AND p.enabled AND j.enabled AND t.enabled ORDER BY j.name`, user)
}
func (s Service) Models(w http.ResponseWriter, r *http.Request, who access.Identity) {
	models, err := s.Catalog.Models(r.Context(), who, "")
	if err != nil {
		platform.Error(w, 503, "models_unavailable")
		return
	}
	for i := range models {
		if adapter, ok := s.AccountsService.Providers.Get(models[i].Provider); ok {
			models[i].ProviderName = adapter.Label
		}
	}
	platform.JSON(w, 200, map[string]any{"data": models})
}
