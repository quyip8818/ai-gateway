import { useState } from "react";
import { Link } from "react-router-dom";
import { date, operationName, usePages, useResource } from "../api";
import type { Collection, Job } from "../api";
import {
  Empty,
  Loading,
  Notice,
  Pager,
  Panel,
  Segments,
  Status,
} from "../components";

const views = [
  ["", "全部任务"],
  ["succeeded", "已完成"],
  ["failed", "失败"],
  ["submit_unknown", "待核验"],
] as const;

export function MediaLibrary({ base, root }: { base: string; root: string }) {
  const pages = usePages();
  const [status, setStatus] = useState("");
  const jobs = useResource<Collection<Job>>(
    base +
      "/jobs?" +
      new URLSearchParams({ cursor: pages.cursor, limit: "8", status }),
    pages.cursor ? 0 : 3000,
  );
  const next = jobs.value?.next_cursor;
  return (
    <Panel title="作品与任务">
      <Segments
        label="筛选任务"
        options={views}
        value={status}
        onChange={(value) => {
          setStatus(value);
          pages.reset();
        }}
      />
      <Notice error={jobs.error} retry={jobs.refresh} />
      {!jobs.value && !jobs.error && <Loading />}
      {jobs.value?.data.length === 0 && (
        <Empty title={status ? "没有此状态的任务" : "暂无任务"}>
          {!status && "生成图片或视频后，可在这里查看进度与成品。"}
        </Empty>
      )}
      {!!jobs.value?.data.length && (
        <ul className="media-library">
          {jobs.value.data.map((job) => (
            <MediaEntry key={job.id} job={job} base={base} root={root} />
          ))}
        </ul>
      )}
      <Pager
        previous={pages.previous}
        next={next ? () => pages.next(next) : undefined}
      />
    </Panel>
  );
}

function MediaEntry({
  job,
  base,
  root,
}: {
  job: Job;
  base: string;
  root: string;
}) {
  const detail = root + "/media/" + job.id;
  const asset = job.status === "succeeded" ? job.artifacts?.[0] : undefined;
  const url = asset
    ? base + "/jobs/" + job.id + "/artifacts/" + asset
    : undefined;
  const video = job.operation === "video.generate";
  return (
    <li className="media-entry">
      {url && <Preview key={url} url={url} video={video} detail={detail} />}
      <div className="media-entry-info">
        <div>
          <Link to={detail}>
            <strong>{operationName(job.operation)}</strong>
          </Link>
          <small>{job.model}</small>
          <small>{date(job.created_at)}</small>
        </div>
        <Status value={job.status} />
      </div>
      {job.status === "succeeded" && !url && (
        <small className="media-entry-note">成品已不可用</small>
      )}
    </li>
  );
}

function Preview({
  url,
  video,
  detail,
}: {
  url: string;
  video: boolean;
  detail: string;
}) {
  const [failed, setFailed] = useState(false);
  if (failed)
    return <div className="media-preview-unavailable">成品暂不可预览</div>;
  return (
    <>
      <Link
        className="media-preview"
        to={detail}
        aria-label={video ? "查看视频任务" : "查看图片任务"}
      >
        {video ? (
          <>
            <video
              muted
              playsInline
              preload="metadata"
              src={url}
              onError={() => setFailed(true)}
            />
            <span className="play-indicator" aria-hidden="true">
              ▶
            </span>
          </>
        ) : (
          <img
            src={url}
            loading="lazy"
            alt=""
            onError={() => setFailed(true)}
          />
        )}
      </Link>
      <a className="media-download" href={url} download>
        下载{video ? "视频" : "图片"}
      </a>
    </>
  );
}
