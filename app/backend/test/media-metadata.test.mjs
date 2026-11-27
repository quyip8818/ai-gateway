import assert from 'node:assert/strict';
import test from 'node:test';
import { imageDimensions, imageMime } from '../src/modules/media/image-content.ts';
import { inspectVideoHistory } from '../src/providers/jimeng/api/controllers/video-history.ts';

function webp(chunk, data) {
  const bytes = Buffer.alloc(20 + data.length + (data.length & 1));
  bytes.write('RIFF');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WEBP' + chunk, 8);
  bytes.writeUInt32LE(data.length, 16);
  data.copy(bytes, 20);
  return bytes;
}

test('reads JPEG and WebP dimensions without decoding pixels', () => {
  const jpeg = Buffer.from('ffd8ffe000040000ffc2000b080018002001011100', 'hex');
  const lossless = Buffer.alloc(5);
  lossless[0] = 0x2f;
  lossless.writeUInt32LE((23 << 14) | 31, 1);
  for (const bytes of [
    jpeg,
    webp('VP8 ', Buffer.from('0000009d012a20001800', 'hex')),
    webp('VP8L', lossless),
    webp('VP8X', Buffer.from('000000001f0000170000', 'hex')),
  ]) {
    const mime = imageMime(bytes);
    assert.deepEqual(imageDimensions(bytes, mime), { width: 32, height: 24 });
    assert.equal(imageDimensions(bytes.subarray(0, 17), mime), undefined);
  }
});

test('does not attach the original rendition dimensions to a fallback video URL', () => {
  const url = 'https://cdn.fixture.test/video';
  const { result } = inspectVideoHistory({
    task: {
      status: 50,
      item_list: [{
        video: {
          transcoded_video: { origin: { video_url: 'https://cdn.fixture.test/cover.png', width: 1920, height: 1080 } },
          play_url: url,
          width: 720,
          height: 1280,
          duration_ms: '5016.667',
        },
      }],
    },
  }, 'task');
  assert.deepEqual(result, { state: 'ready', url, output: { width: 720, height: 1280, duration_ms: 5016.667 } });
});
