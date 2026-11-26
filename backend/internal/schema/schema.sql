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

CREATE TABLE account_pools (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, project_id uuid NOT NULL,
 provider text NOT NULL CHECK(provider ~ '^[a-z][a-z0-9-]{0,39}$'), slug text NOT NULL, owner_id uuid,
 UNIQUE(project_id,slug), UNIQUE(tenant_id,project_id,id), UNIQUE NULLS NOT DISTINCT(project_id,provider,owner_id),
 FOREIGN KEY(tenant_id,project_id) REFERENCES projects(tenant_id,id),
 FOREIGN KEY(tenant_id,project_id,owner_id) REFERENCES project_principals(tenant_id,project_id,id)
);
CREATE TABLE key_grants (
 tenant_id uuid NOT NULL, project_id uuid NOT NULL, key_id uuid NOT NULL, principal_id uuid NOT NULL, pool_id uuid NOT NULL,
 PRIMARY KEY(key_id,pool_id),
 FOREIGN KEY(tenant_id,project_id,key_id,principal_id) REFERENCES api_keys(tenant_id,project_id,id,principal_id),
 FOREIGN KEY(tenant_id,project_id,pool_id) REFERENCES account_pools(tenant_id,project_id,id)
);

CREATE FUNCTION may_use_pool(pool uuid, request_key text, subject uuid, administrator boolean)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(
  SELECT 1 FROM account_pools p WHERE p.id=pool AND (p.owner_id IS NULL OR p.owner_id=subject)
  AND ((request_key='' AND administrator) OR EXISTS(
   SELECT 1 FROM key_grants g JOIN api_keys k ON k.id=g.key_id
   WHERE g.pool_id=p.id AND g.principal_id=subject
     AND (request_key='' OR k.id::text=request_key)
     AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>now())
  ))
 );
$$;

CREATE TABLE account_authorizations (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, project_id uuid NOT NULL, principal_id uuid NOT NULL,
 provider text NOT NULL,
 state_digest bytea NOT NULL UNIQUE, verifier_ciphertext bytea,
 phase text NOT NULL DEFAULT 'waiting' CHECK(phase IN ('waiting','verifying','succeeded','failed')),
 result_id uuid, expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes',
 FOREIGN KEY(tenant_id,project_id,principal_id) REFERENCES project_principals(tenant_id,project_id,id)
);
CREATE INDEX account_authorizations_expiry ON account_authorizations(expires_at);
CREATE TABLE upstream_accounts (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, project_id uuid NOT NULL, pool_id uuid NOT NULL,
 protocol text NOT NULL CHECK(protocol IN ('responses','messages','openai_media')),
 label text NOT NULL, base_url text NOT NULL, execution_secret bytea NOT NULL, managed boolean NOT NULL,
 credential_fingerprint bytea UNIQUE NOT NULL, refresh_secret bytea, expires_at timestamptz,
 count_tokens boolean NOT NULL DEFAULT false, enabled boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(), verified_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz,
 credential_version bigint NOT NULL DEFAULT 1,
 refresh_state text NOT NULL DEFAULT 'ready' CHECK(refresh_state IN ('ready','refreshing','reauthorize')),
 refresh_deadline timestamptz,
 CHECK(NOT count_tokens OR protocol='messages'),
 CHECK(refresh_secret IS NULL OR (expires_at IS NOT NULL AND NOT managed)),
 UNIQUE(tenant_id,project_id,id),
 FOREIGN KEY(tenant_id,project_id,pool_id) REFERENCES account_pools(tenant_id,project_id,id)
);
CREATE INDEX upstream_accounts_pool ON upstream_accounts(pool_id);
CREATE UNIQUE INDEX upstream_accounts_managed_base ON upstream_accounts(base_url) WHERE managed;

CREATE FUNCTION account_credential_ready(account upstream_accounts)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT account.refresh_state='ready' AND (account.expires_at IS NULL OR account.expires_at>now());
$$;

CREATE TABLE account_models (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, project_id uuid NOT NULL,
 account_id uuid NOT NULL, operation text NOT NULL, model text NOT NULL, upstream_model text NOT NULL,
 capabilities jsonb NOT NULL DEFAULT '{}',
 UNIQUE(tenant_id,project_id,id), UNIQUE(account_id,operation,model),
 FOREIGN KEY(tenant_id,project_id,account_id) REFERENCES upstream_accounts(tenant_id,project_id,id)
);
CREATE INDEX account_models_catalog ON account_models(project_id,operation,model);
CREATE TABLE requests (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, project_id uuid NOT NULL, principal_id uuid NOT NULL, key_id uuid, account_model_id uuid NOT NULL,
 operation text NOT NULL, model text NOT NULL, status text NOT NULL, failure_stage text, error_code text,
 created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 UNIQUE(tenant_id,project_id,id), UNIQUE(tenant_id,project_id,id,principal_id),
 FOREIGN KEY(tenant_id,project_id,principal_id) REFERENCES project_principals(tenant_id,project_id,id),
 FOREIGN KEY(tenant_id,project_id,key_id,principal_id) REFERENCES api_keys(tenant_id,project_id,id,principal_id),
 FOREIGN KEY(tenant_id,project_id,account_model_id) REFERENCES account_models(tenant_id,project_id,id)
);
CREATE INDEX requests_recent ON requests(project_id,created_at DESC,id DESC);
CREATE TABLE upstream_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, project_id uuid NOT NULL, request_id uuid NOT NULL, account_id uuid NOT NULL,
 attempt_no integer NOT NULL CHECK(attempt_no>0), upstream_id text, status_code integer, state text NOT NULL DEFAULT 'unknown',
 first_output_at timestamptz, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 UNIQUE(request_id,attempt_no), UNIQUE(tenant_id,project_id,request_id,id),
 FOREIGN KEY(tenant_id,project_id,request_id) REFERENCES requests(tenant_id,project_id,id),
 FOREIGN KEY(tenant_id,project_id,account_id) REFERENCES upstream_accounts(tenant_id,project_id,id)
);
CREATE TABLE assets (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, project_id uuid NOT NULL, principal_id uuid NOT NULL,
 key_id uuid,
 object_key text NOT NULL UNIQUE, mime text NOT NULL, bytes bigint NOT NULL CHECK(bytes>0), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,project_id,id), FOREIGN KEY(tenant_id,project_id,principal_id) REFERENCES project_principals(tenant_id,project_id,id),
 FOREIGN KEY(tenant_id,project_id,key_id,principal_id) REFERENCES api_keys(tenant_id,project_id,id,principal_id)
);
CREATE TABLE media_jobs (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, project_id uuid NOT NULL, principal_id uuid NOT NULL, request_id uuid UNIQUE NOT NULL,
 operation text NOT NULL, caller_id uuid NOT NULL, idempotency_key text, input_hash bytea NOT NULL, input jsonb,
 status text NOT NULL CHECK(status IN ('queued','submitting','running','submit_unknown','finalizing','succeeded','failed','canceled')),
 CHECK((status='queued') = (input IS NOT NULL)),
 upstream_job_id text, attempt_id uuid, progress integer CHECK(progress BETWEEN 0 AND 100), error_code text,
 run_after timestamptz NOT NULL DEFAULT now(), lease_until timestamptz, lease_version bigint NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,project_id,id),
 FOREIGN KEY(tenant_id,project_id,request_id,principal_id) REFERENCES requests(tenant_id,project_id,id,principal_id),
 FOREIGN KEY(tenant_id,project_id,request_id,attempt_id) REFERENCES upstream_attempts(tenant_id,project_id,request_id,id)
);
CREATE UNIQUE INDEX media_idempotency ON media_jobs(project_id,caller_id,operation,idempotency_key) WHERE idempotency_key IS NOT NULL;
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

CREATE TABLE gateway_schema (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 version integer NOT NULL CHECK(version>0)
);
