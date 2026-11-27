import type { Accounts } from '../accounts/service.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { Store } from '../../infrastructure/postgres/store.ts';
import { AppError, isUUID } from '../../domain.ts';
import type { Files } from '../../infrastructure/files/storage.ts';
import { jimengVideos as provider, jimengMediaFiles } from '../../providers/registry.ts';

export function publicVideo(job) {
  return {
    id: 'video_' + job.id,
    object: 'video',
    model: job.public_model,
    status: ['submitting', 'submission_unknown', 'in_progress'].includes(job.status) ? 'in_progress' : job.status,
    progress: job.progress,
    size: job.size,
    seconds: job.seconds,
    created_at: Math.floor(new Date(job.created_at).getTime() / 1000),
    completed_at: job.completed_at ? Math.floor(new Date(job.completed_at).getTime() / 1000) : null,
    remixed_from_video_id: job.source_id ? 'video_' + job.source_id : null,
    error: job.error_code ? { code: job.error_code, message: 'Video generation did not complete' } : null,
  };
}

type VideoRepository = Pick<Store,
  'findVideo' | 'findIdempotentVideo' | 'insertVideo' | 'updateVideo' | 'setVideoSize' |
  'startVideo' | 'completeVideo' | 'readVideoPayload'
>;

export function createVideoService(store: VideoRepository, accounts: Accounts, files: Files) {
  async function get(key, raw: string) {
    const id = typeof raw === 'string' && raw.startsWith('video_') ? raw.slice(6) : '';
    if (!isUUID(id)) throw new AppError(404, 'video_not_found');
    const job = await store.findVideo(id, key.id);
    if (!job) throw new AppError(404, 'video_not_found');
    return job;
  }

  async function enqueue(key, operation: 'generate' | 'recast', body, idempotency: string | undefined) {
    if (idempotency && !/^[\x21-\x7e]{1,128}$/.test(idempotency))
      throw new AppError(400, 'invalid_idempotency_key');
    if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 32_000)
      throw new AppError(400, 'invalid_prompt');
    const publicModel =
      body.model ??
      'jimeng/' + (operation === 'recast' ? provider.defaultRecastModel : 'jimeng-video-seedance-2.0');
    if (typeof publicModel !== 'string' || !publicModel.startsWith('jimeng/'))
      throw new AppError(400, 'invalid_video_model');
    const rawSource = operation === 'recast' ? body.video?.upstream_id : undefined;
    if (rawSource !== undefined && (body.video?.id || typeof rawSource !== 'string' || !isUUID(rawSource))) {
      throw new AppError(400, 'invalid_recast_source');
    }
    const source = operation === 'recast' && !rawSource ? await get(key, body.video?.id ?? '') : null;
    const sourceId = source?.id ?? rawSource;
    const requestedSeconds = body.seconds === undefined ? undefined : Number(body.seconds);
    const desiredSize = body.size === undefined ? undefined : provider.parseSize(body.size);
    const url = body.input_reference?.image_url;
    if (body.input_reference !== undefined && typeof url !== 'string') {
      throw new AppError(400, 'invalid_reference');
    }
    const hash = createHash('sha256')
      .update(JSON.stringify([publicModel, body.prompt, body.size, requestedSeconds, url, sourceId]))
      .digest();
    const lookup = async () => {
      if (!idempotency) return;
      const previous = await store.findIdempotentVideo(key.id, operation, idempotency);
      if (previous && !previous.input_hash.equals(hash)) throw new AppError(409, 'idempotency_conflict');
      return previous;
    };
    const previous = await lookup();
    if (previous) return previous;
    if (
      (body.size !== undefined && !desiredSize) ||
      (requestedSeconds !== undefined && (!Number.isSafeInteger(requestedSeconds) || requestedSeconds <= 0))
    ) {
      throw new AppError(400, 'invalid_video_dimensions');
    }
    if (source && source.status !== 'completed') throw new AppError(409, 'source_not_ready');
    const recastDuration = provider.recastDuration(publicModel.slice(7));
    if ((recastDuration !== undefined) !== (operation === 'recast')) throw new AppError(400, 'invalid_video_model');
    const target = await accounts.select(key, publicModel, 'video', source?.account_id ?? null, false);
    let resolution, ratio, seconds, size;
    if (recastDuration === undefined) {
      const signal = AbortSignal.timeout(30_000);
      const credential = await accounts.currentCredential(target, signal);
      const config = await provider.specs(target.upstream_id, credential.token, signal);
      resolution = desiredSize?.resolution ?? config.defaultResolution;
      ratio = desiredSize?.ratio ?? '16:9';
      seconds = requestedSeconds ?? config.defaultDuration;
      if (
        !config.supportedResolutions.includes(resolution) ||
        !config.supportedDurations.includes(seconds)
      ) {
        throw new AppError(400, 'unsupported_video_spec');
      }
      size = body.size ?? provider.size(16, 9, resolution === '4k' ? 2160 : Number.parseInt(resolution));
    } else {
      seconds = recastDuration;
    }
    let reference;
    if (url !== undefined) {
      try {
        reference = await jimengMediaFiles.loadReference(url);
      } catch {
        throw new AppError(400, 'invalid_reference');
      }
    }
    const id = randomUUID();
    const job = await store.insertVideo({
      id,
      owner: key.id,
      account: target.id,
      accountVersion: target.credential_version,
      model: publicModel,
      upstreamModel: target.upstream_id,
      operation,
      key: idempotency ?? null,
      hash,
      payload: { prompt: body.prompt, reference, ratio, resolution },
      size: size ?? null,
      seconds: String(seconds),
      source: source?.id ?? null,
      upstreamSource: sourceId ?? null,
    });
    return job ?? (await lookup());
  }

  async function process(job, signal: AbortSignal) {
    const update = (
      status: string,
      wait: number,
      history: string | null = null,
      error: string | null = null,
      progress = 0,
    ) =>
      store.updateVideo(job.id, job.lease_version, status, wait, history, error, progress);
    if (Date.now() - new Date(job.created_at).getTime() > 24 * 60 * 60 * 1000) {
      await update('failed', 0, null, 'video_deadline_exceeded');
      return;
    }
    let lease;
    try {
      const account = await accounts.find(job.account_id);
      if (!account?.enabled) throw new AppError(409, 'account_disabled');
      if (job.status === 'queued') {
        const claimed = await accounts.claim(job.account_id);
        if (!claimed) {
          await update('queued', 3);
          return;
        }
        lease = claimed.lease;
      }
      const credential = await accounts.currentCredential(account, signal);
      if (job.status === 'queued') {
        const payload = store.readVideoPayload(job.id, job.payload);
        const request = await provider.prepare(job, payload, credential.token, signal);
        if (request.size !== undefined) await store.setVideoSize(job.id, job.lease_version, request.size);
        const started = await store.startVideo(job.id, job.lease_version);
        if (!started.rowCount) return;
        job.status = 'submitting';
        const history = await request.submit();
        await update('in_progress', 2, history);
        return;
      }
      const state = await provider.inspect(job.id, job.history_id, credential.token, signal);
      if (state.state === 'failed') {
        await update('failed', 0, null, 'upstream_video_failed');
        return;
      }
      if (state.state === 'ready') {
        const bytes = await jimengMediaFiles.downloadVideo(
          state.url,
          256 * 1024 * 1024,
          AbortSignal.any([signal, AbortSignal.timeout(40_000)]),
        );
        if (bytes.toString('ascii', 4, 8) !== 'ftyp') throw new Error('Unexpected video content');
        await store.completeVideo(job, bytes.length, () => files.write(job.id, bytes));
        return;
      }
      await update(
        job.status === 'submission_unknown' ? job.status : 'in_progress',
        5,
        null,
        null,
        state.progress,
      );
    } catch (error) {
      const code = provider.terminalError(error);
      if (code) await update('failed', 0, null, code);
      else if (job.status === 'submitting') await update('submission_unknown', 8);
      else if (error instanceof AppError && error.code === 'account_disabled')
        await update('failed', 0, null, error.code);
      else await update(job.status, 10);
    } finally {
      if (lease) await accounts.release(lease);
    }
  }

  return { get, enqueue, process };
}
