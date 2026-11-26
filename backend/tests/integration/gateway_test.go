package integration

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"ai-gateway/internal/access"
	"ai-gateway/internal/accounts"
	"ai-gateway/internal/app"
	"ai-gateway/internal/catalog"
	"ai-gateway/internal/coding"
	"ai-gateway/internal/console"
	"ai-gateway/internal/media"
	"ai-gateway/internal/metering"
	"ai-gateway/internal/platform"
	"ai-gateway/internal/protocol"
	"ai-gateway/internal/providers"
	"ai-gateway/internal/schema"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

func TestGateway(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set TEST_DATABASE_URL to a dedicated test database")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	db, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for range 2 {
		if err := schema.Initialize(ctx, db); err != nil {
			t.Fatal(err)
		}
	}
	var calls atomic.Int32
	var sawReference atomic.Bool
	var videoPolls atomic.Int32
	canceledUpstream := make(chan struct{}, 1)
	contractSSE := ": heartbeat\r\n\r\nevent: response.output_item.added\r\ndata: {\"type\":\"response.output_item.added\",\r\ndata: \"item\":{\"type\":\"function_call\",\"call_id\":\"call_fixture\"}}\r\n\r\ndata: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":9,\"output_tokens\":2}}}\n\n"
	const followBody = `{"model":"local","input":[{"type":"function_call_output","call_id":"call_fixture","output":"ok"}],"stream":true,"extra_fixture":{"preserve":true}}`
	startedMedia := make(chan struct{}, 1)
	releaseMedia := make(chan struct{})
	var ambiguousVideos atomic.Int32
	var ambiguousImages atomic.Int32
	var jimengProvisioned atomic.Bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/dashboard/login":
			http.SetCookie(w, &http.Cookie{Name: "session", Value: "local-session", Path: "/"})
			io.WriteString(w, `{"success":true}`)
		case "/dashboard/logout", "/dashboard/keys/1", "/account-pool/imported":
			io.WriteString(w, `{"success":true}`)
		case "/account-pool/":
			if _, err := r.Cookie("session"); err != nil {
				w.WriteHeader(401)
				return
			}
			if r.Method == "POST" {
				var input map[string]string
				if json.NewDecoder(r.Body).Decode(&input) != nil || input["sessionId"] != "fixture-cookie" {
					w.WriteHeader(400)
					return
				}
				jimengProvisioned.Store(true)
				io.WriteString(w, `{"id":"imported"}`)
			} else if jimengProvisioned.Load() {
				io.WriteString(w, `[{"id":"imported"}]`)
			} else {
				io.WriteString(w, "[]")
			}
		case "/dashboard/keys":
			if r.Method == "POST" {
				io.WriteString(w, `{"key":"jm_fixture_managed","apiKey":{"id":1}}`)
			} else {
				io.WriteString(w, "[]")
			}
		case "/token/check":
			io.WriteString(w, `{"live":true}`)
		case "/v1/models":
			switch {
			case r.Header.Get("Authorization") == "Bearer jm_fixture_managed":
				io.WriteString(w, `{"data":[{"id":"image-fixture","owned_by":"jimeng-image"},{"id":"video-fixture","owned_by":"jimeng-video"}]}`)
			case r.Header.Get("Authorization") == "Bearer codex-oauth":
				io.WriteString(w, `{"data":[{"id":"gpt-fixture"}]}`)
			case r.Header.Get("x-api-key") == "kiro-token" || r.Header.Get("x-api-key") == "claude-token" || r.Header.Get("x-api-key") == "lab-token":
				io.WriteString(w, `{"data":[{"id":"claude-fixture"}]}`)
			default:
				w.WriteHeader(401)
			}
		case "/v1/responses":
			body, _ := io.ReadAll(r.Body)
			w.Header().Set("Content-Type", "text/event-stream")
			switch {
			case strings.Contains(string(body), "cancellation-fixture"):
				io.WriteString(w, "data: {\"type\":\"response.output_text.delta\"}\n\n")
				w.(http.Flusher).Flush()
				select {
				case <-r.Context().Done():
					canceledUpstream <- struct{}{}
				case <-time.After(10 * time.Second):
				}
				return
			case strings.Contains(string(body), "tool-contract-fixture"):
				for i := 0; i < len(contractSSE); i += 7 {
					end := min(i+7, len(contractSSE))
					io.WriteString(w, contractSSE[i:end])
					w.(http.Flusher).Flush()
				}
				return
			case strings.Contains(string(body), "call_fixture"):
				if string(body) != followBody {
					http.Error(w, "payload changed", 400)
					return
				}
				io.WriteString(w, "data: {\"type\":\"response.completed\"}\n\n")
				return
			}
			if strings.Contains(string(body), "break-stream") {
				io.WriteString(w, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n")
				return
			}
			io.WriteString(w, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":4}}}\n\n")
		case "/v1/messages/count_tokens":
			w.Header().Set("Content-Type", "application/json")
			key := r.Header.Get("x-api-key")
			validKey := key == "claude-token" || key == "lab-token" || key == "mock-key" && r.Header.Get("anthropic-beta") == "fixture-beta"
			if !validKey || r.Header.Get("Authorization") != "" || r.Header.Get("anthropic-version") != "2023-06-01" {
				http.Error(w, "header mismatch", 400)
				return
			}
			io.WriteString(w, `{"input_tokens":7}`)

		case "/v1/messages":
			switch r.Header.Get("x-api-key") {
			case "mock-key", "kiro-token", "claude-token", "lab-token":
			default:
				w.WriteHeader(401)
				return
			}
			w.Header().Set("Content-Type", "text/event-stream")
			io.WriteString(w, "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":3}}}\n\ndata: {\"type\":\"message_stop\"}\n\n")

		case "/v1/images/edits":
			body, _ := io.ReadAll(r.Body)
			if bytes.Contains(body, []byte(`"ratio"`)) || bytes.Contains(body, []byte(`"filePath"`)) ||
				!bytes.Contains(body, []byte(`"size":"1024x1024"`)) || !bytes.Contains(body, []byte(`"images":[{"image_url":"data:image/png;base64,`)) {
				w.WriteHeader(400)
				return
			}
			io.WriteString(w, `{"data":[{"b64_json":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC9sAAAAASUVORK5CYII="}]}`)
		case "/v1/images/generations":
			body, _ := io.ReadAll(r.Body)
			if bytes.Contains(body, []byte(`"model":"image-fixture"`)) {
				if r.Header.Get("Authorization") != "Bearer jm_fixture_managed" {
					w.WriteHeader(401)
					return
				}
				io.WriteString(w, `{"data":[{"b64_json":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC9sAAAAASUVORK5CYII="}]}`)
				return
			}
			if strings.Contains(string(body), "mixed-load-image") {
				startedMedia <- struct{}{}
				select {
				case <-releaseMedia:
				case <-r.Context().Done():
					return
				}
				io.WriteString(w, `{"data":[{"b64_json":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC9sAAAAASUVORK5CYII="}]}`)
				return
			}
			if strings.Contains(string(body), "never-replay-image") {
				ambiguousImages.Add(1)
				w.WriteHeader(502)
				return
			}
			calls.Add(1)
			io.WriteString(w, `{"usage":{"credits_used":1.25},"data":[{"b64_json":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC9sAAAAASUVORK5CYII="}]}`)
		case "/v1/videos":
			body, _ := io.ReadAll(r.Body)
			if bytes.Contains(body, []byte(`"model":"video-fixture"`)) {
				if r.Header.Get("Authorization") != "Bearer jm_fixture_managed" {
					w.WriteHeader(401)
					return
				}
				io.WriteString(w, `{"id":"video_enrolled"}`)
				return
			}
			if bytes.Contains(body, []byte("data:image/png;base64,")) {
				sawReference.Store(true)
			}
			if strings.Contains(string(body), "never-replay-video") {
				if r.Header.Get("Idempotency-Key") == "" {
					w.WriteHeader(400)
					return
				}
				ambiguousVideos.Add(1)
				if connection, _, err := w.(http.Hijacker).Hijack(); err == nil {
					connection.Close()
				}
				return
			}
			calls.Add(1)
			io.WriteString(w, `{"id":"video_fixture"}`)
		case "/v1/videos/video_fixture":
			if videoPolls.Add(1) == 1 {
				io.WriteString(w, `{"status":"in_progress","progress":80,"cover_url":"https://fixture.invalid/cover.png"}`)
				return
			}
			io.WriteString(w, `{"status":"completed"}`)
		case "/v1/videos/video_enrolled":
			if r.Header.Get("Authorization") != "Bearer jm_fixture_managed" {
				w.WriteHeader(401)
				return
			}
			io.WriteString(w, `{"status":"completed"}`)
		case "/v1/videos/video_enrolled/content":
			if r.Header.Get("Authorization") != "Bearer jm_fixture_managed" {
				w.WriteHeader(401)
				return
			}
			w.Header().Set("Content-Type", "video/mp4")
			io.WriteString(w, "\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom")
		case "/v1/videos/video_fixture/content":
			w.Header().Set("Content-Type", "video/mp4")
			io.WriteString(w, "\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom")
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()
	key := bytes.Repeat([]byte{6}, 32)
	enc := bytes.Repeat([]byte{8}, 32)
	a := access.Store{DB: db, Key: key}
	c := catalog.Store{DB: db, Key: enc}
	makeProject := func() (access.Identity, string) {
		t.Helper()
		who := access.Identity{Tenant: platform.ID(), Project: platform.ID(), Principal: platform.ID()}
		run := func(query string, args ...any) {
			if _, err := db.Exec(ctx, query, args...); err != nil {
				t.Fatal(err)
			}
		}
		run("INSERT INTO tenants(id,name) VALUES($1,'test')", who.Tenant)
		run("INSERT INTO projects(id,tenant_id,name) VALUES($1,$2,'test')", who.Project, who.Tenant)
		run("INSERT INTO project_principals(id,tenant_id,project_id,role) VALUES($1,$2,$3,'service')", who.Principal, who.Tenant, who.Project)
		keyID, token, err := a.Issue(ctx, db, who, "integration")
		if err != nil {
			t.Fatal(err)
		}
		pools := map[string]string{}
		for provider, id := range map[string]string{"openai": "codex", "anthropic": "claude", "jimeng": "jimeng"} {
			pool := platform.ID()
			pools[provider] = pool
			run("INSERT INTO account_pools(id,tenant_id,project_id,provider,slug) VALUES($1,$2,$3,$4,$4||'-fixture')", pool, who.Tenant, who.Project, id)
			run("INSERT INTO key_grants(tenant_id,project_id,key_id,principal_id,pool_id) VALUES($1,$2,$3,$4,$5)", who.Tenant, who.Project, keyID, who.Principal, pool)
		}
		for op, provider := range map[string]string{"responses": "openai", "messages": "anthropic", "image.generate": "jimeng", "video.generate": "jimeng"} {
			conn := platform.ID()
			secure, err := platform.Seal(enc, conn, "mock-key")
			if err != nil {
				t.Fatal(err)
			}
			wire := protocol.Kind(op)
			if provider == "jimeng" {
				wire = protocol.Media
			}
			run(`INSERT INTO upstream_accounts(id,tenant_id,project_id,pool_id,protocol,label,base_url,execution_secret,managed,credential_fingerprint,count_tokens)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,false,$9,$10)`, conn, who.Tenant, who.Project, pools[provider], wire, provider, upstream.URL, secure, []byte(conn), op == "messages")
			run("INSERT INTO account_models(tenant_id,project_id,operation,model,upstream_model,account_id) VALUES($1,$2,$3,'local','local',$4)", who.Tenant, who.Project, op, conn)
		}
		return who, token
	}
	owner, token := makeProject()
	_, other := makeProject()
	m := &media.Service{DB: db, Catalog: c, Dir: t.TempDir(), Client: upstream.Client()}
	workerContext, stopWorker := context.WithCancel(ctx)
	defer stopWorker()
	workerDone := make(chan struct{})
	go func() { defer close(workerDone); m.Run(workerContext) }()
	providerRegistry, err := providers.New(providers.Config{Codex: upstream.URL, Kiro: upstream.URL, Claude: upstream.URL}).WithExecutors(
		[]providers.Executor{{Provider: "jimeng", URL: upstream.URL, Username: "fixture", Password: "fixture"}},
	)
	if err != nil {
		t.Fatal(err)
	}
	providerRegistry, err = providerRegistry.WithCompatible([]providers.Compatible{{
		ID: "lab", Label: "Lab", Base: upstream.URL, Protocol: protocol.Messages, CountTokens: true,
	}})
	if err != nil {
		t.Fatal(err)
	}
	providerRegistry = providerRegistry.WithOAuthClients(map[string]providers.OAuthClient{"codex": {
		AuthorizeURL: "https://issuer.invalid/authorize", TokenURL: "https://issuer.invalid/token", ClientID: "fixture-client",
	}})
	server := httptest.NewServer((app.App{DB: db, Access: a, Coding: &coding.Service{Access: a, Catalog: c, Metrics: metering.Store{DB: db}, Client: upstream.Client()}, Media: m, Console: console.Service{DB: db, Store: a, Catalog: c, PublicBase: "http://console.local",
		AccountsService: accounts.Service{DB: db, Key: enc,
			Providers: providerRegistry,
		},
	}}).Handler())
	defer server.Close()
	send := func(verb, path, payload, key, idem string, want int) string {
		t.Helper()
		request, err := http.NewRequest(verb, server.URL+path, strings.NewReader(payload))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Authorization", "Bearer "+key)
		request.Header.Set("Content-Type", "application/json")
		if idem != "" {
			request.Header.Set("Idempotency-Key", idem)
		}
		response, err := server.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		raw, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != want {
			t.Fatalf("%s %s = %d, want %d: %s", verb, path, response.StatusCode, want, raw)
		}
		return string(raw)
	}
	if s := send("POST", "/openai/v1/responses", `{"model":"local","stream":true}`, token, "", 200); !strings.Contains(s, "response.completed") {
		t.Fatal(s)
	}
	if s := send("POST", "/anthropic/v1/messages", `{"model":"local","stream":true}`, token, "", 200); !strings.Contains(s, "message_stop") {
		t.Fatal(s)
	}
	t.Run("codex_tool_and_fragmented_sse", func(t *testing.T) {
		body := send("POST", "/openai/v1/responses", `{"model":"local","input":"tool-contract-fixture","stream":true}`, token, "", 200)
		if body != contractSSE {
			t.Fatalf("gateway altered SSE events: %q", body)
		}
		if body = send("POST", "/openai/v1/responses", followBody, token, "", 200); !strings.Contains(body, "response.completed") {
			t.Fatal(body)
		}
	})
	t.Run("anthropic_count_tokens_and_headers", func(t *testing.T) {
		req, _ := http.NewRequest("POST", server.URL+"/anthropic/v1/messages/count_tokens", strings.NewReader(`{"model":"local","messages":[{"role":"user","content":"test"}]}`))
		req.Header.Set("x-api-key", token)
		req.Header.Set("anthropic-beta", "fixture-beta")
		res, err := server.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		body, _ := io.ReadAll(res.Body)
		if res.StatusCode != 200 || string(body) != `{"input_tokens":7}` {
			t.Fatalf("%d: %s", res.StatusCode, body)
		}
	})
	t.Run("client_cancellation_reaches_upstream", func(t *testing.T) {
		context, cancel := context.WithTimeout(ctx, 8*time.Second)
		defer cancel()
		req, _ := http.NewRequestWithContext(context, "POST", server.URL+"/openai/v1/responses", strings.NewReader(`{"model":"local","input":"cancellation-fixture","stream":true}`))
		req.Header.Set("Authorization", "Bearer "+token)
		res, err := server.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		id := res.Header.Get("X-Request-Id")
		cancel()
		res.Body.Close()
		select {
		case <-canceledUpstream:
		case <-time.After(5 * time.Second):
			t.Fatal("upstream did not see cancellation")
		}
		until := time.Now().Add(5 * time.Second)
		for {
			var status string
			if err := db.QueryRow(ctx, "SELECT status FROM requests WHERE id=$1", id).Scan(&status); err != nil {
				t.Fatal(err)
			}
			if status == "client_canceled" {
				break
			}
			if time.Now().After(until) {
				t.Fatalf("unexpected status after cancel: %s", status)
			}
			time.Sleep(25 * time.Millisecond)
		}
	})
	var payloadBuffer bytes.Buffer
	form := multipart.NewWriter(&payloadBuffer)
	file, err := form.CreateFormFile("file", "frame.png")
	if err != nil {
		t.Fatal(err)
	}
	png, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC9sAAAAASUVORK5CYII=")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = file.Write(png); err != nil {
		t.Fatal(err)
	}
	if err = form.Close(); err != nil {
		t.Fatal(err)
	}
	upload, _ := http.NewRequest("POST", server.URL+"/media/v1/assets", &payloadBuffer)
	upload.Header.Set("Authorization", "Bearer "+token)
	upload.Header.Set("Content-Type", form.FormDataContentType())
	res, err := server.Client().Do(upload)
	if err != nil {
		t.Fatal(err)
	}
	var asset struct {
		ID string `json:"asset_id"`
	}
	err = json.NewDecoder(res.Body).Decode(&asset)
	res.Body.Close()
	if err != nil || res.StatusCode != 201 || asset.ID == "" {
		t.Fatalf("upload status=%d: %v", res.StatusCode, err)
	}
	if _, err = db.Exec(ctx, `UPDATE account_models SET capabilities='{"input_roles":["first_frame"]}' WHERE operation='video.generate'`); err != nil {
		t.Fatal(err)
	}
	withReference := `{"model":"local","operation":"video.generate","prompt":"test","inputs":[{"role":"first_frame","asset_id":"` + asset.ID + `"}]}`
	send("POST", "/media/v1/jobs", withReference, other, "foreign-asset", 404)
	siblingID, siblingKey, err := a.Issue(ctx, db, owner, "same-principal-media-key")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(ctx, `INSERT INTO key_grants(tenant_id,project_id,key_id,principal_id,pool_id)
 SELECT tenant_id,project_id,$2,$3,id FROM account_pools WHERE project_id=$1 AND slug='jimeng-fixture'`, owner.Project, siblingID, owner.Principal); err != nil {
		t.Fatal(err)
	}
	if result := send("POST", "/media/v1/jobs", withReference, siblingKey, "other-key-asset", 404); !strings.Contains(result, "asset_not_found") {
		t.Fatalf("same-principal Key reached the wrong authorization check: %s", result)
	}

	for _, op := range []string{"image.generate", "video.generate"} {
		payload := `{"model":"local","operation":"` + op + `","prompt":"test"}`
		if op == "video.generate" {
			payload = withReference
		}
		var job struct {
			ID, Status string
			Artifacts  []string
			Credits    *string `json:"credits_used"`
			Progress   *int
		}
		decode := func(s string) {
			t.Helper()
			if err := json.Unmarshal([]byte(s), &job); err != nil {
				t.Fatal(err)
			}
		}
		decode(send("POST", "/media/v1/jobs", payload, token, "stable", 202))
		id := job.ID
		decode(send("POST", "/media/v1/jobs", payload, token, "stable", 200))
		if job.ID != id {
			t.Fatal("idempotency replay returned a different task")
		}
		send("POST", "/media/v1/jobs", strings.Replace(payload, "test", "another", 1), token, "stable", 409)
		send("GET", "/media/v1/jobs/"+id, "", other, "", 404)
		deadline := time.Now().Add(20 * time.Second)
		observedPreviewOnly := false
		for job.Status != "succeeded" && time.Now().Before(deadline) {
			time.Sleep(300 * time.Millisecond)
			decode(send("GET", "/media/v1/jobs/"+id, "", token, "", 200))
			if op == "video.generate" && job.Status == "running" && job.Progress != nil && *job.Progress == 80 {
				if len(job.Artifacts) != 0 {
					t.Fatal("cover leaked as final video asset")
				}
				observedPreviewOnly = true
			}
		}
		if len(job.Artifacts) != 1 || job.Status != "succeeded" {
			t.Fatalf("%s: %+v", op, job)
		}
		if op == "video.generate" {
			if !observedPreviewOnly {
				t.Fatal("did not observe the running state with cover only")
			}
			request, err := http.NewRequest("GET", server.URL+"/media/v1/jobs/"+id+"/artifacts/"+job.Artifacts[0], nil)
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("Authorization", "Bearer "+token)
			request.Header.Set("Range", "bytes=4-7")
			response, err := server.Client().Do(request)
			if err != nil {
				t.Fatal(err)
			}
			segment, err := io.ReadAll(response.Body)
			response.Body.Close()
			if err != nil || response.StatusCode != 206 || string(segment) != "ftyp" {
				t.Fatalf("wrong video range %d: %q", response.StatusCode, segment)
			}
		}

		if op == "image.generate" && (job.Credits == nil || *job.Credits != "1.25") {
			t.Fatalf("reported credits=%v", job.Credits)
		}
		if op == "video.generate" && job.Credits != nil {
			t.Fatal("absent video credits were fabricated")
		}

		send("GET", "/media/v1/jobs/"+id+"/artifacts/"+job.Artifacts[0], "", token, "", 200)
		send("GET", "/media/v1/jobs/"+id+"/artifacts/"+job.Artifacts[0], "", other, "", 404)
	}
	if !sawReference.Load() || videoPolls.Load() < 2 {
		t.Fatal("did not exercise first-frame forwarding and deferred video result")
	}

	var imageConn string
	if err = db.QueryRow(ctx, `SELECT account_id FROM account_models WHERE project_id=$1 AND operation='image.generate'`, owner.Project).Scan(&imageConn); err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(ctx, `INSERT INTO account_models(tenant_id,project_id,operation,model,upstream_model,account_id,capabilities)
	VALUES($1,$2,'image.generate','modern-image','local',$3,'{"aspect_ratios":["1:1"],"image_sizes":{"1:1":"1024x1024"},"input_roles":["reference_image"]}')`, owner.Tenant, owner.Project, imageConn)
	if err != nil {
		t.Fatal(err)
	}
	// A less recently used account in the same pool cannot accept image references.
	if _, err = db.Exec(ctx, `INSERT INTO account_models(tenant_id,project_id,operation,model,upstream_model,account_id)
 SELECT tenant_id,project_id,'image.generate','modern-image','text-only-image',account_id
 FROM account_models WHERE project_id=$1 AND operation='video.generate'`, owner.Project); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(ctx, `UPDATE upstream_accounts SET last_used_at=NULL WHERE id IN (
 SELECT account_id FROM account_models WHERE project_id=$1 AND operation='video.generate')`, owner.Project); err != nil {
		t.Fatal(err)
	}
	var edit struct{ ID, Status string }
	editPayload := `{"model":"modern-image","operation":"image.generate","prompt":"edit","spec":{"aspect_ratio":"1:1"},"inputs":[{"role":"reference_image","asset_id":"` + asset.ID + `"}]}`
	if err = json.Unmarshal([]byte(send("POST", "/media/v1/jobs", editPayload, token, "modern-image-edit", 202)), &edit); err != nil {
		t.Fatal(err)
	}
	editDeadline := time.Now().Add(8 * time.Second)
	for edit.Status != "succeeded" && time.Now().Before(editDeadline) {
		time.Sleep(200 * time.Millisecond)
		if err = json.Unmarshal([]byte(send("GET", "/media/v1/jobs/"+edit.ID, "", token, "", 200)), &edit); err != nil {
			t.Fatal(err)
		}
	}
	if edit.Status != "succeeded" {
		t.Fatalf("modern edit reached %s", edit.Status)
	}

	// A dial failure before any request bytes were sent can select another authorized account.
	closed, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	dead := "http://" + closed.Addr().String()
	closed.Close()
	var primary, pool, route string
	err = db.QueryRow(ctx, `SELECT r.id,a.id,a.pool_id FROM account_models r JOIN upstream_accounts a ON a.id=r.account_id
	WHERE r.project_id=$1 AND r.operation='responses'`, owner.Project).Scan(&route, &primary, &pool)
	if err != nil {
		t.Fatal(err)
	}
	backup := platform.ID()
	sealed, err := platform.Seal(enc, backup, "test")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(ctx, `INSERT INTO upstream_accounts(id,tenant_id,project_id,pool_id,protocol,label,base_url,execution_secret,managed,credential_fingerprint,last_used_at)
 VALUES($1,$2,$3,$4,'responses','backup',$5,$6,false,$7,now())`, backup, owner.Tenant, owner.Project, pool, upstream.URL, sealed, []byte(backup)); err != nil {
		t.Fatal(err)
	}

	if _, err = db.Exec(ctx, `INSERT INTO account_models(tenant_id,project_id,operation,model,upstream_model,account_id)
	SELECT tenant_id,project_id,operation,model,upstream_model,$2 FROM account_models WHERE id=$1`, route, backup); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(ctx, `UPDATE upstream_accounts SET base_url=$2 WHERE id=$1`, primary, dead); err != nil {
		t.Fatal(err)
	}
	send("POST", "/openai/v1/responses", `{"model":"local","stream":true}`, token, "", 200)
	var attempts int
	if err = db.QueryRow(ctx, `SELECT count(*) FROM upstream_attempts a JOIN requests r ON r.id=a.request_id
	WHERE r.id=(SELECT id FROM requests WHERE project_id=$1 AND operation='responses' ORDER BY created_at DESC LIMIT 1)`, owner.Project).Scan(&attempts); err != nil || attempts != 2 {
		t.Fatalf("backup attempts=%d: %v", attempts, err)
	}

	if _, err = db.Exec(ctx, "UPDATE upstream_accounts SET base_url=$2 WHERE id=$1", primary, upstream.URL); err != nil {
		t.Fatal(err)
	}
	output := send("POST", "/openai/v1/responses", `{"model":"local","stream":true,"input":"break-stream"}`, token, "", 200)
	if !strings.Contains(output, "partial") || strings.Contains(output, "response.completed") {
		t.Fatal("invalid interrupted stream")
	}
	var streamStatus string
	err = db.QueryRow(ctx, `SELECT r.status,count(a.id) FROM requests r JOIN upstream_attempts a ON a.request_id=r.id
	WHERE r.id=(SELECT id FROM requests WHERE project_id=$1 AND operation='responses' ORDER BY created_at DESC LIMIT 1)
	GROUP BY r.status`, owner.Project).Scan(&streamStatus, &attempts)
	if err != nil || streamStatus != "interrupted" || attempts != 1 {
		t.Fatalf("interrupted stream status=%s attempts=%d: %v", streamStatus, attempts, err)
	}
	waitStatus := func(prompt, op, want string) {
		t.Helper()
		body := `{"model":"local","operation":"` + op + `","prompt":"` + prompt + `"}`
		var job struct{ ID, Status string }
		if err := json.Unmarshal([]byte(send("POST", "/media/v1/jobs", body, token, prompt, 202)), &job); err != nil {
			t.Fatal(err)
		}
		until := time.Now().Add(15 * time.Second)
		for job.Status != want && time.Now().Before(until) {
			time.Sleep(300 * time.Millisecond)
			if err := json.Unmarshal([]byte(send("GET", "/media/v1/jobs/"+job.ID, "", token, "", 200)), &job); err != nil {
				t.Fatal(err)
			}
		}
		if job.Status != want {
			t.Fatalf("job %s reached %s, want %s", prompt, job.Status, want)
		}
	}
	waitStatus("never-replay-video", "video.generate", "submit_unknown")
	waitStatus("never-replay-image", "image.generate", "submit_unknown")
	stopWorker()
	<-workerDone
	var leaseJob struct{ ID string }
	body := `{"model":"local","operation":"image.generate","prompt":"abandoned-worker"}`
	if err = json.Unmarshal([]byte(send("POST", "/media/v1/jobs", body, token, "abandoned-worker", 202)), &leaseJob); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(ctx, "UPDATE media_jobs SET status='submitting',input=NULL,lease_until=now()-interval '5 minutes' WHERE id=$1 AND status='queued'", leaseJob.ID); err != nil {
		t.Fatal(err)
	}
	go m.Run(ctx)
	until := time.Now().Add(5 * time.Second)
	for {
		var state string
		if err = db.QueryRow(ctx, "SELECT status FROM media_jobs WHERE id=$1", leaseJob.ID).Scan(&state); err != nil {
			t.Fatal(err)
		}
		if state == "submit_unknown" {
			break
		}
		if time.Now().After(until) {
			t.Fatalf("expired submission lease left job in %s", state)
		}
		time.Sleep(100 * time.Millisecond)
	}
	if ambiguousImages.Load() != 1 || ambiguousVideos.Load() != 1 {
		t.Fatalf("ambiguous image/video submissions: %d/%d", ambiguousImages.Load(), ambiguousVideos.Load())
	}
	var page struct {
		Data []struct{ ID string }
		Next string `json:"next_cursor"`
	}
	decodePage := func(path, key string) {
		t.Helper()
		if err := json.Unmarshal([]byte(send("GET", path, "", key, "", 200)), &page); err != nil {
			t.Fatal(err)
		}
	}
	decodePage("/media/v1/jobs?limit=1", token)
	if len(page.Data) != 1 || page.Next == "" {
		t.Fatal("media page missing cursor")
	}
	firstID, cursor := page.Data[0].ID, page.Next
	decodePage("/media/v1/jobs?limit=1&cursor="+url.QueryEscape(cursor), token)
	if len(page.Data) != 1 || page.Data[0].ID == firstID {
		t.Fatal("pagination returned same job")
	}
	send("GET", "/media/v1/jobs?limit=1&cursor="+url.QueryEscape(cursor), "", other, "", 400)
	send("GET", "/media/v1/jobs?limit=1&status=failed&cursor="+url.QueryEscape(cursor), "", token, "", 400)
	orphan := filepath.Join(m.Dir, platform.ID())
	if err = os.WriteFile(orphan, []byte("unused"), 0600); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if err = os.Chtimes(orphan, now.Add(-48*time.Hour), now.Add(-48*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err = m.Sweep(ctx, media.Retention{SessionsBefore: now, AssetsBefore: now.AddDate(0, 0, -30), OrphansBefore: now.Add(-24 * time.Hour), IdempotencyBefore: now.AddDate(0, 0, -30), RequestsBefore: now.AddDate(0, 0, -30), AuditBefore: now.AddDate(0, 0, -90)}); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(orphan); !os.IsNotExist(err) {
		t.Fatal("orphan was not collected")
	}
	send("POST", "/media/v1/jobs", `{"model":"local","operation":"image.generate","prompt":"mixed-load-image"}`, token, "mixed", 202)
	select {
	case <-startedMedia:
	case <-time.After(5 * time.Second):
		t.Fatal("media worker did not start")
	}
	send("POST", "/anthropic/v1/messages", `{"model":"local","stream":true}`, token, "", 200)
	if result := send("GET", "/metrics", "", token, "", 200); !strings.Contains(result, `gateway_media_jobs{state="active"} 1`) {
		t.Fatalf("metrics did not report active media work: %s", result)
	}
	close(releaseMedia)

	hash, err := bcrypt.GenerateFromPassword([]byte("fixture-password"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	var user string
	username := "admin-" + platform.ID()
	if err = db.QueryRow(ctx, "INSERT INTO users(username,password_hash) VALUES($1,$2) RETURNING id", username, hash).Scan(&user); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(ctx, "UPDATE project_principals SET user_id=$2,role='admin' WHERE id=$1", owner.Principal, user); err != nil {
		t.Fatal(err)
	}
	jar, _ := cookiejar.New(nil)
	browser := &http.Client{Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	browse := func(method, path, payload string, want int) string {
		t.Helper()
		r, err := http.NewRequest(method, server.URL+path, strings.NewReader(payload))
		if err != nil {
			t.Fatal(err)
		}
		r.Header.Set("Origin", "http://console.local")
		r.Header.Set("X-Gateway-CSRF", "1")
		res, err := browser.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		raw, _ := io.ReadAll(res.Body)
		if res.StatusCode != want {
			t.Fatalf("%s %s returned %d: %s", method, path, res.StatusCode, raw)
		}
		return string(raw)
	}
	browse("POST", "/console/v1/session", `{"username":"`+username+`","password":"fixture-password"}`, 200)
	base := "/console/v1/projects/" + owner.Project
	var authorization struct {
		ID  string
		URL string `json:"authorization_url"`
	}
	if err = json.Unmarshal([]byte(browse("POST", base+"/account-authorizations", `{"provider":"codex"}`, 201)), &authorization); err != nil || authorization.ID == "" {
		t.Fatalf("authorization setup: %v", err)
	}
	issuer, err := url.Parse(authorization.URL)
	if err != nil || issuer.Query().Get("code_challenge_method") != "S256" || issuer.Query().Get("state") == "" {
		t.Fatalf("authorization binding not issued: %v", err)
	}
	callback := "/console/v1/oauth/callback?error=access_denied&state=" + url.QueryEscape(issuer.Query().Get("state"))
	if result := browse("GET", base+"/account-authorizations/"+authorization.ID, "", 200); !strings.Contains(result, `"status":"waiting"`) {
		t.Fatal("unexpected pending authorization state")
	}
	browse("GET", callback, "", 303)
	browse("GET", callback, "", 400)
	if result := browse("GET", base+"/account-authorizations/"+authorization.ID, "", 200); !strings.Contains(result, `"status":"failed"`) {
		t.Fatal("canceled authorization remained pending")
	}
	type enrollment struct {
		ID     string
		PoolID string `json:"pool_id"`
	}
	enroll := func(provider, credential string) enrollment {
		t.Helper()
		body, _ := json.Marshal(map[string]string{"provider": provider, "credential": credential})
		var result enrollment
		if err := json.Unmarshal([]byte(browse("POST", base+"/account-enrollments", string(body), 201)), &result); err != nil || result.PoolID == "" {
			t.Fatalf("enrollment %s: %v", provider, err)
		}
		return result
	}
	jimeng := enroll("jimeng", "sessionid=fixture-cookie")
	browse("POST", base+"/account-enrollments", `{"provider":"jimeng","credential":"sessionid=fixture-cookie"}`, 409)
	codex := enroll("codex", `{"tokens":{"access_token":"codex-oauth"}}`)
	kiro := enroll("kiro", `{"accessToken":"kiro-token"}`)
	claude := enroll("claude", "claude-token")
	lab := enroll("lab", "lab-token")
	var pooledKey struct{ ID, Key string }
	if err := json.Unmarshal([]byte(browse("POST", base+"/keys", `{"label":"pooled","pools":["`+codex.PoolID+`","`+kiro.PoolID+`"]}`, 201)), &pooledKey); err != nil || pooledKey.Key == "" {
		t.Fatalf("issue scoped key: %v", err)
	}
	models := send("GET", "/openai/v1/models", "", pooledKey.Key, "", 200)
	if !strings.Contains(models, "/gpt-fixture") || strings.Contains(models, `"id":"local"`) {
		t.Fatalf("invalid scoped model list: %s", models)
	}
	var codexSlug, kiroSlug, claudeSlug, labSlug string
	for _, entry := range []struct {
		id   string
		slug *string
	}{{codex.PoolID, &codexSlug}, {kiro.PoolID, &kiroSlug}, {claude.PoolID, &claudeSlug}, {lab.PoolID, &labSlug}} {
		if err := db.QueryRow(ctx, "SELECT slug FROM account_pools WHERE id=$1", entry.id).Scan(entry.slug); err != nil {
			t.Fatal(err)
		}
	}
	send("POST", "/openai/v1/responses", `{"model":"`+codexSlug+`/gpt-fixture","stream":true}`, pooledKey.Key, "", 200)
	send("POST", "/anthropic/v1/messages", `{"model":"`+kiroSlug+`/claude-fixture","stream":true}`, pooledKey.Key, "", 200)
	send("POST", "/openai/v1/responses", `{"model":"local","stream":true}`, pooledKey.Key, "", 404)
	send("POST", "/anthropic/v1/messages/count_tokens", `{"model":"`+kiroSlug+`/claude-fixture","messages":[]}`, pooledKey.Key, "", 400)
	var extra struct{ Key string }
	if err := json.Unmarshal([]byte(browse("POST", base+"/keys", `{"label":"messages","pools":["`+claude.PoolID+`","`+lab.PoolID+`"]}`, 201)), &extra); err != nil || extra.Key == "" {
		t.Fatalf("issue Key for two Messages providers: %v", err)
	}
	for _, slug := range []string{claudeSlug, labSlug} {
		send("POST", "/anthropic/v1/messages", `{"model":"`+slug+`/claude-fixture","stream":true}`, extra.Key, "", 200)
		send("POST", "/anthropic/v1/messages/count_tokens", `{"model":"`+slug+`/claude-fixture","messages":[]}`, extra.Key, "", 200)
		send("POST", "/anthropic/v1/messages", `{"model":"`+slug+`/claude-fixture","stream":true}`, pooledKey.Key, "", 404)
	}

	var rotated struct{ ID, Key string }
	if err := json.Unmarshal([]byte(browse("POST", base+"/keys/"+pooledKey.ID+"/rotate", "", 201)), &rotated); err != nil || rotated.ID != pooledKey.ID {
		t.Fatalf("rotation changed the logical key: %v", err)
	}
	send("GET", "/openai/v1/models", "", pooledKey.Key, "", 401)
	send("GET", "/openai/v1/models", "", rotated.Key, "", 200)
	var visibleSecrets string
	visibleSecrets = browse("GET", base+"/accounts", "", 200)
	if strings.Contains(visibleSecrets, "fixture-cookie") || strings.Contains(visibleSecrets, "jm_fixture_managed") {
		t.Fatal("account list leaked upstream credentials")
	}
	var jimengSlug string
	if err = db.QueryRow(ctx, "SELECT slug FROM account_pools WHERE id=$1", jimeng.PoolID).Scan(&jimengSlug); err != nil {
		t.Fatal(err)
	}
	var mediaKey struct{ Key string }
	if err = json.Unmarshal([]byte(browse("POST", base+"/keys", `{"label":"jimeng","pools":["`+jimeng.PoolID+`"]}`, 201)), &mediaKey); err != nil || mediaKey.Key == "" {
		t.Fatalf("issue media Key: %v", err)
	}
	for _, kind := range []string{"image", "video"} {
		var job struct {
			ID, Status string
			Artifacts  []string
		}
		body := `{"model":"` + jimengSlug + `/` + kind + `-fixture","operation":"` + kind + `.generate","prompt":"test"}`
		if err = json.Unmarshal([]byte(send("POST", "/media/v1/jobs", body, mediaKey.Key, kind+"-enrolled", 202)), &job); err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(12 * time.Second)
		for job.Status != "succeeded" && time.Now().Before(deadline) {
			time.Sleep(300 * time.Millisecond)
			if err = json.Unmarshal([]byte(send("GET", "/media/v1/jobs/"+job.ID, "", mediaKey.Key, "", 200)), &job); err != nil {
				t.Fatal(err)
			}
		}
		if job.Status != "succeeded" || len(job.Artifacts) != 1 {
			t.Fatalf("enrolled Jimeng %s job did not deliver: %+v", kind, job)
		}
	}
	browse("PATCH", base+"/accounts/"+jimeng.ID, `{"enabled":false}`, 204)
	if _, err = db.Exec(ctx, `UPDATE upstream_accounts SET expires_at=now()-interval '1 minute' WHERE id=$1`, codex.ID); err != nil {
		t.Fatal(err)
	}
	if result := send("GET", "/openai/v1/models", "", rotated.Key, "", 200); strings.Contains(result, "/gpt-fixture") {
		t.Fatalf("expired account model is still visible: %s", result)
	}

	var keyForCheck string
	if err = db.QueryRow(ctx, "SELECT id FROM api_keys WHERE principal_id=$1 AND label='integration'", owner.Principal).Scan(&keyForCheck); err != nil {
		t.Fatal(err)
	}
	var check struct{ ID string }
	if err = json.Unmarshal([]byte(browse("POST", base+"/setup/checks", `{"key_id":"`+keyForCheck+`","model":"local","operation":"responses"}`, 201)), &check); err != nil {
		t.Fatal(err)
	}
	if result := browse("GET", base+"/setup/checks/"+check.ID, "", 200); !strings.Contains(result, `"status":"waiting"`) {
		t.Fatal("onboarding matched a historical generation")
	}
	send("GET", "/openai/v1/models", "", token, "", 200)
	if result := browse("GET", base+"/setup/checks/"+check.ID, "", 200); !strings.Contains(result, `"status":"waiting"`) {
		t.Fatal("onboarding matched a discovery request")
	}
	send("POST", "/openai/v1/responses", `{"model":"local","stream":true}`, token, "", 200)
	if result := browse("GET", base+"/setup/checks/"+check.ID, "", 200); !strings.Contains(result, `"status":"succeeded"`) {
		t.Fatalf("onboarding missing verified generation: %s", result)
	}

	browse("GET", base+"/requests", "", 200)
	var requestPage struct {
		Next string `json:"next_cursor"`
	}
	if err = json.Unmarshal([]byte(browse("GET", base+"/requests?limit=1", "", 200)), &requestPage); err != nil || requestPage.Next == "" {
		t.Fatalf("request cursor missing: %v", err)
	}
	browse("GET", base+"/requests?limit=1&cursor="+url.QueryEscape(requestPage.Next), "", 200)
	browse("GET", base+"/usage/export", "", 200)
	browse("GET", base+"/members", "", 200)
	if _, err = db.Exec(ctx, "UPDATE api_keys SET revoked_at=now() WHERE principal_id=$1", owner.Principal); err != nil {
		t.Fatal(err)
	}
	send("GET", "/openai/v1/models", "", token, "", 401)
	if calls.Load() != 2 {
		t.Fatalf("got %d upstream submissions, want 2", calls.Load())
	}
}
