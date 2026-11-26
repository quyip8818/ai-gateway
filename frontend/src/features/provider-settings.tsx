import { useState } from "react";
import type { FormEvent } from "react";
import { api, useResource } from "../api";
import { Loading, Notice, Status } from "../components";
import {
  CompatibleFields,
  ExecutorFields,
  executorProducts,
} from "./provider-connection-fields";
import type { OAuthAction } from "./provider-connection-fields";

const settingsErrors: Record<string, string> = {
  executor_unreachable:
    "无法验证执行器。请检查地址、管理凭证和调用密钥，确认网关能访问该服务。",
  executor_not_empty:
    "这个实例已有账号或调用凭证。请选择一个专用于本网关的空实例。",
  executor_duplicate: "这个执行器地址已登记。",
  invalid_provider_settings:
    "检查服务地址与凭证。浏览器授权需要 HTTPS 授权地址和令牌地址。",
  provider_settings_in_use: "现有账号或正在进行的授权仍使用此设置。",
  operator_required: "请使用部署时设置的管理员账号配置供应商。",
  invalid_download_hosts: "请输入完整的 CDN 主机名，每行一个，最多 32 个。",
};

type Executor = { id?: string; url: string; occupied: boolean };
type Setup = {
  base_url?: string;
  oauth_configured: boolean;
  callback_url: string;
  executors: Executor[];
  download_hosts?: string[];
};

export function ProviderSettings({
  provider,
  close,
  importReady,
  busy,
  onBusy,
}: {
  provider: string;
  close: () => void;
  importReady: (method: "import" | "direct") => void;
  busy: boolean;
  onBusy: (busy: boolean) => void;
}) {
  const url = "/console/v1/provider-settings/" + encodeURIComponent(provider);
  const setup = useResource<Setup>(url);
  const [mode, setMode] = useState("managed");
  const [oauth, setOAuth] = useState<OAuthAction>("keep");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [hostsMessage, setHostsMessage] = useState("");
  const product = executorProducts[provider];
  const cookie = provider === "jimeng";

  async function update(action: () => Promise<void>) {
    if (busy) return;
    onBusy(true);
    setError("");
    try {
      await action();
      setup.refresh();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      onBusy(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    const value = (key: string) => String(fields.get(key) ?? "").trim();
    await update(async () => {
      setSaved(false);
      if (mode === "managed") {
        await api(
          url,
          cookie
            ? {
                url: value("url"),
                username: value("username"),
                password: String(fields.get("password") ?? ""),
              }
            : {
                url: value("url"),
                management_key: value("management_key"),
                runtime_key: value("runtime_key"),
              },
          "POST",
        );
      } else {
        await api(
          url,
          {
            base_url: value("url"),
            ...(oauth === "change"
              ? {
                  oauth: {
                    authorize_url: value("authorize_url"),
                    token_url: value("token_url"),
                    client_id: value("client_id"),
                    client_secret: value("client_secret"),
                    scope: value("scope"),
                    resource: value("resource"),
                  },
                }
              : {}),
            ...(oauth === "clear" ? { clear_oauth: true } : {}),
          },
          "PUT",
        );
      }
      form.reset();
      setOAuth("keep");
      setSaved(true);
    });
  }

  async function remove(id: string) {
    await update(async () => {
      await api(
        url + "/executors/" + encodeURIComponent(id),
        undefined,
        "DELETE",
      );
      setSaved(false);
    });
  }

  async function saveHosts(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const hosts = String(new FormData(event.currentTarget).get("hosts") ?? "")
      .split(/\r?\n/)
      .map((host) => host.trim())
      .filter(Boolean);
    await update(async () => {
      setHostsMessage("");
      await api(url, { download_hosts: hosts }, "PATCH");
      setHostsMessage("视频下载域名已保存。");
    });
  }

  return (
    <>
      <Notice
        error={
          settingsErrors[error || setup.error || ""] ?? (error || setup.error)
        }
        retry={setup.error ? setup.refresh : undefined}
      />
      {saved && (
        <p className="success" role="status">
          {mode === "managed"
            ? "执行器已验证并连接。"
            : "兼容服务已连接。下一步验证账号凭证。"}
        </p>
      )}
      {!setup.value && !setup.error && <Loading />}
      {setup.value && (
        <>
          {setup.value.executors.length > 0 && (
            <ul className="rows">
              {setup.value.executors.map((item) => (
                <li key={item.url}>
                  <div>
                    <code>{item.url}</code>
                    <small>{item.id ? "控制台登记" : "部署文件登记"}</small>
                  </div>
                  <Status value={item.occupied ? "occupied" : "ready"} />
                  {item.id && !item.occupied && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => void remove(item.id!)}
                    >
                      移除
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <form
            key={mode}
            onSubmit={save}
            onChange={() => {
              if (saved) setSaved(false);
            }}
          >
            <label>
              接入方式
              <select
                value={mode}
                disabled={busy}
                onChange={(event) => {
                  setMode(event.target.value);
                  setOAuth("keep");
                  setSaved(false);
                  setError("");
                }}
              >
                <option value="managed">专用 {product.runtime}</option>
                <option value="direct">已有兼容服务</option>
              </select>
            </label>
            {mode === "managed" ? (
              <ExecutorFields product={product} busy={busy} />
            ) : (
              <CompatibleFields
                setup={setup.value}
                supportsOAuth={!cookie}
                oauth={oauth}
                setOAuth={setOAuth}
                busy={busy}
              />
            )}
            <div className="actions">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={close}
              >
                返回
              </button>
              {saved ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    importReady(mode === "managed" ? "import" : "direct")
                  }
                >
                  继续添加账号
                </button>
              ) : (
                <button disabled={busy}>
                  {busy
                    ? "正在处理…"
                    : mode === "managed"
                      ? "验证并连接"
                      : "验证并保存"}
                </button>
              )}
            </div>
          </form>
          {cookie && (
            <details>
              <summary>视频下载域名</summary>
              <form onSubmit={saveHosts}>
                <label>
                  可信 CDN 主机名
                  <textarea
                    key={setup.value.download_hosts?.join("\n")}
                    name="hosts"
                    defaultValue={setup.value.download_hosts?.join("\n") ?? ""}
                    placeholder="cdn.example.com"
                    rows={3}
                    disabled={busy}
                    onChange={() => setHostsMessage("")}
                  />
                  <small>
                    成品通过 HTTPS 重定向到 CDN
                    时，每行填写一个服务提供的主机名。部署环境已允许的域名也会继续生效。
                  </small>
                </label>
                <button type="submit" className="secondary" disabled={busy}>
                  保存下载域名
                </button>
                {hostsMessage && (
                  <p className="success" role="status">
                    {hostsMessage}
                  </p>
                )}
              </form>
            </details>
          )}
        </>
      )}
    </>
  );
}
