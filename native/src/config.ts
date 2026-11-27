export function readConfig(env: NodeJS.ProcessEnv) {
  const {
    DATABASE_URL: databaseUrl = '',
    GATEWAY_SECRET: gatewaySecret = '',
    ADMIN_TOKEN: adminToken = '',
    HOST: host = '127.0.0.1',
    PORT: portText = '41873',
    MEDIA_DIRECTORY: mediaDirectory = './data/native-media',
    PUBLIC_BASE_URL: publicBaseUrl = '',
  } = env;
  const port = Number(portText);
  const invalid = [
    !databaseUrl.trim() && 'DATABASE_URL',
    gatewaySecret.length < 32 && 'GATEWAY_SECRET (at least 32 characters)',
    adminToken.length < 24 && 'ADMIN_TOKEN (at least 24 characters)',
    !host.trim() && 'HOST',
    (!/^\d+$/.test(portText) || port < 1 || port > 65535) && 'PORT (1–65535)',
  ].filter(Boolean);
  if (invalid.length) {
    throw new Error(`Missing or invalid gateway configuration: ${invalid.join(', ')}. See .env.example.`);
  }
  if (publicBaseUrl) {
    const url = URL.parse(publicBaseUrl);
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('PUBLIC_BASE_URL must be an HTTP(S) URL without credentials. See .env.example.');
    }
  }

  const browserHost = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  const urlHost = browserHost.includes(':') ? `[${browserHost}]` : browserHost;
  const frontendUrl = publicBaseUrl || `http://${urlHost}:${port}/`;
  return { databaseUrl, gatewaySecret, adminToken, host, port, mediaDirectory, publicBaseUrl, frontendUrl };
}
