import { setTimeout as delay } from 'node:timers/promises';
import type { Store } from '../../infrastructure/postgres/store.ts';
import type { createVideoService } from './video.ts';

export function createVideoWorker(
  store: Pick<Store, 'claimVideo' | 'renewVideoLease'>,
  { process }: Pick<ReturnType<typeof createVideoService>, 'process'>,
) {
  async function run(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        const job = await store.claimVideo();
        if (job) {
          const lease = new AbortController();
          const refresh = setInterval(() => {
            void store.renewVideoLease(job.id, job.lease_version)
              .then(
                (result) => {
                  if (!result.rowCount) lease.abort();
                },
                () => lease.abort(),
              );
          }, 25_000);
          try {
            const jobSignal = AbortSignal.any([signal, lease.signal, AbortSignal.timeout(10 * 60_000)]);
            await process(job, jobSignal);
          } finally {
            clearInterval(refresh);
          }
        } else await delay(750, undefined, { signal });
      } catch {
        await delay(1500, undefined, { signal }).catch(() => {});
      }
    }
  }

  return run;
}
