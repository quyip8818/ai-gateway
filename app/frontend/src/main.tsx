import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

import type { Provider } from '../../../shared/contracts/providers.ts';
import { AccountsPage } from './pages/accounts.tsx';
import { KeysPage } from './pages/keys.tsx';
import { LoginPage } from './pages/login.tsx';
import { VideoTasks } from './pages/media.tsx';
import { ResourceTable } from './components/resource-table.tsx';
import { createAdminApi, type Row } from './api/admin.ts';

import { navigation } from './labels.ts';

function Console() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [page, setPage] = useState<keyof typeof navigation>('Accounts');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState<Provider>('jimeng');
  const [rows, setRows] = useState<Record<string, Row[]>>({});
  const [key, setKey] = useState('');
  const [revision, setRevision] = useState(0);

  const api = useMemo(() => createAdminApi(() => {
    setSignedIn(false);
    setRows({});
    setKey('');
  }), []);

  useEffect(() => {
    const check = new AbortController();
    void api.json('session', 'GET', undefined, check.signal)
      .then(() => {
        if (!check.signal.aborted) setSignedIn(true);
      })
      .catch(() => {
        if (!check.signal.aborted) setSignedIn(false);
      });
    return () => check.abort();
  }, [api]);

  const endpoint = page === 'Accounts' ? 'accounts?provider=' + provider : page.toLowerCase();

  useEffect(() => {
    if (!signedIn) return;
    const load = new AbortController();
    const endpoints = page === 'Media' ? [endpoint, 'videos'] : [endpoint];
    Promise.all(endpoints.map(async (path) => [path, await api.json<Row[]>(path, 'GET', undefined, load.signal)] as const))
      .then((result) => {
        if (!load.signal.aborted) setRows((previous) => ({ ...previous, ...Object.fromEntries(result) }));
      })
      .catch((error) => {
        if (!load.signal.aborted) setNotice(error.message);
      });
    return () => {
      load.abort();
    };
  }, [api, signedIn, revision, endpoint, page]);

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
  if (!signedIn) return (
    <LoginPage api={api} act={act} busy={busy} checking={signedIn === null} notice={notice}
      onSignIn={() => setSignedIn(true)} />
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
              await api.json('session', 'DELETE');
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
          <AccountsPage provider={provider} busy={busy} api={api} act={act} onProvider={(item) => {
            setProvider(item);
            setNotice('');
          }} />
        )}
        {page === 'Keys' && (
          <KeysPage api={api} act={act} busy={busy} issuedKey={key} setKey={setKey} setNotice={setNotice} />
        )}
        {page === 'Media' && <VideoTasks videos={rows.videos ?? []} />}
        <ResourceTable page={page} provider={provider} tabRows={tabRows} loading={!rows[endpoint] && !notice}
          busy={busy} api={api} act={act} />
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Console />);
