import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { AppError } from '../../domain.ts';

export async function requestBoundary(ctx, next) {
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
}

export function requestSignal(shutdown: AbortSignal, ctx, timeout = 20 * 60_000) {
  const client = new AbortController();
  ctx.res.once('close', () => client.abort());
  return AbortSignal.any([client.signal, shutdown, AbortSignal.timeout(timeout)]);
}
