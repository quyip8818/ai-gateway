import koaBody from 'koa-body';
import { readFile } from 'node:fs/promises';
import type { Store } from '../db/store.ts';
import { AppError, isUUID } from '../domain.ts';
import type { Files } from '../media/files.ts';
import { imageReferenceMimeType, MAX_IMAGE_REFERENCE_BYTES } from '../providers/jimeng/lib/image-reference.ts';

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
    const mime = imageReferenceMimeType(bytes);
    if (!mime) throw new AppError(400, 'invalid_reference');
    references.push(`data:${mime};base64,${bytes.toString('base64')}`);
  }
  return references;
}

export async function fetchAsset(store: Store, files: Files, ctx, ownerId: string | null) {
  if (!isUUID(ctx.params.id)) throw new AppError(404, 'media_not_found');
  const asset = (
    await store.db.query(
      'SELECT id,mime,bytes FROM media_assets WHERE id=$1 AND ($2::uuid IS NULL OR owner_id=$2)',
      [ctx.params.id, ownerId],
    )
  ).rows[0];
  if (!asset) throw new AppError(404, 'media_not_found');
  ctx.type = asset.mime;
  ctx.length = Number(asset.bytes);
  ctx.body = files.read(asset.id);
}
