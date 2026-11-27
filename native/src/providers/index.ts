import { credentialKinds, isProvider } from '../domain.ts';
import { deriveAccountId } from './codex/runtime.ts';
import { discoverCodex, invokeCodex, refreshCodex } from './codex/adapter.ts';
import { discoverKiro, invokeKiro, refreshKiro } from './kiro/adapter.ts';
import { discoverJimeng } from './jimeng/adapter.ts';
import { discoverClaude, invokeClaude } from './claude.ts';

export function normalizeCredential(provider: string, kind: string, input: unknown) {
  if (!isProvider(provider) || !credentialKinds[provider].some((value) => value === kind)) {
    throw new Error('Unsupported provider or credential type');
  }
  const file = input && typeof input === 'object' ? (input as Record<string, unknown>) : undefined;
  const c = (typeof input === 'string' ? { token: input.trim() } : (file?.tokens ?? file)) as Record<
    string,
    unknown
  >;
  if (!c || typeof c !== 'object') throw new Error('Credential is required');
  if (kind === 'cookie') {
    const raw = String(c.token ?? c.cookie ?? '').trim();
    const token = raw.includes('=') ? raw.match(/(?:^|;\s*)(?:sessionid|sessionid_ss|sid_tt)=([^;]+)/)?.[1] : raw;
    if (!token || !/^[^;\s]+$/.test(token)) throw new Error('A Jimeng sessionid is required');
    return { token };
  }
  if (kind === 'api-key') {
    const token = String(c.token ?? c.apiKey ?? '').trim();
    if (!token || /\s/.test(token)) throw new Error('An API key is required');
    return { token };
  }
  const accessToken = c.accessToken ?? c.access_token;
  const refreshToken = c.refreshToken ?? c.refresh_token;
  const idToken = c.idToken ?? c.id_token;
  const accountId =
    c.accountId ??
    c.account_id ??
    (provider === 'codex' && accessToken ? deriveAccountId(String(accessToken)) : undefined);
  const region = c.region ?? 'us-east-1';
  const apiRegion = c.apiRegion ?? c.api_region ?? 'us-east-1';
  if (
    [
      accessToken,
      refreshToken,
      idToken,
      c.accountId,
      c.account_id,
      c.clientId,
      c.clientSecret,
      c.profileArn,
      c.profile_arn,
    ].some((value) => value != null && (typeof value !== 'string' || value.length > 16384))
  ) {
    throw new Error('Invalid credential field');
  }
  if (!accessToken && !refreshToken) throw new Error('An access or refresh token is required');
  if (
    ![region, apiRegion].every((value) => typeof value === 'string' && /^[a-z]{2}(?:-[a-z]+)+-\d$/.test(value))
  ) {
    throw new Error('Invalid AWS region');
  }
  if (kind === 'oidc' && (!c.clientId || !c.clientSecret)) throw new Error('OIDC requires its registered client');
  const expiresAt = c.expiresAt ?? c.expires_at;
  if (expiresAt != null && (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)))) {
    throw new Error('Invalid credential expiration');
  }
  return {
    accessToken,
    refreshToken,
    idToken,
    accountId,
    region,
    apiRegion,
    expiresAt,
    clientId: c.clientId,
    clientSecret: c.clientSecret,
    profileArn: c.profileArn ?? c.profile_arn,
  };
}

export function refreshCredential(provider: string, kind: string, credential, signal: AbortSignal) {
  if (!credential.refreshToken) throw new Error('Account requires authorization');
  if (provider === 'codex') return refreshCodex(credential, signal);
  if (provider === 'kiro') return refreshKiro(kind, credential, signal);
  throw new Error('Provider credentials must be replaced');
}

export function discover(provider: string, kind: string, credential, signal: AbortSignal) {
  switch (provider) {
    case 'jimeng':
      return discoverJimeng(credential, signal);
    case 'codex':
      return discoverCodex(kind, credential, signal);
    case 'kiro':
      return discoverKiro(kind, credential, signal);
    case 'claude':
      return discoverClaude(credential, signal);
    default:
      throw new Error('Unknown provider');
  }
}

export function invokeText(
  account,
  model: string,
  operation: string,
  input,
  headers: Headers,
  signal: AbortSignal,
) {
  const { provider, kind, credential } = account;
  switch (provider) {
    case 'codex':
      return invokeCodex(kind, credential, model, input, signal);
    case 'kiro':
      return invokeKiro(kind, credential, model, input, signal);
    case 'claude':
      return invokeClaude(credential, model, operation, input, headers, signal);
    default:
      throw new Error('Provider does not support text execution');
  }
}
