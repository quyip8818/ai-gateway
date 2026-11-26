import { useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { api, projectURL, useResource } from "../api";
import type { Job, Model, Project } from "../api";
import { Notice, PageHeading, Panel, Status } from "../components";
import { jimeng } from "../products";
import { MediaComposer } from "./media-composer";

export function Media({ project }: { project: Project }) {
  const [params, setParams] = useSearchParams();
  const goto = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const library = params.get("view") === "library";
  const filter =
    jimeng.operations.find((item) => item.id === params.get("filter"))?.id ??
    "";
  const cursor = params.get("cursor") ?? "";
  const base = projectURL(project.id) + "/media",
    models = useResource<{ data: Model[] }>(library ? null : base + "/models"),
    jobs = useResource<{ data: Job[]; next_cursor?: string }>(
      base +
        "/jobs?" +
        new URLSearchParams({ cursor, operation: filter, limit: "12" }),
      { interval: cursor ? 0 : 3000 },
    );
  const operation =
    jimeng.operations.find((item) => item.id === params.get("operation"))?.id ??
    jimeng.operations.find((item) =>
      models.value?.data.some((model) => model.operation === item.id),
    )?.id ??
    jimeng.operations[0].id;
  function updateQuery(name: string, value: string) {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (value) next.set(name, value);
      else next.delete(name);
      if (name === "filter") next.delete("cursor");
      return next;
    });
  }
  return (
    <>
      <PageHeading
        title={library ? "媒体资源库" : "媒体工作台"}
        description={
          library
            ? "浏览图片与视频任务，打开详情查看和下载成品。"
            : "使用即梦生成图片和视频，查看任务进度并下载成品。"
        }
      >
        <button
          type="button"
          className="secondary"
          disabled={submitting}
          onClick={() => updateQuery("view", library ? "" : "library")}
        >
          {library ? "返回创作" : "打开资源库"}
        </button>
        <Link
          className="action-link"
          to={"../?product=jimeng&operation=" + operation}
        >
          即梦 API 接入
        </Link>
      </PageHeading>
      <Notice error={(!library && models.error) || jobs.error} />
      <div className={library ? undefined : "grid studio-grid media-workspace"}>
        {!library && (
          <MediaComposer
            base={base}
            models={models}
            operation={operation}
            busy={submitting}
            setBusy={setSubmitting}
            admin={project.role === "admin"}
            selectOperation={(value) => updateQuery("operation", value)}
            onCreated={(id) =>
              goto({ pathname: id, search: params.toString() })
            }
          />
        )}
        <Panel title="任务与成品">
          <div
            className="segments studio-switch"
            role="group"
            aria-label="筛选任务"
          >
            {[{ id: "", label: "全部" }, ...jimeng.operations].map((type) => (
              <button
                type="button"
                key={type.id}
                aria-pressed={filter === type.id}
                onClick={() => updateQuery("filter", type.id)}
              >
                {type.label}
              </button>
            ))}
          </div>
          {!jobs.value?.data.length ? (
            <div className="studio-empty media-empty">
              <p>
                {jobs.value
                  ? "这个分类还没有任务"
                  : jobs.error
                    ? "任务读取失败"
                    : "正在加载任务…"}
              </p>
              {jobs.value && !filter && !cursor && (
                <small>提交任务后，可在这里查看状态和成品。</small>
              )}
            </div>
          ) : (
            <ul className="media-gallery">
              {jobs.value.data.map((job) => {
                const video = job.operation === "video.generate";
                const preview =
                  job.artifacts[0] &&
                  base + "/jobs/" + job.id + "/artifacts/" + job.artifacts[0];
                return (
                  <li key={job.id}>
                    <Link to={{ pathname: job.id, search: params.toString() }}>
                      <div className="media-preview">
                        {preview ? (
                          video ? (
                            <video
                              muted
                              playsInline
                              preload="metadata"
                              src={preview + "#t=0.1"}
                            />
                          ) : (
                            <img
                              src={preview}
                              alt="生成图片预览"
                              loading="lazy"
                            />
                          )
                        ) : (
                          <span aria-hidden="true">{video ? "▷" : "✧"}</span>
                        )}
                        <span className="media-type">
                          {video ? (preview ? "▷ 视频" : "视频") : "图片"}
                        </span>
                      </div>
                      <div className="media-card-body">
                        <strong>{job.model}</strong>
                        <Status value={job.status} />
                        <small>
                          {new Date(job.created_at).toLocaleString("zh-CN", {
                            dateStyle: "short",
                            timeStyle: "short",
                          })}
                        </small>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="segments">
            {cursor && (
              <button
                className="secondary"
                onClick={() => updateQuery("cursor", "")}
              >
                最新任务
              </button>
            )}
            {!!jobs.value?.next_cursor && (
              <button
                className="secondary"
                onClick={() =>
                  updateQuery("cursor", jobs.value?.next_cursor ?? "")
                }
              >
                下一页
              </button>
            )}
          </div>
        </Panel>
      </div>
    </>
  );
}
export function JobDetail({ project }: { project: Project }) {
  const { jobId } = useParams();
  const [params] = useSearchParams();
  const library = params.get("view") === "library";
  const base = projectURL(project.id) + "/media/jobs/" + jobId;
  const job = useResource<Job>(base, { interval: 2500, stop: jobFinished });
  const [error, setError] = useState("");
  const [canceling, setCanceling] = useState(false);
  const data = job.value;
  async function cancel() {
    setCanceling(true);
    setError("");
    try {
      await api(base + "/cancel", undefined, "POST");
      job.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCanceling(false);
    }
  }
  return (
    <>
      <PageHeading title="媒体任务详情">
        <Link
          className="action-link"
          to={{ pathname: "../media", search: params.toString() }}
        >
          {library ? "返回资源库" : "返回媒体工作台"}
        </Link>
      </PageHeading>
      <Notice error={error || job.error} />
      {data && (
        <Panel title={data.model}>
          <Status value={data.status} />
          {data.progress !== undefined && <p>进度 {data.progress}%</p>}
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
            <button disabled={canceling} onClick={cancel}>
              {canceling ? "正在取消…" : "取消排队"}
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

function jobFinished(job: Job) {
  return (
    ["succeeded", "failed", "canceled"].includes(job.status) ||
    (job.status === "submit_unknown" && !job.recovery_pending)
  );
}
