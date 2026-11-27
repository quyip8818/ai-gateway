import type pg from 'pg';

export function createRecords(db: pg.Pool) {
  return {
    listAccounts: async (provider?: string) => (await db.query(
        `SELECT id,provider,kind,label,enabled,expires_at,cooldown_until
         FROM provider_accounts WHERE ($1::text IS NULL OR provider=$1) ORDER BY created_at DESC,id`,
        [provider ?? null])).rows,
    listKeys: async () => (await db.query(
        `SELECT id,label,prefix,created_at,revoked_at,scopes,expires_at,providers
         FROM api_keys ORDER BY created_at DESC`)).rows,
    listAttempts: async () => (await db.query(
        `SELECT id,model,operation,status,created_at,finished_at,usage
      FROM request_attempts ORDER BY created_at DESC LIMIT 100`)).rows,
    listAssets: async () => (await db.query(
        `SELECT id,video_id,mime,bytes,created_at FROM media_assets
      ORDER BY created_at DESC LIMIT 100`)).rows,
    listVideos: async () => (await db.query(
        `SELECT * FROM video_jobs
      ORDER BY created_at DESC LIMIT 100`)).rows,
    listModels: async () => (await db.query(
        `SELECT DISTINCT m.public_id AS id,m.operation,m.capabilities FROM account_models m
      JOIN provider_accounts a ON a.id=m.account_id WHERE a.enabled ORDER BY 1,2`)).rows,
    setAccountEnabled: (id: string, enabled: boolean) => db.query(
      'UPDATE provider_accounts SET enabled=$2 WHERE id=$1', [id, enabled],
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
    addAsset: (id: string, owner: string, mime: string, bytes: number) => db.query(
      'INSERT INTO media_assets(id,owner_id,mime,bytes) VALUES($1,$2,$3,$4)', [id, owner, mime, bytes],
    ),
    findAsset: async (id: string, owner: string | null) => (await db.query(
      'SELECT id,mime,bytes FROM media_assets WHERE id=$1 AND ($2::uuid IS NULL OR owner_id=$2)', [id, owner],
    )).rows[0],
  };
}
