import type pg from 'pg';
import { AppError } from '../../domain.ts';
import type { GatewayCrypto } from '../crypto.ts';
import { insertAsset } from './media.ts';

interface NewVideo {
  id: string;
  owner: string;
  account: string;
  accountVersion: string;
  model: string;
  upstreamModel: string;
  operation: 'generate' | 'recast';
  key: string | null;
  hash: Buffer;
  payload: unknown;
  size: string | null;
  seconds: string;
  source: string | null;
  upstreamSource: string | null;
}

export async function hasPendingVideos(client: pg.PoolClient, accountId: string) {
  const result = await client.query(
    "SELECT 1 FROM video_jobs WHERE account_id=$1 AND status NOT IN ('completed','failed') LIMIT 1",
    [accountId],
  );
  return Boolean(result.rowCount);
}

export function failPendingVideos(client: pg.PoolClient, accountId: string) {
  return client.query(
    `UPDATE video_jobs SET status='failed', error_code='account_disabled', completed_at=now(),
       payload=NULL, lease_until=NULL, lease_version=lease_version+1
     WHERE account_id=$1 AND status NOT IN ('completed','failed')`,
    [accountId],
  );
}

export function createVideoRepository(
  db: pg.Pool,
  tx: <T>(run: (client: pg.PoolClient) => Promise<T>) => Promise<T>,
  { seal, unseal }: Pick<GatewayCrypto, 'seal' | 'unseal'>,
) {
  async function claim() {
    return (
      await db.query(`WITH due AS (
        SELECT id FROM video_jobs WHERE status NOT IN ('completed','failed') AND run_after<=now()
        AND (lease_until IS NULL OR lease_until<=now()) ORDER BY run_after LIMIT 1 FOR UPDATE SKIP LOCKED
      ) UPDATE video_jobs j SET lease_until=now()+interval '90 seconds',lease_version=lease_version+1,
        status=CASE WHEN status='submitting' THEN 'submission_unknown' ELSE status END
      FROM due WHERE j.id=due.id RETURNING j.*`)
    ).rows[0];
  }

  return {
    claimVideo: claim,
    readVideoPayload: unseal,
    findVideo: async (id: string, owner: string) => (await db.query(
      'SELECT * FROM video_jobs WHERE id=$1 AND owner_id=$2',
      [id, owner],
    )).rows[0],
    findIdempotentVideo: async (owner: string, operation: string, key: string) => (await db.query(
      `SELECT * FROM video_jobs
        WHERE owner_id=$1 AND operation=$2 AND idempotency_key=$3`,
      [owner, operation, key],
    )).rows[0],
    insertVideo: (job: NewVideo) => tx(async (client) => {
      // Coordinate with credential replacement and deletion before binding a new job.
      const { rowCount } = await client.query(
        'SELECT 1 FROM provider_accounts WHERE id=$1 AND enabled AND credential_version=$2 FOR SHARE',
        [job.account, job.accountVersion],
      );
      if (!rowCount) throw new AppError(409, 'account_changed');
      const { rows: [created] } = await client.query(
        `INSERT INTO video_jobs
        (id,owner_id,account_id,public_model,upstream_model,operation,idempotency_key,input_hash,payload,status,size,seconds,source_id,upstream_source_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued',$10,$11,$12,$13)
        ON CONFLICT(owner_id,operation,idempotency_key) DO NOTHING RETURNING *`,
        [job.id, job.owner, job.account, job.model, job.upstreamModel, job.operation, job.key, job.hash,
          seal(job.id, job.payload), job.size, job.seconds, job.source, job.upstreamSource],
      );
      return created;
    }),
    updateVideo: (id: string, version: number, status: string, wait: number, history: string | null, error: string | null, progress: number) => db.query(
      `UPDATE video_jobs SET status=$3,run_after=now()+$4*interval '1 second',history_id=coalesce($5,history_id),
        error_code=$6,progress=greatest(progress,$7),lease_until=NULL,
        payload=CASE WHEN $3='queued' THEN payload ELSE NULL END,
        completed_at=CASE WHEN $3 IN ('completed','failed') THEN now() ELSE NULL END
        WHERE id=$1 AND lease_version=$2 AND lease_until>now()`,
      [id, version, status, wait, history, error, progress],
    ),
    setVideoSize: (id: string, version: number, size: string) => db.query(
      'UPDATE video_jobs SET size=$3 WHERE id=$1 AND lease_version=$2',
      [id, version, size],
    ),
    startVideo: (id: string, version: number) => db.query(
      "UPDATE video_jobs SET status='submitting',payload=NULL WHERE id=$1 AND lease_version=$2 AND lease_until>now()",
      [id, version],
    ),
    renewVideoLease: (id: string, version: number) => db.query(
      `UPDATE video_jobs SET lease_until=now()+interval '90 seconds'
              WHERE id=$1 AND lease_version=$2 AND lease_until>now()`,
      [id, version],
    ),
    completeVideo: (job: { id: string; lease_version: number }, bytes: number, writeFile: () => Promise<void>) => tx(async (client) => {
      const { rows: [completed] } = await client.query<{ owner_id: string; public_model: string }>(
        `UPDATE video_jobs SET status='completed',progress=100,
          lease_until=NULL,completed_at=now(),error_code=NULL
          WHERE id=$1 AND lease_version=$2 AND lease_until>now() RETURNING owner_id,public_model`,
        [job.id, job.lease_version],
      );
      if (!completed) return;
      // The guarded update holds the job lock until both the file and its metadata are ready.
      await writeFile();
      await insertAsset(client, {
        id: job.id, owner: completed.owner_id, videoId: job.id, mime: 'video/mp4', bytes, model: completed.public_model,
      });
    }),
  };
}
