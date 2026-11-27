import { AccountActions } from '../pages/account-actions.tsx';
import React from 'react';
import type { Provider } from '../../../../shared/contracts/providers.ts';
import type { AdminApi, Row, RunAction } from '../api/admin.ts';
import { cellText, columns, labels, navigation } from '../labels.ts';

export function ResourceTable({ page, provider, tabRows, loading, busy, api, act }: {
  page: keyof typeof columns;
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
              {['Accounts', 'Keys'].includes(page) && <th>操作</th>}
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
