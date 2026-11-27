import type { VideoOutput } from "../../../../../../../shared/contracts/media.ts";
import { isVideoMediaUrl } from "../../lib/media-url.ts";

type HistoryObject = Record<string, unknown>;

export type VideoHistoryResult =
  | { state: "pending"; status?: number }
  | { state: "failed"; status?: number; failCode?: string }
  | { state: "ready"; url: string; output: VideoOutput | null };

const failedStatuses = new Set([10, 30, 40, 100]);

function object(value: unknown): HistoryObject | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as HistoryObject;
  }
}

export function findVideoHistoryRecord(response: unknown, historyId: string) {
  const data = object(response);
  if (data && Object.hasOwn(data, historyId)) return object(data[historyId]);
}

function positiveNumber(value: unknown) {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function pixelCount(value: unknown) {
  const pixels = positiveNumber(value);
  return Number.isSafeInteger(pixels) ? pixels : undefined;
}

function completedVideo(items: unknown): Extract<VideoHistoryResult, { state: "ready" }> | undefined {
  if (!Array.isArray(items)) return;
  for (const entry of items) {
    const item = object(entry);
    const video = object(item?.video);
    if (!video) continue;

    const origin = object(object(video.transcoded_video)?.origin);
    const covers = [video.cover_url, object(item?.common_attr)?.cover_url];
    const url = [origin?.video_url, video.play_url, video.download_url, video.url]
      .find((candidate): candidate is string => isVideoMediaUrl(candidate) && !covers.includes(candidate));
    if (!url) continue;
    const rendition = url === origin?.video_url ? origin : undefined;
    const width = pixelCount(rendition?.width) ?? pixelCount(video.width) ?? null;
    const height = pixelCount(rendition?.height) ?? pixelCount(video.height) ?? null;
    const duration_ms = positiveNumber(rendition?.duration_ms) ?? positiveNumber(video.duration_ms) ?? null;
    return { state: "ready", url, output: width || height || duration_ms ? { width, height, duration_ms } : null };
  }
}

export function inspectVideoHistory(response: unknown, historyId: string):
  { record?: HistoryObject; result: VideoHistoryResult } {
  const record = findVideoHistoryRecord(response, historyId);
  const rawStatus = record?.status;
  if (typeof rawStatus !== "number" && (typeof rawStatus !== "string" || !rawStatus.trim())) {
    return { record, result: { state: "pending" } };
  }
  const status = Number(rawStatus);
  if (!Number.isInteger(status)) return { record, result: { state: "pending" } };

  if (failedStatuses.has(status)) {
    const code = record?.fail_code;
    const failCode = typeof code === "string" || typeof code === "number" ? String(code) : undefined;
    return { record, result: { state: "failed", status, failCode } };
  }
  if (status === 50) {
    const video = completedVideo(record?.item_list);
    if (video) return { record, result: video };
  }
  return { record, result: { state: "pending", status } };
}
