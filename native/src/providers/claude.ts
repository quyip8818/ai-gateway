export async function discoverClaude(credential, signal: AbortSignal) {
  const res = await fetch('https://api.anthropic.com/v1/models', {
    headers: { 'x-api-key': credential.token, 'anthropic-version': '2023-06-01' },
    signal,
    redirect: 'error',
  });
  if (!res.ok) throw new Error('Claude model discovery failed');
  const { data } = await res.json();
  return data.map((m) => ({
    id: m.id,
    operation: 'messages',
    capabilities: { streaming: true, count_tokens: true },
  }));
}

export function invokeClaude(
  credential,
  model: string,
  operation: string,
  input,
  headers: Headers,
  signal: AbortSignal,
) {
  const upstreamHeaders = new Headers({
    'x-api-key': credential.token,
    'content-type': 'application/json',
    'anthropic-version': headers.get('anthropic-version') ?? '2023-06-01',
  });
  if (headers.has('anthropic-beta')) upstreamHeaders.set('anthropic-beta', headers.get('anthropic-beta')!);
  return fetch(`https://api.anthropic.com/v1/messages${operation === 'count_tokens' ? '/count_tokens' : ''}`, {
    method: 'POST',
    body: JSON.stringify({ ...input, model }),
    signal,
    headers: upstreamHeaders,
    redirect: 'error',
  });
}
