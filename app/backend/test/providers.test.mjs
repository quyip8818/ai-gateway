import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCredential, invokeText } from '../../../dist/providers/registry.js';
import { EventStreamDecoder } from '../../../dist/providers/kiro/kiro/event-stream.js';
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

test('rejects oversized Kiro requests before contacting upstream', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('unexpected upstream request'));
  await assert.rejects(
    invokeText(
      { provider: 'kiro', kind: 'desktop', credential: { accessToken: 'fixture', apiRegion: 'us-east-1' } },
      'claude-sonnet-4.5',
      'messages',
      { model: 'kiro/claude-sonnet-4.5', messages: [{ role: 'user', content: 'x'.repeat(12_000_000) }] },
      new Headers(),
      new AbortController().signal,
    ),
    { status: 413, code: 'kiro_payload_too_large' },
  );
});

test('Kiro uses native thinking without injecting or replaying tagged reasoning', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const payload = JSON.parse(options.body);
    const model = payload.conversationState.currentMessage.userInputMessage.modelId;
    const native = model === 'claude-sonnet-4.5';
    assert.doesNotMatch(options.body, /<thinking>|previous reasoning/);
    assert.deepEqual(payload.additionalModelRequestFields, native ? { thinking: { type: 'adaptive' } } : undefined);
    return new Response(Buffer.concat([
      ...(native ? [packet('reasoningContentEvent', { text: 'native reasoning', signature: 'sig' })] : []),
      packet('assistantResponseEvent', { content: 'answer' }),
      packet('metadataEvent', { stopReason: 'END_TURN' }),
    ]));
  });

  for (const model of ['claude-sonnet-4.5', 'claude-haiku-4.5']) {
    const response = await invokeText(
      { provider: 'kiro', kind: 'desktop', credential: { accessToken: 'fixture', apiRegion: 'us-east-1' } },
      model,
      'messages',
      {
        model: 'kiro/' + model,
        thinking: { type: 'adaptive' },
        messages: [
          { role: 'user', content: 'first question' },
          { role: 'assistant', content: [
            { type: 'thinking', thinking: 'previous reasoning' },
            { type: 'text', text: 'first answer' },
          ] },
          { role: 'user', content: 'next question' },
        ],
      },
      new Headers(),
      new AbortController().signal,
    );
    const { content, usage } = await response.json();
    assert.ok(usage.input_tokens > 1);
    assert.deepEqual(content, [
      ...(model === 'claude-sonnet-4.5' ? [{ type: 'thinking', thinking: 'native reasoning', signature: 'sig' }] : []),
      { type: 'text', text: 'answer' },
    ]);
  }
});

const kiroAccount = {
  provider: 'kiro', kind: 'desktop', credential: { accessToken: 'fixture', apiRegion: 'us-east-1' },
};
const kiroInput = {
  model: 'kiro/claude-sonnet-4.5',
  messages: [{ role: 'user', content: 'fixture question' }],
};

function invokeKiroFixture(stream) {
  return invokeText(kiroAccount, 'claude-sonnet-4.5', 'messages', { ...kiroInput, stream },
    new Headers(), new AbortController().signal);
}

test('reports a Kiro refusal consistently in JSON and SSE', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(packet('metadataEvent', {
    stopDetails: { refusal: { category: 'fixture' } },
  })));
  await assert.rejects(invokeKiroFixture(false), { status: 422, code: 'request_refused' });
  const response = await invokeKiroFixture(true);
  const body = await response.text();
  assert.match(body, /"code":"request_refused"/);
  assert.doesNotMatch(body, /message_stop/);
});

test('cancelling Kiro SSE cancels a pending upstream read', { timeout: 2_000 }, async (t) => {
  const reading = Promise.withResolvers();
  const cancelled = Promise.withResolvers();
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    pull() {
      reading.resolve();
      return new Promise(() => {});
    },
    cancel() {
      cancelled.resolve();
    },
  })));
  const response = await invokeKiroFixture(true);
  await reading.promise;
  await response.body.cancel();
  await cancelled.promise;
});
