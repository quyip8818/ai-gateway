import { readFileSync } from 'node:fs';

const ids = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const randomFields = new Set(['seed', 'created_time_in_ms', 'webId', 'generate_id']);

function normalize(value, key) {
  if (randomFields.has(key)) return '<generated>';
  if (Array.isArray(value)) return value.map((item) => normalize(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, normalize(item, name)]));
  }
  if (typeof value !== 'string') return value;
  if (ids.test(value)) return '<uuid>';
  if (/^\s*[[{]/.test(value)) {
    try {
      return normalize(JSON.parse(value));
    } catch {}
  }
  return value;
}

export function jimengSubmission(config) {
  return normalize({
    method: config.method,
    path: new URL(config.url).pathname,
    params: JSON.parse(JSON.stringify(config.params)),
    body: JSON.parse(config.data),
  });
}

export function expectedJimengSubmissions() {
  return JSON.parse(readFileSync(new URL('./fixtures/jimeng-submissions.json', import.meta.url), 'utf8'));
}
