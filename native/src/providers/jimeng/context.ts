import { AsyncLocalStorage } from 'node:async_hooks';

const requests = new AsyncLocalStorage<AbortSignal>();

export function withJimengRequest<T>(signal: AbortSignal, run: () => T): T {
  signal.throwIfAborted();
  return requests.run(signal, run);
}

export function jimengSignal(explicit?: AbortSignal) {
  const current = requests.getStore();
  return explicit && current ? AbortSignal.any([explicit,current]) : explicit ?? current;
}
