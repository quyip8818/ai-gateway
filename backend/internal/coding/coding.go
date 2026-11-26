package coding

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"ai-gateway/internal/access"
	"ai-gateway/internal/catalog"
	"ai-gateway/internal/metering"
	"ai-gateway/internal/platform"
	"github.com/jackc/pgx/v5"
)

type Service struct {
	Access  access.Store
	Catalog catalog.Store
	Metrics metering.Store
	Client  *http.Client
	mu      sync.Mutex
	active  map[string]int
}

func (s *Service) acquire(keys ...string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active == nil {
		s.active = map[string]int{}
	}
	for _, k := range keys {
		if s.active[k] >= 8 {
			return false
		}
	}
	for _, k := range keys {
		s.active[k]++
	}
	return true
}

func (s *Service) release(keys ...string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, k := range keys {
		s.active[k]--
		if s.active[k] == 0 {
			delete(s.active, k)
		}
	}
}

func apiError(w http.ResponseWriter, provider string, status int, code string) {
	kind := map[int]string{400: "invalid_request_error", 401: "authentication_error", 403: "permission_error", 404: "not_found_error", 429: "rate_limit_error", 502: "api_error", 503: "overloaded_error"}[status]
	if kind == "" {
		kind = "invalid_request_error"
	}
	detail := map[string]string{"type": kind, "message": code}
	body := map[string]any{"error": detail}
	if provider == "anthropic" {
		body["type"] = "error"
		body["request_id"] = w.Header().Get("X-Request-Id")
	} else {
		detail["code"] = code
	}
	platform.JSON(w, status, body)
}

func (s *Service) Models(w http.ResponseWriter, r *http.Request, provider, operation string) {
	who, err := s.Access.API(r, "models:read")
	if err != nil {
		apiError(w, provider, access.HTTPStatus(err), "model_list_unavailable")
		return
	}
	models, err := s.Catalog.Models(r.Context(), who.Project, operation)
	if err != nil {
		apiError(w, provider, 503, "model_list_unavailable")
		return
	}
	data := []map[string]any{}
	for _, m := range models {
		if provider == "anthropic" {
			data = append(data, map[string]any{"id": m.ID, "type": "model", "display_name": m.ID, "created_at": "2024-01-01T00:00:00Z"})
		} else {
			data = append(data, map[string]any{"id": m.ID, "object": "model", "owned_by": provider, "created": 0})
		}
	}
	if provider == "anthropic" {
		var first, last any
		if len(data) > 0 {
			first = data[0]["id"]
			last = data[len(data)-1]["id"]
		}
		platform.JSON(w, 200, map[string]any{"data": data, "has_more": false, "first_id": first, "last_id": last})
		return
	}
	platform.JSON(w, 200, map[string]any{"object": "list", "data": data})
}

func (s *Service) Invoke(w http.ResponseWriter, r *http.Request, provider, operation, path string) {
	who, err := s.Access.API(r, "coding:invoke")
	if err != nil {
		apiError(w, provider, access.HTTPStatus(err), "access_denied")
		return
	}
	content, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 8<<20))
	if err != nil {
		apiError(w, provider, 413, "body_too_large")
		return
	}
	var fields map[string]json.RawMessage
	var model string
	if json.Unmarshal(content, &fields) != nil || json.Unmarshal(fields["model"], &model) != nil || strings.TrimSpace(model) == "" {
		apiError(w, provider, 400, "valid_model_required")
		return
	}
	route, err := s.Catalog.Get(r.Context(), who.Project, operation, model, "", false)
	if errors.Is(err, pgx.ErrNoRows) {
		apiError(w, provider, 404, "model_not_found")
		return
	}
	if err != nil || route.Provider != provider {
		apiError(w, provider, 503, "route_unavailable")
		return
	}
	keys := []string{"project:" + who.Project, "upstream:" + provider + ":" + route.Quota}
	if !s.acquire(keys...) {
		apiError(w, provider, 429, "concurrency_exceeded")
		return
	}
	defer s.release(keys...)
	requestID := w.Header().Get("X-Request-Id")
	kind := operation
	if strings.HasSuffix(path, "/count_tokens") {
		kind = "count_tokens"
	}
	attempt, err := s.Metrics.Start(r.Context(), who, requestID, route.ID, route.Connection, kind, model)
	if err != nil {
		apiError(w, provider, 503, "request_store_unavailable")
		return
	}
	status, stage, failure := "interrupted", "upstream", "upstream_interrupted"
	upstreamID := ""
	httpStatus := 0
	var first time.Time
	usage := map[string]json.Number{}
	defer func() {
		if r.Context().Err() != nil && status != "succeeded" {
			status = "client_canceled"
			stage = "stream"
			failure = "client_canceled"
		}
		if err := s.Metrics.Finish(requestID, attempt, status, stage, failure, upstreamID, httpStatus, first, usage); err != nil {
			log.Printf("request %s finalization failed", requestID)
		}
	}()
	if route.Upstream != model {
		fields["model"], _ = json.Marshal(route.Upstream)
		content, _ = json.Marshal(fields)
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Minute)
	defer cancel()
	send := func(route catalog.Route) (*http.Response, error) {
		req, err := http.NewRequestWithContext(ctx, "POST", route.Base+path, bytes.NewReader(content))
		if err != nil {
			return nil, err
		}
		req.GetBody = nil
		req.Header.Set("Content-Type", "application/json")
		if provider == "anthropic" {
			req.Header.Set("x-api-key", route.Token)
			version := r.Header.Get("anthropic-version")
			if version == "" {
				version = "2023-06-01"
			}
			req.Header.Set("anthropic-version", version)
			for _, beta := range r.Header.Values("anthropic-beta") {
				req.Header.Add("anthropic-beta", beta)
			}
		} else {
			req.Header.Set("Authorization", "Bearer "+route.Token)
		}
		return s.Client.Do(req)
	}
	resp, err := send(route)
	var dial *net.OpError
	if err != nil && ctx.Err() == nil && errors.As(err, &dial) && dial.Op == "dial" {
		if alternate, backupErr := s.Catalog.Backup(ctx, route); backupErr == nil {
			if next, retryErr := s.Metrics.Retry(ctx, requestID, attempt, alternate.Connection); retryErr == nil {
				attempt = next
				resp, err = send(alternate)
			}
		}
	}
	if err != nil {
		apiError(w, provider, 502, "upstream_unreachable")
		return
	}
	defer resp.Body.Close()
	upstreamID = resp.Header.Get("request-id")
	if upstreamID == "" {
		upstreamID = resp.Header.Get("x-request-id")
	}
	httpStatus = resp.StatusCode
	for _, key := range []string{"Content-Type", "Retry-After"} {
		if v := resp.Header.Get(key); v != "" {
			w.Header().Set(key, v)
		}
	}
	if resp.StatusCode >= 300 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		raw, err := io.ReadAll(io.LimitReader(resp.Body, (16<<20)+1))
		if err != nil || len(raw) > 16<<20 || !json.Valid(raw) {
			apiError(w, provider, 502, "invalid_upstream_response")
			return
		}
		if resp.StatusCode >= 300 {
			status, stage, failure = "failed", "upstream", "upstream_error"
		} else {
			status, stage, failure = "succeeded", "", ""
			observe(raw, usage)
		}
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(raw)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(resp.StatusCode)
	status, stage, failure = "interrupted", "stream", "incomplete_stream"
	idle := time.AfterFunc(120*time.Second, cancel)
	defer idle.Stop()
	err = relay(w, progressReader{r: resp.Body, progress: func() { idle.Reset(120 * time.Second) }}, func(data []byte) {
		event := observe(data, usage)
		switch event {
		case "response.completed", "message_stop":
			status, stage, failure = "succeeded", "", ""
		case "error", "response.failed", "response.incomplete":
			status, stage, failure = "failed", "stream", "upstream_stream_error"
		}
		if first.IsZero() && (strings.HasSuffix(event, ".delta") || event == "content_block_delta" || event == "content_block_start") {
			first = time.Now()
		}
	})
	if err != nil && status == "succeeded" {
		status, stage, failure = "interrupted", "stream", "stream_write_failed"
	}
}

type progressReader struct {
	r        io.Reader
	progress func()
}

func (r progressReader) Read(p []byte) (int, error) {
	n, err := r.r.Read(p)
	if n > 0 {
		r.progress()
	}
	return n, err
}

func relay(w http.ResponseWriter, src io.Reader, observeFrame func([]byte)) error {
	controller := http.NewResponseController(w)
	reader := bufio.NewReaderSize(src, 64<<10)
	var data []byte
	for {
		line, err := reader.ReadSlice('\n')
		if len(line) > 0 {
			_ = controller.SetWriteDeadline(time.Now().Add(15 * time.Second))
			if _, writeErr := w.Write(line); writeErr != nil {
				return writeErr
			}
			trimmed := bytes.TrimRight(line, "\r\n")
			if len(trimmed) == 0 {
				if len(data) > 0 {
					observeFrame(data)
					data = nil
				}
				if flushErr := controller.Flush(); flushErr != nil {
					return flushErr
				}
			} else if bytes.HasPrefix(trimmed, []byte("data:")) {
				if len(data)+len(trimmed) > 2<<20 {
					return errors.New("SSE frame exceeds observation limit")
				}
				if len(data) > 0 {
					data = append(data, '\n')
				}
				data = append(data, bytes.TrimPrefix(trimmed[5:], []byte(" "))...)
			}
		}
		if err == bufio.ErrBufferFull {
			return errors.New("SSE line exceeds limit")
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

func observe(raw []byte, out map[string]json.Number) string {
	var body struct {
		Type     string                     `json:"type"`
		Usage    map[string]json.RawMessage `json:"usage"`
		Response *struct {
			Usage map[string]json.RawMessage `json:"usage"`
		} `json:"response"`
		Message *struct {
			Usage map[string]json.RawMessage `json:"usage"`
		} `json:"message"`
	}
	if json.Unmarshal(raw, &body) != nil {
		return ""
	}
	values := body.Usage
	if body.Response != nil {
		values = body.Response.Usage
	}
	if body.Message != nil {
		values = body.Message.Usage
	}
	for _, key := range []string{"input_tokens", "output_tokens", "total_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"} {
		if v, exists := values[key]; exists {
			var n json.Number
			if json.Unmarshal(v, &n) == nil {
				if number, err := n.Int64(); err == nil && number >= 0 {
					out[key] = n
				}
			}
		}
	}
	for group, key := range map[string]string{"input_tokens_details": "cached_tokens", "output_tokens_details": "reasoning_tokens"} {
		var nested map[string]json.Number
		if json.Unmarshal(values[group], &nested) == nil {
			if n, e := nested[key].Int64(); e == nil && n >= 0 {
				out[key] = nested[key]
			}
		}
	}
	return body.Type
}
