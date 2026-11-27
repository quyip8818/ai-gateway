import { setTimeout as delay } from 'node:timers/promises';
import { AppError, type Provider } from '../../domain.ts';
import type { GatewayCrypto } from '../../infrastructure/crypto.ts';
import type { Store } from '../../infrastructure/postgres/store.ts';
import { discover, normalizeCredential, refreshCredential, codexAuthorization } from '../../providers/registry.ts';

type AccountRepository = Pick<Store,
  'importAccount' | 'findAccount' | 'claimRefresh' | 'saveRefresh' | 'failRefresh' |
  'saveAuthorization' | 'consumeAuthorization' | 'selectAccount' | 'claimAccount' | 'release' |
  'listAccounts' | 'setAccountEnabled'
>;

function accountValidationError(error: unknown) {
  return error instanceof AppError
    ? error
    : new AppError(422, 'account_validation_failed', 'Check the credential and its provider authorization');
}

export function createAccounts(store: AccountRepository, crypto: Pick<GatewayCrypto, 'unseal'>, redirectUri: string) {
  async function addAccount(provider: Provider, kind: string, label: string, raw: unknown, signal: AbortSignal) {
    let imported: ReturnType<typeof normalizeCredential>;
    try {
      imported = normalizeCredential(provider, kind, raw);
    } catch (error) {
      throw accountValidationError(error);
    }

    const refreshToken = 'refreshToken' in imported && typeof imported.refreshToken === 'string' &&
      (!imported.accessToken || provider === 'kiro' ||
        (typeof imported.expiresAt === 'string' && Date.parse(imported.expiresAt) <= Date.now()))
      ? imported.refreshToken
      : undefined;

    return store.importAccount(provider, kind, label, imported, refreshToken, async () => {
      signal.throwIfAborted();
      let credential;
      let models;
      try {
        credential = refreshToken ? await refreshCredential(provider, kind, imported, signal) : imported;
        models = await discover(provider, kind, credential, signal);
      } catch (error) {
        throw accountValidationError(error);
      }
      if (!models.length) throw new AppError(422, 'no_provider_models');
      return { credential, models };
    });
  }

  async function currentCredential(account: { id: string }, signal: AbortSignal) {
    for (;;) {
      signal.throwIfAborted();
      const row = await store.findAccount(account.id);
      if (!row?.enabled) throw new AppError(409, 'account_disabled');
      const value = crypto.unseal(row.id, row.secret);
      if (!row.expires_at || new Date(row.expires_at).getTime() > Date.now() + 60_000) return value;
      const claimed = await store.claimRefresh(row.id, row.credential_version);
      if (!claimed.rowCount) {
        await delay(250, undefined, { signal });
        continue;
      }
      try {
        const next = await refreshCredential(
          row.provider, row.kind, value, AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
        );
        const updated = await store.saveRefresh(row.id, row.provider, row.credential_version, next);
        if (updated.rowCount) return next;
      } catch {
        await store.failRefresh(row.id, row.credential_version);
        throw new AppError(503, 'credential_refresh_failed');
      }
    }
  }

  async function beginAuthorization(label: string) {
    const flow = await codexAuthorization.begin({ redirectUri });
    await store.saveAuthorization(flow.state, label, flow.codeVerifier);
    return { url: flow.authorizationUrl, state: flow.state, redirect_uri: redirectUri };
  }

  async function completeAuthorization(callback: string, signal: AbortSignal) {
    let url: URL;
    try {
      url = new URL(callback);
    } catch {
      throw new AppError(400, 'invalid_oauth_callback');
    }
    const expected = new URL(redirectUri);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state || url.origin !== expected.origin || url.pathname !== expected.pathname)
      throw new AppError(400, 'invalid_oauth_callback');
    const flow = await store.consumeAuthorization(state);
    if (!flow) throw new AppError(400, 'oauth_flow_expired');
    const token = await codexAuthorization.exchange({ code, codeVerifier: flow.verifier, redirectUri, signal });
    return addAccount('codex', 'oauth', flow.label, {
      ...token,
      expiresAt: new Date(Date.now() + (token.expiresIn ?? 3600) * 1000).toISOString(),
    }, signal);
  }

  async function setEnabled(id: string, enabled: boolean) {
    if (!(await store.setAccountEnabled(id, enabled)).rowCount) throw new AppError(404, 'account_not_found');
  }

  return {
    list: store.listAccounts, setEnabled,
    addAccount, currentCredential, beginAuthorization, completeAuthorization,
    find: store.findAccount, select: store.selectAccount, claim: store.claimAccount, release: store.release,
  };
}

export type Accounts = ReturnType<typeof createAccounts>;
