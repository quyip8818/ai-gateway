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
 upstream_job_id text, attempt_id uuid, progress integer CHECK(progress BETWEEN 0 AND 100), error_code text,
 run_after timestamptz NOT NULL DEFAULT now(), lease_until timestamptz, lease_version bigint NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,project_id,id),
 FOREIGN KEY(tenant_id,project_id,request_id,principal_id) REFERENCES requests(tenant_id,project_id,id,principal_id),
 FOREIGN KEY(tenant_id,project_id,request_id,attempt_id) REFERENCES upstream_attempts(tenant_id,project_id,request_id,id)
);
CREATE UNIQUE INDEX media_idempotency ON media_jobs(project_id,principal_id,operation,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX media_due ON media_jobs(run_after,id) WHERE status IN ('queued','running','finalizing');
CREATE INDEX media_leases ON media_jobs(lease_until) WHERE lease_until IS NOT NULL;
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
