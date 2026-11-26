package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

// TestLiveAuthorized uses real upstream capacity only when explicitly enabled.
func TestLiveAuthorized(t *testing.T) {
	if os.Getenv("GATEWAY_LIVE_TEST") != "1" {
		t.Skip("set GATEWAY_LIVE_TEST=1 to run against authorized upstreams")
	}
	origin := strings.TrimRight(os.Getenv("GATEWAY_LIVE_URL"), "/")
	key := os.Getenv("GATEWAY_LIVE_KEY")
	if origin == "" || key == "" {
		t.Fatal("GATEWAY_LIVE_URL and GATEWAY_LIVE_KEY are required")
	}
	configuredModels := 0
	for _, setting := range []string{"GATEWAY_LIVE_OPENAI_MODEL", "GATEWAY_LIVE_ANTHROPIC_MODEL", "GATEWAY_LIVE_IMAGE_MODEL", "GATEWAY_LIVE_VIDEO_MODEL"} {
		if os.Getenv(setting) != "" {
			configuredModels++
		}
	}
	if configuredModels == 0 {
		t.Fatal("at least one authorized model is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	client := &http.Client{}
	call := func(t *testing.T, method, path string, input any, want int) ([]byte, http.Header) {
		t.Helper()
		var body io.Reader
		if input != nil {
			data, err := json.Marshal(input)
			if err != nil {
				t.Fatal(err)
			}
			body = bytes.NewReader(data)
		}
		r, err := http.NewRequestWithContext(ctx, method, origin+path, body)
		if err != nil {
			t.Fatal(err)
		}
		r.Header.Set("Authorization", "Bearer "+key)
		r.Header.Set("Content-Type", "application/json")
		if method == "POST" && path == "/media/v1/jobs" {
			r.Header.Set("Idempotency-Key", "live-integration-"+time.Now().UTC().Format("20060102T150405.000000000"))
		}
		response, err := client.Do(r)
		if err != nil {
			t.Fatalf("gateway unavailable: %v", err)
		}
		defer response.Body.Close()
		if response.StatusCode != want {
			t.Fatalf("%s %s returned %d (request %s)", method, path, response.StatusCode, response.Header.Get("X-Request-Id"))
		}
		data, err := io.ReadAll(io.LimitReader(response.Body, 4<<20))
		if err != nil {
			t.Fatal(err)
		}
		return data, response.Header
	}
	for _, test := range []struct {
		name, path, modelEnv, terminal string
		request                        func(string) any
	}{
		{"responses", "/openai/v1/responses", "GATEWAY_LIVE_OPENAI_MODEL", "response.completed", func(model string) any {
			return map[string]any{"model": model, "input": "Reply with one word: gateway.", "stream": true}
		}},
		{"messages", "/anthropic/v1/messages", "GATEWAY_LIVE_ANTHROPIC_MODEL", "message_stop", func(model string) any {
			return map[string]any{"model": model, "messages": []map[string]string{{"role": "user", "content": "Reply with one word: gateway."}}, "max_tokens": 32, "stream": true}
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			model := os.Getenv(test.modelEnv)
			if model == "" {
				t.Skip(test.modelEnv + " is unset")
			}
			data, headers := call(t, "POST", test.path, test.request(model), 200)
			if !strings.HasPrefix(headers.Get("Content-Type"), "text/event-stream") || !bytes.Contains(data, []byte(test.terminal)) {
				t.Fatal("expected protocol terminal event")
			}
		})
	}
	for _, mode := range []struct{ operation, modelEnv string }{{"image.generate", "GATEWAY_LIVE_IMAGE_MODEL"}, {"video.generate", "GATEWAY_LIVE_VIDEO_MODEL"}} {
		t.Run(mode.operation, func(t *testing.T) {
			model := os.Getenv(mode.modelEnv)
			if model == "" {
				t.Skip(mode.modelEnv + " is unset")
			}
			type job struct {
				ID, Status string
				Artifacts  []string
			}
			var v job
			raw, _ := call(t, "POST", "/media/v1/jobs", map[string]string{"model": model, "operation": mode.operation, "prompt": "Minimal abstract blue shapes on a white background"}, 202)
			if err := json.Unmarshal(raw, &v); err != nil || v.ID == "" {
				t.Fatal("media task missing ID")
			}
			for v.Status != "succeeded" {
				switch v.Status {
				case "failed", "submit_unknown", "canceled":
					t.Fatalf("media task %s entered %s", v.ID, v.Status)
				}
				select {
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				case <-time.After(4 * time.Second):
				}
				raw, _ = call(t, "GET", "/media/v1/jobs/"+v.ID, nil, 200)
				if err := json.Unmarshal(raw, &v); err != nil {
					t.Fatal(err)
				}
			}
			if len(v.Artifacts) == 0 {
				t.Fatal("media result has no downloadable asset")
			}
			artifact, _ := call(t, "GET", "/media/v1/jobs/"+v.ID+"/artifacts/"+v.Artifacts[0], nil, 200)
			if len(artifact) == 0 {
				t.Fatal("media result was empty")
			}
		})
	}
}
