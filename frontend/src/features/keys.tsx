import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, projectURL, useResource, workspaceURL } from "../api";
import type { Collection, Key, Pool, Project } from "../api";
import {
  Copy,
  Dialog,
  Empty,
  Loading,
  Notice,
  Page,
  Panel,
  Status,
} from "../components";

type Action = { type: "create" } | { type: "rotate" | "revoke"; key: Key };

export function Keys({ project }: { project: Project }) {
  const base = projectURL(project.id);
  const root = workspaceURL(project);
  const [params, setParams] = useSearchParams();
  const selectedPool = params.get("pool");
  const admin = project.role === "admin";
  const keys = useResource<Collection<Key>>(base + "/keys");
  const pools = useResource<Collection<Pool>>(admin ? base + "/pools" : null);
  const [action, setAction] = useState<Action>();
  const [secret, setSecret] = useState<{ key: string; id: string }>();
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const current =
    action ?? (selectedPool && admin ? { type: "create" as const } : undefined);
  const title =
    current?.type === "create"
      ? "签发调用密钥"
      : current?.type === "rotate"
        ? "轮换密钥"
        : "撤销密钥";

  function close() {
    setAction(undefined);
    setError("");
    if (selectedPool) setParams({}, { replace: true });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !current) return;
    const form = new FormData(event.currentTarget);
    const selected = form.getAll("pools");
    if (
      current.type === "create" &&
      (selected.length < 1 || selected.length > 20)
    ) {
      setError("请选择 1 至 20 个账号池。");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result =
        current.type === "create"
          ? await api<{ key: string; id: string }>(base + "/keys", {
              label: String(form.get("label") ?? "").trim(),
              pools: selected,
            })
          : await api<{ key: string; id: string } | undefined>(
              base + "/keys/" + current.key.id + "/" + current.type,
              undefined,
              "POST",
            );
      close();
      setSecret(result);
      setMessage(result ? "" : "密钥已撤销。");
      keys.refresh();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page
      title="调用密钥"
      description="管理当前账号持有的密钥。每把密钥只能调用已授权账号池中的模型。"
      actions={
        admin && (
          <button onClick={() => setAction({ type: "create" })}>
            签发密钥
          </button>
        )
      }
    >
      {message && (
        <div className="success" role="status">
          {message}
        </div>
      )}
      <Panel title="我的密钥">
        <Notice error={keys.error} retry={keys.refresh} />
        {!keys.value && !keys.error && <Loading />}
        {keys.value?.data.length === 0 && (
          <Empty title="暂无调用密钥">
            {admin
              ? "签发密钥后，即可配置客户端。"
              : "请联系项目管理员获取已授权的调用密钥。"}
          </Empty>
        )}
        {!!keys.value?.data.length && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>名称 / 前缀</th>
                  <th>授权账号池</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {keys.value.data.map((key) => (
                  <tr key={key.id}>
                    <td>
                      <strong>{key.label}</strong>
                      <small>
                        <code>{key.prefix}…</code>
                      </small>
                    </td>
                    <td>
                      <div className="chips">
                        {key.pools.map((pool) => (
                          <code key={pool}>{pool}</code>
                        ))}
                      </div>
                    </td>
                    <td>
                      <Status value={key.revoked_at ? "revoked" : "active"} />
                    </td>
                    <td>
                      {key.revoked_at ? (
                        "—"
                      ) : (
                        <div className="inline">
                          <button
                            className="secondary"
                            onClick={() => setAction({ type: "rotate", key })}
                          >
                            轮换
                          </button>
                          <button
                            className="secondary danger-text"
                            onClick={() => setAction({ type: "revoke", key })}
                          >
                            撤销
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {current && (
        <Dialog key={title} title={title} busy={busy} close={close}>
          <form onSubmit={submit}>
            {current.type === "create" ? (
              <>
                <Notice error={pools.error} retry={pools.refresh} />
                {!pools.value && !pools.error && <Loading />}
                {pools.value?.data.length === 0 && (
                  <Empty title="先添加上游账号">
                    <Link to={root + "/admin"}>打开上游账号</Link>
                  </Empty>
                )}
                {!!pools.value?.data.length && (
                  <>
                    <label>
                      名称
                      <input
                        name="label"
                        placeholder="例如：团队开发工具"
                        required
                        maxLength={100}
                        autoFocus
                        disabled={busy}
                      />
                    </label>
                    <fieldset disabled={busy}>
                      <legend>授权账号池</legend>
                      <div className="choices">
                        {pools.value.data.map((pool) => (
                          <label key={pool.id} className="choice">
                            <input
                              type="checkbox"
                              name="pools"
                              value={pool.id}
                              defaultChecked={
                                pools.value?.data.length === 1 ||
                                pool.id === selectedPool
                              }
                            />
                            <span>
                              <strong>{pool.slug}</strong>
                              <small>{pool.available} 个可用账号</small>
                            </span>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  </>
                )}
              </>
            ) : (
              <p>
                「{current.key.label}」的现有密钥将立即失效。
                {current.type === "rotate" && "新密钥保留现有授权和任务归属。"}
              </p>
            )}
            <Notice error={error} />
            <div className="actions">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={close}
              >
                取消
              </button>
              <button
                className={current.type === "revoke" ? "danger" : ""}
                disabled={
                  busy ||
                  (current.type === "create" && !pools.value?.data.length)
                }
              >
                {busy ? "正在处理…" : title}
              </button>
            </div>
          </form>
        </Dialog>
      )}
      {secret && (
        <Dialog title="保存调用密钥" close={() => setSecret(undefined)}>
          <p>完整密钥只显示这一次。请复制并保存到安全位置。</p>
          <pre className="secret">{secret.key}</pre>
          <div className="actions">
            <Copy value={secret.key} label="复制密钥" />
            <Link
              className="button"
              to={root + "/?key=" + encodeURIComponent(secret.id)}
            >
              配置客户端
            </Link>
          </div>
        </Dialog>
      )}
    </Page>
  );
}
