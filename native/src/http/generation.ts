import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { finished } from 'node:stream/promises';
import type { Store } from '../db/store.ts';
import { AppError } from '../domain.ts';
import { invokeText } from '../providers/index.ts';
import { generateImagesWithRetry } from '../providers/jimeng/api/controllers/images.ts';
import { openAIImageSize } from '../providers/jimeng/api/controllers/image-size.ts';
import {
  downloadPublicMedia,
  imageReferenceMimeType,
  loadImageReference,
} from '../providers/jimeng/lib/image-reference.ts';
import { withJimengRequest } from '../providers/jimeng/context.ts';
import type { Files } from '../media/files.ts';

export function generation(store: Store, files: Files) {
  async function attempt(key, model, operation, run) {
    if (typeof model !== 'string' || !model) throw new AppError(400, 'model_required');
    const account = await store.selectAccount(key, model, operation === 'count_tokens' ? 'messages' : operation);
    const id = randomUUID();
    let deferred = false;
    const after = async (status, usage = null) => {
      try {
        await store.db.query('UPDATE request_attempts SET status=$2,usage=$3,finished_at=now() WHERE id=$1', [
          id,
          status,
          usage,
        ]);
      } finally {
        await store.release(account.lease);
      }
    };
    try {
      await store.db.query(
        `INSERT INTO request_attempts(id,workspace_id,owner_id,account_id,operation,model,status)
        VALUES($1,$2,$3,$4,$5,$6,'running')`,
        [id, key.workspace_id, key.id, account.id, operation, model],
      );
      const result = await run(account, (stream, response, readResult) => {
        deferred = true;
        let settled = false;
        const settle = (status, usage = null) => {
          if (settled) return;
          settled = true;
          void after(status, usage).catch(() => {});
        };
        void finished(stream).then(
          () => {
            const { status, usage } = readResult();
            settle(status, usage);
          },
          () => settle('interrupted'),
        );
        response.once('close', () => {
          if (!response.writableFinished) {
            stream.destroy();
            settle('interrupted');
          }
        });
      });
      if (!deferred) await after(result?.status ?? 'succeeded', result?.usage ?? null);
      return result?.value;
    } catch (error) {
      await after('failed').catch(() => {});
      throw error;
    }
  }

  async function text(ctx, key, input, operation: string, signal: AbortSignal) {
    return attempt(key, input.model, operation, async (account, onStream) => {
      if (operation === 'count_tokens' && account.provider !== 'claude')
        throw new AppError(400, 'token_count_unsupported');
      if (
        account.kind === 'oauth' &&
        account.provider === 'codex' &&
        (input.previous_response_id || input.input?.some?.((item) => item?.type === 'item_reference'))
      )
        throw new AppError(400, 'responses_continuation_unsupported');
      const credential = await store.currentCredential(account, signal);
      const response = await invokeText(
        { ...account, credential },
        account.upstream_id,
        operation,
        input,
        new Headers(ctx.headers),
        signal,
      );
      ctx.status = response.status;
      if (response.headers.has('retry-after')) ctx.set('Retry-After', response.headers.get('retry-after')!);
      if (response.ok && response.headers.get('content-type')?.includes('text/event-stream') && response.body) {
        ctx.type = 'text/event-stream';
        ctx.set('Cache-Control', 'no-store');
        ctx.set('X-Accel-Buffering', 'no');
        let buffer = '';
        const decoder = new StringDecoder('utf8');
        let status = 'interrupted';
        let usage = {};
        const monitor = new Transform({
          transform(chunk, _encoding, done) {
            buffer += decoder.write(chunk);
            for (;;) {
              const end = buffer.indexOf('\n');
              if (end < 0) break;
              const line = buffer.slice(0, end).trim();
              buffer = buffer.slice(end + 1);
              if (!line.startsWith('data:')) continue;
              try {
                const e = JSON.parse(line.slice(5));
                const measured = e.response?.usage ?? e.message?.usage ?? e.usage;
                if (measured)
                  usage = {
                    ...usage,
                    ...measured,
                    source: account.provider === 'kiro' ? 'estimated' : 'reported',
                  };
                if (['message_stop', 'response.completed'].includes(e.type) && status !== 'failed')
                  status = 'succeeded';
                if (['response.failed', 'response.incomplete', 'error'].includes(e.type)) status = 'failed';
              } catch {}
            }
            if (buffer.length > 2 * 1024 * 1024) buffer = '';
            done(null, chunk);
          },
        });
        const upstream = Readable.fromWeb(response.body);
        upstream.on('error', (error) => monitor.destroy(error));
        monitor.once('close', () => upstream.destroy());
        upstream.pipe(monitor);
        onStream(monitor, ctx.res, () => ({ status, usage }));
        ctx.body = monitor;
        return {};
      }
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new AppError(502, 'invalid_upstream_response');
      }
      ctx.body = payload;
      return { status: response.ok ? 'succeeded' : 'failed', usage: payload?.usage };
    });
  }

  async function images(key, input, uploads: string[], edit: boolean, signal: AbortSignal, origin: string) {
    if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 32_000)
      throw new AppError(400, 'invalid_prompt');
    const n = Number(input.n ?? 1);
    const format = input.response_format ?? 'url';
    const size = input.size === undefined || input.size === 'auto' ? undefined : openAIImageSize(input.size);
    if (
      !Number.isInteger(n) ||
      n < 1 ||
      n > 8 ||
      !['url', 'b64_json'].includes(format) ||
      (input.size !== undefined && input.size !== 'auto' && !size)
    )
      throw new AppError(400, 'invalid_image_spec');
    const images = input.images ?? [];
    if (
      !Array.isArray(images) ||
      (!edit && (images.length || uploads.length)) ||
      (edit && ((!images.length && !uploads.length) || images.length + uploads.length > 10))
    )
      throw new AppError(400, 'invalid_images');
    const references = [...uploads];
    for (const image of images) {
      if (typeof image?.image_url !== 'string') throw new AppError(400, 'invalid_reference');
      try {
        references.push(await loadImageReference(image.image_url));
      } catch {
        throw new AppError(400, 'invalid_reference');
      }
    }
    return attempt(key, input.model ?? 'jimeng/jimeng-image-5.0-lite', 'image', async (account) => {
      const c = await store.currentCredential(account, signal);
      const urls = await withJimengRequest(signal, () =>
        generateImagesWithRetry(account.upstream_id, input.prompt, { size, n, filePaths: references }, c.token),
      );
      if (!urls.length) throw new AppError(502, 'image_generation_failed');
      const data = [];
      for (const url of urls) {
        const bytes = await downloadPublicMedia(url, 24 * 1024 * 1024, signal);
        const mime = imageReferenceMimeType(bytes);
        if (!mime) throw new AppError(502, 'invalid_media_content');
        const id = randomUUID();
        await files.write(id, bytes);
        await store.db.query(
          'INSERT INTO media_assets(id,workspace_id,owner_id,mime,bytes) VALUES($1,$2,$3,$4,$5)',
          [id, key.workspace_id, key.id, mime, bytes.length],
        );
        data.push(
          format === 'b64_json' ? { b64_json: bytes.toString('base64') } : { url: store.signedMedia(id, origin) },
        );
      }
      return { value: { created: Math.floor(Date.now() / 1000), data } };
    });
  }

  return { text, images };
}
