import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCredential, invokeText } from '../dist/providers/index.js';
import { EventStreamDecoder } from '../dist/providers/kiro/kiro/event-stream.js';
import { packet } from './upstream-fixture.mjs';

test('isolates credential kinds and validates AWS region', () => {
  assert.deepEqual(normalizeCredential('jimeng', 'cookie', 'a=b; sessionid=fixture'), { token: 'fixture' });
  assert.throws(() => normalizeCredential('kiro', 'oidc', { region: 'bad.example', refreshToken: 'x' }));
  assert.throws(() => normalizeCredential('__proto__', 'oauth', {}));
});

test('decodes split Kiro frames and rejects invalid CRC', () => {
  const frame = packet('assistantResponseEvent', { content: 'hello' });
  const decoder = new EventStreamDecoder();
  assert.deepEqual(decoder.push(frame.subarray(0, 9)), []);
  const [result] = decoder.push(frame.subarray(9));
  assert.equal(result.headers[':event-type'], 'assistantResponseEvent');
  assert.deepEqual(JSON.parse(Buffer.from(result.payload)), { content: 'hello' });
  frame[frame.length - 1] ^= 0xff;
  assert.throws(() => new EventStreamDecoder().push(frame));
});

test('sends Claude requests directly to Anthropic', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(options.headers.get('x-api-key'), 'fixture');
    assert.equal(JSON.parse(options.body).model, 'upstream');
    return Response.json({ ok: true });
  });
  const response = await invokeText(
    { provider: 'claude', kind: 'api-key', credential: { token: 'fixture' } },
    'upstream',
    'messages',
    { model: 'claude/alias' },
    new Headers(),
    new AbortController().signal,
  );
  assert.deepEqual(await response.json(), { ok: true });
});
