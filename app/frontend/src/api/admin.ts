import { errorMessages } from '../labels.ts';

export function createAdminApi(onUnauthorized: () => void) {
  async function request(path: string, options?: RequestInit) {
    const response = await fetch('/admin/v1/' + path, options);
    options?.signal?.throwIfAborted();
    if (response.status === 401) onUnauthorized();
    return response;
  }

  async function json<T = unknown>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await request(path, {
      method,
      signal,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const value = await response.json().catch(() => null);
      signal?.throwIfAborted();
      throw new Error(errorMessages[value?.error?.code] ?? `请求失败（HTTP ${response.status}）`);
    }
    return response.status === 204 ? null as T : await response.json();
  }

  async function download(id: string) {
    const response = await request('media/' + id);
    if (!response.ok) throw new Error('下载失败');
    return response.blob();
  }

  return { json, download };
}

export type AdminApi = ReturnType<typeof createAdminApi>;
export type RunAction = (run: () => Promise<unknown>, success?: string) => Promise<void>;
export type Row = { id: string } & Record<string, unknown>;
