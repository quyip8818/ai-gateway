import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { text } from "./api";

const errors: Record<string, string> = {
  invalid_login: "用户名或密码不正确。",
  access_denied: "当前会话没有访问权限。请刷新页面或重新登录。",
  invalid_account_credential: "凭证格式不正确、已失效或被上游拒绝。",
  credential_adapter_unavailable: "此授权方式需要部署方配置兼容执行器。",
  account_validation_unavailable:
    "无法验证上游账号或获取模型，请检查执行器连接。",
  no_available_account_executor: "没有空闲的专用执行器，请联系部署管理员。",
  provider_unconfigured: "此供应商的执行器尚未配置。",
  account_already_imported: "这份凭证已经导入。",
  authorization_unavailable: "暂时无法开始或读取账号授权。",
  invalid_setup_check: "无法开始验证，请确认密钥仍可访问所选模型。",
  setup_check_expired: "验证已过期，请重新开始。",
  invalid_media_request: "请检查提示词和生成参数。",
  cancel_unavailable: "无法取消任务，请刷新查看最新状态。",
  request_not_found: "找不到该请求，或当前会话无权查看。",
  job_not_found: "找不到该任务，或当前会话无权查看。",
  key_not_found: "密钥已撤销或不属于当前账号。",
  "Failed to fetch": "无法连接网关，请检查网络后重试。",
};

export function Notice({
  error,
  retry,
}: {
  error?: string;
  retry?: () => void;
}) {
  if (!error) return null;
  return (
    <div className="notice" role="alert">
      <span>{errors[error] ?? error}</span>
      {retry && (
        <button className="secondary" onClick={retry}>
          重试
        </button>
      )}
    </div>
  );
}

export function Page({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  useEffect(() => {
    document.title = title + " · AI Gateway";
  }, [title]);
  return (
    <>
      <header className="page-heading">
        <div>
          <h1>{title}</h1>
          {description && <p>{description}</p>}
        </div>
        {actions && <div className="actions">{actions}</div>}
      </header>
      {children}
    </>
  );
}

export function Panel({
  title,
  actions,
  children,
  className = "",
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={"panel " + className}>
      {(title || actions) && (
        <header className="panel-heading">
          {title && <h2>{title}</h2>}
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children && <div>{children}</div>}
    </div>
  );
}

export function Loading() {
  return (
    <p className="loading" role="status">
      正在加载…
    </p>
  );
}

export function Dialog({
  title,
  busy,
  close,
  children,
}: {
  title: string;
  busy?: boolean;
  close: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) close();
      }}
    >
      <header className="panel-heading">
        <h2>{title}</h2>
        <button
          type="button"
          className="secondary"
          aria-label="关闭"
          disabled={busy}
          onClick={close}
        >
          ×
        </button>
      </header>
      {children}
    </dialog>
  );
}

export function Copy({
  value,
  label = "复制",
}: {
  value: string;
  label?: string;
}) {
  const [status, setStatus] = useState("");
  return (
    <div className="inline">
      <button
        type="button"
        className="secondary"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setStatus("已复制");
          } catch {
            setStatus("请手动复制");
          }
        }}
      >
        {label}
      </button>
      <span className="muted" role="status">
        {status}
      </span>
    </div>
  );
}

const labels: Record<string, string> = {
  succeeded: "成功",
  failed: "失败",
  queued: "排队中",
  running: "运行中",
  finalizing: "交付中",
  submitting: "提交中",
  submit_unknown: "待核验",
  submission_unknown: "待核验",
  canceled: "已取消",
  waiting: "等待调用",
  interrupted: "流中断",
  active: "已启用",
  paused: "已暂停",
  revoked: "已撤销",
  reauthorize: "需重新授权",
  expired: "已过期",
  ready: "可用",
  verifying: "验证中",
};
export function Status({ value }: { value: unknown }) {
  const key = text(value);
  return <span className={"status " + key}>{labels[key] ?? key}</span>;
}

export function Segments({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: readonly (readonly [string, string])[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="segments" role="group" aria-label={label}>
      {options.map(([id, name]) => (
        <button
          type="button"
          key={id}
          disabled={disabled}
          aria-pressed={id === value}
          onClick={() => onChange(id)}
        >
          {name}
        </button>
      ))}
    </div>
  );
}

export function Pager({
  previous,
  next,
}: {
  previous?: () => void;
  next?: () => void;
}) {
  if (!previous && !next) return null;
  return (
    <div className="pager">
      <button className="secondary" disabled={!previous} onClick={previous}>
        上一页
      </button>
      <button className="secondary" disabled={!next} onClick={next}>
        下一页
      </button>
    </div>
  );
}

export function Definition({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="definitions">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
