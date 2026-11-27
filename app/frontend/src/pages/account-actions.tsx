import React, { useState } from 'react';
import type { AdminApi, Row, RunAction } from '../api/admin.ts';

const icons = {
  enable: 'M8 5v14l11-7z',
  disable: 'M9 5v14m6-14v14',
  reload: 'M20 11a8 8 0 1 0-2 6m2-11v5h-5',
  edit: 'm4 16-1 5 5-1L20 8l-4-4L4 16zm10-10 4 4',
  remove: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7',
};

function IconButton({ icon, label, disabled, onClick }: {
  icon: keyof typeof icons;
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className={icon === 'remove' ? 'quiet account-icon danger' : 'quiet account-icon'}
      title={label} aria-label={label} disabled={disabled} onClick={onClick}>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={icons[icon]} />
      </svg>
    </button>
  );
}

export function AccountActions({ row, api, act, busy }: { row: Row; api: AdminApi; act: RunAction; busy: boolean }) {
  const [editing, setEditing] = useState(false);
  const endpoint = 'accounts/' + row.id;
  return (
    <>
      <div className="actions account-actions">
        <IconButton icon={row.enabled ? 'disable' : 'enable'} label={row.enabled ? '停用账号' : '启用账号'}
          disabled={busy} onClick={() => void act(() => api.json(endpoint, 'PATCH', { enabled: !row.enabled }))} />
        <IconButton icon="reload" label="重新验证并刷新模型" disabled={busy}
          onClick={() => void act(() => api.json(endpoint + '/reload', 'POST'), '账号和模型已刷新')} />
        {row.provider === 'jimeng' && row.kind === 'cookie' && (
          <IconButton icon="edit" label="更改 Cookie" disabled={busy} onClick={() => setEditing((value) => !value)} />
        )}
        <IconButton icon="remove" label="删除账号" disabled={busy} onClick={() => {
          if (confirm(`删除账号「${row.label ?? row.id}」？未完成的视频任务将标记为失败。`))
            void act(() => api.json(endpoint, 'DELETE'), '账号已删除');
        }} />
      </div>
      {editing && (
        <form className="account-cookie-edit" onSubmit={(event) => {
          event.preventDefault();
          const cookie = new FormData(event.currentTarget).get('cookie');
          void act(async () => {
            await api.json(endpoint + '/credential', 'PUT', { cookie });
            setEditing(false);
          }, 'Cookie 已更新');
        }}>
          <label>
            新 Cookie
            <input name="cookie" type="password" autoComplete="off" spellCheck={false}
              placeholder="sessionid=…" required disabled={busy} />
          </label>
          <div className="actions">
            <button type="submit" disabled={busy}>验证并保存</button>
            <button type="button" className="quiet" disabled={busy} onClick={() => setEditing(false)}>取消</button>
          </div>
        </form>
      )}
    </>
  );
}
