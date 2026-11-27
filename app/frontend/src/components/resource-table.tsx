import { AccountActions } from '../pages/account-actions.tsx';
import React from 'react';
import type { Provider } from '../../../../shared/contracts/providers.ts';
import type { AdminApi, Row, RunAction } from '../api/admin.ts';
import { cellText, columns, labels, navigation } from '../labels.ts';

export function ResourceTable({ page, provider, tabRows, loading, busy, api, act }: {
  page: keyof typeof navigation;
  provider: Provider;
  tabRows: Row[];
  loading: boolean;
  busy: boolean;
  api: AdminApi;
  act: RunAction;
}) {
  return (
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
                  <td><AccountActions row={row} api={api} act={act} busy={busy} /></td>
                )}
                {page === 'Keys' && (
                  <td>
                    {!row.revoked_at && (
                      <button
                        className="quiet"
                        disabled={busy}
                        onClick={() => {
                          if (confirm('确认撤销此密钥？')) void act(() => api.json('keys/' + row.id, 'DELETE'));
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
                          const blob = await api.download(row.id);
                          const url = URL.createObjectURL(blob);
                          const link = document.createElement('a');
                          link.href = url;
                          link.download = row.id + '.' + (blob.type.split('/')[1] ?? 'bin');
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
            {loading ? '加载中…' : page === 'Accounts' ? `暂无${labels[provider]}账号` : `暂无${navigation[page]}`}
          </p>
        )}
      </div>
    </section>
  );
}
