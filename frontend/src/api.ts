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
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    signal,
    method: method ?? (payload === undefined ? "GET" : "POST"),
    headers: {
      "X-Gateway-CSRF": "1",
      ...(payload !== undefined && !(payload instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
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
export function useResource<T>(path: string, every = 0) {
  const [value, setValue] = useState<T>();
  const [error, setError] = useState("");
  const [version, refresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    setValue(undefined);
    setError("");
    async function read() {
      try {
        const next = await api<T>(
          path,
          undefined,
          undefined,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setValue(next);
        setError("");
      } catch (error) {
        if (!controller.signal.aborted) setError((error as Error).message);
      } finally {
        if (every && !controller.signal.aborted)
          timer = window.setTimeout(read, every);
      }
    }
    void read();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [path, every, version]);
  return { value, error, refresh: () => refresh((v) => v + 1) };
}
