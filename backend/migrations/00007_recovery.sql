CREATE TABLE model_route_backups (
 tenant_id uuid NOT NULL,
 project_id uuid NOT NULL,
 route_id uuid PRIMARY KEY,
 connection_id uuid NOT NULL,
 FOREIGN KEY (tenant_id,project_id,route_id) REFERENCES model_routes(tenant_id,project_id,id),
 FOREIGN KEY (tenant_id,project_id,connection_id) REFERENCES connections(tenant_id,project_id,id)
);
ALTER TABLE connections ADD COLUMN video_idempotency_verified boolean NOT NULL DEFAULT false;
ALTER TABLE media_jobs ADD COLUMN submission_replays integer NOT NULL DEFAULT 0 CHECK (submission_replays BETWEEN 0 AND 1);
ALTER TABLE media_jobs ADD COLUMN replay_allowed boolean NOT NULL DEFAULT false;
CREATE INDEX media_reconcile_due ON media_jobs(run_after,id)
 WHERE status='submit_unknown' AND replay_allowed AND submission_replays=0;
