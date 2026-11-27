import { requestBoundary, requestSignal } from './http/middleware/lifecycle.ts';
import { createCatalog } from './modules/catalog/service.ts';
import { createIdentity } from './modules/identity/service.ts';
import { createVideoWorker } from './modules/media/worker.ts';
import { createCrypto } from './infrastructure/crypto.ts';
import { createAccounts } from './modules/accounts/service.ts';
import { createMediaAssets } from './modules/media/assets.ts';
import { registerAdmin } from './http/admin/routes.ts';
import { registerAdminResources } from './http/admin/resources.ts';
import { registerAPI } from './http/public/routes.ts';
import Koa from 'koa';
import Router from '@koa/router';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { readConfig } from './config.ts';
import { openStore } from './infrastructure/postgres/store.ts';
import { AppError } from './domain.ts';
import { openFiles } from './infrastructure/files/storage.ts';
import { createVideoService } from './modules/media/video.ts';
import { generation } from './modules/gateway/generation.ts';
import { listen } from './http/listen.ts';
import browserTransport from './providers/jimeng/lib/browser-transport.ts';
import { jimengBrowserSetting } from './providers/jimeng/settings.ts';
import { createSettings } from './modules/settings/service.ts';

const config = (() => {
  try {
    return readConfig(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
})();
// Keep the console bundle paired with the routes loaded by this process.
const [consoleHtml, consoleScript] = await Promise.all([
  readFile(new URL('./frontend/index.html', import.meta.url), 'utf8'),
  readFile(new URL('./frontend/console.js', import.meta.url), 'utf8'),
]);
const crypto = createCrypto(config.gatewaySecret);
const store = openStore(config.databaseUrl, crypto);
const files = openFiles(resolve(config.mediaDirectory));
await store.initialize();
await files.initialize();
const settings = createSettings(store, [jimengBrowserSetting(process.env)]);
const identity = createIdentity(store, config);
const catalog = createCatalog(store);
const accounts = createAccounts(store, crypto, config.codexRedirectUri, settings);
const media = createMediaAssets(store, files, crypto);
const videos = createVideoService(store, accounts, files);
const generate = generation(store, accounts, media);
const app = new Koa();
const router = new Router();
const shutdown = new AbortController();

app.use(requestBoundary);
const signalFor = (ctx, timeout?: number) => requestSignal(shutdown.signal, ctx, timeout);

router.get('/livez', (ctx) => {
  ctx.status = 204;
});
router.get('/readyz', async (ctx) => {
  try {
    await store.health();
  } catch {
    throw new AppError(503, 'database_unavailable');
  }
  ctx.status = 204;
});
router.get('/', (ctx) => {
  ctx.type = 'text/html';
  ctx.body = consoleHtml;
});
router.get('/console.js', (ctx) => {
  ctx.type = 'application/javascript';
  ctx.body = consoleScript;
});

registerAdmin(router, store, identity, catalog, accounts, config.publicBaseUrl, signalFor);
registerAdminResources(router, store, media, settings);
registerAPI(router, identity, catalog, media, videos, generate, signalFor, config.publicBaseUrl);
app.use(router.routes());
app.use(router.allowedMethods());

const server = createServer(app.callback());
try {
  await listen(server, config.port, config.host, process.argv.includes('--replace-listener'));
} catch (error) {
  await store.close();
  if (error instanceof Error && 'code' in error && error.code === 'EADDRINUSE') {
    console.error(`端口 ${config.host}:${config.port} 仍被占用。`);
  } else {
    console.error(error instanceof Error ? error.message : error);
  }
  process.exit(1);
}
console.log(`Frontend URL: ${config.frontendUrl}`);
const worker = createVideoWorker(store, videos)(shutdown.signal);
async function stop() {
  if (shutdown.signal.aborted) return;
  shutdown.abort();
  const force = setTimeout(() => process.exit(1), 15_000);
  force.unref();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await worker;
  await browserTransport.close();
  await store.close();
}
process.once('SIGTERM', () => {
  void stop();
});
process.once('SIGINT', () => {
  void stop();
});
