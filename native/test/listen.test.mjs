import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import test from 'node:test';
import { listen } from '../src/http/listen.ts';

const hasLsof = !spawnSync('lsof', ['-v'], { stdio: 'ignore' }).error;
const host = '127.0.0.1';

async function startListener(t, options, ignoreTerm = false) {
  const holder = spawn(process.execPath, ['-e', `
    const { createServer } = require('node:net');
    const server = createServer();
    process.on('SIGTERM', () => { if (!${ignoreTerm}) server.close(); });
    server.on('error', (error) => console.log(JSON.stringify({ error: error.code })));
    server.listen(${JSON.stringify(options)}, () => console.log(JSON.stringify({ port: server.address().port })));
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = once(holder, 'exit');
  t.after(async () => {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL');
    await exited;
  });
  const [output] = await once(holder.stdout, 'data');
  return { ...JSON.parse(output.toString()), holder, exited };
}

function serverFor(t) {
  const server = createServer();
  t.after(async () => {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });
  return server;
}

for (const ignoreTerm of [false, true]) {
  test(
    ignoreTerm ? 'a listener ignoring SIGTERM is stopped' : 'a listener is replaced gracefully when requested',
    { skip: !hasLsof, timeout: 12_000 },
    async (t) => {
      const { port, error, holder, exited } = await startListener(t, { port: 0, host }, ignoreTerm);
      assert.ifError(error);
      const server = serverFor(t);
      await assert.rejects(listen(server, port, host), { code: 'EADDRINUSE' });
      assert.equal(holder.exitCode, null);

      await listen(server, port, host, true);
      assert.equal(server.address().port, port);
      assert.deepEqual(await exited, ignoreTerm ? [null, 'SIGKILL'] : [0, null]);
    },
  );
}

test('replacing the IPv4 listener leaves a separate IPv6-only listener on the same port', {
  skip: !hasLsof, timeout: 12_000,
}, async (t) => {
  const ipv6 = await startListener(t, { port: 0, host: '::', ipv6Only: true });
  if (['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(ipv6.error)) {
    t.skip('IPv6 is unavailable');
    return;
  }
  assert.ifError(ipv6.error);
  const ipv4 = await startListener(t, { port: ipv6.port, host });
  assert.ifError(ipv4.error);
  const server = serverFor(t);
  await listen(server, ipv6.port, host, true);
  assert.deepEqual(await ipv4.exited, [0, null]);
  assert.equal(ipv6.holder.exitCode, null);
  assert.equal(ipv6.holder.signalCode, null);
});
