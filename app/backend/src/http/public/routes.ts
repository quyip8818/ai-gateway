import type Router from '@koa/router';
import type { Identity } from '../../modules/identity/service.ts';
import type { Catalog } from '../../modules/catalog/service.ts';
import { AppError, isUUID } from '../../domain.ts';
import type { MediaAssets } from '../../modules/media/assets.ts';
import { publicVideo, type createVideoService } from '../../modules/media/video.ts';
import type { generation } from '../../modules/gateway/generation.ts';
import { bearer, jsonBody, mediaBody, objectBody, uploads } from '../middleware/request.ts';
import { fetchAsset } from '../media.ts';

export function registerAPI(
  router: Router,
  identity: Identity,
  catalog: Catalog,
  media: MediaAssets,
  videos: ReturnType<typeof createVideoService>,
  generate: ReturnType<typeof generation>,
  requestSignal: (ctx, timeout?: number) => AbortSignal,
  publicBaseUrl: string,
) {
  const caller = (ctx) => identity.authenticateKey(bearer(ctx) || ctx.get('x-api-key'));

  async function authenticate(ctx, next) {
    ctx.state.key = await caller(ctx);
    await next();
  }

  router.get('/v1/models', async (ctx) => {
    ctx.body = await catalog.listPublic(await caller(ctx));
  });
  for (const [path, operation] of [
    ['/responses', 'responses'],
    ['/messages', 'messages'],
    ['/messages/count_tokens', 'count_tokens'],
  ]) {
    router.post('/v1' + path, authenticate, jsonBody, async (ctx) => {
      const delivery = await generate.text(
        ctx.state.key, objectBody(ctx), operation, new Headers(ctx.headers), requestSignal(ctx),
      );
      ctx.status = delivery.status;
      if (delivery.retryAfter) ctx.set('Retry-After', delivery.retryAfter);
      if (delivery.kind === 'stream') {
        ctx.type = 'text/event-stream';
        ctx.set('Cache-Control', 'no-store');
        ctx.set('X-Accel-Buffering', 'no');
        ctx.res.once('close', () => {
          if (!ctx.res.writableFinished) delivery.body.destroy();
        });
      }
      ctx.body = delivery.body;
    });
  }
  for (const [path, edit] of [
    ['/generations', false],
    ['/edits', true],
  ] as const) {
    router.post('/v1/images' + path, authenticate, mediaBody, async (ctx) => {
      ctx.body = await generate.images(
        ctx.state.key,
        objectBody(ctx),
        await uploads(ctx, ['image', 'image[]']),
        edit,
        requestSignal(ctx),
        publicBaseUrl || ctx.origin,
      );
    });
  }
  for (const [path, operation] of [
    ['', 'generate'],
    ['/edits', 'recast'],
  ] as const) {
    router.post('/v1/videos' + path, authenticate, mediaBody, async (ctx) => {
      const body = objectBody(ctx);
      const refs = await uploads(ctx, ['input_reference']);
      if (
        refs.length > 1 ||
        (refs.length && body.input_reference) ||
        (operation === 'recast' &&
          (refs.length ||
            body.input_reference !== undefined ||
            body.size !== undefined ||
            body.seconds !== undefined))
      )
        throw new AppError(400, 'invalid_video_input');
      if (refs.length) body.input_reference = { image_url: refs[0] };
      ctx.body = publicVideo(
        await videos.enqueue(ctx.state.key, operation, body, ctx.get('idempotency-key') || undefined),
      );
    });
  }
  router.get('/v1/videos/:id', async (ctx) => {
    ctx.body = publicVideo(await videos.get(await caller(ctx), ctx.params.id));
  });
  router.get('/v1/videos/:id/content', async (ctx) => {
    const key = await caller(ctx);
    const job = await videos.get(key, ctx.params.id);
    if (job.status !== 'completed') throw new AppError(409, 'video_not_ready');
    await fetchAsset(media, ctx, key.id, job.id);
  });

  router.get('/v1/media/:id', async (ctx) => {
    if (isUUID(ctx.params.id) && media.verifyUrl(ctx.params.id, ctx.query.expires, ctx.query.signature)) {
      return fetchAsset(media, ctx, null);
    }
    return fetchAsset(media, ctx, (await caller(ctx)).id);
  });
}
