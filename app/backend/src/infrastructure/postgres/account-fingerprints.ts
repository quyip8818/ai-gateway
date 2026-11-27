import type pg from 'pg';
import type { GatewayCrypto } from '../crypto.ts';
import { AppError, type Provider } from '../../domain.ts';

import type { CredentialTokens } from '../../providers/credentials.ts';

export function createAccountFingerprints(digest: GatewayCrypto['digest']) {
  function hash(provider: Provider, token: string) {
    return digest(JSON.stringify(['account-credential', provider, token]));
  }

  function hashes(provider: Provider, credential: CredentialTokens) {
    const tokens = [credential.token, credential.accessToken, credential.refreshToken];
    return [...new Set(tokens)].flatMap((token) =>
      typeof token === 'string' && token ? [hash(provider, token)] : [],
    );
  }

  async function assertAvailable(db: pg.Pool | pg.PoolClient, fingerprints: Buffer[]) {
    const result = await db.query(
      'SELECT 1 FROM account_credential_fingerprints WHERE fingerprint=ANY($1::bytea[]) LIMIT 1',
      [fingerprints],
    );
    if (result.rowCount) throw new AppError(409, 'duplicate_account_credential');
  }

  async function record(db: pg.PoolClient, accountId: string, fingerprints: Buffer[]) {
    await db.query(
      `INSERT INTO account_credential_fingerprints(account_id,fingerprint)
       SELECT $1, unnest($2::bytea[]) ON CONFLICT DO NOTHING`,
      [accountId, fingerprints],
    );
  }

  function lock(db: pg.PoolClient, provider: Provider) {
    return db.query('SELECT pg_advisory_xact_lock(683191341, hashtext($1))', [provider]);
  }

  async function claimImport(db: pg.PoolClient, provider: Provider, refreshToken: string) {
    // Serialize uses of the same refresh token before any upstream call can rotate it.
    const key = hash(provider, refreshToken).readBigInt64BE(0).toString();
    const { rows: [result] } = await db.query(
      'SELECT pg_try_advisory_xact_lock($1::bigint) AS claimed',
      [key],
    );
    if (!result.claimed) throw new AppError(409, 'account_credential_import_in_progress');
  }

  return { hashes, assertAvailable, record, lock, claimImport };
}
