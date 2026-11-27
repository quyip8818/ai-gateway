import pg from 'pg';
import schema from './initial.sql';

const SCHEMA_VERSION = 10;

const SCHEMA_LOCK = 'SELECT pg_advisory_xact_lock(683191340)';

async function installSchema(client: pg.PoolClient) {
  await client.query(schema);
  await client.query('INSERT INTO gateway_schema(version) VALUES($1)', [SCHEMA_VERSION]);
}

export async function initializeSchema(client: pg.PoolClient) {
  await client.query(SCHEMA_LOCK);
  const { rows: [table] } = await client.query("SELECT to_regclass('gateway_schema') IS NOT NULL AS present");
  if (!table.present) {
    await installSchema(client);
    return;
  }

  const { rows: [marker] } = await client.query('SELECT version FROM gateway_schema WHERE singleton');
  if (marker?.version !== SCHEMA_VERSION) {
    throw new Error(`The database schema version is unsupported (found ${marker?.version ?? 'none'}, expected ${SCHEMA_VERSION}). Use an empty database or schema, or run npm run reset to clear the gateway tables.`);
  }
}

export async function resetSchema(client: pg.PoolClient) {
  await client.query(SCHEMA_LOCK);
  const { rows: [{ name }] } = await client.query<{ name: string | null }>(
    'SELECT current_schema() AS name',
  );
  if (!name) throw new Error('DATABASE_URL does not select a PostgreSQL schema.');

  const namespace = pg.escapeIdentifier(name);
  await client.query('SET LOCAL search_path TO ' + namespace);
  const tables = [
    'gateway_schema', 'admin_sessions', 'provider_accounts', 'account_credential_fingerprints',
    'account_models', 'api_keys', 'account_leases', 'video_jobs', 'media_assets',
    'request_attempts', 'authorization_flows', 'runtime_settings',
  ];
  await client.query('DROP TABLE IF EXISTS ' + tables.map((table) => namespace + '.' + table).join(', '));
  await installSchema(client);
}
