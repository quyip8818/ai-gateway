import { createHash } from 'node:crypto';
import { v1 } from 'uuid';
import CRC32 from 'crc-32';
import randomstring from 'randomstring';

export default {
  uuid(separator = true) {
    const id = v1();
    return separator ? id : id.replaceAll('-', '');
  },
  unixTimestamp: () => Math.floor(Date.now() / 1000),
  md5: (value: string) => createHash('md5').update(value).digest('hex'),
  crc32: (value: Buffer) => CRC32.buf(value),
  generateRandomString: randomstring.generate,
};
