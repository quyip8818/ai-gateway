import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { promisify } from 'node:util';
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
    await json('/admin/v1/providers/jimeng/settings', undefined, undefined, 401);
    await json('/admin/v1/media', undefined, undefined, 401);
    await json('/admin/v1/session', undefined, { username, password: 'wrong-password' }, 401);
    await json('/admin/v1/session', undefined, { username, password }, 403, { origin: 'https://foreign.example' });
    const session = await http('/admin/v1/session', undefined, { username, password });
    assert.equal(session.status, 204);
    const cookie = session.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly; SameSite=Strict/);
    const admin = cookie.split(';')[0];
    assert.equal((await http('/admin/v1/session', admin)).status, 204);
    await json('/admin/v1/accounts', admin.split('=')[1], undefined, 401);
    const settingId = 'jimeng.browser_transport';
    const settingsPath = '/admin/v1/providers/jimeng/settings';
    const settingPath = settingsPath + '/' + settingId;
    const readSetting = async () =>
      (await json(settingsPath, admin)).find((item) => item.id === settingId);
    assert.deepEqual(await json('/admin/v1/providers/claude/settings', admin), []);
    const setSetting = async (value) => http(settingPath, admin, { value }, {}, 'PUT');
    assert.equal((await readSetting()).source, 'env');
    assert.equal((await readSetting()).value, 'off');
    const rejected = await setSetting('invalid');
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).error.code, 'invalid_setting_value');
    const applied = await setSetting('always');
    assert.equal(applied.status, 200);
    assert.equal((await applied.json())[0].value, 'always');
    assert.equal((await readSetting()).source, 'console');
    assert.equal((await setSetting(null)).status, 200);
    assert.equal((await readSetting()).value, 'off');
    assert.equal((await readSetting()).source, 'env');
    assert.equal((await setSetting('off')).status, 200);

    const concurrent = await Promise.all(
      ['test-jimeng-token', 'Cookie: a=b; sessionid=test-jimeng-token'].map((credential) =>
        http('/admin/v1/accounts', admin, { provider: 'jimeng', kind: 'cookie', credential }),
      ),
    );
    assert.deepEqual(concurrent.map((response) => response.status).sort(), [201, 409]);
    const duplicateAccount = concurrent.find((response) => response.status === 409);
    assert.equal((await duplicateAccount.json()).error.code, 'duplicate_account_credential');

    const [browserAccount] = await json('/admin/v1/accounts?provider=jimeng', admin);
    const browserAccountPath = '/admin/v1/accounts/' + browserAccount.id;
    const browserSetting = browserAccountPath + '/settings/browser-transport';
    assert.equal(browserAccount.browser_transport, null);
    assert.equal((await http(browserSetting, undefined, { value: 'off' }, {}, 'PUT')).status, 401);
    assert.equal((await http(browserSetting, admin, { value: 'invalid' }, {}, 'PUT')).status, 400);
    assert.equal((await http(browserSetting, admin, { value: 'off' }, {}, 'PUT')).status, 204);
    assert.equal((await setSetting('always')).status, 200);
    assert.equal((await http(browserAccountPath + '/reload', admin, undefined, {}, 'POST')).status, 204);
    assert.equal((await json('/admin/v1/accounts?provider=jimeng', admin))[0].browser_transport, 'off');
    assert.equal((await setSetting('off')).status, 200);
    assert.equal((await http(browserSetting, admin, { value: null }, {}, 'PUT')).status, 204);
    assert.equal((await json('/admin/v1/accounts?provider=jimeng', admin))[0].browser_transport, null);

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
    const [claudeAccount] = await json('/admin/v1/accounts?provider=claude', admin);
    const unsupportedSetting = await http(
      '/admin/v1/accounts/' + claudeAccount.id + '/settings/browser-transport', admin, { value: 'off' }, {}, 'PUT',
    );
    assert.equal(unsupportedSetting.status, 400);
    assert.equal((await unsupportedSetting.json()).error.code, 'account_setting_unsupported');
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
    const imageBytes = Buffer.from(image.data[0].b64_json, 'base64');
    assert.equal(imageBytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(image.resolution, '2k');
    assert.equal(image.data[0].width, 1);
    assert.equal(image.data[0].height, 1);
    assert.deepEqual(image.usage, { credits_used: 6 });
    const billingLines = server.output().split('\n');
    assert.equal(billingLines.filter((line) => line === '[fixture jimeng ledger request]').length, 1);
    const imageAttempt = (await json('/admin/v1/requests', admin)).find((attempt) => attempt.operation === 'image');
    assert.equal(imageAttempt.status, 'succeeded');
    assert.equal(imageAttempt.credits_used, 6);
    const receipt = imageAttempt.usage.credit_receipt;
    assert.match(receipt.submit_id, /^[a-f0-9-]{36}$/);
    assert.equal(receipt.credits_used, 6);
    const receiptPrefix = '[jimeng image credits ledger] ';
    const loggedReceipt = billingLines.find((line) => line.startsWith(receiptPrefix));
    assert.ok(loggedReceipt);
    assert.deepEqual(JSON.parse(loggedReceipt.slice(receiptPrefix.length)), receipt);
    const edited = await json('/v1/images/edits', key, {
      prompt: 'fixture edit',
      images: [{ image_url: 'data:image/png;base64,iVBORw0KGgo=' }],
    });
    const download = await fetch(edited.data[0].url);
    assert.deepEqual(edited.usage, { credits_used: null });
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), imageBytes);
    assert.equal(edited.data[0].width, 1);
    assert.equal(edited.data[0].height, 1);
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
    const multipartImage = await multipartEdit.json();
    assert.equal(multipartImage.data[0].b64_json, image.data[0].b64_json);
    assert.deepEqual(multipartImage.usage, { credits_used: null });
    assert.equal(server.output().split('\n').filter((line) => line === '[fixture jimeng ledger request]').length, 3);
    const invalidURL = new URL(edited.data[0].url);
    invalidURL.searchParams.set('expires', '1');
    assert.equal((await fetch(invalidURL)).status, 401);

    const mediaPage = '/admin/v1/media';
    const images = await json(mediaPage + '?type=image&provider=jimeng&limit=1', admin);
    assert.equal(images.total, 3);
    assert.equal(images.total_pages, 3);
    assert.equal(images.items.length, 1);
    assert.equal(images.items[0].provider, 'jimeng');
    assert.equal(images.items[0].model, 'jimeng/jimeng-image-5.0-lite');
    assert.equal(images.items[0].type, 'image');
    assert.equal(images.items[0].bytes, imageBytes.length);
    const pageTwo = await json(mediaPage + '?type=image&page=2&limit=1', admin);
    assert.notEqual(pageTwo.items[0].id, images.items[0].id);
    assert.equal((await json(mediaPage + '?provider=kiro', admin)).total, 0);
    await json(mediaPage + '?limit=101', admin, undefined, 400);
    await json(mediaPage + '?type=video&type=image', admin, undefined, 400);
    const adminImage = '/admin/v1/media/' + images.items[0].id;
    await json(adminImage, key, undefined, 401);
    const attachment = await http(adminImage + '?download=1', admin);
    assert.match(attachment.headers.get('content-disposition'), /attachment; filename=".*\.png"/);
    assert.equal((await attachment.arrayBuffer()).byteLength, imageBytes.length);

    const body = { prompt: 'fixture lost submission', size: '720x1280', seconds: 5 };
    const headers = { 'idempotency-key': 'same-operation' };
    const [first, duplicate] = await Promise.all([
      json('/v1/videos', key, body, 200, headers),
      json('/v1/videos', key, body, 200, headers),
    ]);
    assert.equal(duplicate.id, first.id);
    assert.equal(first.resolution, '720p');
    assert.equal(first.output, null);
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
    assert.equal((await readSetting()).source, 'console');
    assert.equal((await readSetting()).value, 'off');
    async function waitForCompletedVideo(id) {
      for (let i = 0; i < 60; i++) {
        const video = await json('/v1/videos/' + id, key);
        if (video.status === 'completed') return video;
        assert.notEqual(video.status, 'failed', JSON.stringify(video.error));
        await delay(250);
      }
      assert.fail('Video did not complete: ' + id + '\n' + server.output());
    }
    const current = await waitForCompletedVideo(first.id);
    assert.equal(current.size, '720x1280');
    assert.equal(current.seconds, '5');
    assert.equal(current.resolution, '720p');
    assert.deepEqual(current.output, { width: 704, height: 1252, duration_ms: 5017 });
    assert.equal((await readFile(submissions, 'utf8')).trim(), first.id.slice(6));
    const content = await http('/v1/videos/' + first.id + '/content', key);
    assert.equal(Buffer.from(await content.arrayBuffer()).toString('ascii', 4, 8), 'ftyp');
    const range = await http('/v1/videos/' + first.id + '/content', key, undefined, { range: 'bytes=4-7' });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('accept-ranges'), 'bytes');
    assert.match(range.headers.get('content-range'), /^bytes 4-7\/[0-9]+$/);
    assert.equal(await range.text(), 'ftyp');
    const suffix = await http('/v1/videos/' + first.id + '/content', key, undefined, { range: 'bytes=-4' });
    assert.equal(suffix.status, 206);
    assert.equal((await suffix.arrayBuffer()).byteLength, 4);
    const conditional = await http('/v1/videos/' + first.id + '/content', key, undefined, {
      range: 'bytes=4-7', 'if-range': '"unknown"',
    });
    assert.equal(conditional.status, 200);
    assert.ok((await conditional.arrayBuffer()).byteLength > 4);
    const unsatisfiable = await http('/v1/videos/' + first.id + '/content', key, undefined, { range: 'bytes=9999-' });
    assert.equal(unsatisfiable.status, 416);
    assert.match(unsatisfiable.headers.get('content-range'), /^bytes \*\/[0-9]+$/);
    await unsatisfiable.arrayBuffer();
    assert.equal((await waitForCompletedVideo(recast.id)).resolution, '480p');
    const videos = await json(mediaPage + '?type=video', admin);
    assert.equal(videos.total, 2);
    assert.equal(videos.items.find(({ id }) => id === first.id.slice(6)).model, current.model);
    const videoHead = await http('/admin/v1/media/' + first.id.slice(6), admin, undefined, {}, 'HEAD');
    assert.equal(videoHead.status, 200);
    assert.equal(videoHead.headers.get('content-type'), 'video/mp4');
    assert.ok(Number(videoHead.headers.get('content-length')) > 0);
    const [jimengAccount] = await json('/admin/v1/accounts?provider=jimeng', admin);
    const accountPath = '/admin/v1/accounts/' + jimengAccount.id;
    await enableAccount(jimengAccount, false);
    assert.equal((await http(accountPath + '/reload', admin, undefined, {}, 'POST')).status, 204);
    assert.equal((await json('/admin/v1/accounts?provider=jimeng', admin))[0].enabled, false);
    assert.equal((await http(accountPath + '/credential', admin, { cookie: 'a=b' }, {}, 'PUT')).status, 422);
    assert.equal((await http(accountPath + '/credential', admin, { cookie: 'test-jimeng-replacement' }, {}, 'PUT')).status, 204);
    await json('/admin/v1/accounts', admin, {
      provider: 'jimeng', kind: 'cookie', credential: 'sessionid=test-jimeng-replacement',
    }, 409);
    await enableAccount(jimengAccount, true);
    assert.equal((await http(accountPath + '/reload', admin, undefined, {}, 'POST')).status, 204);
    const { rows: [pendingVideo] } = await db.query(
      `INSERT INTO ${schema}.video_jobs
        (id,owner_id,account_id,public_model,upstream_model,operation,input_hash,status,run_after)
       SELECT gen_random_uuid(),owner_id,account_id,public_model,upstream_model,operation,input_hash,
         'queued',now()+interval '1 hour' FROM ${schema}.video_jobs WHERE id=$1 RETURNING id`,
      [first.id.slice(6)],
    );
    const blockedReplacement = await http(accountPath + '/credential', admin, {
      cookie: 'test-jimeng-token',
    }, {}, 'PUT');
    assert.equal(blockedReplacement.status, 409);
    assert.equal((await blockedReplacement.json()).error.code, 'account_has_pending_videos');
    assert.equal((await http(accountPath, admin, undefined, {}, 'DELETE')).status, 204);
    const failed = await json('/v1/videos/video_' + pendingVideo.id, key);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error.code, 'account_disabled');
    assert.deepEqual(await json('/admin/v1/accounts?provider=jimeng', admin), []);
    assert.equal((await http(accountPath + '/reload', admin, undefined, {}, 'POST')).status, 404);
    assert.equal((await http(accountPath, admin, { enabled: true }, {}, 'PATCH')).status, 404);
    assert.equal((await json('/v1/videos/' + first.id, key)).status, 'completed');
    await json('/admin/v1/accounts', admin, {
      provider: 'jimeng', kind: 'cookie', credential: 'test-jimeng-replacement',
    }, 201);
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
    for (const version of [3, 4, 5, 6, 7, 8, 99]) {
      await db.query(`UPDATE ${schema}.gateway_schema SET version=$1`, [version]);
      server = start();
      const [exitCode] = await server.closed;
      assert.notEqual(exitCode, 0);
      assert.match(server.output(), /schema version is unsupported/);
      assert.equal((await db.query(`SELECT version FROM ${schema}.gateway_schema`)).rows[0].version, version);
    }
    const reset = () => promisify(execFile)(process.execPath, ['dist/reset.js'], {
      env: { ...process.env, DATABASE_URL: url.href },
    });
    const { rows: [{ version: previousVersion }] } = await db.query(`SELECT version FROM ${schema}.gateway_schema`);
    await db.query(`CREATE TABLE ${schema}.unrelated (value text NOT NULL);
      INSERT INTO ${schema}.unrelated VALUES ('keep');
      CREATE VIEW ${schema}.external_dependency AS SELECT id FROM ${schema}.api_keys`);
    await assert.rejects(reset, /2BP01/);
    assert.equal((await db.query(`SELECT version FROM ${schema}.gateway_schema`)).rows[0].version, previousVersion);
    await db.query(`DROP VIEW ${schema}.external_dependency`);
    await reset();
    const { rows: [afterReset] } = await db.query(`SELECT
      (SELECT count(*)::int FROM ${schema}.api_keys) AS keys,
      (SELECT count(*)::int FROM ${schema}.runtime_settings) AS settings,
      (SELECT value FROM ${schema}.unrelated) AS unrelated`);
    assert.deepEqual(afterReset, { keys: 0, settings: 0, unrelated: 'keep' });
    server = start();
    await waitReady();
  },
);
