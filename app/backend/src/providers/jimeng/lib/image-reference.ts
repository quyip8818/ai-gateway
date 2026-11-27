import { lookup } from 'node:dns';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import axios from 'axios';

export const MAX_IMAGE_REFERENCE_BYTES = 50 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

export function imageReferenceMimeType(bytes: Buffer) {
    if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return 'image/png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
}
const BLOCKED = new BlockList();
for (const [address, bits] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
    ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
    ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) BLOCKED.addSubnet(address, bits);
for (const [address, bits] of [
    ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
] as const) BLOCKED.addSubnet(address, bits, 'ipv6');
const GLOBAL_IPV6 = new BlockList();
GLOBAL_IPV6.addSubnet('2000::', 3, 'ipv6');

function isPublicAddress(address: string) {
    const family = isIP(address);
    return family === 4 ? !BLOCKED.check(address)
        : family === 6 && GLOBAL_IPV6.check(address, 'ipv6') && !BLOCKED.check(address, 'ipv6');
}

const publicLookup: LookupFunction = (hostname, options, callback) => {
    // Check the addresses the socket will use, so a second lookup cannot change the target.
    lookup(hostname, { ...options, all: true }, (error, addresses) => {
        if (error) return callback(error, '', 0);
        const allowed = addresses.filter(({ address }) => isPublicAddress(address));
        if (!allowed.length) return callback(new Error('image_url requires a public address'), '', 0);
        if (options.all) return callback(null, allowed);
        callback(null, allowed[0].address, allowed[0].family);
    });
};
const httpAgent = new HttpAgent({ lookup: publicLookup });
const httpsAgent = new HttpsAgent({ lookup: publicLookup });

export async function loadImageReference(value: string) {
    if (value.startsWith('data:')) {
        const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
        if (!match || match[2].length % 4 === 1 || (match[2].endsWith('=') && match[2].length % 4 !== 0)
            || Buffer.byteLength(match[2], 'base64') > MAX_IMAGE_REFERENCE_BYTES
            || imageReferenceMimeType(Buffer.from(match[2].slice(0, 16), 'base64')) !== match[1]) {
            throw new Error('image_url must contain a valid PNG, JPEG or WebP data URL');
        }
        return value;
    }

    let url = new URL(value);
    const signal = AbortSignal.timeout(20000);
    for (let hop = 0; hop <= 3; hop++) {
        const host = url.hostname.replace(/^\[|\]$/g, '');
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
            || (isIP(host) && !isPublicAddress(host))) {
            throw new Error('image_url must refer to a public HTTP(S) image');
        }
        const response = await axios.get<Buffer>(url.href, {
            httpAgent, httpsAgent, signal, proxy: false, maxRedirects: 0,
            responseType: 'arraybuffer', maxContentLength: MAX_IMAGE_REFERENCE_BYTES,
            validateStatus: status => status === 200 || [301, 302, 303, 307, 308].includes(status),
        });
        if (response.status !== 200) {
            const location = response.headers.location;
            if (typeof location !== 'string' || !location) throw new Error('image_url redirect has no location');
            url = new URL(location, url);
            continue;
        }
        const contentType = imageReferenceMimeType(response.data);
        if (!contentType) {
            throw new Error('image_url must return a PNG, JPEG or WebP image');
        }
        return 'data:' + contentType + ';base64,' + response.data.toString('base64');
    }
    throw new Error('image_url redirects too many times');
}

export async function downloadPublicMedia(value: string, maxBytes: number, signal: AbortSignal) {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
        || (isIP(host) && !isPublicAddress(host))) throw new Error('Invalid media URL');
    const res = await axios.get<Buffer>(url.href, {
        httpsAgent, signal, proxy: false, maxRedirects: 0,
        responseType: 'arraybuffer', maxContentLength: maxBytes,
    });
    return res.data;
}
