import assert from 'node:assert/strict';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import axios from 'axios';
import { downloadGeneratedImage, downloadPublicMedia, loadImageReference } from '../src/providers/jimeng/lib/image-reference.ts';

test('accepts a proxy Fake-IP for generated images on the Jimeng CDN', async (t) => {
  const cdn = 'p26-dreamina-sign.byteimg.com';
  const privateCdn = 'p9-dreamina-sign.byteimg.com';
  const other = cdn + '.example.test';
  const fakeIp = '198.18.18.211';
  const addresses = new Map([[cdn, fakeIp], [privateCdn, '192.168.1.20'], [other, fakeIp]]);
  const lookup = t.mock.method(dns, 'lookup', (hostname, options, callback) => {
    assert.equal(options.all, true);
    callback(null, [{ address: addresses.get(hostname), family: 4 }]);
  });
  syncBuiltinESMExports();

  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const originalAdapter = axios.defaults.adapter;
  t.after(() => {
    lookup.mock.restore();
    syncBuiltinESMExports();
    axios.defaults.adapter = originalAdapter;
  });
  axios.defaults.adapter = async (config) => {
    const hostname = new URL(config.url).hostname;
    const resolved = await new Promise((resolve, reject) => {
      config.httpsAgent.options.lookup(hostname, { all: true }, (error, result) => {
        if (error) reject(error);
        else resolve(result);
      });
    });
    assert.deepEqual(resolved, [{ address: fakeIp, family: 4 }]);
    return { data: png, status: 200, headers: {}, config };
  };

  const url = (hostname) => 'https://' + hostname + '/image.png';
  const download = (hostname) => downloadGeneratedImage(url(hostname), 1024, AbortSignal.timeout(1000));
  assert.deepEqual(await download(cdn), png);
  for (const request of [
    () => download(privateCdn),
    () => download(other),
    () => downloadPublicMedia(url(cdn), 1024, AbortSignal.timeout(1000)),
    () => loadImageReference(url(cdn)),
  ]) {
    await assert.rejects(request, /image_url requires a public address/);
  }
});
