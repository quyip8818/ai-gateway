ALTER TABLE provider_accounts ADD COLUMN deleted_at timestamptz;
CREATE INDEX video_jobs_pending_account ON video_jobs(account_id) WHERE status NOT IN ('completed','failed');
