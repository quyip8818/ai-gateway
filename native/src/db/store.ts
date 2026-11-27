import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import pg from 'pg';
import schema from './initial.sql';
import { discover, normalizeCredential, refreshCredential } from '../providers/index.ts';

import { AppError } from '../domain.ts';

export const ADMIN_SESSION_SECONDS = 8 * 60 * 60;

export function openStore(connection: string, secret: string) {
  const db = new pg.Pool({ connectionString: connection, max: 20 });
  const encryptionKey = createHash('sha256').update('ai-gateway credential encryption\0').update(secret).digest();
  const digestKey = createHash('sha256').update('ai-gateway key digest\0').update(secret).digest();

  async function tx<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const value = await run(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  function seal(id: string, value: unknown) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
    cipher.setAAD(Buffer.from(id));
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]);
  }

  function unseal(id: string, value: Buffer) {
    const decoder = createDecipheriv('aes-256-gcm', encryptionKey, value.subarray(0, 12));
    decoder.setAAD(Buffer.from(id));
    decoder.setAuthTag(value.subarray(12, 28));
    return JSON.parse(Buffer.concat([decoder.update(value.subarray(28)), decoder.final()]).toString());
  }

  function digest(token: string) {
    return createHmac('sha256', digestKey).update(token).digest();
  }

  function signedMedia(id: string, origin: string) {
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const url = new URL('/v1/media/' + id, origin);
    url.searchParams.set('expires', String(expires));
    url.searchParams.set('signature', digest(`media:${id}:${expires}`).toString('base64url'));
    return url.href;
  }

  function verifyMedia(id: string, expires: unknown, signature: unknown) {
    if (
      typeof expires !== 'string' ||
      !/^\d{1,12}$/.test(expires) ||
      Number(expires) <= Date.now() / 1000 ||
      typeof signature !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(signature)
    )
      return false;
    const raw = Buffer.from(signature, 'base64url');
    const expected = digest(`media:${id}:${expires}`);
    return raw.length === expected.length && timingSafeEqual(raw, expected);
  }

  async function initialize() {
    return tx(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(683191340)');
      const exists = (await client.query("SELECT to_regclass('gateway_schema') IS NOT NULL AS value")).rows[0]
        .value;
      if (exists) {
        const version = (await client.query('SELECT version FROM gateway_schema WHERE singleton')).rows[0]
          ?.version;
        if (version !== 2) throw new Error('The database schema version is unsupported. Set DATABASE_URL to an empty database.');
      } else {
        await client.query(schema);
      }
    });
  }

  function sessionDigest(scope: string, session: string) {
    return digest(`admin-session:${scope}:${session}`);
  }

  function createAdminSession(scope: string, previous: string | undefined) {
    const session = randomBytes(32).toString('base64url');
    return tx(async (client) => {
      await client.query('DELETE FROM admin_sessions WHERE expires_at<=now() OR digest=$1', [
        previous ? sessionDigest(scope, previous) : null,
      ]);
      await client.query(
        "INSERT INTO admin_sessions(digest,expires_at) VALUES($1,now()+$2*interval '1 second')",
        [sessionDigest(scope, session), ADMIN_SESSION_SECONDS],
      );
      return session;
    });
  }

  async function hasAdminSession(scope: string, session: string | undefined) {
    if (!session || !/^[A-Za-z0-9_-]{43}$/.test(session)) return false;
    return Boolean(
      (await db.query('SELECT 1 FROM admin_sessions WHERE digest=$1 AND expires_at>now()', [
        sessionDigest(scope, session),
      ])).rowCount,
    );
  }

  function endAdminSession(scope: string, session: string) {
    return db.query('DELETE FROM admin_sessions WHERE digest=$1', [sessionDigest(scope, session)]);
  }

  async function getKey(raw: string) {
    if (!raw.startsWith('ag_')) return;
    return (
      await db.query(
        'SELECT id,scopes FROM api_keys WHERE digest=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())',
        [digest(raw)],
      )
    ).rows[0];
  }

  async function createKey(
    label: string,
    pools: string[],
    scopes: string[],
    expiresAt: string | null,
  ) {
    const token = 'ag_' + randomBytes(32).toString('base64url');
    return tx(async (client) => {
      const key = (
        await client.query(
          'INSERT INTO api_keys(label,prefix,digest,scopes,expires_at) VALUES($1,$2,$3,$4,$5) RETURNING id,label,prefix,scopes,expires_at',
          [label, token.slice(0, 12), digest(token), scopes, expiresAt],
        )
      ).rows[0];
      for (const pool of new Set(pools)) {
        await client.query('INSERT INTO api_key_pool_grants(key_id,pool_id) VALUES($1,$2)', [key.id, pool]);
      }
      return { ...key, token };
    });
  }

  async function addAccount(
    provider: string,
    kind: string,
    label: string,
    raw: unknown,
    pool: string,
    concurrency: number,
    signal: AbortSignal,
  ) {
    let credential;
    let models;
    try {
      credential = normalizeCredential(provider, kind, raw);
      if (
        credential.refreshToken &&
        (!credential.accessToken || provider === 'kiro' || Date.parse(credential.expiresAt) <= Date.now())
      ) {
        credential = await refreshCredential(provider, kind, credential, signal);
      }
      models = await discover(provider, kind, credential, signal);
    } catch {
      throw new AppError(422, 'account_validation_failed', 'Check the credential and its provider authorization');
    }
    if (!models.length) throw new AppError(422, 'no_provider_models');
    const id = randomUUID();
    await tx(async (client) => {
      const {
        rows: [target],
      } = await client.query(
        'INSERT INTO account_pools(name,provider) VALUES($1,$2) ON CONFLICT(provider,name) DO UPDATE SET name=excluded.name RETURNING id',
        [pool, provider],
      );
      await client.query(
        `INSERT INTO provider_accounts(id,pool_id,provider,kind,label,secret,concurrency,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          id,
          target.id,
          provider,
          kind,
          label,
          seal(id, credential),
          concurrency,
          credential.expiresAt ?? null,
        ],
      );
      for (const model of models) {
        await client.query(`INSERT INTO account_models VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [
          id,
          provider + '/' + model.id,
          model.id,
          model.operation,
          model.capabilities,
        ]);
      }
    });
    return { id, model_count: models.length };
  }

  const allowed = `a.enabled AND EXISTS
    (SELECT 1 FROM api_key_pool_grants g JOIN api_keys k ON k.id=g.key_id
      WHERE g.key_id=$1 AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>now()) AND g.pool_id=a.pool_id)`;

  async function models(key) {
    return (
      await db.query(
        `SELECT DISTINCT ON(m.public_id,m.operation) m.public_id AS id,m.operation,m.capabilities
      FROM account_models m JOIN provider_accounts a ON a.id=m.account_id WHERE ${allowed}
      AND m.operation=ANY($2) ORDER BY m.public_id,m.operation,a.id`,
        [key.id, key.scopes],
      )
    ).rows;
  }

  async function selectAccount(
    key,
    model: string,
    operation: string,
    fixed: string | null = null,
    reserve = true,
  ) {
    if (!key.scopes.includes(operation)) throw new AppError(403, 'operation_not_granted');
    return tx(async (client) => {
      const {
        rows: [account],
      } = await client.query(
        `SELECT a.*,m.upstream_id,m.capabilities
        FROM provider_accounts a JOIN account_models m ON a.id=m.account_id
        WHERE ${allowed} AND m.public_id=$2 AND m.operation=$3 AND ($4::uuid IS NULL OR a.id=$4)
        AND (NOT $5::boolean OR ((a.cooldown_until IS NULL OR a.cooldown_until<=now())
        AND (SELECT count(*) FROM account_leases l WHERE l.account_id=a.id AND l.until_at>now())<a.concurrency))
        ORDER BY a.last_used_at NULLS FIRST,a.id LIMIT 1 ${reserve ? 'FOR UPDATE OF a SKIP LOCKED' : ''}`,
        [key.id, model, operation, fixed, reserve],
      );
      if (!account) {
        const visible = await client.query(
          `SELECT 1 FROM provider_accounts a JOIN account_models m ON a.id=m.account_id
          WHERE ${allowed} AND m.public_id=$2 AND m.operation=$3 LIMIT 1`,
          [key.id, model, operation],
        );
        throw new AppError(
          visible.rowCount ? 429 : 404,
          visible.rowCount ? 'account_unavailable' : 'model_not_found',
        );
      }
      if (!reserve) return account;
      const lease = randomUUID();
      await client.query("INSERT INTO account_leases VALUES($1,$2,now()+interval '22 minutes')", [
        lease,
        account.id,
      ]);
      await client.query('UPDATE provider_accounts SET last_used_at=now() WHERE id=$1', [account.id]);
      return { ...account, lease };
    });
  }

  async function claimAccount(id: string) {
    return tx(async (client) => {
      const {
        rows: [account],
      } = await client.query(
        `SELECT a.* FROM provider_accounts a WHERE a.id=$1 AND a.enabled
        AND (a.cooldown_until IS NULL OR a.cooldown_until<=now())
        AND (SELECT count(*) FROM account_leases l WHERE l.account_id=a.id AND l.until_at>now())<a.concurrency
        FOR UPDATE OF a SKIP LOCKED`,
        [id],
      );
      if (!account) return;
      const lease = randomUUID();
      await client.query("INSERT INTO account_leases VALUES($1,$2,now()+interval '15 minutes')", [lease, id]);
      await client.query('UPDATE provider_accounts SET last_used_at=now() WHERE id=$1', [id]);
      return { ...account, lease };
    });
  }

  async function currentCredential(account, signal: AbortSignal) {
    for (;;) {
      signal.throwIfAborted();
      const {
        rows: [row],
      } = await db.query('SELECT * FROM provider_accounts WHERE id=$1', [account.id]);
      if (!row?.enabled) throw new AppError(409, 'account_disabled');
      const value = unseal(row.id, row.secret);
      if (!row.expires_at || new Date(row.expires_at).getTime() > Date.now() + 60_000) return value;
      const claimed = await db.query(
        `UPDATE provider_accounts SET refresh_until=now()+interval '35 seconds'
        WHERE id=$1 AND credential_version=$2 AND (refresh_until IS NULL OR refresh_until<=now())`,
        [row.id, row.credential_version],
      );
      if (!claimed.rowCount) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      try {
        const next = await refreshCredential(
          row.provider,
          row.kind,
          value,
          AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
        );
        const updated = await db.query(
          `UPDATE provider_accounts SET secret=$1,expires_at=$2,
          refresh_until=NULL,credential_version=credential_version+1 WHERE id=$3 AND credential_version=$4`,
          [seal(row.id, next), next.expiresAt, row.id, row.credential_version],
        );
        if (updated.rowCount) return next;
      } catch {
        await db.query(
          `UPDATE provider_accounts SET refresh_until=NULL,cooldown_until=now()+interval '30 seconds'
          WHERE id=$1 AND credential_version=$2`,
          [row.id, row.credential_version],
        );
        throw new AppError(503, 'credential_refresh_failed');
      }
    }
  }

  return {
    db,
    tx,
    seal,
    unseal,
    signedMedia,
    verifyMedia,
    initialize,
    createAdminSession,
    hasAdminSession,
    endAdminSession,
    getKey,
    createKey,
    addAccount,
    models,
    selectAccount,
    claimAccount,
    currentCredential,
    release: (lease: string) => db.query('DELETE FROM account_leases WHERE id=$1', [lease]),
  };
}

export type Store = ReturnType<typeof openStore>;
