import { createAccountMaintenance, insertAccountModels } from './account-maintenance.ts';
import { createRecords } from './records.ts';
import { createSettingsRepository } from './settings.ts';
import { createMediaRepository } from './media.ts';
import { createVideoRepository } from './videos.ts';
import { randomBytes, randomUUID } from 'node:crypto';
import type { GatewayCrypto } from '../crypto.ts';
import pg from 'pg';
import { withTransaction } from './transaction.ts';
import { initializeSchema } from './schema.ts';
import { createAccountFingerprints } from './account-fingerprints.ts';
import type { CredentialTokens } from '../../providers/credentials.ts';

import type { DiscoveredModel } from '../../providers/registry.ts';
import { AppError, type Provider } from '../../domain.ts';

export function openStore(connection: string, { seal, unseal, digest }: GatewayCrypto) {
  const db = new pg.Pool({ connectionString: connection, max: 20 });
  const fingerprints = createAccountFingerprints(digest);
  const tx = <T>(run: (client: pg.PoolClient) => Promise<T>) => withTransaction(db, run);

  function sessionDigest(scope: string, session: string) {
    return digest(`admin-session:${scope}:${session}`);
  }

  function createAdminSession(scope: string, previous: string | undefined, seconds: number) {
    const session = randomBytes(32).toString('base64url');
    return tx(async (client) => {
      await client.query('DELETE FROM admin_sessions WHERE expires_at<=now() OR digest=$1', [
        previous ? sessionDigest(scope, previous) : null,
      ]);
      await client.query(
        "INSERT INTO admin_sessions(digest,expires_at) VALUES($1,now()+$2*interval '1 second')",
        [sessionDigest(scope, session), seconds],
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
    providers: Provider[],
    scopes: string[],
    expiresAt: string | null,
  ) {
    const token = 'ag_' + randomBytes(32).toString('base64url');
    const {
      rows: [key],
    } = await db.query(
      `INSERT INTO api_keys(label,prefix,digest,scopes,expires_at,providers) VALUES($1,$2,$3,$4,$5,$6)
       RETURNING id,label,prefix,scopes,expires_at,providers`,
      [label, token.slice(0, 12), digest(token), scopes, expiresAt, providers],
    );
    return { ...key, token };
  }

  async function importAccount(
    provider: Provider,
    kind: string,
    label: string,
    imported: CredentialTokens,
    refreshToken: string | undefined,
    prepare: () => Promise<{
      credential: CredentialTokens & { expiresAt?: unknown };
      models: DiscoveredModel[];
    }>,
  ) {
    const importedHashes = fingerprints.hashes(provider, imported);
    const id = randomUUID();

    async function insert(client: pg.PoolClient, { credential, models }: Awaited<ReturnType<typeof prepare>>) {
      const hashes = [...importedHashes, ...fingerprints.hashes(provider, credential)];
      await fingerprints.lock(client, provider);
      await fingerprints.assertAvailable(client, hashes);
      await client.query(
        `INSERT INTO provider_accounts(id,provider,kind,label,secret,expires_at)
        VALUES($1,$2,$3,$4,$5,$6)`,
        [
          id,
          provider,
          kind,
          label || `${provider}-${id.slice(0, 8)}`,
          seal(id, credential),
          credential.expiresAt ?? null,
        ],
      );
      await fingerprints.record(client, id, hashes);
      await insertAccountModels(client, id, models);
      return { id, model_count: models.length };
    }

    if (refreshToken) {
      return tx(async (client) => {
        await fingerprints.claimImport(client, provider, refreshToken);
        await fingerprints.assertAvailable(client, importedHashes);
        return insert(client, await prepare());
      });
    }

    await fingerprints.assertAvailable(db, importedHashes);
    const prepared = await prepare();
    return tx((client) => insert(client, prepared));
  }

  const allowed = `a.enabled AND EXISTS
    (SELECT 1 FROM api_keys k
      WHERE k.id=$1 AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>now())
      AND a.provider=ANY(k.providers))`;

  async function models(key) {
    return (
      await db.query<{ id: string; operation: string; capabilities: Record<string, unknown>; provider: Provider }>(
        `SELECT DISTINCT ON(m.public_id,m.operation) m.public_id AS id,m.operation,m.capabilities,a.provider
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
        `SELECT a.id,a.provider,a.kind,a.credential_version,m.upstream_id
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
          WHERE ${allowed} AND m.public_id=$2 AND m.operation=$3 AND ($4::uuid IS NULL OR a.id=$4) LIMIT 1`,
          [key.id, model, operation, fixed],
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

  function findAccount(id: string) {
    return db.query('SELECT * FROM provider_accounts WHERE id=$1 AND deleted_at IS NULL', [id]).then((result) => result.rows[0]);
  }

  function claimRefresh(id: string, version: number) {
    return db.query(
      `UPDATE provider_accounts SET refresh_until=now()+interval '35 seconds'
      WHERE id=$1 AND credential_version=$2 AND (refresh_until IS NULL OR refresh_until<=now())`,
      [id, version],
    );
  }

  function saveRefresh(id: string, provider: Provider, version: number, next) {
    return tx(async (client) => {
      await fingerprints.lock(client, provider);
      const updated = await client.query(
        `UPDATE provider_accounts SET secret=$1,expires_at=$2,
        refresh_until=NULL,credential_version=credential_version+1 WHERE id=$3 AND credential_version=$4
         RETURNING credential_version`,
        [seal(id, next), next.expiresAt, id, version],
      );
      if (updated.rowCount) await fingerprints.record(client, id, fingerprints.hashes(provider, next));
      return updated;
    });
  }

  function failRefresh(id: string, version: number) {
    return db.query(
      `UPDATE provider_accounts SET refresh_until=NULL,cooldown_until=now()+interval '30 seconds'
      WHERE id=$1 AND credential_version=$2`,
      [id, version],
    );
  }

  async function saveAuthorization(state: string, label: string, verifier: string) {
    await db.query('DELETE FROM authorization_flows WHERE expires_at<=now()');
    await db.query(`INSERT INTO authorization_flows VALUES($1,$2,$3,now()+interval '10 minutes')`, [
      state, label, seal(state, verifier),
    ]);
  }

  async function consumeAuthorization(state: string) {
    const { rows: [flow] } = await db.query(
      'DELETE FROM authorization_flows WHERE state=$1 AND expires_at>now() RETURNING label,verifier',
      [state],
    );
    return flow && { label: flow.label, verifier: unseal(state, flow.verifier) };
  }

  return {
    health: () => db.query('SELECT 1'),
    close: () => db.end(),
    initialize: () => tx(initializeSchema),
    createAdminSession,
    hasAdminSession,
    endAdminSession,
    getKey,
    createKey,
    importAccount,
    findAccount,
    ...createAccountMaintenance(tx, seal, fingerprints),
    claimRefresh,
    saveRefresh,
    failRefresh,
    saveAuthorization,
    consumeAuthorization,
    models,
    selectAccount,
    claimAccount,
    ...createRecords(db),
    ...createSettingsRepository(db),
    ...createMediaRepository(db),
    ...createVideoRepository(db, tx, { seal, unseal }),
    release: (lease: string) => db.query('DELETE FROM account_leases WHERE id=$1', [lease]),
  };
}

export type Store = ReturnType<typeof openStore>;
