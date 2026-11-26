import type { ReactNode } from "react";
import { text } from "./api";

export function Notice({ error }: { error?: string }) {
  return error ? (
    <p className="error" role="alert">
      {error}
    </p>
  ) : null;
}
export function Field({
  name,
  label,
  type = "text",
  required = true,
}: {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
}) {
  return (
    <label>
      {label}
      <input name={name} type={type} required={required} />
    </label>
  );
}
export function Panel({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}
export function Status({ value }: { value: unknown }) {
  const v = text(value);
  return (
    <span className={"status " + v}>
      {(
        {
          succeeded: "成功",
          failed: "失败",
          queued: "排队",
          running: "运行中",
          finalizing: "交付中",
          submitting: "提交中",
          submit_unknown: "待核验",
          canceled: "已取消",
          waiting: "等待调用",
          interrupted: "流中断",
        } as Record<string, string>
      )[v] ?? v}
    </span>
  );
}
