import React, { useState, type FormEvent } from 'react';
import { credentialKinds, type Provider } from './domain.ts';
import { labels } from './console-labels.ts';

const credentialLabel: Record<string, string> = {
  cookie: '账号 Cookie',
  oauth: 'Codex 授权 JSON',
  desktop: 'Kiro 授权 JSON',
  oidc: 'Kiro OIDC 授权 JSON',
  'api-key': 'API Key',
};

const methodLabels: Record<string, string> = {
  browser: '浏览器授权',
  oauth: '导入 auth.json',
};

async function readCredential(fields: FormData, useJSON: boolean): Promise<unknown> {
  let input = String(fields.get('credential') ?? '').trim();
  if (!useJSON) return input;
  const file = fields.get('credential_file');
  if (!input && file instanceof File && file.name) {
    if (file.size > 1024 * 1024) throw new Error('授权文件不能超过 1 MiB');
    input = await file.text();
  }
  if (!input.trim()) throw new Error('请粘贴授权 JSON 或选择文件');
  try {
    return JSON.parse(input);
  } catch {
    throw new Error('账号凭证的 JSON 格式有误');
  }
}

export function AddAccount({
  provider,
  busy,
  api,
  act,
}: {
  provider: Provider;
  busy: boolean;
  api: <T = unknown>(path: string, method: string, body: unknown) => Promise<T>;
  act: (run: () => Promise<unknown>, success?: string) => Promise<void>;
}) {
  const [method, setMethod] = useState<string>(credentialKinds[provider][0]);
  const [authURL, setAuthURL] = useState('');
  const methods: readonly string[] =
    provider === 'codex' ? [...credentialKinds.codex, 'browser'] : credentialKinds[provider];
  const browser = method === 'browser';
  const startingOAuth = browser && !authURL;
  const useJSON = !browser && method !== 'cookie' && method !== 'api-key';

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    void act(async () => {
      const label = fields.get('label');
      if (startingOAuth) {
        const flow = await api<{ url: string }>('codex/authorize', 'POST', { label });
        setAuthURL(flow.url);
        return;
      }
      if (browser) {
        await api('codex/complete', 'POST', { callback: fields.get('callback') });
        setAuthURL('');
      } else {
        const credential = await readCredential(fields, useJSON);
        await api('accounts', 'POST', { provider, kind: method, credential, label });
      }
      form.reset();
    }, startingOAuth ? undefined : '账号已添加');
  }

  return (
    <section className="account-form">
      <h2>{provider === 'jimeng' ? '添加即梦账号' : `添加 ${labels[provider]} 账号`}</h2>
      <form onSubmit={submit}>
        {methods.length > 1 && (
          <label>
            授权方式
            <select
              value={method}
              disabled={busy}
              onChange={(event) => {
                setMethod(event.target.value);
                setAuthURL('');
              }}
            >
              {methods.map((kind) => (
                <option key={kind} value={kind}>{methodLabels[kind] ?? labels[kind]}</option>
              ))}
            </select>
          </label>
        )}
        {browser ? (
          authURL && (
            <>
              <div className="actions">
                <a href={authURL} target="_blank" rel="noreferrer">打开 Codex 授权页面</a>
                <button className="quiet" type="button" disabled={busy} onClick={() => setAuthURL('')}>
                  重新发起
                </button>
              </div>
              <label>
                授权后的回调地址
                <input name="callback" required disabled={busy} />
              </label>
            </>
          )
        ) : useJSON ? (
          <div className="credential-json" key={method}>
            <label>
              {credentialLabel[method]}
              <textarea name="credential" autoComplete="off" spellCheck={false} placeholder="粘贴 JSON" disabled={busy} />
            </label>
            <label className="credential-file">
              或上传 JSON 文件
              <input name="credential_file" type="file" accept=".json,application/json" disabled={busy} />
            </label>
          </div>
        ) : (
          <label key={method}>
            {credentialLabel[method]}
            <input
              name="credential"
              type="password"
              placeholder={method === 'cookie' ? 'sessionid=…' : undefined}
              required
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
            />
          </label>
        )}
        {!(browser && authURL) && (
          <details>
            <summary>自定义名称（可选）</summary>
            <label>
              账号名称
              <input name="label" maxLength={100} disabled={busy} />
            </label>
          </details>
        )}
        <button disabled={busy}>
          {busy ? '处理中…' : startingOAuth ? '创建授权链接' : browser ? '完成授权' : '验证并添加'}
        </button>
      </form>
    </section>
  );
}
