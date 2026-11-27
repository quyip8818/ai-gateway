import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { providers, type Provider } from './domain.ts';
import { AddAccount } from './console-accounts.tsx';

import { navigation, labels, cellText, columns, errorMessages } from './console-labels.ts';

type Row = Record<string, any>;

function Console() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [page, setPage] = useState<keyof typeof navigation>('Accounts');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState<Provider>('jimeng');
  const [rows, setRows] = useState<Record<string, Row[]>>({});
  const [key, setKey] = useState('');
  const [revision, setRevision] = useState(0);

  async function api<T = unknown>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch('/admin/v1/' + path, {
      method,
      signal,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    signal?.throwIfAborted();
    if (response.status === 401) {
      setSignedIn(false);
      setRows({});
      setKey('');
    }
    const value = response.status === 204 ? null : await response.json();
    if (!response.ok) {
      throw new Error(errorMessages[value?.error?.code] ?? `请求失败（HTTP ${response.status}）`);
    }
    return value;
  }
  useEffect(() => {
    const check = new AbortController();
    void fetch('/admin/v1/session', { signal: check.signal })
      .then((response) => {
        if (!check.signal.aborted) setSignedIn(response.ok);
      })
      .catch(() => {
        if (!check.signal.aborted) setSignedIn(false);
      });
    return () => check.abort();
  }, []);

  const endpoint = page === 'Accounts' ? 'accounts?provider=' + provider : page.toLowerCase();

  useEffect(() => {
    if (!signedIn) return;
    const load = new AbortController();
    const endpoints = page === 'Media' ? [endpoint, 'videos'] : [endpoint];
    Promise.all(endpoints.map(async (path) => [path, await api<Row[]>(path, 'GET', undefined, load.signal)] as const))
      .then((result) => {
        if (!load.signal.aborted) setRows((previous) => ({ ...previous, ...Object.fromEntries(result) }));
      })
      .catch((error) => {
        if (!load.signal.aborted) setNotice(error.message);
      });
    return () => {
      load.abort();
    };
  }, [signedIn, revision, endpoint, page]);

  async function act(run: () => Promise<unknown>, success?: string) {
    setBusy(true);
    setNotice('');
    try {
      await run();
      setRevision((v) => v + 1);
      if (success) setNotice(success);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '请求失败');
    } finally {
      setBusy(false);
    }
  }
  const tabRows = rows[endpoint] ?? [];
  if (!signedIn)
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
              await api('session', 'POST', { username: form.get('username'), password: form.get('password') });
              setSignedIn(true);
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
          {notice && (
            <p className="feedback" role="status">
              {notice}
            </p>
          )}
          <button disabled={busy || signedIn === null}>登录</button>
        </form>
      </main>
    );

  return (
    <div className="layout">
      <aside>
        <div className="brand">
          <span>AG</span> ai-gateway
        </div>
        <nav>
          {(Object.entries(navigation) as [keyof typeof navigation, string][]).map(([item, title]) => (
            <button
              className={page === item ? 'selected' : ''}
              key={item}
              disabled={busy}
              onClick={() => {
                setPage(item);
                setNotice('');
              }}
            >
              {title}
            </button>
          ))}
        </nav>
        <button
          className="quiet"
          disabled={busy}
          onClick={() => {
            void act(async () => {
              await api('session', 'DELETE');
              setSignedIn(false);
              setRows({});
              setKey('');
            });
          }}
        >
          退出登录
        </button>
      </aside>
      <main>
        <header>
          <h1>{navigation[page]}</h1>
          <div className="actions">
            <button className="quiet" onClick={() => setRevision((v) => v + 1)}>
              刷新
            </button>
          </div>
        </header>
        {notice && (
          <p className="feedback" role="status">
            {notice}
          </p>
        )}
        {page === 'Accounts' && (
          <>
            <div className="products" role="group" aria-label="按产品管理账号">
              {providers.map((item) => (
                <button
                  type="button"
                  key={item}
                  disabled={busy}
                  aria-pressed={provider === item}
                  onClick={() => {
                    setProvider(item);
                    setNotice('');
                  }}
                >
                  {labels[item]}
                </button>
              ))}
            </div>
            <AddAccount key={provider} provider={provider} busy={busy} api={api} act={act} />
          </>
        )}
        {page === 'Keys' && (
          <section>
            <h2>签发密钥</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const form = e.currentTarget;
                const data = new FormData(form);
                void act(async () => {
                  const result = await api<{ token: string }>('keys', 'POST', {
                    label: data.get('label'),
                    providers: data.getAll('provider'),
                  });
                  setKey(result.token);
                  form.reset();
                }, '密钥已签发');
              }}
            >
              <label>
                密钥名称
                <input name="label" required maxLength={100} />
              </label>
              <fieldset>
                <legend>可调用的产品</legend>
                <div className="product-checks">
                  {providers.map((item) => (
                    <label className="check" key={item}>
                      <input type="checkbox" name="provider" value={item} disabled={busy} />
                      {labels[item]}
                    </label>
                  ))}
                </div>
              </fieldset>
              <button disabled={busy}>签发密钥</button>
            </form>
            {key && (
              <div className="reveal">
                <code>{key}</code>
                <button
                  className="quiet"
                  onClick={() =>
                    void navigator.clipboard.writeText(key).catch(() => setNotice('请手动复制密钥'))
                  }
                >
                  复制
                </button>
                <button className="quiet" onClick={() => setKey('')}>
                  关闭
                </button>
              </div>
            )}
          </section>
        )}
        {page === 'Media' && (
          <section>
            <h2>视频任务</h2>
            <div className="table">
              <table>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>模型</th>
                    <th>状态</th>
                    <th>进度</th>
                  </tr>
                </thead>
                <tbody>
                  {(rows.videos ?? []).map((v) => (
                    <tr key={v.id}>
                      <td>{v.id}</td>
                      <td>{v.model}</td>
                      <td>{cellText('status', v.status)}</td>
                      <td>{v.progress}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
        <section>
          <div className="table">
            <table>
              <thead>
                <tr>
                  {columns[page].map(([field, title]) => (
                    <th key={field}>{title}</th>
                  ))}
                  {['Accounts', 'Keys', 'Media'].includes(page) && <th>操作</th>}
                </tr>
              </thead>
              <tbody>
                {tabRows.map((row, i) => (
                  <tr key={row.id + '-' + i}>
                    {columns[page].map(([field]) => (
                      <td key={field}>
                        {cellText(field, row[field])}
                      </td>
                    ))}
                    {page === 'Accounts' && (
                      <td>
                        <button
                          className="quiet"
                          disabled={busy}
                          onClick={() =>
                            void act(() => api('accounts/' + row.id, 'PATCH', { enabled: !row.enabled }))
                          }
                        >
                          {row.enabled ? '停用' : '启用'}
                        </button>
                      </td>
                    )}
                    {page === 'Keys' && (
                      <td>
                        {!row.revoked_at && (
                          <button
                            className="quiet"
                            disabled={busy}
                            onClick={() => {
                              if (confirm('确认撤销此密钥？')) void act(() => api('keys/' + row.id, 'DELETE'));
                            }}
                          >
                            撤销
                          </button>
                        )}
                      </td>
                    )}
                    {page === 'Media' && (
                      <td>
                        <button
                          className="quiet"
                          onClick={() =>
                            void act(async () => {
                              const response = await fetch('/admin/v1/media/' + row.id);
                              if (!response.ok) throw new Error('下载失败');
                              const url = URL.createObjectURL(await response.blob());
                              const link = document.createElement('a');
                              link.href = url;
                              link.download = row.id + '.' + (row.mime.split('/')[1] ?? 'bin');
                              link.click();
                              setTimeout(() => URL.revokeObjectURL(url), 1000);
                            })
                          }
                        >
                          下载
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {!tabRows.length && (
              <p className="empty">
                {!rows[endpoint] && !notice ? '加载中…' : page === 'Accounts' ? `暂无${labels[provider]}账号` : `暂无${navigation[page]}`}
              </p>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Console />);
