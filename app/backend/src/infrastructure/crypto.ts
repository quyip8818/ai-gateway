import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export function createCrypto(secret: string) {
  const encryptionKey = createHash('sha256').update('ai-gateway credential encryption\0').update(secret).digest();
  const digestKey = createHash('sha256').update('ai-gateway key digest\0').update(secret).digest();

  function seal(id: string, value: unknown) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
    cipher.setAAD(Buffer.from(id));
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]);
  }

  function unseal(id: string, value: Buffer) {
    const decoder = createDecipheriv('aes-256-gcm', encryptionKey, value.subarray(0, 12));
    decoder.setAAD(Buffer.from(id));
    decoder.setAuthTag(value.subarray(12, 28));
    return JSON.parse(Buffer.concat([decoder.update(value.subarray(28)), decoder.final()]).toString());
  }

  function digest(token: string) {
    return createHmac('sha256', digestKey).update(token).digest();
  }

  function signedMedia(id: string, origin: string) {
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const url = new URL('/v1/media/' + id, origin);
    url.searchParams.set('expires', String(expires));
    url.searchParams.set('signature', digest(`media:${id}:${expires}`).toString('base64url'));
    return url.href;
  }

  function verifyMedia(id: string, expires: unknown, signature: unknown) {
    if (
      typeof expires !== 'string' ||
      !/^\d{1,12}$/.test(expires) ||
      Number(expires) <= Date.now() / 1000 ||
      typeof signature !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(signature)
    )
      return false;
    const raw = Buffer.from(signature, 'base64url');
    const expected = digest(`media:${id}:${expires}`);
    return raw.length === expected.length && timingSafeEqual(raw, expected);
  }

  return { seal, unseal, digest, signedMedia, verifyMedia };
}

export type GatewayCrypto = ReturnType<typeof createCrypto>;
