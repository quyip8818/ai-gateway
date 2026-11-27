import React, { useState } from 'react';
import type { AdminSettings, RuntimeSetting, SettingSource } from '../../../../shared/contracts/settings.ts';
import type { AdminApi, RunAction } from '../api/admin.ts';
import { useAdminResource } from '../api/use-admin-resource.ts';
import { ResourceError } from '../components/feedback.tsx';
import { Icon } from '../components/icon.tsx';
import { labels } from '../labels.ts';

const sources: Record<SettingSource, string> = {
  console: '控制台覆盖', env: '环境变量', default: '内置默认值',
};

const optionHelp: Record<string, Record<string, string>> = {
  'jimeng.browser_transport': {
    off: '通过服务端发送请求。',
    auto: '按请求选择传输方式。',
    always: '通过浏览器发送即梦请求。',
  },
};

export function SettingsPage({ api, revision, act, busy }: {
  api: AdminApi;
  revision: number;
  act: RunAction;
  busy: boolean;
}) {
  const { data, error, loading, refreshing, retry } = useAdminResource<AdminSettings>(api, 'settings', revision);
  const service = data?.service;

  function save(setting: RuntimeSetting, value: string | null) {
    void act(
      () => api.json('settings/' + encodeURIComponent(setting.id), 'PUT', { value }),
      value === null ? '已恢复启动配置' : '配置已生效',
    );
  }

  return (
    <>
      {error && <ResourceError message={error} retry={retry} />}
      {loading && <p className="loading-panel" role="status">正在读取配置…</p>}
      {data && (
        <div className="settings-grid" aria-busy={refreshing}>
          <div className="settings-runtime">
            {data.runtime.map((setting) => (
              <SettingCard key={JSON.stringify([setting.id, setting.value, setting.source])}
                setting={setting} disabled={busy || refreshing} saving={busy}
                onSave={(value) => save(setting, value)} />
            ))}
          </div>
          {service && (
            <section className="settings-startup panel">
              <div className="settings-heading">
                <span className="section-icon"><Icon name="server" size={20} /></span>
                <div><h2>启动配置</h2><p>随服务启动读取</p></div>
              </div>
              <dl className="setting-list">
                <dt>监听主机</dt><dd><code>{service.host}</code></dd>
                <dt>监听端口</dt><dd><code>{service.port}</code></dd>
                <dt>对外入口</dt><dd>{service.public_origin ?? '使用请求地址'}</dd>
                <dt>媒体目录</dt><dd><code>{service.media_directory}</code></dd>
              </dl>
            </section>
          )}
        </div>
      )}
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
          <h2>{setting.title}</h2>
          {setting.provider && <p>{labels[setting.provider]}</p>}
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
