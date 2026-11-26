import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, projectURL, useResource, workspaceURL } from "../api";
import type { Collection, Key, Model, Pool, Project } from "../api";
import {
  Copy,
  Empty,
  Loading,
  Notice,
  Page,
  Panel,
  Segments,
  Status,
} from "../components";

const clients = [
  ["responses", "Codex"],
  ["messages", "Claude Code"],
] as const;
type Check = { status: string; id?: string };
const checkDone = (value: Check) => value.status === "succeeded";

export function Setup({ project }: { project: Project }) {
  const base = projectURL(project.id);
  const root = workspaceURL(project);
  const admin = project.role === "admin";
  const [params] = useSearchParams();
  const models = useResource<Collection<Model>>(base + "/models");
  const keys = useResource<Collection<Key>>(base + "/keys");
  const pools = useResource<Collection<Pool>>(admin ? base + "/pools" : null);
  const [operation, setOperation] = useState("");
  const [selection, setSelection] = useState("");
  const [pickedKey, setPickedKey] = useState<string>();
  const activeKeys = keys.value?.data.filter((key) => !key.revoked_at) ?? [];
  const selectedKey =
    activeKeys.find((key) => key.id === (pickedKey ?? params.get("key"))) ??
    (!pickedKey && !params.get("key") && activeKeys.length === 1
      ? activeKeys[0]
      : undefined);
  const directory = models.value?.data ?? [];
  const permitted = directory.filter(
    (model) =>
      !selectedKey || selectedKey.pools.includes(model.id.split("/")[0]),
  );
  const client =
    operation ||
    clients.find(([id]) =>
      permitted.some((model) => model.operation === id),
    )?.[0] ||
    "responses";
  const options = permitted.filter((model) => model.operation === client);
  const model = options.find((item) => item.id === selection) ?? options[0];
  const clientName = clients.find(([id]) => client === id)?.[1];
  const mediaCount = directory.filter(
    (item) =>
      item.operation === "image.generate" ||
      item.operation === "video.generate",
  ).length;

  return (
    <Page
      title="使用网关"
      description="按客户端选择公开模型，复制配置并验证首条请求。"
      actions={
        <Link className="button secondary" to={root + "/media"}>
          打开媒体创作 <span aria-hidden="true">↗</span>
        </Link>
      }
    >
      {admin && pools.value && keys.value && (
        <div className="steps" aria-label="接入流程">
          <Link to={root + "/admin"}>
            <span>{pools.value.data.length ? "✓" : "1"}</span>
            <div>
              <strong>添加上游账号</strong>
              <small>
                {pools.value.data.length
                  ? pools.value.data.length + " 个账号池"
                  : "验证凭证并自动入池"}
              </small>
            </div>
            <b aria-hidden="true">↗</b>
          </Link>
          <Link to={root + "/keys"}>
            <span>{activeKeys.length ? "✓" : "2"}</span>
            <div>
              <strong>签发调用密钥</strong>
              <small>
                {activeKeys.length
                  ? activeKeys.length + " 把启用密钥"
                  : "为客户端授权账号池"}
              </small>
            </div>
            <b aria-hidden="true">↗</b>
          </Link>
          <a href="#client-config">
            <span>3</span>
            <div>
              <strong>配置客户端</strong>
              <small>发送首条请求并验证</small>
            </div>
            <b aria-hidden="true">↓</b>
          </a>
        </div>
      )}
      <div id="client-config" className="columns">
        <Panel title="客户端配置">
          <Segments
            label="客户端"
            value={client}
            options={clients}
            onChange={(value) => {
              setOperation(value);
              setSelection("");
            }}
          />
          <Notice error={models.error} retry={models.refresh} />
          <Notice error={keys.error} retry={keys.refresh} />
          {!models.value && !models.error && <Loading />}
          {activeKeys.length > 0 && (
            <label>
              调用密钥
              <select
                value={selectedKey?.id ?? ""}
                onChange={(e) => {
                  setPickedKey(e.target.value);
                  setSelection("");
                  setOperation("");
                }}
              >
                <option value="">查看项目模型</option>
                {activeKeys.map((key) => (
                  <option key={key.id} value={key.id}>
                    {key.label} · {key.prefix}
                  </option>
                ))}
              </select>
            </label>
          )}
          {model ? (
            <>
              {options.length > 1 && (
                <label>
                  公开模型
                  <select
                    value={model.id}
                    onChange={(e) => setSelection(e.target.value)}
                  >
                    {options.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.id}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <ClientConfig
                key={client + model.id}
                client={client}
                name={clientName ?? ""}
                model={model}
              />
            </>
          ) : (
            models.value && (
              <Empty
                title={
                  selectedKey
                    ? "此密钥未授权可用模型"
                    : "当前客户端暂无可用模型"
                }
              >
                {admin && !selectedKey ? (
                  <Link to={root + "/admin"}>查看上游账号</Link>
                ) : (
                  "试试其他客户端，或请管理员检查账号池授权。"
                )}
              </Empty>
            )
          )}
        </Panel>
        <div className="stack">
          <Panel title="验证首条请求">
            {model && selectedKey ? (
              <SetupCheck
                key={client + ":" + model.id + ":" + selectedKey.id}
                base={base}
                root={root}
                operation={client}
                model={model.id}
                keyID={selectedKey.id}
              />
            ) : (
              <p className="muted">
                选择一把能访问公开模型的调用密钥，然后在客户端发出一条请求。
              </p>
            )}
            {!selectedKey && <Link to={root + "/keys"}>查看调用密钥</Link>}
          </Panel>
          <Panel title="网页媒体创作">
            <p className="muted">
              {mediaCount
                ? "使用项目会话生成图片或视频，跟踪任务并下载成品。"
                : "项目暂无可用的图片或视频模型。"}
            </p>
            <Link to={root + "/media"}>打开创作工作区 →</Link>
          </Panel>
        </div>
      </div>
    </Page>
  );
}

function ClientConfig({
  client,
  name,
  model,
}: {
  client: string;
  name: string;
  model: Model;
}) {
  const codex = client === "responses";
  const origin = window.location.origin;
  const config = codex
    ? `model_provider = "gateway"\nmodel = ${JSON.stringify(model.id)}\n\n[model_providers.gateway]\nname = "AI Gateway"\nbase_url = "${origin}/openai/v1"\nenv_key = "GATEWAY_KEY"\nwire_api = "responses"\nsupports_websockets = false`
    : [
        "env -u ANTHROPIC_API_KEY",
        `  ANTHROPIC_BASE_URL="${origin}/anthropic"`,
        '  ANTHROPIC_AUTH_TOKEN="$GATEWAY_KEY"',
        `  ANTHROPIC_MODEL='${model.id.replaceAll("'", "'\\''")}'`,
        "  claude",
      ].join(" \\\n");
  return (
    <>
      <div className="model-summary">
        <strong>{name}</strong>
        <small>实际上游 {model.provider_name ?? model.provider}</small>
        <code>{model.id}</code>
      </div>
      <p className="muted">
        先将调用密钥设置为环境变量 <code>GATEWAY_KEY</code>。
        {codex
          ? "将配置合并到 ~/.codex/config.toml。"
          : "运行以下命令启动 Claude Code。"}
      </p>
      <div className="code-block">
        <div>
          <span>{codex ? "config.toml" : "Shell"}</span>
          <Copy value={config} label="复制配置" />
        </div>
        <pre>{config}</pre>
      </div>
    </>
  );
}

function SetupCheck({
  base,
  root,
  operation,
  model,
  keyID,
}: {
  base: string;
  root: string;
  operation: string;
  model: string;
  keyID: string;
}) {
  const [id, setID] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const result = useResource<Check>(
    id ? base + "/setup/checks/" + id : null,
    2000,
    checkDone,
  );
  async function start(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      setID(
        (
          await api<{ id: string }>(base + "/setup/checks", {
            key_id: keyID,
            operation,
            model,
          })
        ).id,
      );
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const status = result.value?.status;
  return (
    <form onSubmit={start}>
      <p className="muted">
        {id
          ? "请用已选密钥和模型发送一条请求。此处会显示调用结果。"
          : "开始验证后，在客户端发送请求即可检查配置。"}
      </p>
      <Notice error={error || result.error} />
      {id && !result.error && (
        <div className="inline" aria-live="polite">
          <Status value={status ?? "waiting"} />
          {result.value?.id && (
            <Link to={root + "/requests/" + result.value.id}>查看请求</Link>
          )}
        </div>
      )}
      <button className="secondary" disabled={busy}>
        {busy ? "正在开始…" : id ? "重新验证" : "开始验证"}
      </button>
    </form>
  );
}
