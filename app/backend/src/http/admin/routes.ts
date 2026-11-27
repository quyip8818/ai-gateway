import type { Identity } from '../../modules/identity/service.ts';
import type { Catalog } from '../../modules/catalog/service.ts';
import type { Accounts } from '../../modules/accounts/service.ts';
import type Router from '@koa/router';
import type { Store } from '../../infrastructure/postgres/store.ts';
import { AppError, isProvider, isUUID } from '../../domain.ts';
import { publicVideo } from '../../modules/media/video.ts';
import { registerAdminSession } from './session.ts';
import { jsonBody, objectBody } from '../middleware/request.ts';

function accountLabel(label: unknown) {
  if (typeof label !== 'string' || label.length > 100) throw new AppError(400, 'invalid_account');
  return label.trim();
}

export function registerAdmin(
  router: Router,
  store: Pick<Store, 'listAttempts' | 'listVideos'>,
  identity: Identity,
  catalog: Catalog,
  accounts: Accounts,
  publicBaseUrl: string,
  requestSignal: (ctx, timeout?: number) => AbortSignal,
) {
  registerAdminSession(router, identity, publicBaseUrl);
  router.get('/admin/v1/accounts', async (ctx) => {
    const provider = ctx.query.provider;
    if (provider !== undefined && !isProvider(provider)) throw new AppError(400, 'invalid_provider');
    ctx.body = await accounts.list(provider);
  });
  router.post('/admin/v1/accounts', jsonBody, async (ctx) => {
    const { provider, kind, credential, label = '' } = objectBody(ctx);
    if (!isProvider(provider)) throw new AppError(400, 'invalid_provider');
    ctx.body = await accounts.addAccount(
      provider,
      kind,
      accountLabel(label),
      credential,
      requestSignal(ctx, 45_000),
    );
    ctx.status = 201;
  });
  router.patch('/admin/v1/accounts/:id', jsonBody, async (ctx) => {
    const { enabled } = objectBody(ctx);
    if (!isUUID(ctx.params.id) || typeof enabled !== 'boolean') throw new AppError(400, 'invalid_account');
    await accounts.setEnabled(ctx.params.id, enabled);
    ctx.status = 204;
  });
  router.put('/admin/v1/accounts/:id/credential', jsonBody, async (ctx) => {
    const { cookie } = objectBody(ctx);
    if (!isUUID(ctx.params.id) || typeof cookie !== 'string') throw new AppError(400, 'invalid_account');
    await accounts.replaceCookie(ctx.params.id, cookie, requestSignal(ctx, 45_000));
    ctx.status = 204;
  });
  router.post('/admin/v1/accounts/:id/reload', async (ctx) => {
    if (!isUUID(ctx.params.id)) throw new AppError(404, 'account_not_found');
    await accounts.reload(ctx.params.id, requestSignal(ctx, 45_000));
    ctx.status = 204;
  });
  router.delete('/admin/v1/accounts/:id', async (ctx) => {
    if (!isUUID(ctx.params.id)) throw new AppError(404, 'account_not_found');
    await accounts.remove(ctx.params.id);
    ctx.status = 204;
  });
  router.get('/admin/v1/keys', async (ctx) => {
    ctx.body = await identity.listKeys();
  });
  router.post('/admin/v1/keys', jsonBody, async (ctx) => {
    ctx.body = await identity.issueKey(objectBody(ctx));
    ctx.status = 201;
  });
  router.delete('/admin/v1/keys/:id', async (ctx) => {
    await identity.revokeKey(ctx.params.id);
    ctx.status = 204;
  });
  router.get('/admin/v1/requests', async (ctx) => {
    ctx.body = await store.listAttempts();
  });
  router.get('/admin/v1/videos', async (ctx) => {
    ctx.body = (await store.listVideos()).map(publicVideo);
  });
  router.get('/admin/v1/models', async (ctx) => {
    ctx.body = await catalog.listAdmin();
  });

  router.post('/admin/v1/codex/authorize', jsonBody, async (ctx) => {
    ctx.body = await accounts.beginAuthorization(accountLabel(objectBody(ctx).label ?? ''));
  });
  router.post('/admin/v1/codex/complete', jsonBody, async (ctx) => {
    ctx.body = await accounts.completeAuthorization(objectBody(ctx).callback, requestSignal(ctx, 60_000));
    ctx.status = 201;
  });
}
