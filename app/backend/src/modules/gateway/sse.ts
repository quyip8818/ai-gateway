import { Readable, Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

export function monitorSSE(body: ReadableStream<Uint8Array>, source: 'estimated' | 'reported') {
  let buffer = '';
  const decoder = new StringDecoder('utf8');
  let status = 'interrupted';
  let usage = {};
  const monitor = new Transform({
    transform(chunk, _encoding, done) {
      buffer += decoder.write(chunk);
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line.startsWith('data:')) continue;
        try {
          const e = JSON.parse(line.slice(5));
          const measured = e.response?.usage ?? e.message?.usage ?? e.usage;
          if (measured)
            usage = {
              ...usage,
              ...measured,
              source,
            };
          if (['message_stop', 'response.completed'].includes(e.type) && status !== 'failed')
            status = 'succeeded';
          if (['response.failed', 'response.incomplete', 'error'].includes(e.type)) status = 'failed';
        } catch {}
      }
      if (buffer.length > 2 * 1024 * 1024) buffer = '';
      done(null, chunk);
    },
  });
  const upstream = Readable.fromWeb(body);
  upstream.on('error', (error) => monitor.destroy(error));
  monitor.once('close', () => upstream.destroy());
  upstream.pipe(monitor);
  return { stream: monitor, outcome: () => ({ status, usage }) };
}
