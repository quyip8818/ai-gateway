import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

const providerKinds = {
  jimeng: ['cookie'],
  codex: ['oauth', 'api-key'],
  kiro: ['desktop', 'oidc'],
  claude: ['api-key'],
};
const navigation = ['Accounts', 'Keys', 'Models', 'Requests', 'Media'];
type Row = Record<string, any>;

function Console() {
  const [token, setToken] = useState('');
  const [session, setSession] = useState('');
  const [page, setPage] = useState('Accounts');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState('jimeng');
  const [kind, setKind] = useState('cookie');
  const [rows, setRows] = useState<Record<string, Row[]>>({});
  const [key, setKey] = useState('');
  const [authURL, setAuthURL] = useState('');
  const [space, setSpace] = useState('');
  const [revision, setRevision] = useState(0);

  async function api(path: string, method = 'GET', body?: unknown) {
    const headers: Record<string, string> = { authorization: 'Bearer ' + session };
    if (space) headers['x-workspace-id'] = space;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch('/admin/v1/' + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = response.status === 204 ? null : await response.json();
    if (!response.ok) throw new Error(value?.error?.message ?? 'Request failed');
    return value;
  }
  useEffect(() => {
    if (!session) return;
    let active = true;
    const endpoints = ['accounts', 'pools', 'keys', 'models', 'requests', 'media', 'videos', 'workspaces'];
    Promise.all(endpoints.map(async (path) => [path, await api(path)]))
      .then((result) => {
        if (active) setRows(Object.fromEntries(result));
      })
      .catch((error) => {
        if (active) setNotice(error.message);
      });
    return () => {
      active = false;
    };
  }, [session, space, revision]);

  async function act(run: () => Promise<unknown>, success?: string) {
    setBusy(true);
    setNotice('');
    try {
      await run();
      setRevision((v) => v + 1);
      if (success) setNotice(success);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  }
  const columns = {
    Accounts: [
      ['label', 'Account'],
      ['provider', 'Provider'],
      ['kind', 'Authorization'],
      ['concurrency', 'Capacity'],
      ['enabled', 'Status'],
    ],
    Keys: [
      ['label', 'Key'],
      ['prefix', 'Prefix'],
      ['created_at', 'Created'],
      ['revoked_at', 'Revoked'],
    ],
    Models: [
      ['id', 'Model'],
      ['operation', 'Operation'],
    ],
    Requests: [
      ['model', 'Model'],
      ['operation', 'Operation'],
      ['status', 'Status'],
      ['created_at', 'Started'],
    ],
    Media: [
      ['id', 'Asset'],
      ['mime', 'Format'],
      ['bytes', 'Bytes'],
      ['created_at', 'Created'],
    ],
  };
  const tabRows = rows[page.toLowerCase()] ?? [];
  if (!session)
    return (
      <main className="login">
        <div className="brand">
          <span>AG</span> ai-gateway
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const response = await fetch('/admin/v1/session', {
                method: 'POST',
                headers: { authorization: 'Bearer ' + token },
              });
              if (!response.ok) throw new Error('Admin token was not accepted');
              setSession((await response.json()).token);
              setToken('');
            });
          }}
        >
          <h1>Gateway console</h1>
          <label>
            Admin token
            <input type="password" value={token} required onChange={(e) => setToken(e.target.value)} />
          </label>
          {notice && (
            <p className="feedback" role="status">
              {notice}
            </p>
          )}
          <button disabled={busy}>Open console</button>
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
          {navigation.map((item) => (
            <button
              className={page === item ? 'selected' : ''}
              key={item}
              onClick={() => {
                setPage(item);
                setNotice('');
              }}
            >
              {item}
            </button>
          ))}
        </nav>
        <button
          className="quiet"
          onClick={() => {
            void api('session', 'DELETE').catch(() => {});
            setSession('');
            setRows({});
            setKey('');
            setAuthURL('');
            setNotice('');
          }}
        >
          Sign out
        </button>
      </aside>
      <main>
        <header>
          <h1>{page}</h1>
          <div className="actions">
            <select aria-label="Workspace" value={space} onChange={(e) => setSpace(e.target.value)}>
              <option value="">Default workspace</option>
              {(rows.workspaces ?? [])
                .filter((row) => row.name !== 'Default')
                .map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
                ))}
            </select>
            <button className="quiet" onClick={() => setRevision((v) => v + 1)}>
              Refresh
            </button>
          </div>
        </header>
        {notice && (
          <p className="feedback" role="status">
            {notice}
          </p>
        )}
        {page === 'Accounts' && (
          <section>
            <h2>Add account</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const form = e.currentTarget;
                const data = new FormData(form);
                void act(async () => {
                  const input = String(data.get('credential') ?? '').trim();
                  const credential = input.startsWith('{') ? JSON.parse(input) : input;
                  await api('accounts', 'POST', {
                    provider,
                    kind,
                    credential,
                    label: data.get('label'),
                    pool: data.get('pool') || 'Default',
                    concurrency: Number(data.get('concurrency')),
                  });
                  form.reset();
                }, 'Account added');
              }}
            >
              <div className="fields">
                <label>
                  Provider
                  <select
                    value={provider}
                    onChange={(e) => {
                      setProvider(e.target.value);
                      setKind(providerKinds[e.target.value][0]);
                    }}
                  >
                    {Object.keys(providerKinds).map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Authorization
                  <select value={kind} onChange={(e) => setKind(e.target.value)}>
                    {providerKinds[provider].map((k) => (
                      <option key={k}>{k}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Account name
                  <input name="label" required maxLength={100} />
                </label>
                <label>
                  Account pool
                  <input name="pool" placeholder="Default" />
                </label>
                <label>
                  Concurrency
                  <input name="concurrency" defaultValue={1} type="number" min={1} max={100} />
                </label>
              </div>
              <label>
                Credential
                <textarea name="credential" required autoComplete="off" spellCheck={false} />
              </label>
              <button disabled={busy}>Validate and add</button>
            </form>
            {provider === 'codex' && (
              <form
                className="oauth"
                onSubmit={(e) => {
                  e.preventDefault();
                  const data = new FormData(e.currentTarget);
                  void act(async () => {
                    if (!authURL) {
                      const flow = await api('codex/authorize', 'POST', { label: data.get('label') });
                      setAuthURL(flow.url);
                    } else {
                      await api('codex/complete', 'POST', { callback: data.get('callback') });
                      setAuthURL('');
                    }
                  });
                }}
              >
                <h3>Codex browser authorization</h3>
                {authURL ? (
                  <>
                    <a href={authURL} target="_blank" rel="noreferrer">
                      Open authorization
                    </a>
                    <label>
                      Callback URL
                      <input name="callback" required />
                    </label>
                  </>
                ) : (
                  <label>
                    Account name
                    <input name="label" required />
                  </label>
                )}
                <button disabled={busy}>{authURL ? 'Complete authorization' : 'Create authorization link'}</button>
              </form>
            )}
          </section>
        )}
        {page === 'Keys' && (
          <section>
            <h2>Issue key</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const form = e.currentTarget;
                const data = new FormData(form);
                void act(async () => {
                  const result = await api('keys', 'POST', {
                    label: data.get('label'),
                    pools: data.getAll('pool'),
                  });
                  setKey(result.token);
                  form.reset();
                }, 'Key created');
              }}
            >
              <label>
                Key name
                <input name="label" required maxLength={100} />
              </label>
              <fieldset>
                <legend>Allowed account pools</legend>
                {(rows.pools ?? []).map((pool) => (
                  <label className="check" key={pool.id}>
                    <input type="checkbox" name="pool" value={pool.id} />
                    {pool.provider} / {pool.name}
                  </label>
                ))}
              </fieldset>
              <button disabled={busy || !rows.pools?.length}>Issue key</button>
            </form>
            {key && (
              <div className="reveal">
                <code>{key}</code>
                <button
                  className="quiet"
                  onClick={() =>
                    void navigator.clipboard.writeText(key).catch(() => setNotice('Copy the key manually'))
                  }
                >
                  Copy
                </button>
                <button className="quiet" onClick={() => setKey('')}>
                  Dismiss
                </button>
              </div>
            )}
          </section>
        )}
        {page === 'Media' && (
          <section>
            <h2>Video tasks</h2>
            <div className="table">
              <table>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Model</th>
                    <th>Status</th>
                    <th>Progress</th>
                  </tr>
                </thead>
                <tbody>
                  {(rows.videos ?? []).map((v) => (
                    <tr key={v.id}>
                      <td>{v.id}</td>
                      <td>{v.model}</td>
                      <td>{v.status}</td>
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
                  {['Accounts', 'Keys', 'Media'].includes(page) && <th>Action</th>}
                </tr>
              </thead>
              <tbody>
                {tabRows.map((row, i) => (
                  <tr key={row.id + '-' + i}>
                    {columns[page].map(([field]) => (
                      <td key={field}>
                        {field === 'enabled' ? (row.enabled ? 'Enabled' : 'Disabled') : String(row[field] ?? '—')}
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
                          {row.enabled ? 'Disable' : 'Enable'}
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
                              if (confirm('Revoke this key?')) void act(() => api('keys/' + row.id, 'DELETE'));
                            }}
                          >
                            Revoke
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
                              const response = await fetch('/admin/v1/media/' + row.id, {
                                headers: {
                                  authorization: 'Bearer ' + session,
                                  ...(space ? { 'x-workspace-id': space } : {}),
                                },
                              });
                              if (!response.ok) throw new Error('Download failed');
                              const url = URL.createObjectURL(await response.blob());
                              const link = document.createElement('a');
                              link.href = url;
                              link.download = row.id + '.' + (row.mime.split('/')[1] ?? 'bin');
                              link.click();
                              setTimeout(() => URL.revokeObjectURL(url), 1000);
                            })
                          }
                        >
                          Download
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {!tabRows.length && <p className="empty">No {page.toLowerCase()} yet.</p>}
          </div>
        </section>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Console />);
