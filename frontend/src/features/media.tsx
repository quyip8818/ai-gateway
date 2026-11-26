import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, projectURL, useResource } from "../api";
import type { Job, Model, Project } from "../api";
import { Field, Notice, Panel, Status } from "../components";

export function Media({ project }: { project: Project }) {
  const [cursor, setCursor] = useState("");
  const base = projectURL(project.id) + "/media",
    models = useResource<{ data: Model[] }>(base + "/models"),
    jobs = useResource<{ data: Job[]; next_cursor?: string }>(
      base + "/jobs?" + new URLSearchParams({ cursor }),
      cursor ? 0 : 3000,
    );
  const [model, setModel] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    idem = useRef<{ input: string; key: string } | undefined>(undefined),
    assetCache = useRef<{ file: File; id: string } | undefined>(undefined),
    goto = useNavigate();
  const choice = models.value?.data.find(
    (x) => x.operation + "|" + x.id === model,
  );
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!choice) return;
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      let asset = "";
      const file = f.get("file");
      if (file instanceof File && file.size) {
        if (assetCache.current?.file === file) {
          asset = assetCache.current.id;
        } else {
          const body = new FormData();
          body.set("file", file);
          asset = (await api<{ asset_id: string }>(base + "/assets", body))
            .asset_id;
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
                role:
                  choice.operation === "video.generate"
                    ? "first_frame"
                    : "reference_image",
              },
            ]
          : undefined,
      };
      const raw = JSON.stringify(body);
      if (!idem.current || idem.current.input !== raw)
        idem.current = { input: raw, key: crypto.randomUUID() };
      const reply = await fetch(base + "/jobs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Gateway-CSRF": "1",
          "Idempotency-Key": idem.current.key,
        },
        body: raw,
      });
      const data = await reply.json();
      if (!reply.ok) throw new Error(data.error?.code ?? "提交失败");
      idem.current = undefined;
      goto(data.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <h1>媒体任务</h1>
      <Notice error={error || models.error || jobs.error} />
      <div className="grid">
        <Panel title="创建即梦任务">
          <form onSubmit={submit}>
            <label>
              模型与操作
              <select
                required
                value={model}
                onChange={(e) => setModel(e.target.value)}
              >
                <option value="">选择模型</option>
                {models.value?.data.map((x) => (
                  <option
                    key={x.operation + "|" + x.id}
                    value={x.operation + "|" + x.id}
                  >
                    {x.id} ·{" "}
                    {x.operation === "video.generate" ? "视频" : "图片"}
                  </option>
                ))}
              </select>
            </label>
            <label>
              提示词
              <textarea name="prompt" required rows={5} />
            </label>
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
            {!!choice?.capabilities?.input_roles?.length && (
              <Field
                label="参考素材"
                name="file"
                type="file"
                required={false}
              />
            )}
            <button disabled={busy || !choice}>
              {busy ? "正在提交…" : "提交任务"}
            </button>
          </form>
        </Panel>
        <Panel title="近期任务">
          {!jobs.value?.data.length ? (
            <p>暂无任务</p>
          ) : (
            <ul className="rows">
              {jobs.value.data.map((j) => (
                <li key={j.id}>
                  <Link to={j.id}>
                    {j.model}
                    <small>{j.id}</small>
                  </Link>
                  <Status value={j.status} />
                </li>
              ))}
            </ul>
          )}
          {cursor && (
            <button className="secondary" onClick={() => setCursor("")}>
              最新任务
            </button>
          )}
          {!!jobs.value?.next_cursor && (
            <button
              className="secondary"
              onClick={() => setCursor(jobs.value?.next_cursor ?? "")}
            >
              下一页
            </button>
          )}
        </Panel>
      </div>
    </>
  );
}
export function JobDetail({ project }: { project: Project }) {
  const { jobId } = useParams();
  const base = projectURL(project.id) + "/media/jobs/" + jobId;
  const [poll, setPoll] = useState(2500);
  const job = useResource<Job>(base, poll);
  const [error, setError] = useState("");
  useEffect(() => {
    if (
      job.value &&
      (["succeeded", "failed", "canceled"].includes(job.value.status) ||
        (job.value.status === "submit_unknown" && !job.value.recovery_pending))
    )
      setPoll(0);
  }, [job.value]);
  const data = job.value;
  return (
    <>
      <h1>媒体任务详情</h1>
      <Link to="../">返回任务</Link>
      <Notice error={error || job.error} />
      {data && (
        <Panel title={data.model}>
          <Status value={data.status} />
          <p>
            {data.progress !== undefined ? "进度 " + data.progress + "%" : null}
          </p>
          <Notice error={data.error?.code} />
          <p>即梦积分：{data.credits_used ?? "上游未报告"}</p>
          {data.status === "submit_unknown" && (
            <p>上游受理情况待核验，请使用请求 ID 排查。</p>
          )}
          <p>
            <Link
              to={
                "/app/projects/" + project.id + "/requests/" + data.request_id
              }
            >
              {data.request_id}
            </Link>
          </p>
          {data.status === "queued" && (
            <button
              onClick={() =>
                api(base + "/cancel", undefined, "POST")
                  .then(job.refresh)
                  .catch((e) => setError(e.message))
              }
            >
              取消排队
            </button>
          )}
          {data.artifacts.map((id) => {
            const url = base + "/artifacts/" + id;
            return (
              <figure className="artifact" key={id}>
                {data.operation === "video.generate" ? (
                  <video controls playsInline preload="metadata" src={url} />
                ) : (
                  <img src={url} loading="lazy" alt="即梦生成图片" />
                )}
                <figcaption>
                  <a href={url} download>
                    下载成品
                  </a>
                </figcaption>
              </figure>
            );
          })}
        </Panel>
      )}
    </>
  );
}
