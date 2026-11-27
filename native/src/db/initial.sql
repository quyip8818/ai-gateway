CREATE TABLE gateway_schema (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), version integer NOT NULL
);
INSERT INTO gateway_schema(version) VALUES(2);
CREATE TABLE admin_sessions (
  digest bytea PRIMARY KEY, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_sessions_expiry ON admin_sessions(expires_at);
CREATE TABLE account_pools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL, provider text NOT NULL, UNIQUE(provider, name), UNIQUE(id, provider)
);
CREATE TABLE provider_accounts (
  id uuid PRIMARY KEY, pool_id uuid NOT NULL, provider text NOT NULL,
  kind text NOT NULL, label text NOT NULL, secret bytea NOT NULL, enabled boolean NOT NULL DEFAULT true,
  expires_at timestamptz, cooldown_until timestamptz, concurrency integer NOT NULL DEFAULT 1 CHECK(concurrency BETWEEN 1 AND 100),
  last_used_at timestamptz, credential_version bigint NOT NULL DEFAULT 0,
  refresh_until timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(pool_id,provider) REFERENCES account_pools(id,provider)
);
CREATE TABLE account_models (
  account_id uuid NOT NULL REFERENCES provider_accounts ON DELETE CASCADE, public_id text NOT NULL,
  upstream_id text NOT NULL, operation text NOT NULL, capabilities jsonb NOT NULL,
  PRIMARY KEY(account_id, public_id, operation)
);
CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL, prefix text NOT NULL, digest bytea NOT NULL UNIQUE,
  scopes text[] NOT NULL DEFAULT ARRAY['responses','messages','image','video'], expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz
);
CREATE TABLE api_key_pool_grants (
  key_id uuid NOT NULL REFERENCES api_keys, pool_id uuid NOT NULL REFERENCES account_pools,
  PRIMARY KEY(key_id,pool_id)
);
CREATE TABLE account_leases (
  id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES provider_accounts ON DELETE CASCADE,
  until_at timestamptz NOT NULL
);
CREATE INDEX account_lease_lookup ON account_leases(account_id,until_at);
CREATE TABLE video_jobs (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES api_keys, account_id uuid NOT NULL REFERENCES provider_accounts,
  public_model text NOT NULL, upstream_model text NOT NULL, payload bytea,
  operation text NOT NULL CHECK(operation IN ('generate','recast')), idempotency_key text, input_hash bytea NOT NULL,
  status text NOT NULL CHECK(status IN ('queued','submitting','submission_unknown','in_progress','completed','failed')),
  history_id text, source_id uuid, upstream_source_id text, progress integer NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
  size text, seconds text, error_code text, run_after timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz, lease_version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  UNIQUE(owner_id,id),
  FOREIGN KEY(owner_id,source_id) REFERENCES video_jobs(owner_id,id),
  UNIQUE(owner_id,operation,idempotency_key)
);
CREATE INDEX video_jobs_due ON video_jobs(run_after) WHERE status NOT IN ('completed','failed');
CREATE TABLE media_assets (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES api_keys,
  video_id uuid UNIQUE, mime text NOT NULL, bytes bigint NOT NULL CHECK(bytes>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(owner_id,video_id) REFERENCES video_jobs(owner_id,id)
);
CREATE TABLE request_attempts (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES api_keys, account_id uuid NOT NULL REFERENCES provider_accounts,
  operation text NOT NULL, model text NOT NULL, status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, usage jsonb
);
CREATE TABLE authorization_flows (
  state text PRIMARY KEY,
  label text NOT NULL, verifier bytea NOT NULL, expires_at timestamptz NOT NULL
);
