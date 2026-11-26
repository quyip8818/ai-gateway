import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import type { Model } from "../api";
import { Notice, Panel } from "../components";
import { jimeng } from "../products";

export function MediaComposer({
  base,
  models,
  operation,
  busy,
  setBusy,
  admin,
  selectOperation,
  onCreated,
}: {
  base: string;
  models: { value?: { data: Model[] }; error: string };
  operation: string;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  admin: boolean;
  selectOperation: (operation: string) => void;
  onCreated: (id: string) => void;
}) {
  const [model, setModel] = useState(""),
    [error, setError] = useState(""),
    idem = useRef<{ input: string; key: string } | undefined>(undefined),
    assetCache = useRef<{ file: File; id: string } | undefined>(undefined),
    request = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      if (request.current) {
        request.current.abort();
        setBusy(false);
      }
    },
    [setBusy],
  );
  const available = models.value?.data.filter((x) => x.operation === operation);
  const choice = available?.find((x) => x.id === model) ?? available?.[0];
  const inputRole =
    operation === "video.generate" ? "first_frame" : "reference_image";
  const acceptsReference =
    choice?.capabilities?.input_roles?.includes(inputRole);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!choice || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      let asset = "";
      const input = e.currentTarget.elements.namedItem("file");
      const file =
        input instanceof HTMLInputElement ? input.files?.[0] : undefined;
      if (acceptsReference && file?.size) {
        if (assetCache.current?.file === file) {
          asset = assetCache.current.id;
        } else {
          const body = new FormData();
          body.set("file", file);
          asset = (
            await api<{ asset_id: string }>(base + "/assets", body, "POST", {
              signal: controller.signal,
            })
          ).asset_id;
          assetCache.current = { file, id: asset };
        }
      }
      const body = {
        model: choice.id,
        operation: choice.operation,
        prompt: f.get("prompt"),
        spec: {
          aspect_ratio: f.get("ratio") || undefined,
          duration_seconds: Number(f.get("duration")) || undefined,
        },
        inputs: asset
          ? [
              {
                asset_id: asset,
                role: inputRole,
              },
            ]
          : undefined,
      };
      const raw = JSON.stringify(body);
      if (!idem.current || idem.current.input !== raw) {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        const key = Array.from(bytes, (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        idem.current = { input: raw, key };
      }
      const data = await api<{ id: string }>(base + "/jobs", body, "POST", {
        signal: controller.signal,
        headers: { "Idempotency-Key": idem.current.key },
      });
      if (controller.signal.aborted) return;
      idem.current = undefined;
      onCreated(data.id);
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message);
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <Panel title="创建任务">
      <Notice error={error} />
      <div
        className="segments studio-switch"
        role="group"
        aria-label="生成类型"
      >
        {jimeng.operations.map((type) => (
          <button
            type="button"
            key={type.id}
            disabled={busy}
            aria-pressed={operation === type.id}
            onClick={() => {
              if (operation === type.id) return;
              selectOperation(type.id);
              setModel("");
              setError("");
            }}
          >
            {type.label}
          </button>
        ))}
      </div>
      {!choice && (
        <div className="studio-empty">
          <p>
            {models.value
              ? "当前类型暂无可用模型。"
              : models.error
                ? "模型目录读取失败。"
                : "正在加载模型…"}
          </p>
          {models.value &&
            (admin ? (
              <Link to={"../admin?operation=" + operation}>
                前往项目管理发布路由 →
              </Link>
            ) : (
              <p>请联系项目管理员发布路由。</p>
            ))}
        </div>
      )}
      <form onSubmit={submit}>
        <label>
          模型
          <select
            required
            disabled={busy || !choice}
            value={choice?.id ?? ""}
            onChange={(e) => setModel(e.target.value)}
          >
            {!choice && <option value="">暂无可选模型</option>}
            {available?.map((x) => (
              <option key={x.id} value={x.id}>
                {x.id}
              </option>
            ))}
          </select>
        </label>
        <label>
          提示词
          <textarea
            name="prompt"
            required
            rows={5}
            placeholder="描述画面、风格、光线或镜头运动"
          />
        </label>
        <div className="media-options" key={operation + "|" + choice?.id}>
          {!!choice?.capabilities?.aspect_ratios?.length && (
            <label>
              画幅
              <select name="ratio">
                <option value="">使用默认值</option>
                {choice.capabilities.aspect_ratios.map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
          )}
          {!!choice?.capabilities?.duration_seconds?.length && (
            <label>
              时长
              <select name="duration">
                <option value="">使用默认值</option>
                {choice.capabilities.duration_seconds.map((v) => (
                  <option key={v} value={v}>
                    {v} 秒
                  </option>
                ))}
              </select>
            </label>
          )}
          {acceptsReference && (
            <label>
              {operation === "video.generate" ? "首帧图片" : "参考图片"}
              （可选）
              <input name="file" type="file" accept="image/*" />
            </label>
          )}
        </div>
        <button disabled={busy || !choice}>
          {busy ? "正在提交…" : "提交任务"}
        </button>
      </form>
    </Panel>
  );
}
