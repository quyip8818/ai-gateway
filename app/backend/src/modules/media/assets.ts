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
  async function saveImage(owner: string, mime: string, bytes: Buffer) {
    const id = randomUUID();
    await files.write(id, bytes);
    await store.addAsset(id, owner, mime, bytes.length);
    return id;
  }

  async function open(id: string, owner: string | null) {
    if (!isUUID(id)) throw new AppError(404, 'media_not_found');
    const asset = await store.findAsset(id, owner);
    if (!asset) throw new AppError(404, 'media_not_found');
    return { mime: asset.mime, bytes: Number(asset.bytes), stream: files.read(asset.id) };
  }

  return { saveImage, open, read: files.read, signedUrl: crypto.signedMedia, verifyUrl: crypto.verifyMedia };
}

export type MediaAssets = ReturnType<typeof createMediaAssets>;
