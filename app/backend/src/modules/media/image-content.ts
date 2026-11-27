export const MAX_IMAGE_REFERENCE_BYTES = 50 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

export function imageMime(bytes: Buffer) {
  if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
}

type ImageDimensions = { width: number; height: number };

function jpegDimensions(bytes: Buffer): ImageDimensions | undefined {
  let offset = 2;
  while (offset < bytes.length && bytes[offset++] === 0xff) {
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9 || offset + 2 > bytes.length) return;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return;
    const frame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (frame) {
      if (length < 8) return;
      return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
}

function webpDimensions(bytes: Buffer): ImageDimensions | undefined {
  const end = Math.min(bytes.length, bytes.readUInt32LE(4) + 8);
  for (let offset = 12; offset + 8 <= end;) {
    const chunk = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const data = offset + 8;
    if (data + length > end) return;
    if (chunk === 'VP8X' && length >= 10) {
      return { width: bytes.readUIntLE(data + 4, 3) + 1, height: bytes.readUIntLE(data + 7, 3) + 1 };
    }
    if (chunk === 'VP8L' && length >= 5 && bytes[data] === 0x2f) {
      const dimensions = bytes.readUInt32LE(data + 1);
      return { width: (dimensions & 0x3fff) + 1, height: ((dimensions >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8 ' && length >= 10 && !(bytes[data] & 1)
      && bytes.readUIntBE(data + 3, 3) === 0x9d012a) {
      return { width: bytes.readUInt16LE(data + 6) & 0x3fff, height: bytes.readUInt16LE(data + 8) & 0x3fff };
    }
    offset = data + length + (length & 1);
  }
}

export function imageDimensions(bytes: Buffer, mime: NonNullable<ReturnType<typeof imageMime>>) {
  let dimensions: ImageDimensions | undefined;
  if (mime === 'image/png' && bytes.length >= 33 && bytes.readUInt32BE(8) === 13
    && bytes.toString('ascii', 12, 16) === 'IHDR') {
    dimensions = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  } else if (mime === 'image/jpeg') dimensions = jpegDimensions(bytes);
  else if (mime === 'image/webp' && bytes.length >= 12) dimensions = webpDimensions(bytes);
  return dimensions && dimensions.width > 0 && dimensions.height > 0 ? dimensions : undefined;
}
