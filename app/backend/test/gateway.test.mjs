import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';
import { testTool } from './text-provider-contract.mjs';

test(
  'a fresh PostgreSQL database exercises all products and their access boundaries',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 90_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-gateway-native-test-'));
    const db = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await db.connect();
    const schema = 'native_test_' + process.pid;
    await db.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.searchParams.set('options', '-c search_path=' + schema);
    const username = 'test-admin';
    const password = 'test-only-password-for-gateway';
    const port = Number(process.env.TEST_GATEWAY_PORT ?? 55472);
    const cancellation = join(directory, 'cancellation.txt');
    const submissions = join(directory, 'submissions.txt');
    const refreshes = join(directory, 'refreshes.txt');
    function start(adminPassword = password) {
      const child = spawn(process.execPath, ['--import', './app/backend/test/upstream-fixture.mjs', 'dist/server.js'], {
        env: {
          ...process.env,
          DATABASE_URL: url.href,
          ADMIN_USERNAME: username,
          ADMIN_PASSWORD: adminPassword,
          GATEWAY_SECRET: 'test-only-gateway-encryption-secret',
          HOST: '127.0.0.1',
          PORT: String(port),
          MEDIA_DIRECTORY: directory,
          GATEWAY_TEST_SUBMISSIONS: submissions,
          GATEWAY_TEST_REFRESHES: refreshes,
          GATEWAY_TEST_CANCELLATION: cancellation,
          JIMENG_BROWSER_TRANSPORT: 'off',
          GATEWAY_TEST_UPSTREAM: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (data) => (output += data));
      child.stderr.on('data', (data) => (output += data));
      const closed = once(child, 'close');
      return { child, closed, output: () => output };
    }
    let server = start();
    t.after(async () => {
      server.child.kill('SIGTERM');
      await server.closed;
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.end();
      await rm(directory, { recursive: true, force: true });
    });
    const base = 'http://127.0.0.1:' + port;
    async function waitReady() {
      for (let i = 0; i < 100; i++) {
        if (server.child.exitCode !== null) break;
        const response = await fetch(base + '/readyz').catch(() => null);
        if (response?.status === 204) return;
        await delay(100);
      }
      assert.fail(server.output());
    }
    await waitReady();
    const http = async (path, token, body, extra = {}, method = body === undefined ? 'GET' : 'POST') =>
      fetch(base + path, {
        method,
        headers: {
          ...(token?.startsWith('gateway_session=') ? { cookie: token } : token ? { authorization: 'Bearer ' + token } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...extra,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const json = async (path, token, body, status = 200, extra) => {
      const response = await http(path, token, body, extra);
      const result = await response.json();
      assert.equal(response.status, status, path + ' ' + JSON.stringify(result) + '\n' + server.output());
      return result;
    };
    assert.equal((await http('/')).status, 200);
    assert.equal((await http('/console.js')).status, 200);
    await json('/v1/models', undefined, undefined, 401);
    await json('/openai/v1/models', undefined, undefined, 404);
    await json('/admin/v1/accounts', undefined, undefined, 401);
    await json('/admin/v1/session', undefined, { username, password: 'wrong-password' }, 401);
    await json('/admin/v1/session', undefined, { username, password }, 403, { origin: 'https://foreign.example' });
    const session = await http('/admin/v1/session', undefined, { username, password });
    assert.equal(session.status, 204);
    const cookie = session.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly; SameSite=Strict/);
    const admin = cookie.split(';')[0];
    assert.equal((await http('/admin/v1/session', admin)).status, 204);
    await json('/admin/v1/accounts', admin.split('=')[1], undefined, 401);
    const concurrent = await Promise.all(
      ['test-jimeng-token', 'Cookie: a=b; sessionid=test-jimeng-token'].map((credential) =>
        http('/admin/v1/accounts', admin, { provider: 'jimeng', kind: 'cookie', credential }),
      ),
    );
    assert.deepEqual(concurrent.map((response) => response.status).sort(), [201, 409]);
    const duplicateAccount = concurrent.find((response) => response.status === 409);
    assert.equal((await duplicateAccount.json()).error.code, 'duplicate_account_credential');

    for (const entry of [
      ['codex', 'oauth', { accessToken: 'test-codex-token', accountId: 'fixture' }],
      ['claude', 'api-key', 'test-claude-token'],
    ]) {
      const [provider, kind, credential] = entry;
      await json(
        '/admin/v1/accounts',
        admin,
        { provider, kind, credential, label: provider },
        201,
      );
    }
    const kiroImports = await Promise.all([{ refreshToken: 'test-kiro-refresh' }, { refresh_token: 'test-kiro-refresh' }].map((credential) =>
      http('/admin/v1/accounts', admin, {
        provider: 'kiro', kind: 'desktop', credential, label: 'kiro',
      }),
    ));
    assert.deepEqual(kiroImports.map((response) => response.status).sort(), [201, 409]);
    assert.equal((await readFile(refreshes, 'utf8')).trim(), 'desktop');
    for (const [provider, kind, credential] of [
      ['codex', 'oauth', { tokens: { access_token: 'test-codex-token', account_id: 'fixture' } }],
      ['kiro', 'desktop', { refresh_token: 'test-kiro-refresh' }],
      ['claude', 'api-key', { apiKey: 'test-claude-token' }],
    ]) {
      const result = await json('/admin/v1/accounts', admin, { provider, kind, credential, label: 'Duplicate' }, 409);
      assert.equal(result.error.code, 'duplicate_account_credential');
    }

    const oauth = await json('/admin/v1/codex/authorize', admin, { label: 'Codex PKCE' });
    const authURL = new URL(oauth.url);
    assert.equal(authURL.origin, 'https://auth.openai.com');
    assert.equal(authURL.searchParams.get('code_challenge_method'), 'S256');
    const callback = new URL(oauth.redirect_uri);
    callback.searchParams.set('state', oauth.state);
    callback.searchParams.set('code', 'test-codex-code');
    await json('/admin/v1/codex/complete', admin, { callback: callback.href }, 201);
    await json('/admin/v1/codex/complete', admin, { callback: callback.href }, 400);
    await json(
      '/admin/v1/accounts',
      admin,
      {
        provider: 'kiro',
        kind: 'oidc',
        label: 'Kiro OIDC',
        credential: {
          refreshToken: 'test-oidc-refresh',
          clientId: 'fixture-client',
          clientSecret: 'fixture-secret',
        },
      },
      201,
    );
    const openaiKey = (
      await json('/admin/v1/keys', admin, { label: 'codex-product', providers: ['codex'] }, 201)
    ).token;
    assert.ok(!(await json('/v1/models', openaiKey)).data.some((model) => model.id === 'codex/gpt-api-fixture'));
    await json(
      '/admin/v1/accounts',
      admin,
      { provider: 'codex', kind: 'api-key', label: 'OpenAI API', credential: 'test-openai-token' },
      201,
    );
    const kiroAccounts = await json('/admin/v1/accounts?provider=kiro', admin);
    assert.deepEqual(kiroAccounts.map((a) => a.kind).sort(), ['desktop', 'oidc']);
    assert.ok(kiroAccounts.every((a) => a.provider === 'kiro'));
    await json('/admin/v1/accounts?provider=unknown', admin, undefined, 400);
    const key = (
      await json(
        '/admin/v1/keys',
        admin,
        { label: 'fixture', providers: ['jimeng', 'codex', 'kiro', 'claude'] },
        201,
      )
    ).token;
    const other = (
      await json(
        '/admin/v1/keys',
        admin,
        { label: 'other', providers: ['claude'] },
        201,
      )
    ).token;
    const models = (await json('/v1/models', key)).data;
    assert.ok(models.length > 4);
    assert.deepEqual(
      (await json('/v1/models', other)).data.map((m) => m.owned_by),
      ['claude'],
    );
    await json('/admin/v1/workspaces', admin, undefined, 404);
    await json('/admin/v1/keys', admin, { label: 'invalid-product', providers: ['unknown'] }, 400);
    await json('/admin/v1/keys', admin, { label: 'no-products', providers: [] }, 400);
    const claude = {
      model: 'claude/claude-fixture',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 32,
    };
    assert.equal((await json('/v1/messages', key, claude)).content[0].text, 'fixture');
    assert.equal((await json('/v1/messages/count_tokens', key, claude)).input_tokens, 3);
    const disconnect = new AbortController();
    const pending = await fetch(base + '/v1/messages', {
      method: 'POST',
      signal: disconnect.signal,
      headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...claude,
        stream: true,
        messages: [{ role: 'user', content: 'fixture cancellation' }],
      }),
    });
    const reader = pending.body.getReader();
    assert.match(Buffer.from((await reader.read()).value).toString(), /message_start/);
    disconnect.abort();
    await reader.cancel().catch(() => {});
    for (let i = 0; i < 80; i++) {
      if (await readFile(cancellation, 'utf8').catch(() => null)) break;
      await delay(25);
    }
    assert.equal(await readFile(cancellation, 'utf8'), 'cancelled');
    for (let i = 0; i < 80; i++) {
      const {
        rows: [row],
      } = await db.query(`SELECT status FROM ${schema}.request_attempts ORDER BY created_at DESC LIMIT 1`);
      if (row.status === 'interrupted') break;
      await delay(25);
    }
    assert.equal(
      (await db.query(`SELECT status FROM ${schema}.request_attempts ORDER BY created_at DESC LIMIT 1`)).rows[0]
        .status,
      'interrupted',
    );
    assert.equal((await json('/v1/messages', key, claude)).content[0].text, 'fixture');
    const kiro = { ...claude, model: models.find((m) => m.owned_by === 'kiro').id };
    await json('/v1/messages', other, kiro, 404);
    const oidcKey = (
      await json('/admin/v1/keys', admin, { label: 'kiro', providers: ['kiro'] }, 201)
    ).token;
    const desktopAccount = kiroAccounts.find((a) => a.kind === 'desktop');
    const oidcAccount = kiroAccounts.find((a) => a.kind === 'oidc');
    async function enableAccount(account, enabled, token = admin) {
      assert.equal((await http('/admin/v1/accounts/' + account.id, token, { enabled }, {}, 'PATCH')).status, 204);
    }
    await enableAccount(desktopAccount, false);
    assert.equal((await json('/v1/messages', oidcKey, kiro)).content[0].text, 'fixture');
    await enableAccount(desktopAccount, true);
    await enableAccount(oidcAccount, false);
    await db.query(
      `UPDATE ${schema}.provider_accounts SET expires_at=now()-interval '1 minute',concurrency=2 WHERE id=$1`,
      [desktopAccount.id],
    );
    async function invokeWhileRefreshing() {
      // SKIP LOCKED can return 429 while the other request is claiming its lease.
      for (let retry = 0; retry < 10; retry++) {
        const response = await http('/v1/messages', key, kiro);
        const result = await response.json();
        if (response.status === 200) return result;
        assert.equal(response.status, 429);
        assert.equal(result.error.code, 'account_unavailable');
        await delay(20);
      }
      assert.fail('Kiro account lease remained unavailable');
    }
    await Promise.all([invokeWhileRefreshing(), invokeWhileRefreshing()]);
    assert.equal((await readFile(refreshes, 'utf8')).trim().split('\n').length, 2);
    const tool = testTool(kiro.model);
    const kiroTool = await json('/v1/messages', key, tool);
    assert.deepEqual(kiroTool.content.find((block) => block.type === 'tool_use').input, { id: 7 });
    const kiroStream = await http('/v1/messages', key, { ...tool, stream: true });
    const events = await kiroStream.text();
    assert.match(events, /input_json_delta/);
    assert.match(events, /message_stop/);
    for (const [text, status] of [
      ['fixture Kiro exception', 400],
      ['fixture Kiro truncated', 502],
    ]) {
      await json('/v1/messages', key, { ...kiro, messages: [{ role: 'user', content: text }] }, status);
    }
    await enableAccount(oidcAccount, true);
    await db.query(
      `UPDATE ${schema}.provider_accounts SET expires_at=now()-interval '1 minute' WHERE label='Codex PKCE'`,
    );
    const accounts = await json('/admin/v1/accounts', admin);
    const manualCodex = accounts.find((a) => a.label === 'codex');
    assert.equal(
      (await http('/admin/v1/accounts/' + manualCodex.id, admin, { enabled: false }, {}, 'PATCH')).status,
      204,
    );
    const stream = await http('/v1/responses', key, { model: 'codex/gpt-fixture', stream: true, input: 'hello' });
    assert.equal(stream.status, 200);
    assert.match(await stream.text(), /response.completed/);
    assert.ok((await readFile(refreshes, 'utf8')).split('\n').includes('codex'));
    const openai = await json('/v1/responses', openaiKey, { model: 'codex/gpt-api-fixture', input: 'hello' });
    assert.equal(openai.id, 'resp_api_fixture');
    const codexTool = await json('/v1/responses', key, {
      model: 'codex/gpt-fixture',
      input: 'hello',
      tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
    });
    assert.deepEqual(codexTool.output[0], {
      type: 'function_call',
      name: 'lookup',
      call_id: 'call_1',
      arguments: '{"id":7}',
    });

    const image = await json('/v1/images/generations', key, {
      prompt: 'fixture image',
      size: '1536x1024',
      response_format: 'b64_json',
    });
    assert.equal(Buffer.from(image.data[0].b64_json, 'base64').toString('hex'), '89504e470d0a1a0a');
    const edited = await json('/v1/images/edits', key, {
      prompt: 'fixture edit',
      images: [{ image_url: 'data:image/png;base64,iVBORw0KGgo=' }],
    });
    const download = await fetch(edited.data[0].url);
    assert.equal(download.status, 200);
    assert.equal(Buffer.from(await download.arrayBuffer()).toString('base64'), 'iVBORw0KGgo=');
    const form = new FormData();
    form.set('prompt', 'fixture edit');
    form.set('response_format', 'b64_json');
    form.set('image', new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' }), 'reference.png');
    const multipartEdit = await fetch(base + '/v1/images/edits', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + key },
      body: form,
    });
    assert.equal(multipartEdit.status, 200);
    assert.equal((await multipartEdit.json()).data[0].b64_json, 'iVBORw0KGgo=');
    const invalidURL = new URL(edited.data[0].url);
    invalidURL.searchParams.set('expires', '1');
    assert.equal((await fetch(invalidURL)).status, 401);

    const body = { prompt: 'fixture lost submission', size: '720x1280', seconds: 5 };
    const headers = { 'idempotency-key': 'same-operation' };
    const [first, duplicate] = await Promise.all([
      json('/v1/videos', key, body, 200, headers),
      json('/v1/videos', key, body, 200, headers),
    ]);
    assert.equal(duplicate.id, first.id);
    const recast = await json('/v1/videos/edits', key, {
      prompt: 'fixture recast',
      video: { upstream_id: '11111111-1111-1111-1111-111111111111' },
    });
    await json('/v1/videos', key, { prompt: 'different' }, 409, headers);
    await json('/v1/videos', key, { prompt: 'bad reference', input_reference: {} }, 400);
    await json('/v1/videos/' + first.id, other, undefined, 404);
    for (let i = 0; i < 80; i++) {
      const {
        rows: [row],
      } = await db.query(`SELECT status FROM ${schema}.video_jobs WHERE id=$1`, [first.id.slice(6)]);
      if (row.status === 'submission_unknown') break;
      await delay(50);
    }
    assert.equal(
      (await db.query(`SELECT status FROM ${schema}.video_jobs WHERE id=$1`, [first.id.slice(6)])).rows[0].status,
      'submission_unknown',
    );
    server.child.kill('SIGTERM');
    await server.closed;
    server = start();
    await waitReady();
    let current;
    for (let i = 0; i < 60; i++) {
      current = await json('/v1/videos/' + first.id, key);
      if (['completed', 'failed'].includes(current.status)) break;
      await delay(250);
    }
    assert.equal(current.status, 'completed');
    assert.equal((await readFile(submissions, 'utf8')).trim(), first.id.slice(6));
    const content = await http('/v1/videos/' + first.id + '/content', key);
    assert.equal(Buffer.from(await content.arrayBuffer()).toString('ascii', 4, 8), 'ftyp');
    assert.equal((await json('/v1/videos/' + recast.id, key)).status, 'completed');
    assert.equal((await http('/admin/v1/session', admin, undefined, {}, 'DELETE')).status, 204);
    await json('/admin/v1/accounts', admin, undefined, 401);
    const beforePasswordChange = await http('/admin/v1/session', undefined, { username, password });
    assert.equal(beforePasswordChange.status, 204);
    const oldCookie = beforePasswordChange.headers.get('set-cookie').split(';')[0];
    server.child.kill('SIGTERM');
    await server.closed;
    server = start('changed-test-password-for-gateway');
    await waitReady();
    assert.equal((await http('/admin/v1/session', oldCookie)).status, 401);
    assert.equal((await http('/admin/v1/session', undefined, { username, password })).status, 401);
    server.child.kill('SIGTERM');
    await server.closed;
    for (const version of [2, 99]) {
      await db.query(`UPDATE ${schema}.gateway_schema SET version=$1`, [version]);
      server = start();
      const [exitCode] = await server.closed;
      assert.notEqual(exitCode, 0);
      assert.match(server.output(), /schema version is unsupported/);
      assert.equal((await db.query(`SELECT version FROM ${schema}.gateway_schema`)).rows[0].version, version);
    }
  },
);
