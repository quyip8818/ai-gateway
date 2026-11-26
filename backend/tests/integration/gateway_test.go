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
	"ai-gateway/internal/app"
	"ai-gateway/internal/catalog"
	"ai-gateway/internal/coding"
	"ai-gateway/internal/console"
	"ai-gateway/internal/media"
	"ai-gateway/internal/metering"
	"ai-gateway/internal/platform"
	"ai-gateway/migrations"
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
	if err := migrations.Apply(ctx, db); err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	var sawReference atomic.Bool
	var videoPolls atomic.Int32
	canceledUpstream := make(chan struct{}, 1)
	contractSSE := ": heartbeat\r\n\r\nevent: response.output_item.added\r\ndata: {\"type\":\"response.output_item.added\",\r\ndata: \"item\":{\"type\":\"function_call\",\"call_id\":\"call_fixture\"}}\r\n\r\ndata: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":9,\"output_tokens\":2}}}\n\n"
	const followBody = `{"model":"local","input":[{"type":"function_call_output","call_id":"call_fixture","output":"ok"}],"stream":true,"extra_fixture":{"preserve":true}}`
	startedMedia := make(chan struct{}, 1)
	releaseMedia := make(chan struct{})
	var retries atomic.Int32
	var ambiguousImages atomic.Int32
	var recordedKey atomic.Value
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
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
			if r.Header.Get("x-api-key") != "mock-key" || r.Header.Get("Authorization") != "" || r.Header.Get("anthropic-version") != "2023-06-01" || r.Header.Get("anthropic-beta") != "fixture-beta" {
				http.Error(w, "header mismatch", 400)
				return
			}
			io.WriteString(w, `{"input_tokens":7}`)

		case "/v1/messages":
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
			if bytes.Contains(body, []byte("data:image/png;base64,")) {
				sawReference.Store(true)
			}
			if strings.Contains(string(body), "recover-once") {
				key := r.Header.Get("Idempotency-Key")
				if retries.Add(1) == 1 {
					recordedKey.Store(key)
					if c, _, err := w.(http.Hijacker).Hijack(); err == nil {
						c.Close()
					}
					return
				}
				if key == "" || key != recordedKey.Load() {
					w.WriteHeader(409)
					return
				}
				io.WriteString(w, `{"id":"video_fixture"}`)
				return
			}
			if strings.Contains(string(body), "never-replay-image") {
				ambiguousImages.Add(1)
				w.WriteHeader(502)
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
		_, token, err := a.Issue(ctx, db, who, "integration")
		if err != nil {
			t.Fatal(err)
		}
		for op, provider := range map[string]string{"responses": "openai", "messages": "anthropic", "image.generate": "jimeng", "video.generate": "jimeng"} {
			conn := platform.ID()
			secure, err := platform.Seal(enc, conn, "mock-key")
			if err != nil {
				t.Fatal(err)
			}
			run("INSERT INTO connections(id,tenant_id,project_id,provider,label,base_url,token,quota_scope) VALUES($1,$2,$3,$4,$4,$5,$6,$1::uuid::text)", conn, who.Tenant, who.Project, provider, upstream.URL, secure)
			run("INSERT INTO model_routes(tenant_id,project_id,operation,model,upstream_model,connection_id,version) VALUES($1,$2,$3,'local','local',$4,1)", who.Tenant, who.Project, op, conn)
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
	server := httptest.NewServer((app.App{DB: db, Access: a, Coding: &coding.Service{Access: a, Catalog: c, Metrics: metering.Store{DB: db}, Client: upstream.Client()}, Media: m, Console: console.Service{DB: db, Store: a, Catalog: c, PublicBase: "http://console.local"}}).Handler())
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
	if _, err = db.Exec(ctx, `UPDATE model_routes SET capabilities='{"input_roles":["first_frame"]}' WHERE operation='video.generate'`); err != nil {
		t.Fatal(err)
	}
	withReference := `{"model":"local","operation":"video.generate","prompt":"test","inputs":[{"role":"first_frame","asset_id":"` + asset.ID + `"}]}`
	send("POST", "/media/v1/jobs", withReference, other, "foreign-asset", 404)

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
	if err = db.QueryRow(ctx, `SELECT connection_id FROM model_routes WHERE project_id=$1 AND operation='image.generate'`, owner.Project).Scan(&imageConn); err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(ctx, `INSERT INTO model_routes(tenant_id,project_id,operation,model,upstream_model,connection_id,version,capabilities)
	VALUES($1,$2,'image.generate','modern-image','local',$3,1,'{"image_api":"openai","aspect_ratios":["1:1"],"image_sizes":{"1:1":"1024x1024"},"input_roles":["reference_image"]}')`, owner.Tenant, owner.Project, imageConn)
	if err != nil {
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

	// A dial failure before any request bytes were sent can use one approved backup.
	closed, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	dead := "http://" + closed.Addr().String()
	closed.Close()
	var primary, quota, route string
	err = db.QueryRow(ctx, `SELECT r.id,c.id,c.quota_scope FROM model_routes r JOIN connections c ON c.id=r.connection_id
	WHERE r.project_id=$1 AND r.operation='responses'`, owner.Project).Scan(&route, &primary, &quota)
	if err != nil {
		t.Fatal(err)
	}
	backup := platform.ID()
	sealed, err := platform.Seal(enc, backup, "test")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(ctx, `INSERT INTO connections(id,tenant_id,project_id,provider,label,base_url,token,quota_scope)
	VALUES($1,$2,$3,'openai','backup',$4,$5,$6)`, backup, owner.Tenant, owner.Project, upstream.URL, sealed, quota); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(ctx, `INSERT INTO model_route_backups(tenant_id,project_id,route_id,connection_id) VALUES($1,$2,$3,$4)`, owner.Tenant, owner.Project, route, backup); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(ctx, `UPDATE connections SET base_url=$2 WHERE id=$1`, primary, dead); err != nil {
		t.Fatal(err)
	}
	send("POST", "/openai/v1/responses", `{"model":"local","stream":true}`, token, "", 200)
	var attempts int
	if err = db.QueryRow(ctx, `SELECT count(*) FROM upstream_attempts a JOIN requests r ON r.id=a.request_id
	WHERE r.id=(SELECT id FROM requests WHERE project_id=$1 AND operation='responses' ORDER BY created_at DESC LIMIT 1)`, owner.Project).Scan(&attempts); err != nil || attempts != 2 {
		t.Fatalf("backup attempts=%d: %v", attempts, err)
	}

	if _, err = db.Exec(ctx, "UPDATE connections SET base_url=$2 WHERE id=$1", primary, upstream.URL); err != nil {
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
	// Reconcile only a verified video via exactly the same upstream idempotency key.
	if _, err = db.Exec(ctx, "UPDATE connections SET video_idempotency_verified=true WHERE project_id=$1 AND provider='jimeng'", owner.Project); err != nil {
		t.Fatal(err)
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
	waitStatus("recover-once", "video.generate", "succeeded")
	if retries.Load() != 2 {
		t.Fatalf("expected exactly one safe replay, got %d requests", retries.Load())
	}
	waitStatus("never-replay-image", "image.generate", "submit_unknown")
	stopWorker()
	<-workerDone
	var leaseJob struct{ ID string }
	body := `{"model":"local","operation":"image.generate","prompt":"abandoned-worker"}`
	if err = json.Unmarshal([]byte(send("POST", "/media/v1/jobs", body, token, "abandoned-worker", 202)), &leaseJob); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(ctx, "UPDATE media_jobs SET status='submitting',lease_until=now()-interval '5 minutes' WHERE id=$1 AND status='queued'", leaseJob.ID); err != nil {
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
	if ambiguousImages.Load() != 1 {
		t.Fatalf("ambiguous image submission retried %d times", ambiguousImages.Load())
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
	email := platform.ID() + "@example.test"
	if err = db.QueryRow(ctx, "INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id", email, hash).Scan(&user); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(ctx, "UPDATE project_principals SET user_id=$2,role='admin' WHERE id=$1", owner.Principal, user); err != nil {
		t.Fatal(err)
	}
	jar, _ := cookiejar.New(nil)
	browser := &http.Client{Jar: jar}
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
	browse("POST", "/console/v1/session", `{"email":"`+email+`","password":"fixture-password"}`, 200)
	base := "/console/v1/projects/" + owner.Project
	draft := `{"model":"local","upstream":"local","operation":"responses","connection":"` + primary + `","backup":"` + backup + `"}`
	browse("POST", base+"/routes/validate", draft, 200)
	browse("POST", base+"/routes/validate", strings.Replace(draft, backup, primary, 1), 400)
	browse("POST", base+"/routes/publish", draft, 201)
	browse("POST", base+"/routes/"+route+"/restore", "{}", 201)
	var count int
	if err = db.QueryRow(ctx, `SELECT count(*) FROM model_routes WHERE project_id=$1 AND operation='responses' AND active AND version=3`, owner.Project).Scan(&count); err != nil || count != 1 {
		t.Fatalf("route restore did not publish a new version: %v", err)
	}
	imageDraft := `{"model":"local","upstream":"local","operation":"image.generate","connection":"` + imageConn + `"}`
	invalidImageDraft := strings.TrimSuffix(imageDraft, "}") + `,"capabilities":{"aspect_ratios":["1:1"]}}`
	browse("POST", base+"/routes/validate", invalidImageDraft, 400)
	browse("POST", base+"/routes/publish", invalidImageDraft, 400)
	var legacyImageRoute string
	if err = db.QueryRow(ctx, `SELECT id FROM model_routes WHERE project_id=$1 AND model='local' AND operation='image.generate' AND active`, owner.Project).Scan(&legacyImageRoute); err != nil {
		t.Fatal(err)
	}
	browse("POST", base+"/routes/validate", imageDraft, 200)
	browse("POST", base+"/routes/publish", imageDraft, 201)
	const imageContractQuery = `SELECT coalesce(capabilities->>'image_api','') FROM model_routes WHERE project_id=$1 AND model='local' AND operation='image.generate' AND active`
	var imageContract string
	if err = db.QueryRow(ctx, imageContractQuery, owner.Project).Scan(&imageContract); err != nil || imageContract != "openai" {
		t.Fatalf("new image route contract %q: %v", imageContract, err)
	}
	browse("POST", base+"/routes/"+legacyImageRoute+"/restore", "{}", 201)
	if err = db.QueryRow(ctx, imageContractQuery, owner.Project).Scan(&imageContract); err != nil || imageContract != "" {
		t.Fatalf("restored image route contract %q: %v", imageContract, err)
	}

	var keyForCheck string
	if err = db.QueryRow(ctx, "SELECT id FROM api_keys WHERE principal_id=$1", owner.Principal).Scan(&keyForCheck); err != nil {
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

	legacy := url.Values{"key_id": {keyForCheck}, "operation": {"responses"}, "model": {"local"}, "since": {time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano)}}
	if result := browse("GET", base+"/setup/checks?"+legacy.Encode(), "", 200); !strings.Contains(result, `"status":"succeeded"`) {
		t.Fatalf("legacy setup check failed: %s", result)
	}

	browse("GET", base+"/requests", "", 200)
	var requestPage struct {
		Next string `json:"next_cursor"`
	}
	if err = json.Unmarshal([]byte(browse("GET", base+"/requests?limit=1", "", 200)), &requestPage); err != nil || requestPage.Next == "" {
		t.Fatalf("request cursor missing: %v", err)
	}
	browse("GET", base+"/requests?limit=1&cursor="+url.QueryEscape(requestPage.Next), "", 200)
	browse("POST", base+"/billing/prices", `{"operation":"messages","model":"local","metric":"input_tokens","unit":"token","amount_per_unit":"0.125"}`, 201)
	send("POST", "/anthropic/v1/messages", `{"model":"local","stream":true}`, token, "", 200)
	browse("POST", base+"/billing/prices", `{"operation":"messages","model":"local","metric":"input_tokens","unit":"token","amount_per_unit":"0.25"}`, 201)
	if output := browse("POST", base+"/billing/reconcile", "{}", 200); !strings.Contains(output, `"booked":1`) {
		t.Fatalf("first settlement: %s", output)
	}
	if output := browse("POST", base+"/billing/reconcile", "{}", 200); !strings.Contains(output, `"booked":0`) {
		t.Fatalf("duplicate settlement: %s", output)
	}
	var billed bool
	if err = db.QueryRow(ctx, "SELECT count(*)=1 AND bool_and(amount=0.375) FROM billing_entries WHERE project_id=$1", owner.Project).Scan(&billed); err != nil || !billed {
		t.Fatalf("billing amount did not use original price: %v", err)
	}
	browse("GET", base+"/usage/export", "", 200)
	var invite struct{ Token string }
	if err = json.Unmarshal([]byte(browse("POST", base+"/invitations", `{"email":"`+platform.ID()+`@example.test"}`, 201)), &invite); err != nil {
		t.Fatal(err)
	}
	browse("POST", "/console/v1/invitations/accept", `{"token":"`+invite.Token+`","password":"fixture-member"}`, 204)
	browse("POST", "/console/v1/invitations/accept", `{"token":"`+invite.Token+`","password":"fixture-member"}`, 404)
	if _, err = db.Exec(ctx, "UPDATE api_keys SET revoked_at=now() WHERE principal_id=$1", owner.Principal); err != nil {
		t.Fatal(err)
	}
	send("GET", "/openai/v1/models", "", token, "", 401)
	if calls.Load() != 2 {
		t.Fatalf("got %d upstream submissions, want 2", calls.Load())
	}
}
