import type Router from '@koa/router';
import { mediaTypes, type MediaType } from '../../../../../shared/contracts/media.ts';
import { AppError, isProvider } from '../../domain.ts';
import type { Store } from '../../infrastructure/postgres/store.ts';
import type { MediaAssets } from '../../modules/media/assets.ts';
import type { Settings } from '../../modules/settings/service.ts';
import { fetchAsset } from '../media.ts';
import { jsonBody, objectBody } from '../middleware/request.ts';

function positiveInteger(value: unknown, fallback: number) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new AppError(400, 'invalid_media_query');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new AppError(400, 'invalid_media_query');
  return number;
}

export function registerAdminResources(
  router: Router,
  store: Pick<Store, 'pageAssets'>,
  media: MediaAssets,
  settings: Settings,
) {
  router.get('/admin/v1/providers/:provider/settings', async (ctx) => {
    const { provider } = ctx.params;
    if (!isProvider(provider)) throw new AppError(404, 'setting_not_found');
    ctx.body = await settings.list(provider);
  });
  router.put('/admin/v1/providers/:provider/settings/:id', jsonBody, async (ctx) => {
    const { provider, id } = ctx.params;
    if (!isProvider(provider)) throw new AppError(404, 'setting_not_found');
    ctx.body = await settings.update(provider, id, objectBody(ctx).value);
  });

  router.get('/admin/v1/media', async (ctx) => {
    const { type, provider } = ctx.query;
    const page = positiveInteger(ctx.query.page, 1);
    const limit = positiveInteger(ctx.query.limit, 20);
    if ((type !== undefined && !mediaTypes.some((value) => value === type))
      || (provider !== undefined && !isProvider(provider))
      || limit > 100 || !Number.isSafeInteger((page - 1) * limit)) {
      throw new AppError(400, 'invalid_media_query');
    }
    ctx.body = await store.pageAssets({ type: type as MediaType | undefined, provider, page, limit });
  });
  router.get('/admin/v1/media/:id', async (ctx) => fetchAsset(media, ctx, null));
}
