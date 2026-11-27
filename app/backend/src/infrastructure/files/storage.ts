import { createReadStream } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function openFiles(directory: string) {
  const path = (id: string) => join(directory, id);
  return {
    initialize: () => mkdir(directory, { recursive: true }),
    async write(id: string, data: Buffer) {
      const target = path(id);
      const temporary = path('.' + randomUUID());
      try {
        await writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
        await rename(temporary, target);
      } finally {
        await unlink(temporary).catch(() => {});
      }
    },
    read: (id: string, range?: { start: number; end: number }) => createReadStream(path(id), range),
  };
}

export type Files = ReturnType<typeof openFiles>;
