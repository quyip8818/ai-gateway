export type CredentialTokens = { token?: unknown; accessToken?: unknown; refreshToken?: unknown };
export type CredentialInput = Record<string, unknown>;

export function normalizeApiKey(c: CredentialInput) {
  const token = String(c.token ?? c.apiKey ?? '').trim();
  if (!token || /\s/.test(token)) throw new Error('An API key is required');
  return { token };
}

export function normalizeOAuth(
  c: CredentialInput,
  kind: string,
  deriveId?: (token: string) => string | undefined,
) {
  const accessToken = c.accessToken ?? c.access_token;
  const refreshToken = c.refreshToken ?? c.refresh_token;
  const idToken = c.idToken ?? c.id_token;
  const accountId =
    c.accountId ??
    c.account_id ??
    (accessToken ? deriveId?.(String(accessToken)) : undefined);
  const region = c.region ?? 'us-east-1';
  const apiRegion = c.apiRegion ?? c.api_region ?? 'us-east-1';
  if (
    [
      accessToken,
      refreshToken,
      idToken,
      c.accountId,
      c.account_id,
      c.clientId,
      c.clientSecret,
      c.profileArn,
      c.profile_arn,
    ].some((value) => value != null && (typeof value !== 'string' || value.length > 16384))
  ) {
    throw new Error('Invalid credential field');
  }
  if (!accessToken && !refreshToken) throw new Error('An access or refresh token is required');
  if (
    ![region, apiRegion].every((value) => typeof value === 'string' && /^[a-z]{2}(?:-[a-z]+)+-\d$/.test(value))
  ) {
    throw new Error('Invalid AWS region');
  }
  if (kind === 'oidc' && (!c.clientId || !c.clientSecret)) throw new Error('OIDC requires its registered client');
  const expiresAt = c.expiresAt ?? c.expires_at;
  if (expiresAt != null && (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)))) {
    throw new Error('Invalid credential expiration');
  }
  return {
    accessToken,
    refreshToken,
    idToken,
    accountId,
    region,
    apiRegion,
    expiresAt,
    clientId: c.clientId,
    clientSecret: c.clientSecret,
    profileArn: c.profileArn ?? c.profile_arn,
  };
}
