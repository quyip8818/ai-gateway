CREATE TABLE gateway_schema (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), version integer NOT NULL
);
CREATE TABLE admin_sessions (
  digest bytea PRIMARY KEY, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_sessions_expiry ON admin_sessions(expires_at);
CREATE TABLE provider_accounts (
  id uuid PRIMARY KEY, provider text NOT NULL,
  kind text NOT NULL, label text NOT NULL, secret bytea NOT NULL, enabled boolean NOT NULL DEFAULT true,
  expires_at timestamptz, cooldown_until timestamptz, concurrency integer NOT NULL DEFAULT 1 CHECK(concurrency BETWEEN 1 AND 100),
  last_used_at timestamptz, credential_version bigint NOT NULL DEFAULT 0,
  refresh_until timestamptz, deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  browser_transport text CHECK (
    browser_transport IS NULL OR (provider = 'jimeng' AND browser_transport IN ('off', 'auto', 'always'))
  )
);
CREATE INDEX provider_accounts_by_product ON provider_accounts(provider,created_at DESC,id);
CREATE TABLE account_credential_fingerprints (
  account_id uuid NOT NULL REFERENCES provider_accounts ON DELETE CASCADE,
  fingerprint bytea NOT NULL,
  PRIMARY KEY (account_id, fingerprint)
);
CREATE INDEX account_credential_fingerprint_lookup ON account_credential_fingerprints(fingerprint);
CREATE TABLE account_models (
  account_id uuid NOT NULL REFERENCES provider_accounts ON DELETE CASCADE, public_id text NOT NULL,
  upstream_id text NOT NULL, operation text NOT NULL, capabilities jsonb NOT NULL,
  PRIMARY KEY(account_id, public_id, operation)
);
CREATE INDEX account_models_by_public_id ON account_models(public_id,operation,account_id);
CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL, prefix text NOT NULL, digest bytea NOT NULL UNIQUE,
  scopes text[] NOT NULL DEFAULT ARRAY['responses','messages','image','video'],
  providers text[] NOT NULL CHECK(cardinality(providers)>0), expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz
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
  size text, seconds text, output jsonb, error_code text, run_after timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz, lease_version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  UNIQUE(owner_id,id),
  FOREIGN KEY(owner_id,source_id) REFERENCES video_jobs(owner_id,id),
  UNIQUE(owner_id,operation,idempotency_key)
);
CREATE INDEX video_jobs_due ON video_jobs(run_after) WHERE status NOT IN ('completed','failed');
CREATE INDEX video_jobs_pending_account ON video_jobs(account_id) WHERE status NOT IN ('completed','failed');
CREATE TABLE media_assets (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES api_keys,
  video_id uuid UNIQUE, mime text NOT NULL, bytes bigint NOT NULL CHECK(bytes>0), model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(owner_id,video_id) REFERENCES video_jobs(owner_id,id)
);
CREATE INDEX media_assets_recent ON media_assets(created_at DESC,id DESC);
CREATE TABLE request_attempts (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES api_keys, account_id uuid NOT NULL REFERENCES provider_accounts,
  operation text NOT NULL, model text NOT NULL, status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, usage jsonb
);
CREATE TABLE authorization_flows (
  state text PRIMARY KEY,
  label text NOT NULL, verifier bytea NOT NULL, expires_at timestamptz NOT NULL
);

CREATE TABLE runtime_settings (
  id text PRIMARY KEY,
  value text NOT NULL
);
