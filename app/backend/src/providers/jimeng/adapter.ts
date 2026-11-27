import type { CredentialInput } from '../credentials.ts';
import { readJimengSessionId } from './credential.ts';
import { AppError } from '../../domain.ts';
import { withJimengRequest } from './context.ts';
import { getTokenLiveStatus } from './api/controllers/core.ts';
import { listModelConfigs } from './api/controllers/models.ts';
import { videoRecastModel } from './lib/configs/video-recast-models.ts';
import { getSupportedVideoDurations } from './api/controllers/videos.ts';
import EX from './api/consts/exceptions.ts';
import APIException from './lib/exceptions/APIException.ts';

async function verifySession(token: string, signal: AbortSignal) {
  let live;
  try {
    live = await withJimengRequest(signal, () => getTokenLiveStatus(token));
  } catch (error) {
    const apiError = error instanceof APIException ? error : undefined;
    const status = apiError?.httpStatusCode;
    if (status === 401) {
      throw new AppError(422, 'jimeng_session_rejected', 'Jimeng rejected the session');
    }
    if (status === 403 || apiError?.compare(EX.API_RISK_CONTROL_REJECTED)) {
      throw new AppError(502, 'jimeng_validation_denied', 'Jimeng refused the verification request');
    }
    if (status === 429) {
      throw new AppError(429, 'jimeng_validation_rate_limited', 'Jimeng rate-limited verification');
    }
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    console.warn('Jimeng account verification failed', {
      status,
      upstreamCode: typeof code === 'string' && /^[A-Z0-9_]{1,48}$/.test(code) ? code : undefined,
    });
    throw new AppError(502, 'jimeng_validation_unavailable', 'Jimeng verification is unavailable');
  }
  if (!live) throw new AppError(422, 'jimeng_identity_unconfirmed', 'Jimeng did not confirm the account identity');
}

export async function discoverJimeng(c, signal: AbortSignal) {
  await verifySession(c.token, signal);
  const generation = (await withJimengRequest(signal, () => listModelConfigs(c.token, true))).map((m) => ({
    id: m.modelReqKey,
    publicId: m.id,
    operation: m.type,
    capabilities: {
      resolutions: m.supportedResolutions,
      durations: m.type === 'video' ? getSupportedVideoDurations(m) : undefined,
      counts: m.supportedGenerateCounts,
    },
  }));
  const recast = {
    id: videoRecastModel.upstreamModel,
    publicId: videoRecastModel.id,
    operation: 'video',
    capabilities: {
      mode: 'recast',
      resolutions: [videoRecastModel.resolution],
      durations: [videoRecastModel.sourceDurationMs / 1000],
    },
  };
  return [...generation, recast];
}

export function normalizeJimengCredential(c: CredentialInput) {
  const token = readJimengSessionId(c.token ?? c.cookie);
  if (!token) throw new AppError(422, 'jimeng_invalid_cookie_format', 'Provide a sessionid or a Cookie containing it');
  return { token };
}
