CREATE TABLE tenants (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, enabled boolean NOT NULL DEFAULT true);
CREATE TABLE projects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants, name text NOT NULL, enabled boolean NOT NULL DEFAULT true, UNIQUE(tenant_id,id));
CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE NOT NULL, password_hash bytea NOT NULL, enabled boolean NOT NULL DEFAULT true);
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
