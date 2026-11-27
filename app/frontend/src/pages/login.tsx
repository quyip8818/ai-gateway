import { Feedback, type Notice } from '../components/feedback.tsx';
import React from 'react';
import type { AdminApi, RunAction } from '../api/admin.ts';

export function LoginPage({ api, act, busy, checking, notice, onSignIn }: {
  api: AdminApi;
  act: RunAction;
  busy: boolean;
  checking: boolean;
  notice: Notice | null;
  onSignIn: () => void;
}) {
  return (
    <main className="login">
      <div className="brand">
        <span>AG</span> ai-gateway
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          void act(async () => {
            await api.json('session', 'POST', { username: form.get('username'), password: form.get('password') });
            onSignIn();
          });
        }}
      >
        <h1>网关控制台</h1>
        <label>
          用户名
          <input name="username" autoComplete="username" required maxLength={128} />
        </label>
        <label>
          密码
          <input name="password" type="password" autoComplete="current-password" required maxLength={1024} />
        </label>
        <Feedback notice={notice} />
        <button disabled={busy || checking}>登录</button>
      </form>
    </main>
  );
}
