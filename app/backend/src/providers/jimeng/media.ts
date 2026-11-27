import { readImageCredits } from './api/controllers/credit-history.ts';
import { request } from './api/controllers/core.ts';
import { generateImagesWithRetry } from './api/controllers/images.ts';
import { openAIImageSize } from './api/controllers/image-size.ts';
import { resolveVideoModelConfig } from './api/controllers/models.ts';
import { inspectVideoHistory } from './api/controllers/video-history.ts';
import { getDefaultVideoDuration, getSupportedVideoDurations, submitVideoGeneration } from './api/controllers/videos.ts';
import { prepareVideoRecast } from './api/controllers/video-recast.ts';
import { submitScenarioVideo } from './api/controllers/video-scenario.ts';
import { describeVideoTaskProgress } from './api/controllers/video-task-progress.ts';
import { videoSize, videoSizeSpec } from './api/controllers/video-size.ts';
import { withJimengRequest } from './context.ts';
import JimengError from './lib/exceptions/APIException.ts';
import JimengExceptions from './api/consts/exceptions.ts';
import { DEFAULT_VIDEO_RECAST_MODEL, VIDEO_RECAST_MODELS } from './lib/configs/video-recast-models.ts';
import { downloadGeneratedImage, downloadPublicMedia, loadImageReference } from './lib/image-reference.ts';

export const jimengImages = {
  size: openAIImageSize,
  async generate(model: string, prompt: string, options: Parameters<typeof generateImagesWithRetry>[2], token: string, signal: AbortSignal) {
    return withJimengRequest(signal, async () => {
      const { urls, submitId } = await generateImagesWithRetry(model, prompt, options, token);
      const usage = readImageCredits(token, submitId).then((credits_used) => {
        const credit_receipt = { submit_id: submitId, credits_used };
        console.info('[jimeng image credits ledger]', JSON.stringify(credit_receipt));
        return { credit_receipt };
      });
      return { urls, usage };
    });
  },
};

export const jimengVideos = {
  defaultRecastModel: DEFAULT_VIDEO_RECAST_MODEL,
  recastDuration(model: string) {
    const preset = VIDEO_RECAST_MODELS.get(model);
    return preset?.sourceDurationMs === undefined ? undefined : preset.sourceDurationMs / 1000;
  },
  size: videoSize,
  parseSize: videoSizeSpec,
  async specs(model: string, token: string, signal: AbortSignal) {
    const config = await withJimengRequest(signal, () => resolveVideoModelConfig(model, token));
    return {
      defaultResolution: config.defaultResolution,
      supportedResolutions: config.supportedResolutions,
      defaultDuration: getDefaultVideoDuration(config),
      supportedDurations: getSupportedVideoDurations(config),
    };
  },
  async prepare(job, payload, token: string, signal: AbortSignal) {
    if (job.operation === 'recast') {
      const preset = VIDEO_RECAST_MODELS.get(job.upstream_model)!;
      const scenario = await withJimengRequest(signal, () =>
        prepareVideoRecast(token, job.upstream_source_id, payload.prompt, preset),
      );
      return {
        size: scenario.size,
        submit: () => withJimengRequest(signal, () => submitScenarioVideo(token, job.id, scenario)),
      };
    }
    const config = await withJimengRequest(signal, () => resolveVideoModelConfig(job.upstream_model, token));
    return {
      submit: () => withJimengRequest(signal, () =>
        submitVideoGeneration(config, payload.prompt, {
          ratio: payload.ratio,
          resolution: payload.resolution,
          duration: Number(job.seconds),
          referencePath: payload.reference,
        }, token, job.id),
      ),
    };
  },
  async inspect(id: string, history: string | null, token: string, signal: AbortSignal) {
    const data = history ? { history_ids: [history] } : { submit_ids: [id] };
    const response = await withJimengRequest(signal, () => request(
      'post', '/mweb/v1/get_history_by_ids', token,
      { data, signal, timeout: 15_000 }, { retry: false, logPayload: false },
    ));
    const { result, record } = inspectVideoHistory(response, history ?? id);
    if (result.state === 'ready') return { state: 'ready' as const, url: result.url };
    if (result.state === 'failed') return { state: 'failed' as const };
    return { state: 'pending' as const, progress: describeVideoTaskProgress(result, record).percent };
  },
  terminalError(error: unknown) {
    if (!(error instanceof JimengError)) return;
    if (error.compare(JimengExceptions.API_REQUEST_PARAMS_INVALID)) return 'invalid_upstream_video_input';
    if (error.compare(JimengExceptions.API_IMAGE_GENERATION_INSUFFICIENT_POINTS))
      return 'insufficient_jimeng_credits';
  },
};

export const jimengMediaFiles = { downloadImage: downloadGeneratedImage, downloadVideo: downloadPublicMedia, loadReference: loadImageReference };
