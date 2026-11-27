import { AsyncLocalStorage } from 'node:async_hooks';
import type { BrowserTransportMode } from '../../../../../shared/contracts/jimeng-settings.ts';

const requests = new AsyncLocalStorage<{ signal: AbortSignal; mode?: BrowserTransportMode }>();

export function withJimengRequest<T>(signal: AbortSignal, run: () => T, mode = jimengTransportMode()): T {
  signal.throwIfAborted();
  return requests.run({ signal, mode }, run);
}

export function jimengTransportMode() {
  return requests.getStore()?.mode;
}

export function jimengSignal(explicit?: AbortSignal) {
  const current = requests.getStore()?.signal;
  return explicit && current ? AbortSignal.any([explicit, current]) : explicit ?? current;
}
