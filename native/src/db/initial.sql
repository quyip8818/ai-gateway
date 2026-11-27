CREATE TABLE gateway_schema (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), version integer NOT NULL
);
INSERT INTO gateway_schema(version) VALUES(1);
CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL UNIQUE
);
CREATE TABLE admin_sessions (
  digest bytea PRIMARY KEY, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_sessions_expiry ON admin_sessions(expires_at);
CREATE TABLE account_pools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces,
  name text NOT NULL, provider text NOT NULL, UNIQUE(workspace_id, provider, name),
  UNIQUE(workspace_id, id, provider), UNIQUE(workspace_id, id)
);
CREATE TABLE provider_accounts (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL, pool_id uuid NOT NULL, provider text NOT NULL,
  kind text NOT NULL, label text NOT NULL, secret bytea NOT NULL, enabled boolean NOT NULL DEFAULT true,
  expires_at timestamptz, cooldown_until timestamptz, concurrency integer NOT NULL DEFAULT 1 CHECK(concurrency BETWEEN 1 AND 100),
  last_used_at timestamptz, credential_version bigint NOT NULL DEFAULT 0,
  refresh_until timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(workspace_id,pool_id,provider) REFERENCES account_pools(workspace_id,id,provider),
  UNIQUE(workspace_id,id)
);
CREATE TABLE account_models (
  account_id uuid NOT NULL REFERENCES provider_accounts ON DELETE CASCADE, public_id text NOT NULL,
  upstream_id text NOT NULL, operation text NOT NULL, capabilities jsonb NOT NULL,
  PRIMARY KEY(account_id, public_id, operation)
);
CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces,
  label text NOT NULL, prefix text NOT NULL, digest bytea NOT NULL UNIQUE,
  scopes text[] NOT NULL DEFAULT ARRAY['responses','messages','image','video'], expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
  UNIQUE(workspace_id,id)
);
CREATE TABLE api_key_pool_grants (
  workspace_id uuid NOT NULL, key_id uuid NOT NULL, pool_id uuid NOT NULL,
  PRIMARY KEY(key_id,pool_id),
  FOREIGN KEY(workspace_id,key_id) REFERENCES api_keys(workspace_id,id),
  FOREIGN KEY(workspace_id,pool_id) REFERENCES account_pools(workspace_id,id)
);
CREATE TABLE account_leases (
  id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES provider_accounts ON DELETE CASCADE,
  until_at timestamptz NOT NULL
);
CREATE INDEX account_lease_lookup ON account_leases(account_id,until_at);
CREATE TABLE video_jobs (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL, owner_id uuid NOT NULL, account_id uuid NOT NULL,
  public_model text NOT NULL, upstream_model text NOT NULL, payload bytea,
  operation text NOT NULL CHECK(operation IN ('generate','recast')), idempotency_key text, input_hash bytea NOT NULL,
  status text NOT NULL CHECK(status IN ('queued','submitting','submission_unknown','in_progress','completed','failed')),
  history_id text, source_id uuid, upstream_source_id text, progress integer NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
  size text, seconds text, error_code text, run_after timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz, lease_version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  FOREIGN KEY(workspace_id,owner_id) REFERENCES api_keys(workspace_id,id),
  FOREIGN KEY(workspace_id,account_id) REFERENCES provider_accounts(workspace_id,id),
  UNIQUE(workspace_id,owner_id,id),
  FOREIGN KEY(workspace_id,owner_id,source_id) REFERENCES video_jobs(workspace_id,owner_id,id),
  UNIQUE(workspace_id,owner_id,operation,idempotency_key)
);
CREATE INDEX video_jobs_due ON video_jobs(run_after) WHERE status NOT IN ('completed','failed');
CREATE TABLE media_assets (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL, owner_id uuid NOT NULL,
  video_id uuid UNIQUE, mime text NOT NULL, bytes bigint NOT NULL CHECK(bytes>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(workspace_id,owner_id) REFERENCES api_keys(workspace_id,id),
  FOREIGN KEY(workspace_id,owner_id,video_id) REFERENCES video_jobs(workspace_id,owner_id,id)
);
CREATE TABLE request_attempts (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL, owner_id uuid NOT NULL, account_id uuid NOT NULL,
  operation text NOT NULL, model text NOT NULL, status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, usage jsonb,
  FOREIGN KEY(workspace_id,owner_id) REFERENCES api_keys(workspace_id,id),
  FOREIGN KEY(workspace_id,account_id) REFERENCES provider_accounts(workspace_id,id)
);
CREATE TABLE authorization_flows (
  state text PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces,
  label text NOT NULL, verifier bytea NOT NULL, expires_at timestamptz NOT NULL
);
