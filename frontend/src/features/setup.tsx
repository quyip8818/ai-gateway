import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, projectURL, text, useResource } from "../api";
import type { Key, Model, Project, Row } from "../api";
import { Field, Notice, Panel, Status } from "../components";

export function Setup({ project }: { project: Project }) {
  const base = projectURL(project.id),
    keys = useResource<{ data: Key[] }>(base + "/keys"),
    models = useResource<{ data: Model[] }>(base + "/models");
  const [op, setOp] = useState("responses"),
    [model, selectModel] = useState(""),
    [key, selectKey] = useState(""),
    [checkID, setCheckID] = useState(""),
    [secret, setSecret] = useState(""),
    [error, setError] = useState(""),
    [check, setCheck] = useState<Row>();
  const available = models.value?.data.filter((x) => x.operation === op) ?? [];
  const modelID = available.some((x) => x.id === model)
    ? model
    : (available[0]?.id ?? "");
  useEffect(() => {
    if (!checkID) return;
    let active = true;
    const run = () =>
      api<Row>(base + "/setup/checks/" + checkID)
        .then((value) => {
          if (active) setCheck(value);
        })
        .catch((e) => {
          if (active) {
            setError(e.message);
            setCheckID("");
          }
        });
    void run();
    const timer = setInterval(run, 2500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [base, checkID]);
  async function startCheck() {
    setError("");
    setCheck(undefined);
    try {
      const result = await api<{ id: string }>(base + "/setup/checks", {
        key_id: key,
        model: modelID,
        operation: op,
      });
      setCheckID(result.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const config =
    op === "responses"
      ? `model_provider = "team-gateway"\nmodel = ${JSON.stringify(modelID)}\n\n[model_providers.team-gateway]\nname = "AI Gateway"\nbase_url = "${location.origin}/openai/v1"\nenv_key = "GATEWAY_KEY"\nwire_api = "responses"\nsupports_websockets = false`
      : `export ANTHROPIC_BASE_URL="${location.origin}/anthropic"\nexport ANTHROPIC_AUTH_TOKEN="$GATEWAY_KEY"${modelID ? "\nexport ANTHROPIC_MODEL=" + JSON.stringify(modelID) : ""}`;
  const action = async (path: string, body?: unknown) => {
    try {
      setError("");
      const x = await api<{ key?: string; id?: string }>(
        base + path,
        body,
        "POST",
      );
      if (x?.key) {
        setSecret(x.key);
        selectKey(x.id ?? "");
      }
      keys.refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <>
      <h1>接入工作区</h1>
      <p className="muted">配置客户端并确认第一条模型请求。</p>
      <Notice error={error || keys.error || models.error} />
      <div className="grid">
        <Panel title="客户端配置">
          <div className="segments">
            <button
              className={op === "responses" ? "" : "secondary"}
              onClick={() => {
                setOp("responses");
                setCheckID("");
                setCheck(undefined);
              }}
            >
              Codex
            </button>
            <button
              className={op === "messages" ? "" : "secondary"}
              onClick={() => {
                setOp("messages");
                setCheckID("");
                setCheck(undefined);
              }}
            >
              Claude Code
            </button>
          </div>
          <label>
            模型
            <select
              value={modelID}
              onChange={(e) => {
                selectModel(e.target.value);
                setCheckID("");
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
              <pre>{config}</pre>
              <button
                className="secondary"
                onClick={() =>
                  navigator.clipboard
                    .writeText(config)
                    .catch(() => setError("复制失败，请手动复制"))
                }
              >
                复制配置
              </button>
            </>
          ) : (
            <p>请先发布此客户端可用的模型路由。</p>
          )}
          <label>
            验证使用的密钥
            <select
              value={key}
              onChange={(e) => {
                selectKey(e.target.value);
                setCheckID("");
              }}
            >
              <option value="">选择密钥</option>
              {keys.value?.data
                .filter((x) => !x.revoked_at)
                .map((x) => (
                  <option value={x.id} key={x.id}>
                    {x.label}
                  </option>
                ))}
            </select>
          </label>
          <button disabled={!modelID || !key} onClick={startCheck}>
            开始验证
          </button>
          {checkID && (
            <p>
              使用该配置发送生成请求。{" "}
              <Status value={check?.status ?? "waiting"} />
              {Boolean(check?.id) && (
                <Link to={"requests/" + text(check?.id)}> 查看请求</Link>
              )}
            </p>
          )}
        </Panel>
        <Panel title="API 密钥">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = e.currentTarget;
              void action("/keys", Object.fromEntries(new FormData(f)));
              f.reset();
            }}
          >
            <Field name="label" label="密钥名称" />
            <button>创建密钥</button>
          </form>
          {secret && (
            <div className="warning">
              本密钥只显示一次。<pre>{secret}</pre>
              <button className="secondary" onClick={() => setSecret("")}>
                关闭
              </button>
            </div>
          )}
          <ul className="rows">
            {keys.value?.data.map((x) => (
              <li key={x.id}>
                <div>
                  {x.label}
                  <small>
                    {x.prefix} · {x.revoked_at ? "已撤销" : "启用"}
                  </small>
                </div>
                {!x.revoked_at && (
                  <div className="segments">
                    <button
                      className="secondary"
                      onClick={() => {
                        if (confirm("轮换会立即撤销旧密钥，继续？"))
                          void action("/keys/" + x.id + "/rotate");
                      }}
                    >
                      轮换
                    </button>
                    <button
                      className="secondary"
                      onClick={() => {
                        if (confirm("撤销此密钥？"))
                          void action("/keys/" + x.id + "/revoke");
                      }}
                    >
                      撤销
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </>
  );
}
