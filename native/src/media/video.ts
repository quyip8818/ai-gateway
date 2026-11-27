import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Store } from '../db/store.ts';
import { AppError, isUUID } from '../domain.ts';
import type { Files } from './files.ts';
import { withJimengRequest } from '../providers/jimeng/context.ts';
import { resolveVideoModelConfig } from '../providers/jimeng/api/controllers/models.ts';
import { request } from '../providers/jimeng/api/controllers/core.ts';
import { loadImageReference, downloadPublicMedia } from '../providers/jimeng/lib/image-reference.ts';
import { inspectVideoHistory } from '../providers/jimeng/api/controllers/video-history.ts';
import { describeVideoTaskProgress } from '../providers/jimeng/api/controllers/video-task-progress.ts';
import { videoSize, videoSizeSpec } from '../providers/jimeng/api/controllers/video-size.ts';
import {
  getDefaultVideoDuration,
  getSupportedVideoDurations,
  submitVideoGeneration,
} from '../providers/jimeng/api/controllers/videos.ts';
import { prepareVideoRecast } from '../providers/jimeng/api/controllers/video-recast.ts';
import { submitScenarioVideo } from '../providers/jimeng/api/controllers/video-scenario.ts';
import JimengError from '../providers/jimeng/lib/exceptions/APIException.ts';
import JimengExceptions from '../providers/jimeng/api/consts/exceptions.ts';
import {
  DEFAULT_VIDEO_RECAST_MODEL,
  VIDEO_RECAST_MODELS,
} from '../providers/jimeng/lib/configs/video-recast-models.ts';

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

export function createVideoService(store: Store, files: Files) {
  async function get(key, raw: string) {
    const id = typeof raw === 'string' && raw.startsWith('video_') ? raw.slice(6) : '';
    if (!isUUID(id)) throw new AppError(404, 'video_not_found');
    const job = (
      await store.db.query('SELECT * FROM video_jobs WHERE id=$1 AND workspace_id=$2 AND owner_id=$3', [
        id,
        key.workspace_id,
        key.id,
      ])
    ).rows[0];
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
      'jimeng/' + (operation === 'recast' ? DEFAULT_VIDEO_RECAST_MODEL : 'jimeng-video-seedance-2.0');
    if (typeof publicModel !== 'string' || !publicModel.startsWith('jimeng/'))
      throw new AppError(400, 'invalid_video_model');
    const rawSource = operation === 'recast' ? body.video?.upstream_id : undefined;
    if (rawSource !== undefined && (body.video?.id || typeof rawSource !== 'string' || !isUUID(rawSource))) {
      throw new AppError(400, 'invalid_recast_source');
    }
    const source = operation === 'recast' && !rawSource ? await get(key, body.video?.id ?? '') : null;
    const sourceId = source?.id ?? rawSource;
    const requestedSeconds = body.seconds === undefined ? undefined : Number(body.seconds);
    const desiredSize = body.size === undefined ? undefined : videoSizeSpec(body.size);
    const url = body.input_reference?.image_url;
    if (body.input_reference !== undefined && typeof url !== 'string') {
      throw new AppError(400, 'invalid_reference');
    }
    const hash = createHash('sha256')
      .update(JSON.stringify([publicModel, body.prompt, body.size, requestedSeconds, url, sourceId]))
      .digest();
    const lookup = async () => {
      if (!idempotency) return;
      const previous = (
        await store.db.query(
          `SELECT * FROM video_jobs
        WHERE workspace_id=$1 AND owner_id=$2 AND operation=$3 AND idempotency_key=$4`,
          [key.workspace_id, key.id, operation, idempotency],
        )
      ).rows[0];
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
    const preset = VIDEO_RECAST_MODELS.get(publicModel.slice(7));
    if (Boolean(preset) !== (operation === 'recast')) throw new AppError(400, 'invalid_video_model');
    const target = await store.selectAccount(key, publicModel, 'video', source?.account_id ?? null, false);
    let resolution, ratio, seconds, size;
    if (!preset) {
      const signal = AbortSignal.timeout(30_000);
      const credential = await store.currentCredential(target, signal);
      const config = await withJimengRequest(signal, () =>
        resolveVideoModelConfig(target.upstream_id, credential.token),
      );
      resolution = desiredSize?.resolution ?? config.defaultResolution;
      ratio = desiredSize?.ratio ?? '16:9';
      seconds = requestedSeconds ?? getDefaultVideoDuration(config);
      if (
        !config.supportedResolutions.includes(resolution) ||
        !getSupportedVideoDurations(config).includes(seconds)
      ) {
        throw new AppError(400, 'unsupported_video_spec');
      }
      size = body.size ?? videoSize(16, 9, resolution === '4k' ? 2160 : Number.parseInt(resolution));
    } else {
      seconds = preset.sourceDurationMs / 1000;
    }
    let reference;
    if (url !== undefined) {
      try {
        reference = await loadImageReference(url);
      } catch {
        throw new AppError(400, 'invalid_reference');
      }
    }
    const id = randomUUID();
    const payload = store.seal(id, { prompt: body.prompt, reference, ratio, resolution });
    const {
      rows: [job],
    } = await store.db.query(
      `INSERT INTO video_jobs
      (id,workspace_id,owner_id,account_id,public_model,upstream_model,operation,idempotency_key,input_hash,payload,status,size,seconds,source_id,upstream_source_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'queued',$11,$12,$13,$14)
      ON CONFLICT(workspace_id,owner_id,operation,idempotency_key) DO NOTHING RETURNING *`,
      [
        id,
        key.workspace_id,
        key.id,
        target.id,
        publicModel,
        target.upstream_id,
        operation,
        idempotency ?? null,
        hash,
        payload,
        size ?? null,
        String(seconds),
        source?.id ?? null,
        sourceId ?? null,
      ],
    );
    return job ?? (await lookup());
  }

  async function claim() {
    return (
      await store.db.query(`WITH due AS (
        SELECT id FROM video_jobs WHERE status NOT IN ('completed','failed') AND run_after<=now()
        AND (lease_until IS NULL OR lease_until<=now()) ORDER BY run_after LIMIT 1 FOR UPDATE SKIP LOCKED
      ) UPDATE video_jobs j SET lease_until=now()+interval '90 seconds',lease_version=lease_version+1,
        status=CASE WHEN status='submitting' THEN 'submission_unknown' ELSE status END
      FROM due WHERE j.id=due.id RETURNING j.*`)
    ).rows[0];
  }

  async function process(job, signal: AbortSignal) {
    const update = (
      status: string,
      wait: number,
      history: string | null = null,
      error: string | null = null,
      progress = 0,
    ) =>
      store.db.query(
        `UPDATE video_jobs SET status=$3,run_after=now()+$4*interval '1 second',history_id=coalesce($5,history_id),
        error_code=$6,progress=greatest(progress,$7),lease_until=NULL,
        payload=CASE WHEN $3='queued' THEN payload ELSE NULL END,
        completed_at=CASE WHEN $3 IN ('completed','failed') THEN now() ELSE NULL END
        WHERE id=$1 AND lease_version=$2 AND lease_until>now()`,
        [job.id, job.lease_version, status, wait, history, error, progress],
      );
    if (Date.now() - new Date(job.created_at).getTime() > 24 * 60 * 60 * 1000) {
      await update('failed', 0, null, 'video_deadline_exceeded');
      return;
    }
    let lease;
    try {
      const account = (await store.db.query('SELECT * FROM provider_accounts WHERE id=$1', [job.account_id]))
        .rows[0];
      if (!account?.enabled) throw new AppError(409, 'account_disabled');
      if (job.status === 'queued') {
        const claimed = await store.claimAccount(job.account_id);
        if (!claimed) {
          await update('queued', 3);
          return;
        }
        lease = claimed.lease;
      }
      const credential = await store.currentCredential(account, signal);
      if (job.status === 'queued') {
        const payload = store.unseal(job.id, job.payload);
        let submit: () => Promise<string>;
        if (job.operation === 'recast') {
          const preset = VIDEO_RECAST_MODELS.get(job.upstream_model)!;
          const scenario = await prepareVideoRecast(
            credential.token,
            job.upstream_source_id,
            payload.prompt,
            preset,
          );
          await store.db.query('UPDATE video_jobs SET size=$3 WHERE id=$1 AND lease_version=$2', [
            job.id,
            job.lease_version,
            scenario.size,
          ]);
          submit = () => submitScenarioVideo(credential.token, job.id, scenario);
        } else {
          const config = await resolveVideoModelConfig(job.upstream_model, credential.token);
          submit = () =>
            submitVideoGeneration(
              config,
              payload.prompt,
              {
                ratio: payload.ratio,
                resolution: payload.resolution,
                duration: Number(job.seconds),
                referencePath: payload.reference,
              },
              credential.token,
              job.id,
            );
        }
        const started = await store.db.query(
          "UPDATE video_jobs SET status='submitting',payload=NULL WHERE id=$1 AND lease_version=$2 AND lease_until>now()",
          [job.id, job.lease_version],
        );
        if (!started.rowCount) return;
        job.status = 'submitting';
        const history = await submit();
        await update('in_progress', 2, history);
        return;
      }
      const data = job.history_id ? { history_ids: [job.history_id] } : { submit_ids: [job.id] };
      const response = await request(
        'post',
        '/mweb/v1/get_history_by_ids',
        credential.token,
        { data, signal, timeout: 15_000 },
        { retry: false, logPayload: false },
      );
      const state = inspectVideoHistory(response, job.history_id ?? job.id);
      if (state.result.state === 'failed') {
        await update('failed', 0, null, 'upstream_video_failed');
        return;
      }
      if (state.result.state === 'ready') {
        const bytes = await downloadPublicMedia(
          state.result.url,
          256 * 1024 * 1024,
          AbortSignal.any([signal, AbortSignal.timeout(40_000)]),
        );
        if (bytes.toString('ascii', 4, 8) !== 'ftyp') throw new Error('Unexpected video content');
        await files.write(job.id, bytes);
        await store.tx(async (client) => {
          const completed = await client.query(
            `UPDATE video_jobs SET status='completed',progress=100,
            lease_until=NULL,completed_at=now(),error_code=NULL
            WHERE id=$1 AND lease_version=$2 AND lease_until>now()`,
            [job.id, job.lease_version],
          );
          if (!completed.rowCount) return;
          await client.query(
            `INSERT INTO media_assets(id,workspace_id,owner_id,video_id,mime,bytes)
            VALUES($1,$2,$3,$1,'video/mp4',$4)`,
            [job.id, job.workspace_id, job.owner_id, bytes.length],
          );
        });
        return;
      }
      const progress = describeVideoTaskProgress(state.result, state.record);
      await update(
        job.status === 'submission_unknown' ? job.status : 'in_progress',
        5,
        null,
        null,
        progress.percent,
      );
    } catch (error) {
      if (error instanceof JimengError && error.compare(JimengExceptions.API_REQUEST_PARAMS_INVALID)) {
        await update('failed', 0, null, 'invalid_upstream_video_input');
      } else if (
        error instanceof JimengError &&
        error.compare(JimengExceptions.API_IMAGE_GENERATION_INSUFFICIENT_POINTS)
      ) {
        await update('failed', 0, null, 'insufficient_jimeng_credits');
      } else if (job.status === 'submitting') await update('submission_unknown', 8);
      else if (error instanceof AppError && error.code === 'account_disabled')
        await update('failed', 0, null, error.code);
      else await update(job.status, 10);
    } finally {
      if (lease) await store.release(lease);
    }
  }

  async function run(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        const job = await claim();
        if (job) {
          const lease = new AbortController();
          const refresh = setInterval(() => {
            void store.db
              .query(
                `UPDATE video_jobs SET lease_until=now()+interval '90 seconds'
              WHERE id=$1 AND lease_version=$2 AND lease_until>now()`,
                [job.id, job.lease_version],
              )
              .then(
                (result) => {
                  if (!result.rowCount) lease.abort();
                },
                () => lease.abort(),
              );
          }, 25_000);
          try {
            const jobSignal = AbortSignal.any([signal, lease.signal, AbortSignal.timeout(10 * 60_000)]);
            await withJimengRequest(jobSignal, () => process(job, jobSignal));
          } finally {
            clearInterval(refresh);
          }
        } else await delay(750, undefined, { signal });
      } catch {
        await delay(1500, undefined, { signal }).catch(() => {});
      }
    }
  }

  return { get, enqueue, run };
}
