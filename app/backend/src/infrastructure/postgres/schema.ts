import type pg from 'pg';
import type { GatewayCrypto } from '../crypto.ts';
import type { createAccountFingerprints } from './account-fingerprints.ts';
import schema from './initial.sql';
import fingerprintSchema from './account-fingerprints.sql';

const SCHEMA_VERSION = 4;

export async function initializeSchema(
  client: pg.PoolClient,
  unseal: GatewayCrypto['unseal'],
  fingerprints: ReturnType<typeof createAccountFingerprints>,
) {
  await client.query('SELECT pg_advisory_xact_lock(683191340)');
  const exists = (await client.query("SELECT to_regclass('gateway_schema') IS NOT NULL AS value")).rows[0]
    .value;
  if (!exists) {
    await client.query(schema);
    await client.query(fingerprintSchema);
    await client.query('INSERT INTO gateway_schema(version) VALUES($1)', [SCHEMA_VERSION]);
    return;
  }
  const { rows: [marker] } = await client.query('SELECT version FROM gateway_schema WHERE singleton');
  if (marker?.version === 3) {
    // Quiesce writes while reading and backfilling the existing account snapshots.
    await client.query('LOCK TABLE provider_accounts IN SHARE MODE');
    await client.query(fingerprintSchema);
    const { rows } = await client.query('SELECT id,provider,secret FROM provider_accounts');
    for (const row of rows) {
      const credential = unseal(row.id, row.secret);
      await fingerprints.record(client, row.id, fingerprints.hashes(row.provider, credential));
    }
    await client.query('UPDATE gateway_schema SET version=$1 WHERE singleton', [SCHEMA_VERSION]);
    return;
  }
  if (marker?.version !== SCHEMA_VERSION) {
    throw new Error(`The database schema version is unsupported (found ${marker?.version ?? 'none'}, expected ${SCHEMA_VERSION}).`);
  }
}
