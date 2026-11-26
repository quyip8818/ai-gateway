CREATE TABLE IF NOT EXISTS provider_settings (
 provider text PRIMARY KEY,
 settings bytea NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_executors (
 id uuid PRIMARY KEY,
 provider text NOT NULL,
 base_url text NOT NULL UNIQUE,
 settings bytea NOT NULL
);

CREATE TABLE IF NOT EXISTS media_download_hosts (
 hostname text PRIMARY KEY
);

ALTER TABLE account_authorizations ADD COLUMN IF NOT EXISTS client_digest bytea;
