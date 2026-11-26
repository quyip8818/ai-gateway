CREATE TABLE connections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, project_id uuid NOT NULL,
 provider text NOT NULL CHECK(provider IN ('openai','anthropic','jimeng')), label text NOT NULL, base_url text NOT NULL, token bytea NOT NULL,
 quota_scope text NOT NULL, region text NOT NULL DEFAULT '', enabled boolean NOT NULL DEFAULT true,
 UNIQUE(tenant_id,project_id,id), FOREIGN KEY(tenant_id,project_id) REFERENCES projects(tenant_id,id)
);
CREATE TABLE model_routes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, project_id uuid NOT NULL, operation text NOT NULL, model text NOT NULL,
 upstream_model text NOT NULL, connection_id uuid NOT NULL, version integer NOT NULL CHECK(version>0), active boolean NOT NULL DEFAULT true,
 capabilities jsonb NOT NULL DEFAULT '{}', UNIQUE(tenant_id,project_id,id), UNIQUE(project_id,operation,model,version),
 FOREIGN KEY(tenant_id,project_id,connection_id) REFERENCES connections(tenant_id,project_id,id)
);
CREATE UNIQUE INDEX model_routes_active ON model_routes(project_id,operation,model) WHERE active;
