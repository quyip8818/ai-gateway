import { AppError } from '../../domain.ts';
import { normalizeApiKey, normalizeOAuth, type CredentialInput } from '../credentials.ts';
import {
  createOpenAIOAuthRequest, deriveAccountId, exchangeOpenAIOAuthCode, refreshOpenAIOAuthTokens,
} from './oauth.ts';
import { discoverCodexModels, requestCodexResponse } from './responses.ts';

export async function refreshCodex(c, signal: AbortSignal) {
  const result = await refreshOpenAIOAuthTokens({ refreshToken: c.refreshToken, signal });
  return {
    ...c,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken || c.refreshToken,
    accountId: result.accountId || c.accountId,
    idToken: result.idToken || c.idToken,
    expiresAt: new Date(Date.now() + (result.expiresIn ?? 3600) * 1000).toISOString(),
  };
}

export async function discoverCodex(kind: string, c, signal: AbortSignal) {
  if (kind === 'oauth') {
    const models = await discoverCodexModels(c, signal);
    return models.map((id) => ({ id, operation: 'responses', capabilities: { streaming: true } }));
  }
  const res = await fetch('https://api.openai.com/v1/models', {
    headers: { authorization: `Bearer ${c.token}` },
    signal,
    redirect: 'error',
  });
  if (!res.ok) throw new Error('OpenAI model discovery failed');
  const { data } = await res.json();
  return data.map((m) => ({ id: m.id, operation: 'responses', capabilities: { streaming: true } }));
}

export function validateCodexInput(kind: string, input: Record<string, unknown>) {
  if (
    kind === 'oauth' &&
    (input.previous_response_id ||
      (Array.isArray(input.input) && input.input.some((item) => item?.type === 'item_reference')))
  ) {
    throw new AppError(400, 'responses_continuation_unsupported');
  }
}

export function invokeCodex(kind: string, credential, model: string, input, signal: AbortSignal) {
  const body = { ...input, model };
  if (kind === 'oauth') return requestCodexResponse(credential, body, signal);
  return fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    body: JSON.stringify(body),
    signal,
    redirect: 'error',
    headers: { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json' },
  });
}

export function normalizeCodexCredential(kind: string, input: CredentialInput) {
  return kind === 'api-key' ? normalizeApiKey(input) : normalizeOAuth(input, kind, deriveAccountId);
}

export const codexAuthorization = { begin: createOpenAIOAuthRequest, exchange: exchangeOpenAIOAuthCode };
