CREATE TABLE usage_records (
 attempt_id uuid NOT NULL REFERENCES upstream_attempts, metric text NOT NULL, unit text NOT NULL, source text NOT NULL,
 quantity numeric NOT NULL CHECK(quantity>=0), observed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(attempt_id,metric,unit,source)
);
CREATE TABLE audit_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES projects, actor_id uuid,
 action text NOT NULL, target_id uuid, created_at timestamptz NOT NULL DEFAULT now()
);
