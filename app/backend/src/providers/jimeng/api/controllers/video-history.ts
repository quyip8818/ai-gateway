import { isVideoMediaUrl } from "../../lib/media-url.ts";

type HistoryObject = Record<string, unknown>;
type VideoOutput = { width?: number; height?: number; durationMs?: number };

export type VideoHistoryResult =
  | { state: "pending"; status?: number }
  | { state: "failed"; status?: number; failCode?: string }
  | { state: "ready"; url: string };

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

function completedVideo(items: unknown): { url: string; output: VideoOutput } | undefined {
  if (!Array.isArray(items)) return;
  for (const entry of items) {
    const item = object(entry);
    const video = object(item?.video);
    if (!video) continue;

    const origin = object(object(video.transcoded_video)?.origin);
    const covers = [video.cover_url, object(item?.common_attr)?.cover_url];
    for (const candidate of [origin?.video_url, video.play_url, video.download_url, video.url]) {
      if (!isVideoMediaUrl(candidate) || covers.includes(candidate)) continue;
      return {
        url: candidate,
        output: {
          width: positiveNumber(origin?.width) ?? positiveNumber(video.width),
          height: positiveNumber(origin?.height) ?? positiveNumber(video.height),
          durationMs: positiveNumber(video.duration_ms),
        },
      };
    }
  }
}

export function inspectVideoHistory(response: unknown, historyId: string):
  { record?: HistoryObject; result: VideoHistoryResult; output?: VideoOutput } {
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
    if (video) return { record, result: { state: "ready", url: video.url }, output: video.output };
  }
  return { record, result: { state: "pending", status } };
}
