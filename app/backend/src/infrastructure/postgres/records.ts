import { supportedAccountModel, unsupportedJimengImageModelKeys } from './model-filter.ts';
import type pg from 'pg';
import type { BrowserTransportMode } from '../../../../../shared/contracts/jimeng-settings.ts';

export function createRecords(db: pg.Pool) {
  return {
    listAccounts: async (provider?: string) => (await db.query(
        `SELECT id,provider,kind,label,enabled,expires_at,cooldown_until,browser_transport
         FROM provider_accounts WHERE deleted_at IS NULL AND ($1::text IS NULL OR provider=$1) ORDER BY created_at DESC,id`,
        [provider ?? null])).rows,
    listKeys: async () => (await db.query(
        `SELECT id,label,prefix,created_at,revoked_at,scopes,expires_at,providers
         FROM api_keys ORDER BY created_at DESC`)).rows,
    listAttempts: async () => (await db.query(
        `SELECT id,model,operation,status,created_at,finished_at,usage,
          usage->'credit_receipt'->'credits_used' AS credits_used
      FROM request_attempts ORDER BY created_at DESC LIMIT 100`)).rows,
    listVideos: async () => (await db.query(
        `SELECT * FROM video_jobs
      ORDER BY created_at DESC LIMIT 100`)).rows,
    listModels: async () => (await db.query(
        `SELECT DISTINCT ON (m.public_id,m.operation) m.public_id AS id,m.operation,m.capabilities
        FROM account_models m
      JOIN provider_accounts a ON a.id=m.account_id WHERE a.enabled
      AND ${supportedAccountModel(1)}
      ORDER BY m.public_id,m.operation,a.id`, [unsupportedJimengImageModelKeys])).rows,
    setAccountBrowserTransport: (id: string, value: BrowserTransportMode | null) => db.query(
      "UPDATE provider_accounts SET browser_transport=$2 WHERE id=$1 AND provider='jimeng' AND deleted_at IS NULL",
      [id, value],
    ),
    setAccountEnabled: (id: string, enabled: boolean) => db.query(
      'UPDATE provider_accounts SET enabled=$2 WHERE id=$1 AND deleted_at IS NULL', [id, enabled],
    ),
    revokeKey: (id: string) => db.query(
      'UPDATE api_keys SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1', [id],
    ),
    startAttempt: (id: string, owner: string, account: string, operation: string, model: string) => db.query(
      `INSERT INTO request_attempts(id,owner_id,account_id,operation,model,status)
      VALUES($1,$2,$3,$4,$5,'running')`, [id, owner, account, operation, model],
    ),
    finishAttempt: (id: string, status: string, usage: unknown) => db.query(
      'UPDATE request_attempts SET status=$2,usage=$3,finished_at=now() WHERE id=$1', [id, status, usage],
    ),
  };
}
