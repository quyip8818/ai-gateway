import { Link } from "react-router-dom";
import type { Model, Pool } from "../api";

export type Account = {
  id: string;
  label: string;
  provider: string;
  enabled: boolean;
  expires_at?: string | null;
  refresh_state?: string;
  verified_at?: string | null;
  last_used_at?: string | null;
  models: number;
};

export function needsAuthorization(account: Account) {
  return (
    account.refresh_state === "reauthorize" ||
    (!!account.expires_at && Date.parse(account.expires_at) <= Date.now())
  );
}

export function PoolOverview({
  pools,
  accounts,
  models,
  providerName,
  root,
  selectedProvider,
  reauthorize,
  onSelect,
}: {
  pools: Pool[];
  accounts?: Account[];
  models?: Model[];
  providerName: (id: string) => string;
  root: string;
  selectedProvider: string;
  reauthorize: boolean;
  onSelect: (provider: string, attention: boolean) => void;
}) {
  const byProvider = new Map<string, Pool[]>();
  for (const pool of pools) {
    const group = byProvider.get(pool.provider);
    if (group) group.push(pool);
    else byProvider.set(pool.provider, [pool]);
  }
  return (
    <div className="pool-grid">
      {[...byProvider].map(([provider, group]) => {
        const available = group.reduce((sum, pool) => sum + pool.available, 0);
        const attention = accounts?.filter(
          (account) =>
            account.provider === provider && needsAuthorization(account),
        ).length;
        const modelCount =
          models &&
          new Set(
            models
              .filter((model) => model.provider === provider)
              .map((model) => model.id),
          ).size;
        const selected = selectedProvider === provider;
        return (
          <article className="pool" key={provider}>
            <header className="pool-heading">
              <h3>{providerName(provider)}</h3>
              <span className={available ? "status ready" : "status paused"}>
                {available ? "有可用账号" : "无可用账号"}
              </span>
            </header>
            <dl className="pool-metrics">
              <div>
                <dt>可用账号</dt>
                <dd>{available}</dd>
              </div>
              <div>
                <dt>需重新授权</dt>
                <dd>{attention ?? "—"}</dd>
              </div>
              <div>
                <dt>可用模型</dt>
                <dd>{modelCount ?? "—"}</dd>
              </div>
            </dl>
            <div className="inline">
              <button
                className="secondary"
                aria-pressed={selected && !reauthorize}
                onClick={() => onSelect(provider, false)}
              >
                查看账号
              </button>
              {!!attention && (
                <button
                  className="secondary"
                  aria-pressed={selected && reauthorize}
                  onClick={() => onSelect(provider, true)}
                >
                  查看待授权
                </button>
              )}
            </div>
            <ul className="pool-links">
              {group.map((pool) => (
                <li key={pool.id}>
                  <code>{pool.slug}</code>
                  <Link to={root + "/keys?pool=" + encodeURIComponent(pool.id)}>
                    签发密钥
                  </Link>
                </li>
              ))}
            </ul>
          </article>
        );
      })}
    </div>
  );
}
