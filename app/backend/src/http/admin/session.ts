import type Router from '@koa/router';
import { ADMIN_SESSION_SECONDS, type Identity } from '../../modules/identity/service.ts';
import { AppError } from '../../domain.ts';
import { jsonBody, objectBody } from '../middleware/request.ts';

const cookieName = 'gateway_session';

export function registerAdminSession(
  router: Router,
  identity: Identity,
  publicBaseUrl: string,
) {
  const publicOrigin = publicBaseUrl ? new URL(publicBaseUrl).origin : undefined;
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
    const session = await identity.login(username, password, ctx.cookies.get(cookieName));
    setSessionCookie(ctx, session, ADMIN_SESSION_SECONDS);
    ctx.status = 204;
  });
  router.use('/admin/v1', async (ctx, next) => {
    const session = ctx.cookies.get(cookieName);
    if (!(await identity.hasSession(session))) throw new AppError(401, 'admin_required');
    ctx.state.adminSession = session;
    await next();
  });
  router.get('/admin/v1/session', (ctx) => {
    ctx.status = 204;
  });
  router.delete('/admin/v1/session', async (ctx) => {
    await identity.logout(ctx.state.adminSession);
    setSessionCookie(ctx, '', 0);
    ctx.status = 204;
  });
}
