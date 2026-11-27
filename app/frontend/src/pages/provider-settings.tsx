import React, { useState } from 'react';
import { isBrowserTransportMode, jimengBrowserOptions, jimengBrowserSettingId, type BrowserTransportMode } from '../../../../shared/contracts/jimeng-settings.ts';
import type { Provider } from '../../../../shared/contracts/providers.ts';
import type { RuntimeSetting, SettingSource } from '../../../../shared/contracts/settings.ts';
import type { AdminApi, RunAction } from '../api/admin.ts';
import { useAdminResource } from '../api/use-admin-resource.ts';
import { ResourceError } from '../components/feedback.tsx';
import { Icon } from '../components/icon.tsx';
import { labels } from '../labels.ts';

const sources: Record<SettingSource, string> = {
  console: '控制台覆盖', env: '环境变量', default: '内置默认值',
};

const optionHelp: Record<string, Record<string, string>> = {
  [jimengBrowserSettingId]: {
    off: '通过服务端发送请求。',
    auto: '按请求选择传输方式。',
    always: '通过浏览器发送即梦请求。',
  },
};

export function ProviderSettings({ provider, api, revision, act, busy }: {
  provider: Provider;
  api: AdminApi;
  revision: number;
  act: RunAction;
  busy: boolean;
}) {
  const endpoint = 'providers/' + provider + '/settings';
  const { data: settings, error, loading, refreshing, retry } = useAdminResource<RuntimeSetting[]>(api, endpoint, revision);

  function save(setting: RuntimeSetting, value: string | null) {
    void act(
      () => api.json(endpoint + '/' + encodeURIComponent(setting.id), 'PUT', { value }),
      value === null ? '已恢复部署默认值' : '供应商默认设置已保存',
    );
  }

  return (
    <>
      {error && <ResourceError message={error} retry={retry} />}
      {loading && <p className="loading-panel" role="status">正在读取配置…</p>}
      {settings?.length ? (
        <div className="settings-runtime" aria-busy={refreshing}>
          {settings.map((setting) => (
            <SettingCard key={JSON.stringify([setting.id, setting.value, setting.source])}
              setting={setting} disabled={busy || refreshing} saving={busy}
              onSave={(value) => save(setting, value)} />
          ))}
        </div>
      ) : null}
    </>
  );
}

function SettingCard({ setting, disabled, saving, onSave }: {
  setting: RuntimeSetting;
  disabled: boolean;
  saving: boolean;
  onSave: (value: string | null) => void;
}) {
  const [draft, setDraft] = useState(setting.value);
  const dirty = draft !== setting.value;
  const effective = setting.options.find((option) => option.value === setting.value)?.label ?? setting.value;
  return (
    <section className="settings-card panel">
      <div className="settings-heading">
        <span className="section-icon"><Icon name="settings" size={20} /></span>
        <div>
          <h2>{setting.title}默认值</h2>
          {setting.provider && <p>{labels[setting.provider]}账号可继承或单独覆盖</p>}
        </div>
        <span className="status-pill status-positive"><Icon name="check" size={14} /> 当前为{effective}</span>
      </div>

      <dl className="setting-facts">
        <div><dt>生效来源</dt><dd>{sources[setting.source]}</dd></div>
        {setting.status?.map(({ label, value }) => (
          <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
        ))}
      </dl>

      <form className="setting-form" onSubmit={(event) => {
        event.preventDefault();
        if (dirty && !disabled) onSave(draft);
      }}>
        <fieldset className="setting-options" disabled={disabled}>
          <legend>工作模式</legend>
          <div className="option-grid">
            {setting.options.map(({ value, label }) => (
              <label className="mode-option" key={value}>
                <input type="radio" name="mode" checked={draft === value} onChange={() => setDraft(value)} />
                <span><strong>{label}</strong>
                  {optionHelp[setting.id]?.[value] && <small>{optionHelp[setting.id][value]}</small>}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {setting.environment_variable && (
          <p className="setting-env">启动环境变量 <code>{setting.environment_variable}</code></p>
        )}
        <div className="setting-actions">
          {setting.source === 'console' && (
            <button className="quiet" type="button" disabled={disabled} onClick={() => onSave(null)}>清除覆盖</button>
          )}
          <div className="actions">
            {dirty && <button className="text-button" type="button" disabled={disabled} onClick={() => setDraft(setting.value)}>取消</button>}
            <button type="submit" disabled={!dirty || disabled}>{saving && dirty ? '应用中…' : '应用更改'}</button>
          </div>
        </div>
      </form>
    </section>
  );
}


export function JimengAccountSettings({ value, disabled, onSave, onCancel }: {
  value: unknown;
  disabled: boolean;
  onSave: (value: BrowserTransportMode | null) => void;
  onCancel: () => void;
}) {
  return (
    <form className="account-edit" onSubmit={(event) => {
      event.preventDefault();
      const selected = new FormData(event.currentTarget).get('browser_transport');
      if (selected === '') onSave(null);
      else if (isBrowserTransportMode(selected)) onSave(selected);
    }}>
      <label>
        浏览器传输
        <select name="browser_transport" defaultValue={isBrowserTransportMode(value) ? value : ''} disabled={disabled}>
          <option value="">继承供应商默认值</option>
          {jimengBrowserOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      <div className="actions">
        <button type="submit" disabled={disabled}>保存</button>
        <button type="button" className="quiet" disabled={disabled} onClick={onCancel}>取消</button>
      </div>
    </form>
  );
}
