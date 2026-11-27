import { randomUUID } from 'node:crypto';
import { AppError, isUUID } from '../../domain.ts';
import type { GatewayCrypto } from '../../infrastructure/crypto.ts';
import type { Files } from '../../infrastructure/files/storage.ts';
import type { Store } from '../../infrastructure/postgres/store.ts';

export function createMediaAssets(
  store: Pick<Store, 'addAsset' | 'findAsset'>,
  files: Pick<Files, 'read' | 'write'>,
  crypto: Pick<GatewayCrypto, 'signedMedia' | 'verifyMedia'>,
) {
  async function save(owner: string, model: string, mime: string, bytes: Buffer) {
    const id = randomUUID();
    await files.write(id, bytes);
    await store.addAsset({ id, owner, mime, bytes: bytes.length, model });
    return id;
  }

  async function open(id: string, owner: string | null) {
    if (!isUUID(id)) throw new AppError(404, 'media_not_found');
    const asset = await store.findAsset(id, owner);
    if (!asset) throw new AppError(404, 'media_not_found');
    return {
      mime: asset.mime,
      bytes: Number(asset.bytes),
      read: (range?: { start: number; end: number }) => files.read(asset.id, range),
    };
  }

  return { save, open, signedUrl: crypto.signedMedia, verifyUrl: crypto.verifyMedia };
}

export type MediaAssets = ReturnType<typeof createMediaAssets>;
