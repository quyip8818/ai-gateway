import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, date, projectURL, useResource, workspaceURL } from "../api";
import type { Collection, Pool, Project } from "../api";
import { Empty, Loading, Notice, Page, Panel, Status } from "../components";

import { Enroll } from "./account-enrollment";
import type { Provider } from "./account-enrollment";

type Account = {
  id: string;
  label: string;
  provider: string;
  enabled: boolean;
  expires_at?: string;
  refresh_state?: string;
  verified_at?: string;
  last_used_at?: string;
  models: number;
};
type Authorization = { status: string };
const authorizationDone = (value: Authorization) =>
  !["waiting", "verifying"].includes(value.status);

export function Admin({ project }: { project: Project }) {
  const base = projectURL(project.id);
  const root = workspaceURL(project);
  const providers = useResource<Collection<Provider>>(base + "/providers");
  const accounts = useResource<Collection<Account>>(base + "/accounts");
  const pools = useResource<Collection<Pool>>(base + "/pools");
  const [filter, setFilter] = useState("");
  const [adding, setAdding] = useState(false);
  const [createdPool, setCreatedPool] = useState("");
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [params, setParams] = useSearchParams();
  const authorization = params.get("authorization");
  const result = useResource<Authorization>(
    authorization
      ? base + "/account-authorizations/" + encodeURIComponent(authorization)
      : null,
    2000,
    authorizationDone,
  );
  const visible = accounts.value?.data.filter(
    (account) => !filter || filter === account.provider,
  );
  const providerName = (id: string) =>
    providers.value?.data.find((item) => item.id === id)?.name ?? id;

  function refresh() {
    accounts.refresh();
    pools.refresh();
  }

  async function toggle(account: Account) {
    setPending(account.id);
    setError("");
    try {
      await api(
        base + "/accounts/" + account.id,
        { enabled: !account.enabled },
        "PATCH",
      );
      refresh();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setPending("");
    }
  }

  return (
    <Page
      title="上游账号"
      description="导入上游授权，验证后账号会自动加入对应的池。"
      actions={<button onClick={() => setAdding(true)}>添加账号</button>}
    >
      <Notice error={error} />
      {createdPool && (
        <div className="success" role="status">
          <span>账号验证通过，已加入账号池。</span>
          <Link
            className="button"
            to={root + "/keys?pool=" + encodeURIComponent(createdPool)}
          >
            签发调用密钥
          </Link>
        </div>
      )}
      {authorization && (
        <div className="callout">
          <Notice error={result.error} retry={result.refresh} />
          {!result.error && (
            <span role="status">
              {result.value?.status === "succeeded"
                ? "授权完成，账号已入池。"
                : result.value && authorizationDone(result.value)
                  ? "授权未完成，请重新发起。"
                  : "正在验证授权…"}
            </span>
          )}
          {result.value?.status === "succeeded" && (
            <Link to={root + "/keys"}>签发调用密钥</Link>
          )}
          <button
            className="secondary"
            onClick={() => {
              setParams({}, { replace: true });
              refresh();
            }}
          >
            关闭提示
          </button>
        </div>
      )}
      <Panel
        title="账号列表"
        actions={
          <select
            aria-label="按供应商筛选"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="">全部供应商</option>
            {providers.value?.data.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </select>
        }
      >
        <Notice error={accounts.error} retry={accounts.refresh} />
        <Notice error={providers.error} retry={providers.refresh} />
        {!visible && !accounts.error && <Loading />}
        {visible?.length === 0 && (
          <Empty title={filter ? "此供应商暂无账号" : "还没有上游账号"}>
            <button className="secondary" onClick={() => setAdding(true)}>
              添加账号
            </button>
          </Empty>
        )}
        {!!visible?.length && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>账号</th>
                  <th>状态</th>
                  <th>模型数</th>
                  <th>最近验证</th>
                  <th>最近使用</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((account) => {
                  const needsAuth =
                    account.refresh_state === "reauthorize" ||
                    (!!account.expires_at &&
                      Date.parse(account.expires_at) <= Date.now());
                  return (
                    <tr key={account.id}>
                      <td>
                        <strong>{account.label}</strong>
                        <small>{providerName(account.provider)}</small>
                      </td>
                      <td>
                        <Status
                          value={
                            !account.enabled
                              ? "paused"
                              : needsAuth
                                ? "reauthorize"
                                : "active"
                          }
                        />
                        {!account.enabled && needsAuth && (
                          <small>需重新授权</small>
                        )}
                      </td>
                      <td>{account.models}</td>
                      <td>{date(account.verified_at)}</td>
                      <td>{date(account.last_used_at)}</td>
                      <td>
                        <button
                          className="secondary"
                          disabled={!!pending}
                          onClick={() => void toggle(account)}
                        >
                          {pending === account.id
                            ? "更新中…"
                            : account.enabled
                              ? "暂停"
                              : "启用"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <Panel title="账号池">
        <Notice error={pools.error} retry={pools.refresh} />
        {!pools.value && !pools.error && <Loading />}
        {pools.value && !pools.value.data.length && (
          <Empty title="暂无账号池">第一个账号验证通过后会自动创建。</Empty>
        )}
        {!!pools.value?.data.length && (
          <div className="pool-grid">
            {pools.value.data.map((pool) => (
              <div className="pool" key={pool.id}>
                <strong>{providerName(pool.provider)}</strong>
                <code>{pool.slug}</code>
                <small>{pool.available} 个可用账号</small>
                <Link to={root + "/keys?pool=" + encodeURIComponent(pool.id)}>
                  签发密钥
                </Link>
              </div>
            ))}
          </div>
        )}
      </Panel>
      {adding && (
        <Enroll
          base={base}
          providers={providers.value?.data}
          error={providers.error}
          retry={providers.refresh}
          initial={filter}
          close={() => setAdding(false)}
          done={(pool) => {
            setAdding(false);
            setFilter("");
            setCreatedPool(pool);
            providers.refresh();
            refresh();
          }}
        />
      )}
    </Page>
  );
}
