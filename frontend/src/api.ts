import { useEffect, useState } from "react";

export type Project = { id: string; name: string; role: string };
export type Collection<T> = { data: T[]; next_cursor?: string };
export type Model = {
  id: string;
  operation: string;
  provider: string;
  provider_name?: string;
  capabilities?: {
    aspect_ratios?: string[];
    duration_seconds?: number[];
    input_roles?: string[];
  } | null;
};
export type Pool = {
  id: string;
  provider: string;
  slug: string;
  available: number;
};
export type Job = {
  credits_used?: string | null;
  id: string;
  request_id: string;
  model: string;
  status: string;
  operation: string;
  created_at: string;
  updated_at: string;
  progress?: number;
  artifacts: string[] | null;
  error?: { code: string };
};
export type Key = {
  id: string;
  label: string;
  prefix: string;
  pools: string[];
  revoked_at?: string | null;
};
export type UsageItem = {
  metric: string;
  unit: string;
  quantity: number | string;
  source: string;
};
export const text = (value: unknown) =>
  value == null || value === "" ? "—" : String(value);
export const consoleURL = "/console/v1";
export const projectURL = (id: string) => consoleURL + "/projects/" + id;
export const workspaceURL = (project: Project) => "/app/projects/" + project.id;
export const operationName = (value: string) =>
  (
    ({
      responses: "Responses",
      messages: "Messages",
      "image.generate": "图片生成",
      "video.generate": "视频生成",
    }) as Record<string, string>
  )[value] ?? value;

const dateFormat = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "medium",
  timeStyle: "short",
});
export function date(value?: string | null) {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? dateFormat.format(time) : "—";
}

export class APIError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}

export async function api<T>(
  path: string,
  payload?: unknown,
  method?: string,
  signal?: AbortSignal,
  headers?: Record<string, string>,
): Promise<T> {
  const response = await fetch(path, {
    signal,
    method: method ?? (payload === undefined ? "GET" : "POST"),
    headers: {
      "X-Gateway-CSRF": "1",
      ...(payload !== undefined && !(payload instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...headers,
    },
    body:
      payload instanceof FormData
        ? payload
        : payload === undefined
          ? undefined
          : JSON.stringify(payload),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new APIError(
      error?.error?.code ?? "HTTP " + response.status,
      response.status,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function useResource<T>(
  path: string | null,
  every = 0,
  complete?: (value: T) => boolean,
) {
  const [result, setResult] = useState<{
    path: string;
    value?: T;
    failure?: Error;
  }>();
  const [version, changeVersion] = useState(0);
  useEffect(() => {
    if (!path) return;
    const url = path;
    const controller = new AbortController();
    let timer: number | undefined;
    async function read() {
      try {
        const value = await api<T>(
          url,
          undefined,
          undefined,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setResult({ path: url, value });
        if (complete?.(value)) return;
      } catch (failure) {
        if (controller.signal.aborted) return;
        setResult((previous) => ({
          path: url,
          value: previous?.path === url ? previous.value : undefined,
          failure: failure as Error,
        }));
        if (failure instanceof APIError && failure.status < 500) return;
      }
      if (every) timer = window.setTimeout(read, every);
    }
    void read();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [path, every, version, complete]);

  const current = result?.path === path ? result : undefined;
  return {
    value: current?.value,
    error: current?.failure?.message,
    status:
      current?.failure instanceof APIError ? current.failure.status : undefined,
    refresh: () => changeVersion((v) => v + 1),
  };
}

export function usePages() {
  const [history, setHistory] = useState<string[]>([""]);
  return {
    cursor: history[history.length - 1],
    reset: () => setHistory([""]),
    previous:
      history.length > 1
        ? () => setHistory((items) => items.slice(0, -1))
        : undefined,
    next: (cursor: string) => setHistory((items) => [...items, cursor]),
  };
}
