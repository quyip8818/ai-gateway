export function readJimengSessionId(value: unknown) {
  const raw = typeof value === 'string' ? value.trim().replace(/^cookie\s*:\s*/i, '') : '';
  let token = raw;
  if (raw.includes('=')) {
    const cookies = new Map<string, string>();
    for (const part of raw.split(/[;\r\n]/)) {
      const index = part.indexOf('=');
      if (index < 0) continue;
      const name = part.slice(0, index).trim().toLowerCase();
      const entry = part.slice(index + 1).trim();
      if (entry) cookies.set(name, entry);
    }
    token = cookies.get('sessionid') ?? cookies.get('sessionid_ss') ?? cookies.get('sid_tt')
      ?? cookies.get('sid_guard')?.split(/%7c|\|/i, 1)[0] ?? '';
    // Reject encoded separators in pasted headers without rewriting the credential.
    if (/%(?:0[0-9a-f]|1[0-9a-f]|20|2c|3b|7f)/i.test(token)) return;
  }
  if (/^[\x21-\x7e]+$/.test(token) && !/[;,]/.test(token)) return token;
}
