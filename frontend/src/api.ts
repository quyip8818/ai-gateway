import { useEffect, useState } from "react";

export type Row = Record<string, unknown>;
export type Project = { id: string; name: string; role: string };
export type Model = {
  id: string;
  operation: string;
  capabilities?: {
    aspect_ratios?: string[];
    duration_seconds?: number[];
    input_roles?: string[];
  };
};
export type Job = {
  created_at: string;
  credits_used?: string | null;
  recovery_pending?: boolean;
  id: string;
  request_id: string;
  model: string;
  status: string;
  operation: string;
  progress?: number;
  artifacts: string[];
  error?: { code: string };
};
export type Key = {
  id: string;
  label: string;
  prefix: string;
  revoked_at?: string;
};
export const text = (v: unknown) => (v == null ? "—" : String(v));
export const consoleURL = "/console/v1";
export const projectURL = (id: string) => consoleURL + "/projects/" + id;
export async function api<T>(
  path: string,
  payload?: unknown,
  method?: string,
  options: { signal?: AbortSignal; headers?: Record<string, string> } = {},
): Promise<T> {
  const response = await fetch(path, {
    signal: options.signal,
    method: method ?? (payload === undefined ? "GET" : "POST"),
    headers: {
      "X-Gateway-CSRF": "1",
      ...(payload !== undefined && !(payload instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...options.headers,
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
    throw new Error(error?.error?.code ?? "HTTP " + response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
export function useResource<T>(
  path: string | null,
  {
    interval = 0,
    stop,
    stopOnError = false,
  }: {
    interval?: number;
    stop?: (value: T) => boolean;
    stopOnError?: boolean;
  } = {},
) {
  const [result, setResult] = useState<{
    path: string;
    version: number;
    value?: T;
    error: string;
  }>();
  const [version, refresh] = useState(0);
  useEffect(() => {
    if (path === null) return;
    const controller = new AbortController();
    let timer: number | undefined;
    let value: T | undefined;
    async function read(url: string) {
      try {
        value = await api<T>(url, undefined, undefined, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setResult({ path: url, version, value, error: "" });
        if (value !== undefined && stop?.(value)) return;
      } catch (error) {
        if (controller.signal.aborted) return;
        setResult({
          path: url,
          version,
          value,
          error: (error as Error).message,
        });
        if (stopOnError) return;
      }
      if (interval) timer = window.setTimeout(() => void read(url), interval);
    }
    void read(path);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [path, interval, stop, stopOnError, version]);
  const current =
    result?.path === path && result.version === version ? result : undefined;
  return {
    value: current?.value,
    error: current?.error ?? "",
    refresh: () => refresh((v) => v + 1),
  };
}
