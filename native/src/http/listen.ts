import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { isIPv4, type Server } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const gracefulTimeout = 5_000;

function errorCode(error: unknown) {
  if (error instanceof Error && 'code' in error) return error.code;
}

function addressInUse(error: unknown): error is Error & { address?: string } {
  return errorCode(error) === 'EADDRINUSE';
}

async function listeners(port: number, address: string) {
  let output: string;
  try {
    const { stdout } = await run('lsof', ['-nP', '-a', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpftn'], {
      timeout: 2_000,
    });
    output = stdout;
  } catch (error) {
    if (errorCode(error) === 1 && !(error as { stdout?: string }).stdout) return new Set<number>();
    if (errorCode(error) === 'ENOENT') throw new Error('自动释放本地端口需要 lsof。');
    throw error;
  }

  const matches = new Set<number>();
  const dualStack = new Set<number>();
  const target = address.replace(/^::ffff:(?=\d+\.)/, '');
  const ipv4 = isIPv4(target);
  let pid = 0;
  let family = '';
  for (const line of output.split('\n')) {
    const value = line.slice(1);
    switch (line[0]) {
      case 'p':
        pid = Number(value);
        continue;
      case 'f':
        family = '';
        continue;
      case 't':
        family = value;
        continue;
      case 'n':
        break;
      default:
        continue;
    }
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) continue;
    const bound = value.slice(0, value.lastIndexOf(':')).replace(/^\[|\]$/g, '').replace(/^::ffff:/, '');
    const boundIPv4 = family === 'IPv4' || isIPv4(bound);
    if (address === '::' || bound === target || (ipv4 && boundIPv4 && (target === '0.0.0.0' || bound === '*'))) {
      matches.add(pid);
    } else if (ipv4 && family === 'IPv6' && bound === '*') {
      dualStack.add(pid);
    } else if (!ipv4 && family === 'IPv6' && bound === '*') {
      matches.add(pid);
    }
  }
  // An IPv6 wildcard may accept IPv4 too. When a concrete IPv4 listener is
  // visible, prefer it and leave any IPv6-only wildcard alone.
  return matches.size ? matches : dualStack;
}

function signal(pid: number, name: NodeJS.Signals) {
  try {
    process.kill(pid, name);
  } catch (error) {
    if (errorCode(error) !== 'ESRCH') throw new Error(`无法停止占用端口的进程 PID ${pid}。`, { cause: error });
  }
}

export async function listen(server: Server, port: number, host: string, replaceListener = false) {
  async function bind(address: string) {
    server.listen(port, address);
    await once(server, 'listening');
  }

  async function retry(address: string, timeout: number) {
    const deadline = performance.now() + timeout;
    for (;;) {
      try {
        await bind(address);
        return true;
      } catch (error) {
        if (!addressInUse(error)) throw error;
        if (performance.now() >= deadline) return false;
      }
      await delay(100);
    }
  }

  try {
    await bind(host);
  } catch (error) {
    if (!replaceListener || !addressInUse(error)) throw error;
    // Retry the same address that failed, even when HOST is a DNS name.
    const address = error.address ?? host;
    const occupied = await listeners(port, address);
    for (const pid of occupied) signal(pid, 'SIGTERM');
    if (await retry(address, occupied.size ? gracefulTimeout : 100)) return;
    if (!occupied.size) throw error;

    const remaining = await listeners(port, address);
    for (const pid of remaining) {
      if (occupied.has(pid)) signal(pid, 'SIGKILL');
    }
    if (!(await retry(address, 1_000))) throw error;
  }
}
