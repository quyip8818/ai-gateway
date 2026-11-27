import { registerAdmin } from './http/admin.ts';
import { registerAPI } from './http/api.ts';
import Koa from 'koa';
import Router from '@koa/router';
import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openStore } from './db/store.ts';
import { AppError } from './domain.ts';
import { openFiles } from './media/files.ts';
import { createVideoService } from './media/video.ts';
import { generation } from './http/generation.ts';
import browserTransport from './providers/jimeng/lib/browser-transport.ts';

function required(name: string, min = 1) {
  const value = process.env[name];
  if (!value || value.length < min) throw new Error(`${name} must have at least ${min} characters`);
  return value;
}

const store = openStore(required('DATABASE_URL'), required('GATEWAY_SECRET', 32));
const adminToken = Buffer.from(required('ADMIN_TOKEN', 24));
const directory = resolve(process.env.MEDIA_DIRECTORY ?? './data/native-media');
const files = openFiles(directory);
const workspace = await store.initialize();
await files.initialize();
const videos = createVideoService(store, files);
const generate = generation(store, files);
const app = new Koa();
const router = new Router();
const shutdown = new AbortController();

app.use(async (ctx, next) => {
  ctx.set('X-Request-Id', randomUUID());
  ctx.set('X-Content-Type-Options', 'nosniff');
  ctx.set('Cache-Control', 'no-store');
  try {
    await next();
    if (ctx.status === 404 && !ctx.body) throw new AppError(404, 'not_found');
  } catch (error) {
    const status =
      error instanceof AppError ? error.status : error.status >= 400 && error.status < 500 ? error.status : 502;
    const code =
      error instanceof AppError
        ? error.code
        : status === 413
          ? 'body_too_large'
          : status < 500
            ? 'invalid_request'
            : 'upstream_error';
    ctx.status = status;
    const detail = {
      code,
      message: error instanceof AppError ? error.message : code,
      type: status < 500 ? 'invalid_request_error' : 'api_error',
    };
    ctx.body = ctx.path.startsWith('/v1/messages') ? { type: 'error', error: detail } : { error: detail };
  } finally {
    const all = Object.values(ctx.request.files ?? {}).flat();
    await Promise.allSettled(all.map((file) => unlink(file.filepath)));
  }
});

function requestSignal(ctx, timeout = 20 * 60_000) {
  const client = new AbortController();
  ctx.res.once('close', () => client.abort());
  return AbortSignal.any([client.signal, shutdown.signal, AbortSignal.timeout(timeout)]);
}

router.get('/livez', (ctx) => {
  ctx.status = 204;
});
router.get('/readyz', async (ctx) => {
  try {
    await store.db.query('SELECT 1');
  } catch {
    throw new AppError(503, 'database_unavailable');
  }
  ctx.status = 204;
});
router.get('/', async (ctx) => {
  ctx.type = 'text/html';
  ctx.body = await readFile(new URL('../console.html', import.meta.url), 'utf8');
});
router.get('/console.js', async (ctx) => {
  ctx.type = 'application/javascript';
  ctx.body = await readFile(new URL('../console.js', import.meta.url), 'utf8');
});

registerAdmin(router, store, files, workspace, adminToken, requestSignal);
registerAPI(router, store, files, videos, generate, requestSignal);
app.use(router.routes());
app.use(router.allowedMethods());

const port = Number(process.env.PORT ?? 8080);
const server = app.listen(port, process.env.HOST ?? '0.0.0.0', () =>
  console.log(`ai-gateway listening on ${port}`),
);
const worker = videos.run(shutdown.signal);
async function stop() {
  if (shutdown.signal.aborted) return;
  shutdown.abort();
  const force = setTimeout(() => process.exit(1), 15_000);
  force.unref();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await worker;
  await browserTransport.close();
  await store.db.end();
}
process.once('SIGTERM', () => {
  void stop();
});
process.once('SIGINT', () => {
  void stop();
});
