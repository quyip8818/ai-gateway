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
