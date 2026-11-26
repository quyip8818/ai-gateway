import { useState } from "react";
import type { FormEvent } from "react";
import { api, APIError } from "../api";
import { Dialog, Notice } from "../components";
import { ProviderSettings } from "./provider-settings";

export type Provider = {
  id: string;
  name: string;
  format: string;
  credential_label: string;
  credential_url?: string;
  configured: boolean;
  authorize: boolean;
  can_configure?: boolean;
  can_import_file?: boolean;
  can_import_cookie?: boolean;
  can_import_direct?: boolean;
  executor_full?: boolean;
};
type CredentialMethod = {
  id: "platform" | "import" | "direct" | "oauth";
  label: string;
};

function enrollmentMethods(provider?: Provider): CredentialMethod[] {
  if (!provider) return [];
  const methods: CredentialMethod[] = [];
  if (provider.id === "codex") {
    methods.push({
      id: "platform",
      label: provider.can_import_direct ? "兼容服务 API Key" : "OpenAI API Key",
    });
  }
  const canImport =
    provider.configured &&
    (provider.format !== "auth.json" || provider.can_import_file !== false) &&
    (provider.id !== "jimeng" || provider.can_import_cookie !== false);
  if (canImport)
    methods.push({ id: "import", label: provider.credential_label });
  if (provider.can_import_direct) {
    methods.push({
      id: "direct",
      label:
        provider.id === "jimeng"
          ? "兼容服务 · 账号 Cookie"
          : "兼容服务 · 授权 JSON",
    });
  }
  if (provider.authorize) methods.push({ id: "oauth", label: "浏览器授权" });
  return methods;
}

export function Enroll({
  base,
  providers,
  error: loadError,
  retry,
  initial,
  close,
  done,
}: {
  base: string;
  providers?: Provider[];
  error?: string;
  retry: () => void;
  initial: string;
  close: () => void;
  done: (pool: string) => void;
}) {
  const [selected, select] = useState(initial);
  const [method, setMethod] = useState("");
  const [configuring, configure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const provider = providers?.find((item) => item.id === selected);
  const methods = enrollmentMethods(provider);
  const chosen = methods.find((item) => item.id === method) ?? methods[0];
  const choice = chosen?.id;
  const oauth = choice === "oauth";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !provider || !choice) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      if (oauth) {
        const response = await api<{ authorization_url: string }>(
          base + "/account-authorizations",
          { provider: provider.id },
        );
        window.location.assign(response.authorization_url);
      } else {
        const input = form.get("credential");
        if (input instanceof File && input.size > 60 * 1024)
          throw new Error("授权文件不能超过 60 KiB。");
        const credential =
          input instanceof File
            ? await input.text()
            : String(input ?? "").trim();
        const response = await api<{ pool_id: string }>(
          base + "/account-enrollments",
          {
            provider: provider.id,
            credential:
              choice === "platform"
                ? JSON.stringify({ OPENAI_API_KEY: credential })
                : credential,
            ...(choice === "direct" ? { direct: true } : {}),
          },
        );
        done(response.pool_id);
      }
    } catch (failure) {
      setError((failure as Error).message);
      if (
        failure instanceof APIError &&
        failure.code === "no_available_account_executor"
      )
        retry();
    } finally {
      setBusy(false);
    }
  }

  if (configuring && provider) {
    function closeSettings() {
      retry();
      configure(false);
    }
    return (
      <Dialog title={`连接${provider.name}`} busy={busy} close={closeSettings}>
        <ProviderSettings
          provider={provider.id}
          busy={busy}
          onBusy={setBusy}
          close={closeSettings}
          importReady={(method) => {
            setMethod(method);
            closeSettings();
          }}
        />
      </Dialog>
    );
  }

  return (
    <Dialog title="添加上游账号" busy={busy} close={close}>
      <Notice error={loadError} retry={retry} />
      <form onSubmit={submit}>
        <label>
          供应商
          <select
            autoFocus
            required
            disabled={busy || !providers}
            value={selected}
            onChange={(e) => {
              select(e.target.value);
              setMethod("");
              setError("");
            }}
          >
            <option value="">选择供应商</option>
            {providers?.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        {provider && methods.length > 1 && (
          <label>
            授权方式
            <select
              value={choice}
              disabled={busy}
              onChange={(e) => {
                setMethod(e.target.value);
                setError("");
              }}
            >
              {methods.map(({ id, label }) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        )}
        {provider?.can_configure && (
          <div className="callout">
            {provider.id === "codex" && provider.can_import_file === false ? (
              <p>已有 Codex 登录文件？连接 CLIProxyAPI 后即可导入。</p>
            ) : !choice ? (
              <p>
                {provider.executor_full
                  ? "现有专用实例已经分配。连接另一个空实例后可继续导入。"
                  : "先连接供应商服务，完成后在这里导入账号凭证。"}
              </p>
            ) : null}
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => configure(true)}
            >
              {choice ? "接入设置" : "连接" + provider.name}
            </button>
          </div>
        )}
        {provider && choice && !oauth && (
          <label key={provider.id + choice}>
            {chosen?.label}
            {choice !== "platform" && provider.format === "auth.json" ? (
              <input
                name="credential"
                type="file"
                accept=".json,application/json"
                required
                disabled={busy}
              />
            ) : (
              <input
                name="credential"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={
                  provider.id === "jimeng" ? "sessionid=…" : undefined
                }
                required
                disabled={busy}
              />
            )}
          </label>
        )}
        {choice === "import" && provider?.id === "kiro" && (
          <small>上传含 refreshToken 的授权文件。执行器会自动续期。</small>
        )}
        {choice === "direct" && provider?.id === "kiro" && (
          <small>兼容服务接受含 accessToken 的 Kiro 授权文件。</small>
        )}
        {choice === "import" && provider?.credential_url && (
          <small>
            使用绑定到工作区的 API Key。{" "}
            <a href={provider.credential_url} target="_blank" rel="noreferrer">
              前往 Claude Console 创建 ↗
            </a>
          </small>
        )}
        {provider && !choice && !provider.can_configure && (
          <p className="muted">
            此供应商尚未接通。请由部署时设置的管理员连接服务后再导入。
          </p>
        )}
        {oauth && (
          <p className="muted">完成供应商授权后，浏览器会返回此页面。</p>
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
          {choice && (
            <button disabled={busy}>
              {busy ? "正在验证…" : oauth ? "继续授权" : "验证并添加"}
            </button>
          )}
        </div>
      </form>
    </Dialog>
  );
}
