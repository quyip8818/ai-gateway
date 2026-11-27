import { setTimeout as delay } from 'node:timers/promises';
import { AppError, type Provider } from '../../domain.ts';
import type { GatewayCrypto } from '../../infrastructure/crypto.ts';
import type { Store } from '../../infrastructure/postgres/store.ts';
import { discover, normalizeCredential, normalizeJimengCredential, refreshCredential, codexAuthorization } from '../../providers/registry.ts';

import type { Settings } from '../settings/service.ts';
import { isBrowserTransportMode, jimengBrowserSettingId, type BrowserTransportMode } from '../../../../../shared/contracts/jimeng-settings.ts';
import { startupBrowserTransportMode } from '../../providers/jimeng/settings.ts';
import { withJimengRequest } from '../../providers/jimeng/context.ts';

type AccountRepository = Pick<Store,
  'importAccount' | 'findAccount' | 'syncAccountModels' | 'deleteAccount' | 'claimRefresh' | 'saveRefresh' | 'failRefresh' |
  'saveAuthorization' | 'consumeAuthorization' | 'selectAccount' | 'claimAccount' | 'release' |
  'listAccounts' | 'setAccountEnabled' | 'setAccountBrowserTransport'
>;

function accountValidationError(error: unknown) {
  return error instanceof AppError
    ? error
    : new AppError(422, 'account_validation_failed', 'Check the credential and its provider authorization');
}

export function createAccounts(store: AccountRepository, crypto: Pick<GatewayCrypto, 'unseal'>, redirectUri: string, settings: Pick<Settings, 'resolve'>) {
  async function withProviderSettings<T>(
    account: { provider: Provider; browser_transport?: BrowserTransportMode | null },
    signal: AbortSignal,
    run: () => Promise<T>,
  ) {
    if (account.provider !== 'jimeng') return run();
    const value = account.browser_transport ?? (await settings.resolve(jimengBrowserSettingId)).value;
    return withJimengRequest(signal, run, isBrowserTransportMode(value) ? value : startupBrowserTransportMode);
  }

  async function setBrowserTransport(id: string, value: unknown) {
    if (value !== null && !isBrowserTransportMode(value)) {
      throw new AppError(400, 'invalid_setting_value');
    }
    if ((await store.setAccountBrowserTransport(id, value)).rowCount) return;
    await existingAccount(id);
    throw new AppError(400, 'account_setting_unsupported');
  }

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
      try {
        credential = refreshToken ? await refreshCredential(provider, kind, imported, signal) : imported;
      } catch (error) {
        throw accountValidationError(error);
      }
      return { credential, models: await discoverModels({ provider, kind }, credential, signal) };
    });
  }

  async function credentialSnapshot(id: string, signal: AbortSignal, includeDisabled = false) {
    for (;;) {
      signal.throwIfAborted();
      const row = await store.findAccount(id);
      if (includeDisabled && !row) throw new AppError(404, 'account_not_found');
      if (!row || (!includeDisabled && !row.enabled)) throw new AppError(409, 'account_disabled');
      const value = crypto.unseal(row.id, row.secret);
      if (!row.expires_at || new Date(row.expires_at).getTime() > Date.now() + 60_000) return { account: row, credential: value };
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
        if (updated.rowCount) return { account: { ...row, credential_version: updated.rows[0].credential_version }, credential: next };
      } catch {
        await store.failRefresh(row.id, row.credential_version);
        throw new AppError(503, 'credential_refresh_failed');
      }
    }
  }

  async function currentCredential(account: { id: string }, signal: AbortSignal) {
    return (await credentialSnapshot(account.id, signal)).credential;
  }

  async function existingAccount(id: string) {
    const account = await store.findAccount(id);
    if (!account) throw new AppError(404, 'account_not_found');
    return account;
  }

  async function reload(id: string, signal: AbortSignal) {
    const { account, credential } = await credentialSnapshot(id, signal, true);
    const models = await discoverModels(account, credential, signal);
    await store.syncAccountModels(account, models);
  }

  async function discoverModels(account: { provider: Provider; kind: string; browser_transport?: BrowserTransportMode | null }, credential: unknown, signal: AbortSignal) {
    let models;
    try {
      models = await withProviderSettings(account, signal, () => discover(account.provider, account.kind, credential, signal));
    } catch (error) {
      throw accountValidationError(error);
    }
    if (!models.length) throw new AppError(422, 'no_provider_models');
    return models;
  }

  async function replaceCookie(id: string, cookie: string, signal: AbortSignal) {
    const account = await existingAccount(id);
    if (account.provider !== 'jimeng' || account.kind !== 'cookie')
      throw new AppError(400, 'account_cookie_unsupported');
    const credential = normalizeJimengCredential({ token: cookie });
    const models = await discoverModels(account, credential, signal);
    await store.syncAccountModels(account, models, credential);
  }

  async function remove(id: string) {
    await store.deleteAccount(await existingAccount(id));
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
    list: store.listAccounts, setEnabled, setBrowserTransport, withProviderSettings,
    addAccount, currentCredential, credentialSnapshot, beginAuthorization, completeAuthorization, reload, replaceCookie, remove,
    find: store.findAccount, select: store.selectAccount, claim: store.claimAccount, release: store.release,
  };
}

export type Accounts = ReturnType<typeof createAccounts>;
