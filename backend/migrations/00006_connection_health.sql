ALTER TABLE connections ADD COLUMN probed_at timestamptz;
ALTER TABLE connections ADD COLUMN probe_state text;
