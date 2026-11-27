import React from 'react';
import { providers } from '../../../../shared/contracts/providers.ts';
import type { AdminApi, RunAction } from '../api/admin.ts';
import { labels } from '../labels.ts';

export function KeysPage({ api, act, busy, issuedKey, setKey, onCopyError }: {
  api: AdminApi;
  act: RunAction;
  busy: boolean;
  issuedKey: string;
  setKey: (key: string) => void;
  onCopyError: () => void;
}) {
  return (
    <section>
      <h2>签发密钥</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const data = new FormData(form);
          void act(async () => {
            const result = await api.json<{ token: string }>('keys', 'POST', {
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
      {issuedKey && (
        <div className="reveal">
          <code>{issuedKey}</code>
          <button
            className="quiet"
            onClick={() =>
              void navigator.clipboard.writeText(issuedKey).catch(onCopyError)
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
  );
}
