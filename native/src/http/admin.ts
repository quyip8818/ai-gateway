import type Router from '@koa/router';
import type { Store } from '../db/store.ts';
import { AppError, isUUID, operations } from '../domain.ts';
import type { Files } from '../media/files.ts';
import { publicVideo } from '../media/video.ts';
import { createOpenAIOAuthRequest, exchangeOpenAIOAuthCode } from '../providers/codex/runtime.ts';
import { registerAdminSession } from './admin-session.ts';
import { jsonBody, fetchAsset, objectBody } from './request.ts';

export function registerAdmin(
  router: Router,
  store: Store,
  files: Files,
  config: { adminUsername: string; adminPassword: string; publicBaseUrl: string },
  requestSignal: (ctx, timeout?: number) => AbortSignal,
) {
  registerAdminSession(router, store, config);
  router.get('/admin/v1/accounts', async (ctx) => {
    ctx.body = (
      await store.db.query(
        `SELECT id,pool_id,provider,kind,label,enabled,expires_at,concurrency,cooldown_until
      FROM provider_accounts ORDER BY created_at DESC`,
      )
    ).rows;
  });
  router.get('/admin/v1/pools', async (ctx) => {
    ctx.body = (
      await store.db.query(
        'SELECT id,provider,name FROM account_pools ORDER BY provider,name',
      )
    ).rows;
  });
  router.post('/admin/v1/accounts', jsonBody, async (ctx) => {
    const { provider, kind, credential, label, pool = 'Default', concurrency = 1 } = objectBody(ctx);
    if (
      typeof label !== 'string' ||
      !label.trim() ||
      label.length > 100 ||
      typeof pool !== 'string' ||
      !pool.trim() ||
      pool.length > 100 ||
      !Number.isInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > 100
    ) {
      throw new AppError(400, 'invalid_account');
    }
    ctx.body = await store.addAccount(
      provider,
      kind,
      label,
      credential,
      pool,
      concurrency,
      requestSignal(ctx, 45_000),
    );
    ctx.status = 201;
  });
  router.patch('/admin/v1/accounts/:id', jsonBody, async (ctx) => {
    const { enabled } = objectBody(ctx);
    if (!isUUID(ctx.params.id) || typeof enabled !== 'boolean') throw new AppError(400, 'invalid_account');
    const result = await store.db.query(
      'UPDATE provider_accounts SET enabled=$2 WHERE id=$1',
      [ctx.params.id, enabled],
    );
    if (!result.rowCount) throw new AppError(404, 'account_not_found');
    ctx.status = 204;
  });
  router.get('/admin/v1/keys', async (ctx) => {
    ctx.body = (
      await store.db.query(
        'SELECT id,label,prefix,created_at,revoked_at,scopes,expires_at FROM api_keys ORDER BY created_at DESC',
      )
    ).rows;
  });
  router.post('/admin/v1/keys', jsonBody, async (ctx) => {
    const { label, pools, scopes = operations, expires_at = null } = objectBody(ctx);
    if (
      typeof label !== 'string' ||
      !label.trim() ||
      label.length > 100 ||
      !Array.isArray(pools) ||
      !pools.length ||
      pools.length > 100 ||
      !pools.every((id) => typeof id === 'string' && isUUID(id))
    )
      throw new AppError(400, 'invalid_key');
    const result = await store.db.query(
      'SELECT count(*)::int AS count FROM account_pools WHERE id=ANY($1)',
      [pools],
    );
    if (result.rows[0].count !== new Set(pools).size) throw new AppError(400, 'invalid_pool');
    if (
      !Array.isArray(scopes) ||
      !scopes.length ||
      !scopes.every((s) => operations.includes(s)) ||
      (expires_at !== null && (typeof expires_at !== 'string' || !(Date.parse(expires_at) > Date.now())))
    ) {
      throw new AppError(400, 'invalid_key_scope');
    }
    ctx.body = await store.createKey(label, pools, [...new Set(scopes)], expires_at);
    ctx.status = 201;
  });
  router.delete('/admin/v1/keys/:id', async (ctx) => {
    if (!isUUID(ctx.params.id)) throw new AppError(404, 'key_not_found');
    const result = await store.db.query(
      'UPDATE api_keys SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1',
      [ctx.params.id],
    );
    if (!result.rowCount) throw new AppError(404, 'key_not_found');
    ctx.status = 204;
  });
  router.get('/admin/v1/requests', async (ctx) => {
    ctx.body = (
      await store.db.query(
        `SELECT id,model,operation,status,created_at,finished_at,usage
      FROM request_attempts ORDER BY created_at DESC LIMIT 100`,
      )
    ).rows;
  });
  router.get('/admin/v1/media', async (ctx) => {
    ctx.body = (
      await store.db.query(
        `SELECT id,video_id,mime,bytes,created_at FROM media_assets
      ORDER BY created_at DESC LIMIT 100`,
      )
    ).rows;
  });
  router.get('/admin/v1/videos', async (ctx) => {
    ctx.body = (
      await store.db.query(
        `SELECT * FROM video_jobs
      ORDER BY created_at DESC LIMIT 100`,
      )
    ).rows.map(publicVideo);
  });
  router.get('/admin/v1/models', async (ctx) => {
    ctx.body = (
      await store.db.query(
        `SELECT DISTINCT m.public_id AS id,m.operation,m.capabilities FROM account_models m
      JOIN provider_accounts a ON a.id=m.account_id WHERE a.enabled ORDER BY 1,2`,
      )
    ).rows;
  });

  const redirectUri = process.env.CODEX_REDIRECT_URI ?? 'http://localhost:1455/auth/callback';
  router.post('/admin/v1/codex/authorize', jsonBody, async (ctx) => {
    const { label } = objectBody(ctx);
    if (typeof label !== 'string' || !label.trim() || label.length > 100)
      throw new AppError(400, 'invalid_account');
    const flow = await createOpenAIOAuthRequest({ redirectUri });
    await store.db.query('DELETE FROM authorization_flows WHERE expires_at<=now()');
    await store.db.query(`INSERT INTO authorization_flows VALUES($1,$2,$3,now()+interval '10 minutes')`, [
      flow.state,
      label,
      store.seal(flow.state, flow.codeVerifier),
    ]);
    ctx.body = { url: flow.authorizationUrl, state: flow.state, redirect_uri: redirectUri };
  });
  router.post('/admin/v1/codex/complete', jsonBody, async (ctx) => {
    const { callback } = objectBody(ctx);
    let url: URL;
    try {
      url = new URL(callback);
    } catch {
      throw new AppError(400, 'invalid_oauth_callback');
    }
    const expected = new URL(redirectUri);
    const code = url.searchParams.get('code'),
      state = url.searchParams.get('state');
    if (!code || !state || url.origin !== expected.origin || url.pathname !== expected.pathname)
      throw new AppError(400, 'invalid_oauth_callback');
    const {
      rows: [flow],
    } = await store.db.query(
      `DELETE FROM authorization_flows
      WHERE state=$1 AND expires_at>now() RETURNING *`,
      [state],
    );
    if (!flow) throw new AppError(400, 'oauth_flow_expired');
    const signal = requestSignal(ctx, 60_000);
    const token = await exchangeOpenAIOAuthCode({
      code,
      codeVerifier: store.unseal(state, flow.verifier),
      redirectUri,
      signal,
    });
    ctx.body = await store.addAccount(
      'codex',
      'oauth',
      flow.label,
      {
        ...token,
        expiresAt: new Date(Date.now() + (token.expiresIn ?? 3600) * 1000).toISOString(),
      },
      'Default',
      1,
      signal,
    );
    ctx.status = 201;
  });

  router.get('/admin/v1/media/:id', async (ctx) =>
    fetchAsset(store, files, ctx, null),
  );
}
