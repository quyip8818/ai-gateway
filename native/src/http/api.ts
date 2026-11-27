import type Router from '@koa/router';
import type { Store } from '../db/store.ts';
import { AppError, isUUID } from '../domain.ts';
import type { Files } from '../media/files.ts';
import { publicVideo, type createVideoService } from '../media/video.ts';
import type { generation } from './generation.ts';
import { bearer, jsonBody, mediaBody, fetchAsset, objectBody, uploads } from './request.ts';

export function registerAPI(
  router: Router,
  store: Store,
  files: Files,
  videos: ReturnType<typeof createVideoService>,
  generate: ReturnType<typeof generation>,
  requestSignal: (ctx, timeout?: number) => AbortSignal,
) {
  async function caller(ctx) {
    const key = await store.getKey(bearer(ctx) || ctx.get('x-api-key'));
    if (!key) throw new AppError(401, 'invalid_api_key');
    return key;
  }

  async function authenticate(ctx, next) {
    ctx.state.key = await caller(ctx);
    await next();
  }

  router.get('/v1/models', async (ctx) => {
    const key = await caller(ctx);
    ctx.body = {
      object: 'list',
      data: (await store.models(key)).map((m) => ({ object: 'model', ...m, owned_by: m.id.split('/')[0] })),
    };
  });
  for (const [path, operation] of [
    ['/responses', 'responses'],
    ['/messages', 'messages'],
    ['/messages/count_tokens', 'count_tokens'],
  ]) {
    router.post('/v1' + path, authenticate, jsonBody, async (ctx) => {
      await generate.text(ctx, ctx.state.key, objectBody(ctx), operation, requestSignal(ctx));
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
        process.env.PUBLIC_BASE_URL || ctx.origin,
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
    const job = await videos.get(await caller(ctx), ctx.params.id);
    if (job.status !== 'completed') throw new AppError(409, 'video_not_ready');
    ctx.type = 'video/mp4';
    ctx.body = files.read(job.id);
  });

  router.get('/v1/media/:id', async (ctx) => {
    if (isUUID(ctx.params.id) && store.verifyMedia(ctx.params.id, ctx.query.expires, ctx.query.signature)) {
      return fetchAsset(store, files, ctx, null);
    }
    return fetchAsset(store, files, ctx, await caller(ctx));
  });
}
