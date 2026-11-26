import { useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, projectURL, useResource } from "../api";
import type { Key, Project } from "../api";
import { Field, Notice, PageHeading, Panel } from "../components";

export function Keys({ project }: { project: Project }) {
  const [params] = useSearchParams();
  const base = projectURL(project.id) + "/keys";
  const keys = useResource<{ data: Key[] }>(base);
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState("");
  const [dialogError, setDialogError] = useState("");
  const [secret, setSecret] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  async function mutate(path: string, body?: unknown) {
    setBusy(true);
    setError("");
    setDialogError("");
    setCopied(false);
    try {
      const result = await api<{ key?: string }>(base + path, body, "POST");
      if (result?.key) {
        setSecret(result.key);
        if (!dialog.current?.open) dialog.current?.showModal();
      }
      keys.refresh();
    } catch (e) {
      const message = (e as Error).message;
      if (dialog.current?.open) setDialogError(message);
      else setError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeading
        title="API 密钥"
        description="为当前项目签发、轮换或撤销调用凭证。"
      >
        <button
          type="button"
          disabled={busy}
          onClick={() => dialog.current?.showModal()}
        >
          创建密钥
        </button>
      </PageHeading>
      <Notice error={error || keys.error} />
      <Panel title="我的项目密钥">
        {keys.value?.data.length ? (
          <div className="tableWrap">
            <table>
              <thead>
                <tr>
                  <th>名称</th>
                  <th>密钥前缀</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {keys.value.data.map((key) => (
                  <tr key={key.id}>
                    <td>{key.label}</td>
                    <td className="mono">{key.prefix}</td>
                    <td>
                      <span
                        className={
                          "status " + (key.revoked_at ? "" : "succeeded")
                        }
                      >
                        {key.revoked_at ? "已撤销" : "启用"}
                      </span>
                    </td>
                    <td>
                      {!key.revoked_at && (
                        <div className="inline">
                          <button
                            className="secondary"
                            disabled={busy}
                            onClick={() => {
                              if (confirm("轮换会立即撤销旧密钥，继续？"))
                                void mutate("/" + key.id + "/rotate");
                            }}
                          >
                            轮换
                          </button>
                          <button
                            className="secondary"
                            disabled={busy}
                            onClick={() => {
                              if (confirm("撤销此密钥？"))
                                void mutate("/" + key.id + "/revoke");
                            }}
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
        ) : (
          <p className="muted">
            {keys.value
              ? "暂无密钥"
              : keys.error
                ? "密钥读取失败"
                : "正在加载密钥…"}
          </p>
        )}
        <Link to={{ pathname: "..", search: params.toString() }}>
          返回产品接入 →
        </Link>
      </Panel>
      <dialog
        ref={dialog}
        aria-labelledby="key-dialog-title"
        onCancel={(event) => {
          if (busy) event.preventDefault();
        }}
        onClose={() => {
          setSecret("");
          setCopied(false);
          setDialogError("");
        }}
      >
        <h2 id="key-dialog-title">{secret ? "保存新密钥" : "创建 API 密钥"}</h2>
        {secret ? (
          <>
            <p>完整密钥只显示一次。请妥善保存。</p>
            <pre>{secret}</pre>
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(secret);
                  setDialogError("");
                  setCopied(true);
                } catch {
                  setDialogError("复制失败，请手动复制");
                }
              }}
            >
              {copied ? "已复制" : "复制密钥"}
            </button>
          </>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void mutate(
                "",
                Object.fromEntries(new FormData(event.currentTarget)),
              );
            }}
          >
            <Field name="label" label="密钥名称" />
            <button disabled={busy}>{busy ? "创建中…" : "创建"}</button>
          </form>
        )}
        <Notice error={dialogError} />
        <button
          type="button"
          className="secondary dialog-close"
          disabled={busy}
          onClick={() => dialog.current?.close()}
        >
          {secret ? "完成" : "取消"}
        </button>
      </dialog>
    </>
  );
}
