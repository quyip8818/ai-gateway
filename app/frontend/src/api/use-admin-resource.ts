import { useEffect, useState } from 'react';
import type { AdminApi } from './admin.ts';

export function useAdminResource<T>(api: AdminApi, path: string, revision: number) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ path: string; revision: number; attempt: number; data?: T; error?: string }>();
  useEffect(() => {
    const load = new AbortController();
    void api.json<T>(path, 'GET', undefined, load.signal)
      .then((data) => {
        if (!load.signal.aborted) setResult({ path, revision, attempt, data });
      })
      .catch((error: unknown) => {
        if (!load.signal.aborted) {
          setResult((previous) => ({
            path,
            revision,
            attempt,
            data: previous?.path === path ? previous.data : undefined,
            error: error instanceof Error ? error.message : '请求失败',
          }));
        }
      });
    return () => load.abort();
  }, [api, path, revision, attempt]);
  const current = result?.path === path ? result : undefined;
  const refreshing = !current || current.revision !== revision || current.attempt !== attempt;
  return {
    data: current?.data,
    error: refreshing ? undefined : current?.error,
    loading: refreshing && current?.data === undefined,
    refreshing,
    retry: () => setAttempt((value) => value + 1),
  };
}
