import { useState } from "react";
import type { FormEvent } from "react";
import { api, projectURL, text, useResource } from "../api";
import type { Project, Row } from "../api";
import { Field, Notice, Panel } from "../components";

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
  const base = projectURL(project.id),
    connections = useResource<{ data: Row[] }>(base + "/connections"),
    routes = useResource<{ data: Row[] }>(base + "/routes");
  const members = useResource<{ data: Row[] }>(base + "/members"),
    audit = useResource<{ data: Row[] }>(base + "/audit-events");
  const [err, setErr] = useState("");
  async function probeConnection(id: string) {
    try {
      await api(base + "/connections/" + id + "/probe", undefined, "POST");
      connections.refresh();
    } catch (x) {
      setErr((x as Error).message);
    }
  }
  async function connectionState(id: string, enabled: boolean) {
    try {
      await api(base + "/connections/" + id, { enabled }, "PATCH");
      connections.refresh();
      audit.refresh();
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
      audit.refresh();
      setErr("");
      setValidation("已重发历史路由");
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  async function submit(e: FormEvent<HTMLFormElement>, save: string) {
    e.preventDefault();
    const form = e.currentTarget;
    const mode = (e.nativeEvent as SubmitEvent).submitter?.getAttribute(
      "value",
    );
    const effectivePath =
      save === "/routes/publish" && mode === "validate"
        ? "/routes/validate"
        : save;
    const body: Row = Object.fromEntries(new FormData(form));
    try {
      if ("capabilities" in body)
        body.capabilities = JSON.parse(text(body.capabilities) || "{}");
      if (save === "/connections")
        body.videoIdempotencyVerified = body.videoIdempotencyVerified === "on";
      setValidation("");
      await api(base + effectivePath, body);
      if (effectivePath === "/routes/validate") {
        setValidation("草稿校验通过");
        setErr("");
        return;
      }
      form.reset();
      connections.refresh();
      routes.refresh();
      audit.refresh();
      setErr("");
    } catch (x) {
      setErr((x as Error).message);
    }
  }
  return (
    <>
      <h1>项目管理</h1>
      <Notice error={err || connections.error || routes.error} />
      <div className="grid">
        <Panel title="上游连接">
          <form onSubmit={(e) => submit(e, "/connections")}>
            <label>
              供应商
              <select name="provider">
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="jimeng">即梦</option>
              </select>
            </label>
            <Field label="名称" name="label" />
            <Field label="上游地址" name="base" type="url" />
            <Field label="上游凭证" name="token" type="password" />
            <Field label="共享额度域" name="quota" />
            <Field label="上游数据区域" name="region" required={false} />
            <label className="inline">
              <input
                type="checkbox"
                name="videoIdempotencyVerified"
                style={{ width: "auto" }}
              />
              已验证即梦视频幂等协议
            </label>
            <button>保存连接</button>
          </form>
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
              <select name="operation">
                {[
                  "responses",
                  "messages",
                  "image.generate",
                  "video.generate",
                ].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </label>
            <label>
              连接
              <select name="connection" required>
                <option value="">选择连接</option>
                {connections.value?.data.map((x) => (
                  <option value={text(x.id)} key={text(x.id)}>
                    {text(x.label)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              备用连接
              <select name="backup">
                <option value="">无需备用</option>
                {connections.value?.data.map((x) => (
                  <option value={text(x.id)} key={text(x.id)}>
                    {text(x.label)}
                  </option>
                ))}
              </select>
            </label>
            <Field name="model" label="对外模型 ID" />
            <Field name="upstream" label="上游模型 ID" />
            <label>
              媒体能力（JSON）
              <textarea name="capabilities" defaultValue="{}" rows={3} />
            </label>
            <div className="segments">
              <button type="submit" value="validate" className="secondary">
                校验草稿
              </button>
              <button type="submit" value="publish">
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
