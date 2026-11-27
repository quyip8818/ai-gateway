import { createHash, timingSafeEqual } from 'node:crypto';
import type Router from '@koa/router';
import { ADMIN_SESSION_SECONDS, type Store } from '../db/store.ts';
import { AppError } from '../domain.ts';
import { jsonBody, objectBody } from './request.ts';

const cookieName = 'gateway_session';

export function registerAdminSession(
  router: Router,
  store: Store,
  config: { adminUsername: string; adminPassword: string; publicBaseUrl: string },
) {
  const hash = (value: string) => createHash('sha256').update(value).digest();
  const usernameHash = hash(config.adminUsername);
  const passwordHash = hash(config.adminPassword);
  const sessionScope = createHash('sha256').update(usernameHash).update(passwordHash).digest('hex');
  const publicOrigin = config.publicBaseUrl ? new URL(config.publicBaseUrl).origin : undefined;
  // Set Secure when the public endpoint uses TLS, including TLS terminated at a reverse proxy.
  function setSessionCookie(ctx, session: string, maxAge: number) {
    const secure = ctx.secure || publicOrigin?.startsWith('https:');
    ctx.append(
      'Set-Cookie',
      `${cookieName}=${session}; Path=/admin/v1; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`,
    );
  }

  router.use('/admin/v1', async (ctx, next) => {
    const origin = ctx.get('origin');
    if (!['GET', 'HEAD'].includes(ctx.method) && origin && origin !== (publicOrigin ?? ctx.origin)) {
      throw new AppError(403, 'invalid_origin');
    }
    await next();
  });
  router.post('/admin/v1/session', jsonBody, async (ctx) => {
    const { username, password } = objectBody(ctx);
    if (
      typeof username !== 'string' ||
      username.length > 128 ||
      typeof password !== 'string' ||
      password.length > 1024
    ) {
      throw new AppError(400, 'invalid_credentials');
    }
    const validUsername = timingSafeEqual(hash(username), usernameHash);
    const validPassword = timingSafeEqual(hash(password), passwordHash);
    if (!validUsername || !validPassword) {
      throw new AppError(401, 'invalid_credentials', 'Invalid username or password');
    }
    const previous = ctx.cookies.get(cookieName);
    const session = await store.createAdminSession(sessionScope, previous);
    setSessionCookie(ctx, session, ADMIN_SESSION_SECONDS);
    ctx.status = 204;
  });
  router.use('/admin/v1', async (ctx, next) => {
    const session = ctx.cookies.get(cookieName);
    if (!(await store.hasAdminSession(sessionScope, session))) throw new AppError(401, 'admin_required');
    ctx.state.adminSession = session;
    await next();
  });
  router.get('/admin/v1/session', (ctx) => {
    ctx.status = 204;
  });
  router.delete('/admin/v1/session', async (ctx) => {
    await store.endAdminSession(sessionScope, ctx.state.adminSession);
    setSessionCookie(ctx, '', 0);
    ctx.status = 204;
  });
}
