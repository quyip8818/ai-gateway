import { Feedback, type Notice } from './components/feedback.tsx';
import { Icon, type IconName } from './components/icon.tsx';
import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

import type { Provider } from '../../../shared/contracts/providers.ts';
import { AccountsPage } from './pages/accounts.tsx';
import { KeysPage } from './pages/keys.tsx';
import { LoginPage } from './pages/login.tsx';
import { MediaPage } from './pages/media.tsx';
import { ResourceTable } from './components/resource-table.tsx';
import { createAdminApi, type Row } from './api/admin.ts';

import { navigation } from './labels.ts';

const navIcons: Record<keyof typeof navigation, IconName> = {
  Accounts: 'accounts', Keys: 'key', Models: 'layers', Requests: 'activity', Media: 'image',
};

function Console() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [page, setPage] = useState<keyof typeof navigation>('Accounts');
  const [notice, setNotice] = useState<Notice | null>(null);
  const showError = (error: unknown) =>
    setNotice({ kind: 'error', message: error instanceof Error ? error.message : '请求失败' });
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

  const table = page === 'Media' ? undefined : page;
  const endpoint = table === 'Accounts' ? 'accounts?provider=' + provider : table?.toLowerCase();

  useEffect(() => {
    if (!signedIn || !endpoint) return;
    const load = new AbortController();
    void api.json<Row[]>(endpoint, 'GET', undefined, load.signal)
      .then((result) => {
        if (!load.signal.aborted) setRows((previous) => ({ ...previous, [endpoint]: result }));
      })
      .catch((error) => {
        if (!load.signal.aborted) showError(error);
      });
    return () => {
      load.abort();
    };
  }, [api, signedIn, revision, endpoint]);

  async function act(run: () => Promise<unknown>, success?: string) {
    setBusy(true);
    setNotice(null);
    try {
      await run();
      setRevision((v) => v + 1);
      if (success) setNotice({ kind: 'success', message: success });
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }
  if (!signedIn) return (
    <LoginPage api={api} act={act} busy={busy} checking={signedIn === null} notice={notice}
      onSignIn={() => setSignedIn(true)} />
  );

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <span>AG</span> ai-gateway
        </div>
        <nav aria-label="控制台">
          {(Object.entries(navigation) as [keyof typeof navigation, string][]).map(([item, title]) => (
            <button
              className={page === item ? 'selected' : ''}
              key={item}
              type="button"
              aria-current={page === item ? 'page' : undefined}
              disabled={busy}
              onClick={() => {
                setPage(item);
                setNotice(null);
              }}
            >
              <Icon name={navIcons[item]} />{title}
            </button>
          ))}
        </nav>
        <button
          className="sign-out"
          type="button"
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
          <Icon name="logout" />退出登录
        </button>
      </aside>
      <main>
        <header className="page-header">
          <h1>{navigation[page]}</h1>
          <div className="actions">
            <button type="button" className="quiet icon-text" disabled={busy} onClick={() => setRevision((v) => v + 1)}>
              <Icon name="refresh" size={16} />刷新
            </button>
          </div>
        </header>
        <Feedback notice={notice} />
        {page === 'Accounts' && (
          <AccountsPage provider={provider} revision={revision} busy={busy} api={api} act={act} onProvider={(item) => {
            setProvider(item);
            setNotice(null);
          }} />
        )}
        {page === 'Keys' && (
          <KeysPage api={api} act={act} busy={busy} issuedKey={key} setKey={setKey} onCopyError={() => setNotice({ kind: 'error', message: '请手动复制密钥' })} />
        )}
        {page === 'Media' && <MediaPage api={api} revision={revision} />}
        {table && endpoint && <ResourceTable page={table} provider={provider} tabRows={rows[endpoint] ?? []}
          loading={!rows[endpoint] && !notice} busy={busy} api={api} act={act} />}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Console />);
