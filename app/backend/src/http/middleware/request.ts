import type { MediaAssets } from '../../modules/media/assets.ts';
import koaBody from 'koa-body';
import { readFile } from 'node:fs/promises';
import { AppError } from '../../domain.ts';
import { jimengMediaFiles, MAX_IMAGE_REFERENCE_BYTES } from '../../providers/registry.ts';

export const jsonBody = koaBody({ jsonLimit: '8mb', text: false, urlencoded: false });
export const mediaBody = koaBody({
  jsonLimit: '70mb',
  text: false,
  urlencoded: false,
  multipart: true,
  formidable: { maxFileSize: MAX_IMAGE_REFERENCE_BYTES, maxFields: 30 },
});

export function bearer(ctx) {
  return ctx.get('authorization').match(/^Bearer (\S+)$/i)?.[1] ?? '';
}

export function objectBody(ctx) {
  const body = ctx.request.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, 'invalid_body');
  return body;
}

export async function uploads(ctx, names: string[]) {
  const files = ctx.request.files ?? {};
  if (Object.keys(files).some((name) => !names.includes(name))) throw new AppError(400, 'unexpected_upload');
  const references: string[] = [];
  const items = Object.values(files).flat();
  if (items.length > 10) throw new AppError(400, 'too_many_uploads');
  for (const file of items) {
    if (!file.size || file.size > MAX_IMAGE_REFERENCE_BYTES) throw new AppError(400, 'invalid_reference');
    const bytes = await readFile(file.filepath);
    const mime = jimengMediaFiles.imageMime(bytes);
    if (!mime) throw new AppError(400, 'invalid_reference');
    references.push(`data:${mime};base64,${bytes.toString('base64')}`);
  }
  return references;
}

export async function fetchAsset(media: MediaAssets, ctx, ownerId: string | null) {
  const asset = await media.open(ctx.params.id, ownerId);
  ctx.type = asset.mime;
  ctx.length = asset.bytes;
  ctx.body = asset.stream;
}
