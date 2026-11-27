import type { VideoHistoryResult } from './video-history.ts';

type Fields = Record<string, unknown>;

function fields(value: unknown): Fields | undefined {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Fields;
}

function seconds(value: unknown): number | undefined {
    if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function timestamp(value: unknown, now: number) {
    const time = seconds(value);
    return time !== undefined && time > 0 && time <= now ? time : undefined;
}

export function describeVideoTaskProgress(result: VideoHistoryResult, record?: Fields, liveQueue?: Fields) {
    const now = Date.now() / 1000;
    if (result.state !== 'pending') {
        const finishTime = timestamp(record?.finish_time, now) ?? timestamp(fields(record?.task)?.finish_time, now);
        return {
            status: result.state === 'ready' ? 'completed' : 'failed',
            percent: result.state === 'ready' ? 100 : 0,
            completedAt: finishTime === undefined ? null : Math.floor(finishTime),
        } as const;
    }
    if (result.status === 50) return { status: 'in_progress', percent: 99, completedAt: null } as const;

    const queueStatus = seconds(fields(liveQueue?.queue_info)?.queue_status)
        ?? seconds(fields(record?.queue_info)?.queue_status);
    if (queueStatus === 0 || queueStatus === 1 || (queueStatus === undefined && result.status === undefined)) {
        return { status: 'queued', percent: 0, completedAt: null } as const;
    }

    const created = timestamp(record?.created_time, now);
    const forecasts = fields(liveQueue?.forecast_cost_time);
    const queueEstimate = seconds(forecasts?.forecast_queue_cost) ?? seconds(record?.forecast_queue_cost);
    const generationEstimate = seconds(forecasts?.forecast_generate_cost) ?? seconds(record?.forecast_generate_cost);
    let percent = 0;
    if (queueStatus === 2 && created !== undefined && queueEstimate !== undefined && generationEstimate) {
        const generationElapsed = now - created - queueEstimate;
        if (generationElapsed >= 0 && generationElapsed < generationEstimate) {
            percent = Math.min(99, Math.floor(100 * generationElapsed / generationEstimate));
        }
    }
    return { status: 'in_progress', percent, completedAt: null } as const;
}
