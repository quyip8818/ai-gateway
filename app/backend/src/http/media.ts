import { AppError } from '../domain.ts';
import type { MediaAssets } from '../modules/media/assets.ts';

// Ignore unsupported range units and multiple ranges. An unsatisfiable byte range returns null.
function byteRange(header: string, bytes: number) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header);
  if (!match || (!match[1] && !match[2])) return;
  const start = match[1] ? Number(match[1]) : Math.max(0, bytes - Number(match[2]));
  const requestedEnd = match[1] && match[2] ? Number(match[2]) : undefined;
  if (requestedEnd !== undefined && requestedEnd < start) return;
  const end = Math.min(requestedEnd ?? bytes - 1, bytes - 1);
  return start <= end ? { start, end } : null;
}

export async function fetchAsset(media: MediaAssets, ctx, ownerId: string | null, id = ctx.params.id) {
  const asset = await media.open(id, ownerId);
  const range = ctx.method === 'GET' && !ctx.get('If-Range')
    ? byteRange(ctx.get('Range'), asset.bytes)
    : undefined;
  ctx.set('Accept-Ranges', 'bytes');
  if (range === null) {
    ctx.set('Content-Range', 'bytes */' + asset.bytes);
    throw new AppError(416, 'range_not_satisfiable');
  }
  if (ctx.query.download === '1') {
    const extension = asset.mime === 'image/jpeg' ? 'jpg' : asset.mime.split('/')[1] || 'bin';
    ctx.attachment(id + '.' + extension);
  }
  ctx.type = asset.mime;
  ctx.status = range ? 206 : 200;
  if (range) ctx.set('Content-Range', `bytes ${range.start}-${range.end}/${asset.bytes}`);
  if (ctx.method !== 'HEAD') ctx.body = asset.read(range);
  ctx.length = range ? range.end - range.start + 1 : asset.bytes;
}
