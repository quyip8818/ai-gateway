import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { projectURL, useResource } from "../api";
import type { Model, Project } from "../api";
import { Notice, PageHeading, Panel } from "../components";
import { products } from "../products";
import { SetupCheck } from "./setup-check";
import { setupSnippet } from "./setup-snippet";

export function Setup({ project }: { project: Project }) {
  const base = projectURL(project.id);
  const models = useResource<{ data: Model[] }>(base + "/models");
  const [params, setParams] = useSearchParams();
  const product =
    products.find((item) => item.id === params.get("product")) ?? products[0];
  const operation =
    product.operations.find((item) => item.id === params.get("operation")) ??
    product.operations[0];
  const op = operation.id;
  const isMedia = product.protocol === "media";
  const workspace = isMedia ? product.workspace + "?operation=" + op : "";
  const adminPath = "admin?operation=" + op;
  const keysPath =
    "keys?" + new URLSearchParams({ product: product.id, operation: op });
  const [selection, setSelection] = useState({ operation: "", model: "" });
  const [error, setError] = useState("");
  const model = selection.operation === op ? selection.model : "";
  const available = models.value?.data.filter((x) => x.operation === op) ?? [];
  const modelID = available.some((x) => x.id === model)
    ? model
    : (available[0]?.id ?? "");
  const snippet = modelID
    ? setupSnippet(product.protocol, location.origin, op, modelID)
    : "";
  return (
    <>
      <PageHeading
        title="产品接入"
        description="选择产品、配置模型并发送第一条请求。"
      >
        <Link className="action-link" to={keysPath}>
          管理 API 密钥
        </Link>
      </PageHeading>
      <Notice error={error || models.error} />
      <div className="client-picker" role="group" aria-label="接入方式">
        {products.map((item) => (
          <button
            type="button"
            key={item.id}
            aria-pressed={product.id === item.id}
            onClick={() => {
              setParams({ product: item.id });
              setError("");
            }}
          >
            <span className="client-icon" aria-hidden="true">
              {item.icon}
            </span>
            <span>
              <strong>{item.name}</strong>
              <small>{item.description}</small>
            </span>
          </button>
        ))}
      </div>
      <div className="grid studio-grid">
        <Panel title={isMedia ? product.name + " API 配置" : "客户端配置"}>
          {product.operations.length > 1 && (
            <div
              className="segments studio-switch"
              role="group"
              aria-label="生成类型"
            >
              {product.operations.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  aria-pressed={op === item.id}
                  onClick={() => {
                    setParams({ product: product.id, operation: item.id });
                    setError("");
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}
          <label>
            模型
            <select
              value={modelID}
              onChange={(e) => {
                setSelection({ operation: op, model: e.target.value });
              }}
            >
              <option value="" disabled>
                请选择模型
              </option>
              {available.map((x) => (
                <option key={x.id}>{x.id}</option>
              ))}
            </select>
          </label>
          {modelID ? (
            <>
              {isMedia && (
                <p className="muted">
                  用网关 API 密钥设置 <code>GATEWAY_KEY</code>
                  ，并为本次任务设置唯一的 <code>JOB_KEY</code>
                  。提交后携带同一密钥请求{" "}
                  <code>GET /media/v1/jobs/任务ID</code> 查看状态。
                </p>
              )}
              <pre>{snippet}</pre>
              <button
                className="secondary"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(snippet);
                    setError("");
                  } catch {
                    setError("复制失败，请手动复制");
                  }
                }}
              >
                {isMedia ? "复制命令" : "复制配置"}
              </button>
            </>
          ) : (
            <div className="studio-empty">
              {models.value ? (
                <>
                  <p>
                    {isMedia
                      ? "尚未发布" +
                        product.name +
                        "的" +
                        operation.label +
                        "模型。"
                      : "尚未发布此客户端可用的模型路由。"}
                  </p>
                  {project.role === "admin" ? (
                    <Link to={adminPath}>为{product.name}配置路由 →</Link>
                  ) : (
                    <p>请联系项目管理员发布路由。</p>
                  )}
                </>
              ) : (
                <p>{models.error ? "模型目录读取失败" : "正在加载模型…"}</p>
              )}
            </div>
          )}
          {isMedia ? (
            <Link className="studio-cta" to={workspace}>
              打开{product.name}创作 →
            </Link>
          ) : (
            <SetupCheck key={op} base={base} operation={op} model={modelID} />
          )}
        </Panel>
        <Panel title="接入步骤">
          <ol className="setup-steps">
            <li>
              <strong>准备模型路由</strong>
              <small>
                {available.length
                  ? "当前可用模型 " + available.length + " 个"
                  : "由管理员启用上游连接并发布模型。"}
              </small>
              {project.role === "admin" && (
                <Link to={adminPath}>管理连接和路由 →</Link>
              )}
            </li>
            <li>
              <strong>准备项目密钥</strong>
              <small>在外部客户端使用网关签发的 API 密钥。</small>
              <Link to={keysPath}>查看或创建密钥 →</Link>
            </li>
            <li>
              <strong>发送请求并查看结果</strong>
              <small>
                {isMedia
                  ? "在媒体工作台查看生成状态和成品。"
                  : "发送一条模型请求，或在请求记录中按 ID 排查。"}
              </small>
              <Link to={workspace || "requests"}>
                {isMedia ? "媒体工作台" : "请求记录"} →
              </Link>
            </li>
          </ol>
        </Panel>
      </div>
    </>
  );
}
