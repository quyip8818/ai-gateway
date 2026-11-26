CREATE TABLE web_sessions (digest bytea PRIMARY KEY, user_id uuid NOT NULL REFERENCES users, expires_at timestamptz NOT NULL);
CREATE INDEX web_sessions_expiry ON web_sessions(expires_at);
CREATE TABLE project_invitations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, project_id uuid NOT NULL,
 email text NOT NULL, digest bytea UNIQUE NOT NULL, expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours', used_at timestamptz,
 FOREIGN KEY(tenant_id,project_id) REFERENCES projects(tenant_id,id)
);
