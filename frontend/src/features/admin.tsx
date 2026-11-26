import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, projectURL, text, useResource } from "../api";
import type { Project, Row } from "../api";
import { Field, Notice, PageHeading, Panel } from "../components";

import { operations } from "../products";
import type { ProductOperation } from "../products";
import { providerDetails } from "../providers";
import { ConnectionForm } from "./connection-form";

function BillingPanel({ project }: { project: Project }) {
  const base = projectURL(project.id) + "/billing";
  const entries = useResource<{ data: Row[] }>(base);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function publish(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    try {
      await api(base + "/prices", Object.fromEntries(new FormData(form)));
      form.reset();
      setNotice("价格已发布，将用于后续请求");
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function reconcile() {
    try {
      const data = await api<{ booked: number }>(base + "/reconcile", {});
      setNotice("新增 " + data.booked + " 条试算记录");
      setError("");
      entries.refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Panel title="计费试算">
      <Notice error={error || entries.error} />
      {notice && <p role="status">{notice}</p>}
      <form onSubmit={publish}>
        <label>
          协议
          <select name="operation">
            <option value="responses">OpenAI Responses</option>
            <option value="messages">Anthropic Messages</option>
          </select>
        </label>
        <Field label="模型 ID" name="model" />
        <label>
          计量
          <select name="metric">
            <option>input_tokens</option>
            <option>output_tokens</option>
            <option>cache_creation_input_tokens</option>
            <option>cache_read_input_tokens</option>
          </select>
        </label>
        <input name="unit" value="token" type="hidden" />
        <Field label="每 Token 的内部积分" name="amount_per_unit" />
        <button>发布价格</button>
      </form>
      <p>
        <button className="secondary" onClick={reconcile}>
          试算已完成请求
        </button>
      </p>
      <ul className="rows">
        {entries.value?.data.map((x) => (
          <li key={text(x.id)}>
            {text(x.model)} · {text(x.metric)}
            <span>{text(x.amount)} 积分</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
export function Admin({ project }: { project: Project }) {
  const [params, setParams] = useSearchParams();
  const selected =
    operations.find((item) => item.id === params.get("operation")) ??
    operations[0];
  const tab = params.get("tab") === "governance" ? "governance" : "routing";
  function selectOperation(operation: string) {
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.set("operation", operation);
        return next;
      },
      { replace: true },
    );
  }
  return (
    <>
      <PageHeading
        title="项目管理"
        description="管理上游连接、模型路由、成员与审计。"
      >
        <Link
          className="action-link"
          to={
            "..?" +
            new URLSearchParams({
              product: selected.product.id,
              operation: selected.id,
            })
          }
        >
          返回产品接入
        </Link>
      </PageHeading>
      <div
        className="segments studio-switch admin-switch"
        role="group"
        aria-label="管理模块"
      >
        {[
          ["routing", "连接与路由"],
          ["governance", "成员、审计与计费"],
        ].map(([id, label]) => (
          <button
            type="button"
            key={id}
            aria-pressed={tab === id}
            onClick={() =>
              setParams((previous) => {
                const next = new URLSearchParams(previous);
                next.set("tab", id);
                return next;
              })
            }
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "routing" ? (
        <AdminRouting
          project={project}
          selected={selected}
          selectOperation={selectOperation}
        />
      ) : (
        <Governance project={project} />
      )}
    </>
  );
}

function AdminRouting({
  project,
  selected,
  selectOperation,
}: {
  project: Project;
  selected: ProductOperation;
  selectOperation: (operation: string) => void;
}) {
  const operation = selected.id;
  const routeProvider = selected.product.provider;
  const allowBackup = providerDetails(routeProvider).allowBackup;
  const isMedia = selected.product.protocol === "media";
  const [connection, setConnection] = useState("");
  const [saving, setSaving] = useState(false);
  const base = projectURL(project.id),
    connections = useResource<{ data: Row[] }>(base + "/connections"),
    routes = useResource<{ data: Row[] }>(base + "/routes");
  const compatible =
    connections.value?.data.filter(
      (item) => item.provider === routeProvider && item.enabled,
    ) ?? [];
  const [err, setErr] = useState("");
  async function probeConnection(id: string) {
    setErr("");
    try {
      await api(base + "/connections/" + id + "/probe", undefined, "POST");
      connections.refresh();
    } catch (x) {
      setErr((x as Error).message);
    }
  }
  async function connectionState(id: string, enabled: boolean) {
    setErr("");
    try {
      await api(base + "/connections/" + id, { enabled }, "PATCH");
      connections.refresh();
    } catch (x) {
      setErr((x as Error).message);
    }
  }
  const [validation, setValidation] = useState("");
  async function restore(id: string) {
    if (!confirm("将此历史版本发布为新的生效版本？")) return;
    try {
      await api(base + "/routes/" + id + "/restore", {});
      routes.refresh();
      setErr("");
      setValidation("已重发历史路由");
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  async function submit(e: FormEvent<HTMLFormElement>, save: string) {
    e.preventDefault();
    if (saving) return;
    const form = e.currentTarget;
    const mode = (e.nativeEvent as SubmitEvent).submitter?.getAttribute(
      "value",
    );
    const effectivePath =
      save === "/routes/publish" && mode === "validate"
        ? "/routes/validate"
        : save;
    const body: Row = Object.fromEntries(new FormData(form));
    setSaving(true);
    setErr("");
    setValidation("");
    try {
      if (save === "/routes/publish")
        body.capabilities = JSON.parse(
          String(body.capabilities ?? "").trim() || "{}",
        );
      await api(base + effectivePath, body);
      if (effectivePath === "/routes/validate") {
        setValidation("草稿校验通过");
        setErr("");
        return;
      }
      form.reset();
      if (save === "/routes/publish") setConnection("");
      if (save === "/connections") connections.refresh();
      else {
        setValidation("模型路由已发布");
        routes.refresh();
      }
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <Notice error={err || connections.error || routes.error} />
      <div className="grid studio-grid">
        <Panel title="上游连接">
          <ConnectionForm
            defaultProvider={routeProvider}
            saving={saving}
            onSubmit={(event) => submit(event, "/connections")}
          />
          <ul className="rows">
            {connections.value?.data.map((x) => (
              <li key={text(x.id)}>
                {text(x.label)}
                <span>
                  {text(x.provider)} · {text(x.probe_state)}{" "}
                  <button
                    className="secondary"
                    onClick={() => probeConnection(text(x.id))}
                  >
                    探活
                  </button>{" "}
                  <button
                    className="secondary"
                    onClick={() => connectionState(text(x.id), !x.enabled)}
                  >
                    {x.enabled ? "停用" : "启用"}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title="发布模型路由">
          <form onSubmit={(e) => submit(e, "/routes/publish")}>
            <label>
              操作
              <select
                name="operation"
                value={operation}
                disabled={saving}
                onChange={(event) => {
                  selectOperation(event.target.value);
                  setConnection("");
                  setValidation("");
                }}
              >
                {operations.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label} · {item.id}
                  </option>
                ))}
              </select>
            </label>
            <label>
              主连接
              <select
                name="connection"
                required
                value={
                  compatible.some((item) => item.id === connection)
                    ? connection
                    : ""
                }
                onChange={(event) => setConnection(event.target.value)}
              >
                <option value="">选择连接</option>
                {compatible.map((x) => (
                  <option value={text(x.id)} key={text(x.id)}>
                    {text(x.label)}
                  </option>
                ))}
              </select>
            </label>
            {connections.value && !compatible.length && (
              <small>请先添加或启用与此操作匹配的上游连接。</small>
            )}
            {allowBackup && (
              <label>
                备用连接
                <select name="backup" key={operation + "|" + connection}>
                  <option value="">无需备用</option>
                  {compatible
                    .filter((item) => item.id !== connection)
                    .map((x) => (
                      <option value={text(x.id)} key={text(x.id)}>
                        {text(x.label)}
                      </option>
                    ))}
                </select>
                <small>备用连接需与主连接使用相同的额度域和数据区域。</small>
              </label>
            )}
            <Field name="model" label="对外模型 ID" />
            <Field name="upstream" label="上游模型 ID" />
            {isMedia && (
              <label>
                媒体能力（JSON）
                <textarea
                  key={operation}
                  name="capabilities"
                  defaultValue="{}"
                  rows={3}
                />
              </label>
            )}
            <div className="segments">
              <button
                type="submit"
                value="validate"
                disabled={saving}
                className="secondary"
              >
                校验草稿
              </button>
              <button type="submit" value="publish" disabled={saving}>
                发布路由
              </button>
            </div>
            {validation && <p role="status">{validation}</p>}
          </form>
          <ul className="rows">
            {routes.value?.data.map((x) => (
              <li key={text(x.id)}>
                {text(x.model)}
                <span>
                  v{text(x.version)} · {x.active ? "生效" : "历史"}{" "}
                  {!x.active && (
                    <button
                      className="secondary"
                      onClick={() => restore(text(x.id))}
                    >
                      重发版本
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </>
  );
}

function Governance({ project }: { project: Project }) {
  const base = projectURL(project.id);
  const members = useResource<{ data: Row[] }>(base + "/members");
  const audit = useResource<{ data: Row[] }>(base + "/audit-events");
  return (
    <>
      <Notice error={members.error || audit.error} />
      <div className="grid studio-grid">
        <Panel title="项目成员">
          <ul className="rows">
            {members.value?.data.map((x) => (
              <li key={text(x.id)}>
                {text(x.username)}
                <span>
                  {text(x.role)} · {x.enabled ? "启用" : "停用"}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title="最近审计">
          <ul className="rows">
            {audit.value?.data.map((x) => (
              <li key={text(x.id)}>
                {text(x.action)}
                <small>{text(x.created_at)}</small>
              </li>
            ))}
          </ul>
        </Panel>
        <BillingPanel project={project} />
      </div>
    </>
  );
}
