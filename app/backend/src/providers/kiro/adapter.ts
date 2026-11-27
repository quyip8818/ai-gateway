import { randomUUID } from 'node:crypto';
import { AppError } from '../../domain.ts';
import { MAX_PAYLOAD_BYTES } from './core/config.ts';
import { buildPayload } from './kiro/payload.ts';
import { invoke } from './kiro/client.ts';
import { ResponseBuilder, estimateTokens } from './anthropic/response.ts';
import { streamResponse } from './anthropic/stream.ts';

export async function refreshKiro(kind: string, c, signal: AbortSignal) {
  const endpoint =
    kind === 'oidc'
      ? `https://oidc.${c.region}.amazonaws.com/token`
      : `https://prod.${c.region}.auth.desktop.kiro.dev/refreshToken`;
  const payload =
    kind === 'oidc'
      ? {
          grantType: 'refresh_token',
          refreshToken: c.refreshToken,
          clientId: c.clientId,
          clientSecret: c.clientSecret,
        }
      : { refreshToken: c.refreshToken };
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
    redirect: 'error',
  });
  if (!res.ok) throw new Error('Kiro authorization refresh failed');
  const result = await res.json();
  if (!result.accessToken) throw new Error('Kiro returned no access token');
  return {
    ...c,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken || c.refreshToken,
    profileArn: result.profileArn || c.profileArn,
    expiresAt: new Date(Date.now() + (result.expiresIn ?? 3600) * 1000).toISOString(),
  };
}

export async function discoverKiro(kind: string, c, signal: AbortSignal) {
  const models = new Map();
  const seen = new Set();
  let nextToken;
  for (let page = 0; page < 10; page++) {
    const url = new URL(`https://runtime.${c.apiRegion}.kiro.dev/List-Available-Models`);
    url.searchParams.set('origin', 'AI_EDITOR');
    if (c.profileArn) url.searchParams.set('profileArn', c.profileArn);
    if (nextToken) url.searchParams.set('nextToken', nextToken);
    const headers: Record<string, string> = { authorization: `Bearer ${c.accessToken}` };
    if (kind === 'oidc') headers.tokentype = 'SSO_OIDC';
    const res = await fetch(url, { headers, signal, redirect: 'error' });
    if (!res.ok) throw new Error('Kiro model discovery failed');
    const result = await res.json();
    if (!Array.isArray(result.models)) throw new Error('Kiro returned an invalid model catalog');
    for (const model of [result.defaultModel, ...result.models]) {
      if (typeof model?.modelId !== 'string' || !model.modelId) continue;
      models.set(model.modelId, {
        id: model.modelId,
        operation: 'messages',
        capabilities: { streaming: true, token_limits: model.tokenLimits },
      });
    }
    nextToken = result.nextToken;
    if (!nextToken) return [...models.values()];
    if (seen.has(nextToken)) throw new Error('Kiro returned repeated model pages');
    seen.add(nextToken);
  }
  throw new Error('Kiro model catalog exceeds the page limit');
}

export async function invokeKiro(kind: string, credential, model: string, input, signal: AbortSignal) {
  const payload = { ...input, model };
  const kiroPayload = buildPayload(payload, model, credential.profileArn, randomUUID());
  const body = JSON.stringify(kiroPayload);
  if (Buffer.byteLength(body) > MAX_PAYLOAD_BYTES) throw new AppError(413, 'kiro_payload_too_large');
  const prompt = Math.max(1, estimateTokens(JSON.stringify(payload.messages).length));
  if (payload.stream) {
    const cancelled = new AbortController();
    const events = invoke(body, credential.accessToken, credential.apiRegion, kind === 'oidc',
      AbortSignal.any([signal, cancelled.signal]));
    return streamResponse(events, input.model, prompt, () => cancelled.abort());
  }
  const response = new ResponseBuilder();
  for await (const event of invoke(body, credential.accessToken, credential.apiRegion, kind === 'oidc', signal)) {
    response.accept(event);
  }
  return Response.json(response.response(input.model, prompt));
}
