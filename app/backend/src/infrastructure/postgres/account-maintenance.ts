import type pg from 'pg';
import type { GatewayCrypto } from '../crypto.ts';
import type { DiscoveredModel } from '../../providers/registry.ts';
import { AppError, type Provider } from '../../domain.ts';
import type { createAccountFingerprints } from './account-fingerprints.ts';
import { failPendingVideos, hasPendingVideos } from './videos.ts';

export async function insertAccountModels(client: pg.PoolClient, id: string, provider: Provider, models: DiscoveredModel[]) {
  for (const model of models) {
    await client.query(
      `INSERT INTO account_models(account_id,public_id,upstream_id,operation,capabilities)
       VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [id, provider + '/' + model.id, model.id, model.operation, model.capabilities],
    );
  }
}

export function createAccountMaintenance(
  tx: <T>(run: (client: pg.PoolClient) => Promise<T>) => Promise<T>,
  seal: GatewayCrypto['seal'],
  fingerprints: ReturnType<typeof createAccountFingerprints>,
) {
  async function syncAccountModels(
    account: { id: string; provider: Provider; credential_version: string },
    models: DiscoveredModel[],
    replacement?: { token: string },
  ) {
    return tx(async (client) => {
      if (replacement) await fingerprints.lock(client, account.provider);
      const { rows: [current] } = await client.query(
        'SELECT credential_version FROM provider_accounts WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',
        [account.id],
      );
      if (!current) throw new AppError(404, 'account_not_found');
      if (current.credential_version !== account.credential_version)
        throw new AppError(409, 'account_changed');

      if (replacement) {
        if (await hasPendingVideos(client, account.id)) throw new AppError(409, 'account_has_pending_videos');
        const hashes = fingerprints.hashes(account.provider, replacement);
        await fingerprints.assertAvailable(client, hashes, account.id);
        await client.query(
          `UPDATE provider_accounts SET secret=$2, expires_at=NULL, refresh_until=NULL,
             cooldown_until=NULL, credential_version=credential_version+1 WHERE id=$1`,
          [account.id, seal(account.id, replacement)],
        );
        await fingerprints.remove(client, account.id);
        await fingerprints.record(client, account.id, hashes);
      }

      await client.query('DELETE FROM account_models WHERE account_id=$1', [account.id]);
      await insertAccountModels(client, account.id, account.provider, models);
    });
  }

  async function deleteAccount(account: { id: string; provider: Provider }) {
    return tx(async (client) => {
      await fingerprints.lock(client, account.provider);
      const result = await client.query(
        `UPDATE provider_accounts SET enabled=false, deleted_at=now(), secret=''::bytea,
           expires_at=NULL, refresh_until=NULL, cooldown_until=NULL,
           credential_version=credential_version+1 WHERE id=$1 AND deleted_at IS NULL`,
        [account.id],
      );
      if (!result.rowCount) throw new AppError(404, 'account_not_found');
      await client.query('DELETE FROM account_models WHERE account_id=$1', [account.id]);
      await fingerprints.remove(client, account.id);
      await failPendingVideos(client, account.id);
    });
  }

  return { syncAccountModels, deleteAccount };
}
