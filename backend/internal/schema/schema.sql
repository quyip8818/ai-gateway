CREATE TABLE tenants (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, enabled boolean NOT NULL DEFAULT true);
CREATE TABLE projects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants, name text NOT NULL, enabled boolean NOT NULL DEFAULT true, UNIQUE(tenant_id,id));
CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), username text UNIQUE NOT NULL, password_hash bytea NOT NULL, enabled boolean NOT NULL DEFAULT true);
CREATE TABLE project_principals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, project_id uuid NOT NULL, user_id uuid REFERENCES users,
 role text NOT NULL CHECK(role IN ('admin','member','service')), enabled boolean NOT NULL DEFAULT true,
 CHECK ((role='service')=(user_id IS NULL)), UNIQUE(project_id,user_id), UNIQUE(tenant_id,project_id,id),
 FOREIGN KEY(tenant_id,project_id) REFERENCES projects(tenant_id,id)
);
CREATE TABLE api_keys (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, project_id uuid NOT NULL, principal_id uuid NOT NULL,
 label text NOT NULL, prefix text NOT NULL UNIQUE, digest bytea NOT NULL, scopes text[] NOT NULL, expires_at timestamptz,
 revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,project_id,id,principal_id),
 FOREIGN KEY(tenant_id,project_id,principal_id) REFERENCES project_principals(tenant_id,project_id,id)
);

CREATE TABLE connections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, project_id uuid NOT NULL,
 provider text NOT NULL CHECK(provider IN ('openai','anthropic','jimeng')), label text NOT NULL, base_url text NOT NULL, token bytea NOT NULL,
 quota_scope text NOT NULL, region text NOT NULL DEFAULT '', enabled boolean NOT NULL DEFAULT true,
 probed_at timestamptz, probe_state text, video_idempotency_verified boolean NOT NULL DEFAULT false,
 UNIQUE(tenant_id,project_id,id), FOREIGN KEY(tenant_id,project_id) REFERENCES projects(tenant_id,id)
);
CREATE TABLE model_routes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, project_id uuid NOT NULL, operation text NOT NULL, model text NOT NULL,
 upstream_model text NOT NULL, connection_id uuid NOT NULL, version integer NOT NULL CHECK(version>0), active boolean NOT NULL DEFAULT true,
 capabilities jsonb NOT NULL DEFAULT '{}', UNIQUE(tenant_id,project_id,id), UNIQUE(project_id,operation,model,version),
 FOREIGN KEY(tenant_id,project_id,connection_id) REFERENCES connections(tenant_id,project_id,id)
);
CREATE UNIQUE INDEX model_routes_active ON model_routes(project_id,operation,model) WHERE active;
CREATE TABLE model_route_backups (
 tenant_id uuid NOT NULL,
 project_id uuid NOT NULL,
 route_id uuid PRIMARY KEY,
 connection_id uuid NOT NULL,
 FOREIGN KEY (tenant_id,project_id,route_id) REFERENCES model_routes(tenant_id,project_id,id),
 FOREIGN KEY (tenant_id,project_id,connection_id) REFERENCES connections(tenant_id,project_id,id)
);

CREATE TABLE requests (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, project_id uuid NOT NULL, principal_id uuid NOT NULL, key_id uuid, route_id uuid,
 operation text NOT NULL, model text NOT NULL, status text NOT NULL, failure_stage text, error_code text,
 created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 UNIQUE(tenant_id,project_id,id), UNIQUE(tenant_id,project_id,id,principal_id),
 FOREIGN KEY(tenant_id,project_id,principal_id) REFERENCES project_principals(tenant_id,project_id,id),
 FOREIGN KEY(tenant_id,project_id,key_id,principal_id) REFERENCES api_keys(tenant_id,project_id,id,principal_id),
 FOREIGN KEY(tenant_id,project_id,route_id) REFERENCES model_routes(tenant_id,project_id,id)
);
CREATE INDEX requests_recent ON requests(project_id,created_at DESC,id DESC);
CREATE TABLE upstream_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, project_id uuid NOT NULL, request_id uuid NOT NULL, connection_id uuid NOT NULL,
 attempt_no integer NOT NULL CHECK(attempt_no>0), upstream_id text, status_code integer, state text NOT NULL DEFAULT 'unknown',
 first_output_at timestamptz, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 UNIQUE(request_id,attempt_no), UNIQUE(tenant_id,project_id,request_id,id),
 FOREIGN KEY(tenant_id,project_id,request_id) REFERENCES requests(tenant_id,project_id,id),
 FOREIGN KEY(tenant_id,project_id,connection_id) REFERENCES connections(tenant_id,project_id,id)
);
CREATE TABLE assets (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, project_id uuid NOT NULL, principal_id uuid NOT NULL,
 object_key text NOT NULL UNIQUE, mime text NOT NULL, bytes bigint NOT NULL CHECK(bytes>0), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,project_id,id), FOREIGN KEY(tenant_id,project_id,principal_id) REFERENCES project_principals(tenant_id,project_id,id)
);
CREATE TABLE media_jobs (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, project_id uuid NOT NULL, principal_id uuid NOT NULL, request_id uuid UNIQUE NOT NULL,
 operation text NOT NULL, idempotency_key text, input_hash bytea NOT NULL, input jsonb,
 status text NOT NULL CHECK(status IN ('queued','submitting','running','submit_unknown','finalizing','succeeded','failed','canceled')),
 submission_replays integer NOT NULL DEFAULT 0 CHECK (submission_replays BETWEEN 0 AND 1),
 replay_allowed boolean NOT NULL DEFAULT false,
 upstream_job_id text, attempt_id uuid, progress integer CHECK(progress BETWEEN 0 AND 100), error_code text,
 run_after timestamptz NOT NULL DEFAULT now(), lease_until timestamptz, lease_version bigint NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,project_id,id),
 FOREIGN KEY(tenant_id,project_id,request_id,principal_id) REFERENCES requests(tenant_id,project_id,id,principal_id),
 FOREIGN KEY(tenant_id,project_id,request_id,attempt_id) REFERENCES upstream_attempts(tenant_id,project_id,request_id,id)
);
CREATE UNIQUE INDEX media_idempotency ON media_jobs(project_id,principal_id,operation,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX media_due ON media_jobs(run_after,id) WHERE status IN ('queued','running','finalizing');
CREATE INDEX media_leases ON media_jobs(lease_until) WHERE lease_until IS NOT NULL;
CREATE INDEX media_reconcile_due ON media_jobs(run_after,id)
 WHERE status='submit_unknown' AND replay_allowed AND submission_replays=0;
CREATE TABLE media_job_assets (
 tenant_id uuid NOT NULL, project_id uuid NOT NULL, job_id uuid NOT NULL, asset_id uuid NOT NULL, role text NOT NULL, position integer NOT NULL,
 PRIMARY KEY(job_id,position), FOREIGN KEY(tenant_id,project_id,job_id) REFERENCES media_jobs(tenant_id,project_id,id),
 FOREIGN KEY(tenant_id,project_id,asset_id) REFERENCES assets(tenant_id,project_id,id)
);
CREATE TABLE artifacts (
 tenant_id uuid NOT NULL, project_id uuid NOT NULL, job_id uuid NOT NULL, asset_id uuid NOT NULL, position integer NOT NULL,
 PRIMARY KEY(job_id,position), FOREIGN KEY(tenant_id,project_id,job_id) REFERENCES media_jobs(tenant_id,project_id,id),
 FOREIGN KEY(tenant_id,project_id,asset_id) REFERENCES assets(tenant_id,project_id,id)
);

CREATE TABLE usage_records (
 attempt_id uuid NOT NULL REFERENCES upstream_attempts, metric text NOT NULL, unit text NOT NULL, source text NOT NULL,
 quantity numeric NOT NULL CHECK(quantity>=0), observed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(attempt_id,metric,unit,source)
);
CREATE TABLE audit_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES projects, actor_id uuid,
 action text NOT NULL, target_id uuid, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE web_sessions (digest bytea PRIMARY KEY, user_id uuid NOT NULL REFERENCES users, expires_at timestamptz NOT NULL);
CREATE INDEX web_sessions_expiry ON web_sessions(expires_at);

CREATE TABLE billing_prices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 project_id uuid NOT NULL REFERENCES projects,
 operation text NOT NULL,
 model text NOT NULL,
 metric text NOT NULL,
 unit text NOT NULL,
 amount_per_unit numeric(24,12) NOT NULL CHECK(amount_per_unit>=0),
 active_from timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(project_id,operation,model,metric,unit,active_from),
 UNIQUE(project_id,id)
);
CREATE TABLE billing_entries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 project_id uuid NOT NULL REFERENCES projects,
 attempt_id uuid NOT NULL REFERENCES upstream_attempts,
 price_id uuid NOT NULL,
 operation text NOT NULL,
 model text NOT NULL,
 metric text NOT NULL,
 unit text NOT NULL,
 quantity numeric NOT NULL CHECK(quantity>=0),
 amount numeric NOT NULL CHECK(amount>=0),
 currency text NOT NULL DEFAULT 'credit' CHECK(currency='credit'),
 booked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(attempt_id,metric,unit),
 FOREIGN KEY(project_id,price_id) REFERENCES billing_prices(project_id,id)
);
CREATE INDEX billing_entries_project_recent ON billing_entries(project_id,booked_at DESC,id DESC);

CREATE TABLE setup_checks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 project_id uuid NOT NULL,
 principal_id uuid NOT NULL,
 key_id uuid NOT NULL,
 operation text NOT NULL CHECK(operation IN ('responses','messages')),
 model text NOT NULL,
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '20 minutes',
 FOREIGN KEY(tenant_id,project_id,key_id,principal_id) REFERENCES api_keys(tenant_id,project_id,id,principal_id)
);
CREATE INDEX setup_checks_expiry ON setup_checks(expires_at);
