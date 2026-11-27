import { withJimengRequest } from './context.ts';
import { getTokenLiveStatus } from './api/controllers/core.ts';
import { listModelConfigs } from './api/controllers/models.ts';
import { VIDEO_RECAST_MODELS } from './lib/configs/video-recast-models.ts';

export async function discoverJimeng(c, signal: AbortSignal) {
  if (!(await withJimengRequest(signal, () => getTokenLiveStatus(c.token))))
    throw new Error('Jimeng session is invalid');
  const generation = (await withJimengRequest(signal, () => listModelConfigs(c.token))).map((m) => ({
    id: m.id,
    operation: m.type,
    capabilities: {
      resolutions: m.supportedResolutions,
      durations: m.supportedDurations,
      counts: m.supportedGenerateCounts,
    },
  }));
  const recast = [...VIDEO_RECAST_MODELS].map(([id, model]) => ({
    id,
    operation: 'video',
    capabilities: { mode: 'recast', resolutions: [model.resolution], durations: [model.sourceDurationMs / 1000] },
  }));
  return [...generation, ...recast];
}
