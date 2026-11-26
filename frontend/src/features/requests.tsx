import { operationLabel } from "../products";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { projectURL, text, useResource } from "../api";
import type { Project, Row } from "../api";
import { Notice, PageHeading, Panel, Status } from "../components";

export function RequestList({ project }: { project: Project }) {
  const [search, setSearch] = useState({ id: "", model: "", status: "" }),
    [cursor, setCursor] = useState("");
  const result = useResource<{ data: Row[]; next_cursor?: string }>(
    projectURL(project.id) +
      "/requests?" +
      new URLSearchParams({ ...search, cursor }),
  );
  return (
    <>
      <PageHeading
        title="请求记录"
        description="按请求 ID、模型或状态查找调用和媒体任务。"
      >
        <button type="button" className="secondary" onClick={result.refresh}>
          刷新
        </button>
      </PageHeading>
      <Notice error={result.error} />
      <Panel title="定位请求">
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault();
            const fields = new FormData(e.currentTarget);
            setSearch({
              id: String(fields.get("id")).trim(),
              model: String(fields.get("model")).trim(),
              status: String(fields.get("status")),
            });
            setCursor("");
          }}
        >
          <label>
            网关请求 ID
            <input name="id" />
          </label>
          <label>
            模型 ID
            <input name="model" />
          </label>
          <label>
            状态
            <select name="status">
              <option value="">全部状态</option>
              <option value="succeeded">成功</option>
              <option value="failed">失败</option>
              <option value="running">运行中</option>
              <option value="queued">排队</option>
              <option value="submit_unknown">待核验</option>
              <option value="canceled">已取消</option>
              <option value="interrupted">流中断</option>
            </select>
          </label>
          <button>查询</button>
        </form>
        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>请求 ID</th>
                <th>模型</th>
                <th>操作</th>
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
                  <td>{operationLabel(text(row.operation))}</td>
                  <td>
                    <Status value={row.status} />
                  </td>
                  <td>{text(row.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!result.value?.data.length && !result.error && (
          <p className="muted">
            {result.value ? "暂无符合条件的请求" : "正在读取请求…"}
          </p>
        )}
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
      <PageHeading title="请求详情" description={requestId}>
        <Link className="action-link" to="../requests">
          返回请求记录
        </Link>
      </PageHeading>
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
