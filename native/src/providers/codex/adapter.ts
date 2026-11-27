import { createOpenAIOAuthTransport, refreshOpenAIOAuthTokens } from './runtime.ts';

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
    const transport = createOpenAIOAuthTransport({ auth: c });
    const res = await transport.request('/models', { signal });
    if (!res.ok) throw new Error('Codex model discovery failed');
    const data = await res.json();
    const models = data.data ?? data.models;
    if (!Array.isArray(models)) throw new Error('Codex returned an invalid model catalog');
    return models
      .filter((m) => typeof (m.id ?? m.slug) === 'string')
      .map((m) => ({ id: m.id ?? m.slug, operation: 'responses', capabilities: { streaming: true } }));
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

export function invokeCodex(kind: string, credential, model: string, input, signal: AbortSignal) {
  const request = { method: 'POST', body: JSON.stringify({ ...input, model }), signal };
  if (kind === 'oauth') return createOpenAIOAuthTransport({ auth: credential }).request('/responses', request);
  return fetch('https://api.openai.com/v1/responses', {
    ...request,
    redirect: 'error',
    headers: { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json' },
  });
}
