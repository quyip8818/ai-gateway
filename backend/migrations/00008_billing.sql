CREATE TABLE billing_prices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 project_id uuid NOT NULL REFERENCES projects,
 operation text NOT NULL,
 model text NOT NULL,
 metric text NOT NULL,
 unit text NOT NULL,
 amount_per_unit numeric(24,12) NOT NULL CHECK(amount_per_unit>=0),
 active_from timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(project_id,operation,model,metric,unit,active_from),
 UNIQUE(project_id,id)
);
CREATE TABLE billing_entries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 project_id uuid NOT NULL REFERENCES projects,
 attempt_id uuid NOT NULL REFERENCES upstream_attempts,
 price_id uuid NOT NULL,
 operation text NOT NULL,
 model text NOT NULL,
 metric text NOT NULL,
 unit text NOT NULL,
 quantity numeric NOT NULL CHECK(quantity>=0),
 amount numeric NOT NULL CHECK(amount>=0),
 currency text NOT NULL DEFAULT 'credit' CHECK(currency='credit'),
 booked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(attempt_id,metric,unit),
 FOREIGN KEY(project_id,price_id) REFERENCES billing_prices(project_id,id)
);
CREATE INDEX billing_entries_project_recent ON billing_entries(project_id,booked_at DESC,id DESC);
