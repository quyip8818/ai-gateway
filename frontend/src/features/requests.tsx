import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { projectURL, text, useResource } from "../api";
import type { Project, Row } from "../api";
import { Notice, Panel, Status } from "../components";

export function RequestList({ project }: { project: Project }) {
  const [search, setSearch] = useState(""),
    [id, setID] = useState(""),
    [cursor, setCursor] = useState("");
  const result = useResource<{ data: Row[]; next_cursor?: string }>(
    projectURL(project.id) +
      "/requests?" +
      new URLSearchParams({ id: search, cursor }),
  );
  return (
    <>
      <h1>请求记录</h1>
      <Notice error={result.error} />
      <Panel title="定位请求">
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(id.trim());
            setCursor("");
          }}
        >
          <label>
            网关请求 ID
            <input value={id} onChange={(e) => setID(e.target.value)} />
          </label>
          <button>查询</button>
        </form>
        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>请求 ID</th>
                <th>模型</th>
                <th>状态</th>
                <th>时间</th>
              </tr>
            </thead>
            <tbody>
              {result.value?.data.map((row) => (
                <tr key={text(row.id)}>
                  <td>
                    <Link to={text(row.id)}>{text(row.id)}</Link>
                  </td>
                  <td>{text(row.model)}</td>
                  <td>
                    <Status value={row.status} />
                  </td>
                  <td>{text(row.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!result.value?.data.length && <p>暂无符合条件的请求</p>}
        {cursor && (
          <button className="secondary" onClick={() => setCursor("")}>
            最新请求
          </button>
        )}
        {!!result.value?.next_cursor && (
          <button
            className="secondary"
            onClick={() => setCursor(result.value?.next_cursor ?? "")}
          >
            下一页
          </button>
        )}
      </Panel>
    </>
  );
}
export function RequestDetail({ project }: { project: Project }) {
  const { requestId } = useParams();
  const result = useResource<Row>(
    projectURL(project.id) + "/requests/" + requestId,
  );
  const d = result.value;
  return (
    <>
      <h1>请求详情</h1>
      <p className="mono">{requestId}</p>
      <Notice error={result.error} />
      {d && (
        <Panel title={text(d.model)}>
          <Status value={d.status} />
          <p>
            路由版本 {text(d.route_version)} · 阶段 {text(d.failure_stage)} ·
            错误 {text(d.error_code)}
          </p>
          {Boolean(d.job_id) && (
            <Link
              to={"/app/projects/" + project.id + "/media/" + text(d.job_id)}
            >
              查看媒体任务
            </Link>
          )}
          <h3>上游尝试与用量</h3>
          <pre>{JSON.stringify(d.attempts, null, 2)}</pre>
        </Panel>
      )}
    </>
  );
}
