import { createHash, timingSafeEqual } from 'node:crypto';
import { AppError, isProvider, isUUID, operations } from '../../domain.ts';
import type { Store } from '../../infrastructure/postgres/store.ts';

export const ADMIN_SESSION_SECONDS = 8 * 60 * 60;

type IdentityRepository = Pick<Store,
  'createAdminSession' | 'hasAdminSession' | 'endAdminSession' | 'getKey' | 'listKeys' | 'createKey' | 'revokeKey'
>;

export function createIdentity(store: IdentityRepository, config: { adminUsername: string; adminPassword: string }) {
  const hash = (value: string) => createHash('sha256').update(value).digest();
  const usernameHash = hash(config.adminUsername);
  const passwordHash = hash(config.adminPassword);
  const scope = createHash('sha256').update(usernameHash).update(passwordHash).digest('hex');

  async function login(username: unknown, password: unknown, previous?: string) {
    if (
      typeof username !== 'string' || username.length > 128 ||
      typeof password !== 'string' || password.length > 1024
    ) {
      throw new AppError(400, 'invalid_credentials');
    }
    const validUsername = timingSafeEqual(hash(username), usernameHash);
    const validPassword = timingSafeEqual(hash(password), passwordHash);
    if (!validUsername || !validPassword) {
      throw new AppError(401, 'invalid_credentials', 'Invalid username or password');
    }
    return store.createAdminSession(scope, previous, ADMIN_SESSION_SECONDS);
  }

  async function authenticateKey(token: string) {
    const key = await store.getKey(token);
    if (!key) throw new AppError(401, 'invalid_api_key');
    return key;
  }

  function issueKey({ label, providers, scopes = operations, expires_at = null }: {
    label: unknown;
    providers: unknown;
    scopes?: unknown;
    expires_at?: unknown;
  }) {
    if (
      typeof label !== 'string' || !label.trim() || label.length > 100 ||
      !Array.isArray(providers) || !providers.length || !providers.every(isProvider)
    ) {
      throw new AppError(400, 'invalid_key');
    }
    if (
      !Array.isArray(scopes) || !scopes.length || !scopes.every((s) => operations.includes(s)) ||
      (expires_at !== null && (typeof expires_at !== 'string' || !(Date.parse(expires_at) > Date.now())))
    ) {
      throw new AppError(400, 'invalid_key_scope');
    }
    return store.createKey(label.trim(), [...new Set(providers)], [...new Set(scopes)], expires_at);
  }

  async function revokeKey(id: string) {
    if (!isUUID(id) || !(await store.revokeKey(id)).rowCount) throw new AppError(404, 'key_not_found');
  }

  return {
    login, authenticateKey, issueKey, revokeKey,
    hasSession: (session?: string) => store.hasAdminSession(scope, session),
    logout: (session: string) => store.endAdminSession(scope, session),
    listKeys: store.listKeys,
  };
}

export type Identity = ReturnType<typeof createIdentity>;
