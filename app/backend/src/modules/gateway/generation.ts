import type { Accounts } from '../accounts/service.ts';
import type { MediaAssets } from '../media/assets.ts';
import { randomUUID } from 'node:crypto';
import type { Transform } from 'node:stream';
import { finished } from 'node:stream/promises';
import { monitorSSE } from './sse.ts';
import type { Store } from '../../infrastructure/postgres/store.ts';
import { AppError } from '../../domain.ts';
import { invokeText, jimengImages, jimengMediaFiles, validateTextInput } from '../../providers/registry.ts';

type TextDelivery = { status: number; retryAfter: string | null } & (
  | { kind: 'stream'; body: Transform }
  | { kind: 'json'; body: unknown }
);

export function generation(
  store: Pick<Store, 'startAttempt' | 'finishAttempt'>,
  accounts: Accounts,
  media: MediaAssets,
) {
  async function attempt<T>(
    key: { id: string; scopes: string[] },
    model: unknown,
    operation: string,
    run: (account: Awaited<ReturnType<Accounts['select']>>) => Promise<{
      value: T;
      status?: string;
      usage?: unknown;
      stream?: ReturnType<typeof monitorSSE>;
    }>,
  ): Promise<T> {
    if (typeof model !== 'string' || !model) throw new AppError(400, 'model_required');
    const account = await accounts.select(key, model, operation === 'count_tokens' ? 'messages' : operation);
    const id = randomUUID();
    const after = async (status: string, usage: unknown = null) => {
      try {
        await store.finishAttempt(id, status, usage);
      } finally {
        await accounts.release(account.lease);
      }
    };

    let result;
    try {
      await store.startAttempt(id, key.id, account.id, operation, model);
      result = await run(account);
    } catch (error) {
      await after('failed').catch(() => {});
      throw error;
    }

    const stream = result.stream;
    if (stream) {
      void finished(stream.stream, { cleanup: true }).then(
        () => {
          const { status, usage } = stream.outcome();
          return after(status, usage);
        },
        () => after('interrupted'),
      ).catch(() => {});
    } else {
      await after(result.status ?? 'succeeded', result.usage);
    }
    return result.value;
  }

  async function text(key, input, operation: string, headers: Headers, signal: AbortSignal) {
    return attempt<TextDelivery>(key, input.model, operation, async (account) => {
      if (operation === 'count_tokens' && account.provider !== 'claude')
        throw new AppError(400, 'token_count_unsupported');
      validateTextInput(account.provider, account.kind, input);
      const credential = await accounts.currentCredential(account, signal);
      const response = await invokeText(
        { ...account, credential },
        account.upstream_id,
        operation,
        input,
        headers,
        signal,
      );
      const delivery = { status: response.status, retryAfter: response.headers.get('retry-after') };
      if (response.ok && response.headers.get('content-type')?.includes('text/event-stream') && response.body) {
        const stream = monitorSSE(response.body, account.provider === 'kiro' ? 'estimated' : 'reported');
        return {
          stream,
          value: { ...delivery, kind: 'stream' as const, body: stream.stream },
        };
      }
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new AppError(502, 'invalid_upstream_response');
      }
      return {
        status: response.ok ? 'succeeded' : 'failed',
        usage: payload?.usage,
        value: { ...delivery, kind: 'json' as const, body: payload },
      };
    });
  }

  async function images(key, input, uploads: string[], edit: boolean, signal: AbortSignal, origin: string) {
    if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 32_000)
      throw new AppError(400, 'invalid_prompt');
    const n = Number(input.n ?? 1);
    const format = input.response_format ?? 'url';
    const size = input.size === undefined || input.size === 'auto' ? undefined : jimengImages.size(input.size);
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
        references.push(await jimengMediaFiles.loadReference(image.image_url));
      } catch {
        throw new AppError(400, 'invalid_reference');
      }
    }
    return attempt(key, input.model ?? 'jimeng/jimeng-image-5.0-lite', 'image', async (account) => {
      const c = await accounts.currentCredential(account, signal);
      const urls = await jimengImages.generate(
        account.upstream_id, input.prompt, { size, n, filePaths: references }, c.token, signal,
      );
      if (!urls.length) throw new AppError(502, 'image_generation_failed');
      const data = [];
      for (const url of urls) {
        const bytes = await jimengMediaFiles.download(url, 24 * 1024 * 1024, signal);
        const mime = jimengMediaFiles.imageMime(bytes);
        if (!mime) throw new AppError(502, 'invalid_media_content');
        const id = await media.saveImage(key.id, mime, bytes);
        data.push(
          format === 'b64_json' ? { b64_json: bytes.toString('base64') } : { url: media.signedUrl(id, origin) },
        );
      }
      return { value: { created: Math.floor(Date.now() / 1000), data } };
    });
  }

  return { text, images };
}
