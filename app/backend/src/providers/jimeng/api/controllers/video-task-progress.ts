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

export function pendingVideoProgress(result: Extract<VideoHistoryResult, { state: 'pending' }>, record?: Fields) {
    if (result.status === 50) return 99;
    if (seconds(fields(record?.queue_info)?.queue_status) !== 2) return 0;

    const now = Date.now() / 1000;
    const created = timestamp(record?.created_time, now);
    const queueEstimate = seconds(record?.forecast_queue_cost);
    const generationEstimate = seconds(record?.forecast_generate_cost);
    if (created === undefined || queueEstimate === undefined || !generationEstimate) return 0;

    const elapsed = now - created - queueEstimate;
    return elapsed >= 0 && elapsed < generationEstimate
        ? Math.min(99, Math.floor(100 * elapsed / generationEstimate))
        : 0;
}
