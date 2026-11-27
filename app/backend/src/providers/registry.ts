import { credentialKinds, isProvider, type Provider } from '../domain.ts';
import { normalizeApiKey, normalizeOAuth, type CredentialInput, type CredentialTokens } from './credentials.ts';
import { codexAuthorization, discoverCodex, invokeCodex, normalizeCodexCredential, refreshCodex, validateCodexInput } from './codex/adapter.ts';
import { discoverKiro, invokeKiro, refreshKiro } from './kiro/adapter.ts';
import { discoverJimeng, normalizeJimengCredential } from './jimeng/adapter.ts';
import { discoverClaude, invokeClaude } from './claude.ts';

export interface DiscoveredModel {
  id: string;
  operation: string;
  capabilities: unknown;
}

interface ProviderAdapter {
  normalize(kind: string, input: CredentialInput): ReturnType<typeof normalizeApiKey> | ReturnType<typeof normalizeOAuth>;
  discover(kind: string, credential, signal: AbortSignal): Promise<DiscoveredModel[]>;
  refresh?(kind: string, credential, signal: AbortSignal): Promise<CredentialTokens & { expiresAt?: string }>;
  validateText?(kind: string, input: Record<string, unknown>): void;
  text?(kind: string, credential, model: string, operation: string, input, headers: Headers, signal: AbortSignal): Promise<Response>;
}

const adapters: Record<Provider, ProviderAdapter> = {
  jimeng: {
    normalize: (_kind, input) => normalizeJimengCredential(input),
    discover: (_kind, credential, signal) => discoverJimeng(credential, signal),
  },
  codex: {
    normalize: normalizeCodexCredential,
    discover: discoverCodex,
    validateText: validateCodexInput,
    refresh: (_kind, credential, signal) => refreshCodex(credential, signal),
    text: (kind, credential, model, _operation, input, _headers, signal) =>
      invokeCodex(kind, credential, model, input, signal),
  },
  kiro: {
    normalize: (kind, input) => normalizeOAuth(input, kind),
    discover: discoverKiro,
    refresh: refreshKiro,
    text: (kind, credential, model, _operation, input, _headers, signal) =>
      invokeKiro(kind, credential, model, input, signal),
  },
  claude: {
    normalize: (_kind, input) => normalizeApiKey(input),
    discover: (_kind, credential, signal) => discoverClaude(credential, signal),
    text: (_kind, credential, model, operation, input, headers, signal) =>
      invokeClaude(credential, model, operation, input, headers, signal),
  },
};

export function normalizeCredential(provider: string, kind: string, input: unknown) {
  if (!isProvider(provider) || !credentialKinds[provider].some((value) => value === kind)) {
    throw new Error('Unsupported provider or credential type');
  }
  const file = input && typeof input === 'object' ? (input as CredentialInput) : undefined;
  const credential = typeof input === 'string' ? { token: input.trim() } : (file?.tokens ?? file);
  if (!credential || typeof credential !== 'object') throw new Error('Credential is required');
  return adapters[provider].normalize(kind, credential as CredentialInput);
}

export function refreshCredential(provider: string, kind: string, credential, signal: AbortSignal) {
  if (!credential.refreshToken) throw new Error('Account requires authorization');
  const refresh = isProvider(provider) ? adapters[provider].refresh : undefined;
  if (!refresh) throw new Error('Provider credentials must be replaced');
  return refresh(kind, credential, signal);
}

export function discover(provider: string, kind: string, credential, signal: AbortSignal) {
  if (!isProvider(provider)) throw new Error('Unknown provider');
  return adapters[provider].discover(kind, credential, signal);
}

export function validateTextInput(provider: string, kind: string, input: Record<string, unknown>) {
  if (isProvider(provider)) adapters[provider].validateText?.(kind, input);
}

export function invokeText(account, model: string, operation: string, input, headers: Headers, signal: AbortSignal) {
  const { provider, kind, credential } = account;
  const invoke = isProvider(provider) ? adapters[provider].text : undefined;
  if (!invoke) throw new Error('Provider does not support text execution');
  return invoke(kind, credential, model, operation, input, headers, signal);
}

export { codexAuthorization, normalizeJimengCredential };
export { jimengImages, jimengVideos, jimengMediaFiles } from './jimeng/media.ts';
