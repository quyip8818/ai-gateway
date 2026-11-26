import { useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  api,
  date,
  operationName,
  projectURL,
  useResource,
  workspaceURL,
} from "../api";
import type { Collection, Job, Model, Project } from "../api";
import {
  Definition,
  Empty,
  Loading,
  Notice,
  Page,
  Panel,
  Segments,
  Status,
} from "../components";

import { MediaLibrary } from "./media-library";

const formats = [
  ["image.generate", "图片"],
  ["video.generate", "视频"],
] as const;
const terminal = (job: Job) =>
  ["succeeded", "failed", "canceled", "submit_unknown"].includes(job.status);
const inputLabels: Record<string, string> = {
  first_frame: "首帧",
  reference_image: "参考图",
};

function referenceRole(operation: string) {
  return operation === "video.generate" ? "first_frame" : "reference_image";
}

export function Media({ project }: { project: Project }) {
  const base = projectURL(project.id) + "/media";
  const root = workspaceURL(project);
  const navigate = useNavigate();
  const models = useResource<Collection<Model>>(base + "/models");
  const [mode, setMode] = useState("");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const directory = models.value?.data ?? [];
  const operation =
    mode ||
    formats.find(([id]) =>
      directory.some((item) => item.operation === id),
    )?.[0] ||
    "image.generate";
  const options = directory.filter((item) => item.operation === operation);
  const choice = options.find((item) => item.id === model) ?? options[0];
  const idem = useRef<{ body: string; key: string } | undefined>(undefined);
  const upload = useRef<{ file: File; id: string } | undefined>(undefined);
  const fileInput = useRef<HTMLInputElement>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!choice || busy || !prompt.trim()) return;
    const form = new FormData(e.currentTarget);
    const file = fileInput.current?.files?.[0];
    setBusy(true);
    setError("");
    try {
      if (new TextEncoder().encode(prompt.trim()).length > 32000)
        throw new Error("提示词超过 32,000 字节。");
      let asset = "";
      if (file) {
        if (file.size > 12 * 1024 * 1024) throw new Error("file_too_large");
        if (upload.current?.file !== file) {
          const body = new FormData();
          body.set("file", file);
          upload.current = {
            file,
            id: (await api<{ asset_id: string }>(base + "/assets", body))
              .asset_id,
          };
        }
        asset = upload.current.id;
      }
      const payload = {
        model: choice.id,
        operation: choice.operation,
        prompt: prompt.trim(),
        spec: {
          aspect_ratio: form.get("ratio") || undefined,
          duration_seconds: Number(form.get("duration")) || undefined,
        },
        inputs: asset
          ? [
              {
                asset_id: asset,
                role: referenceRole(choice.operation),
              },
            ]
          : undefined,
      };
      const body = JSON.stringify(payload);
      if (idem.current?.body !== body)
        idem.current = { body, key: crypto.randomUUID() };
      const job = await api<Job>(base + "/jobs", payload, "POST", undefined, {
        "Idempotency-Key": idem.current.key,
      });
      navigate(root + "/media/" + job.id);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page
      title="媒体创作"
      description="生成图片和视频。提交后可离开页面，稍后查看结果。"
    >
      <div className="columns media-columns">
        <Panel title="新建任务">
          <Segments
            label="创作类型"
            value={operation}
            options={formats}
            disabled={busy}
            onChange={(value) => {
              setMode(value);
              setModel("");
              setError("");
            }}
          />
          <Notice error={models.error} retry={models.refresh} />
          {!models.value && !models.error && <Loading />}
          {models.value && !choice && (
            <Empty
              title={
                operation === "image.generate"
                  ? "暂无可用图片模型"
                  : "暂无可用视频模型"
              }
            >
              {project.role === "admin" ? (
                <Link to={root + "/admin"}>查看上游账号</Link>
              ) : (
                "请联系项目管理员开通媒体能力。"
              )}
            </Empty>
          )}
          {choice && (
            <form onSubmit={submit}>
              {options.length > 1 && (
                <label>
                  模型
                  <select
                    disabled={busy}
                    value={choice.id}
                    onChange={(e) => setModel(e.target.value)}
                  >
                    {options.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.id}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                提示词
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder={
                    operation === "image.generate"
                      ? "描述你想生成的画面…"
                      : "描述画面、动作和镜头…"
                  }
                  rows={6}
                  required
                  disabled={busy}
                />
              </label>
              <Options
                key={operation + ":" + choice.id}
                model={choice}
                fileInput={fileInput}
                busy={busy}
              />
              <Notice error={error} />
              <div className="actions">
                <button disabled={busy || !prompt.trim()}>
                  {busy
                    ? "正在提交…"
                    : operation === "image.generate"
                      ? "生成图片"
                      : "生成视频"}
                </button>
              </div>
            </form>
          )}
        </Panel>
        <MediaLibrary base={base} root={root} />
      </div>
    </Page>
  );
}

function Options({
  model,
  fileInput,
  busy,
}: {
  model: Model;
  fileInput: React.RefObject<HTMLInputElement | null>;
  busy: boolean;
}) {
  const ratios = model.capabilities?.aspect_ratios ?? [];
  const durations = model.capabilities?.duration_seconds ?? [];
  const role = referenceRole(model.operation);
  const hasReference = model.capabilities?.input_roles?.includes(role) ?? false;
  if (!ratios.length && !durations.length && !hasReference) return null;
  return (
    <details>
      <summary>生成选项</summary>
      <div className="form-options">
        {!!ratios.length && (
          <label>
            画幅
            <select name="ratio" disabled={busy}>
              <option value="">使用默认值</option>
              {ratios.map((ratio) => (
                <option key={ratio}>{ratio}</option>
              ))}
            </select>
          </label>
        )}
        {!!durations.length && (
          <label>
            时长
            <select name="duration" disabled={busy}>
              <option value="">使用默认值</option>
              {durations.map((duration) => (
                <option key={duration} value={duration}>
                  {duration} 秒
                </option>
              ))}
            </select>
          </label>
        )}
        {hasReference && (
          <label>
            {inputLabels[role]}
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={busy}
            />
          </label>
        )}
      </div>
    </details>
  );
}

export function JobDetail({ project }: { project: Project }) {
  const { jobId } = useParams();
  const root = workspaceURL(project);
  const base = projectURL(project.id) + "/media/jobs/" + jobId;
  const job = useResource<Job>(base, 2500, terminal);
  const [canceling, setCanceling] = useState(false);
  const [error, setError] = useState("");
  const data = job.value;
  async function cancel() {
    setCanceling(true);
    setError("");
    try {
      await api(base + "/cancel", undefined, "POST");
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      job.refresh();
      setCanceling(false);
    }
  }
  return (
    <Page
      title={data ? operationName(data.operation) + "任务" : "媒体任务"}
      actions={
        <Link className="button secondary" to={root + "/media"}>
          返回媒体创作
        </Link>
      }
    >
      <Notice error={job.error} retry={job.refresh} />
      {!data && !job.error && <Loading />}
      {data && (
        <div className="columns">
          <Panel title="生成结果" actions={<Status value={data.status} />}>
            <Notice
              error={
                error ||
                (data.error?.code === "download_host_not_allowed"
                  ? "成品下载地址待确认。管理员可在即梦接入设置中添加可信 CDN 主机名，任务会自动重试。"
                  : data.error?.code)
              }
            />
            {data.status === "submit_unknown" && (
              <Empty title="上游受理情况待核验">
                在请求记录中查看尝试详情。请先确认上游状态，再决定是否重新提交。
              </Empty>
            )}
            {data.status === "queued" && (
              <Empty title="任务正在排队">
                <button
                  className="secondary"
                  disabled={canceling}
                  onClick={() => void cancel()}
                >
                  {canceling ? "正在取消…" : "取消排队"}
                </button>
              </Empty>
            )}
            {!terminal(data) && data.status !== "queued" && (
              <div className="empty" role="status">
                <strong>正在处理任务</strong>
                {data.progress != null && (
                  <progress
                    max="100"
                    value={data.progress}
                    aria-label="生成进度"
                  />
                )}
              </div>
            )}
            {data.status === "canceled" && <Empty title="任务已取消" />}
            {data.status === "succeeded" && !data.artifacts?.length && (
              <Empty title="成品已不可用">
                文件可能已过保留期，任务记录仍可查看。
              </Empty>
            )}
            {data.artifacts?.map((id) => (
              <Artifact
                key={id}
                url={base + "/artifacts/" + id}
                video={data.operation === "video.generate"}
              />
            ))}
          </Panel>
          <Panel title="任务信息">
            <Definition
              items={[
                ["模型", <code>{data.model}</code>],
                ["提交时间", date(data.created_at)],
                ["最近更新", date(data.updated_at)],
                ["上游积分", data.credits_used ?? "上游未报告"],
                ["任务 ID", <code>{data.id}</code>],
                [
                  "请求记录",
                  <Link to={root + "/requests/" + data.request_id}>
                    {data.request_id}
                  </Link>,
                ],
              ]}
            />
          </Panel>
        </div>
      )}
    </Page>
  );
}

function Artifact({ url, video }: { url: string; video: boolean }) {
  const [failed, setFailed] = useState(false);
  return (
    <figure className="artifact">
      {failed ? (
        <Empty title="无法读取成品">文件可能已过保留期。</Empty>
      ) : video ? (
        <video
          controls
          playsInline
          preload="metadata"
          src={url}
          onError={() => setFailed(true)}
        />
      ) : (
        <img
          src={url}
          loading="lazy"
          alt="生成的图片"
          onError={() => setFailed(true)}
        />
      )}
      {!failed && (
        <figcaption>
          <a className="button secondary" href={url} download>
            下载成品
          </a>
        </figcaption>
      )}
    </figure>
  );
}
