import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  date,
  operationName,
  projectURL,
  text,
  usePages,
  useResource,
  workspaceURL,
} from "../api";
import type { Collection, Project, UsageItem } from "../api";
import {
  Copy,
  Definition,
  Empty,
  Loading,
  Notice,
  Page,
  Pager,
  Panel,
  Status,
} from "../components";

type Request = {
  id: string;
  model: string;
  operation: string;
  status: string;
  created_at: string;
  failure_stage?: string;
  error_code?: string;
  job_id?: string;
};
type Attempt = {
  attempt_no: number;
  status: string;
  http_status?: number;
  upstream_id?: string;
  started_at: string;
  finished_at?: string;
  first_output_at?: string;
  usage: UsageItem[];
};
const filters = [
  ["", "全部状态"],
  ["succeeded", "成功"],
  ["failed", "失败"],
  ["interrupted", "流中断"],
  ["submit_unknown", "待核验"],
  ["running", "运行中"],
  ["queued", "排队中"],
  ["canceled", "已取消"],
  ["client_canceled", "客户端取消"],
  ["submitting", "提交中"],
  ["finalizing", "交付中"],
];

export function RequestList({ project }: { project: Project }) {
  const [params, setParams] = useSearchParams();
  const query = {
    id: params.get("id") ?? "",
    model: params.get("model") ?? "",
    status: params.get("status") ?? "",
  };
  return (
    <Page
      title="请求记录"
      description={
        project.role === "admin"
          ? "查看项目请求、上游尝试及失败原因。"
          : "查看自己的请求、上游尝试及失败原因。"
      }
      actions={
        <Link
          className="button secondary"
          to={workspaceURL(project) + "/usage"}
        >
          查看用量
        </Link>
      }
    >
      <Panel>
        <form
          className="filters"
          key={params.toString()}
          onSubmit={(event) => {
            event.preventDefault();
            const next = new URLSearchParams();
            for (const [key, value] of new FormData(event.currentTarget))
              if (String(value).trim()) next.set(key, String(value).trim());
            setParams(next);
          }}
        >
          <label>
            请求 ID
            <input
              name="id"
              defaultValue={query.id}
              placeholder="完整请求 ID"
            />
          </label>
          <label>
            公开模型
            <input
              name="model"
              defaultValue={query.model}
              placeholder="池 / 模型"
            />
          </label>
          <label>
            状态
            <select name="status" defaultValue={query.status}>
              {filters.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button>筛选</button>
          {params.size > 0 && (
            <button
              type="button"
              className="secondary"
              onClick={() => setParams({})}
            >
              清除
            </button>
          )}
        </form>
      </Panel>
      <RequestResults key={params.toString()} project={project} query={query} />
    </Page>
  );
}

function RequestResults({
  project,
  query,
}: {
  project: Project;
  query: Record<string, string>;
}) {
  const pages = usePages();
  const result = useResource<Collection<Request>>(
    projectURL(project.id) +
      "/requests?" +
      new URLSearchParams({ ...query, cursor: pages.cursor }),
  );
  const next = result.value?.next_cursor;
  return (
    <Panel
      title="请求列表"
      actions={
        <button className="secondary" onClick={result.refresh}>
          刷新
        </button>
      }
    >
      <Notice error={result.error} retry={result.refresh} />
      {!result.value && !result.error && <Loading />}
      {result.value?.data.length === 0 && (
        <Empty title="暂无符合条件的请求">
          调整筛选条件，或发送一次调用后刷新。
        </Empty>
      )}
      {!!result.value?.data.length && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>公开模型</th>
                <th>状态</th>
                <th>请求 ID</th>
                <th>发起时间</th>
              </tr>
            </thead>
            <tbody>
              {result.value.data.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>{item.model}</strong>
                    <small>{operationName(item.operation)}</small>
                  </td>
                  <td>
                    <Status value={item.status} />
                  </td>
                  <td>
                    <Link
                      className="mono"
                      to={workspaceURL(project) + "/requests/" + item.id}
                    >
                      {item.id}
                    </Link>
                  </td>
                  <td>{date(item.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager
        previous={pages.previous}
        next={next ? () => pages.next(next) : undefined}
      />
    </Panel>
  );
}

export function RequestDetail({ project }: { project: Project }) {
  const { requestId } = useParams();
  const root = workspaceURL(project);
  const result = useResource<Request & { attempts: Attempt[] }>(
    projectURL(project.id) + "/requests/" + requestId,
  );
  const request = result.value;
  return (
    <Page
      title="请求详情"
      actions={
        <Link className="button secondary" to={root + "/requests"}>
          返回请求记录
        </Link>
      }
    >
      <Notice error={result.error} retry={result.refresh} />
      {!request && !result.error && <Loading />}
      {request && (
        <>
          <Panel
            title={request.model}
            actions={<Status value={request.status} />}
          >
            <Definition
              items={[
                [
                  "请求 ID",
                  <div className="inline">
                    <code>{request.id}</code>
                    <Copy value={request.id} />
                  </div>,
                ],
                ["操作", operationName(request.operation)],
                ["发起时间", date(request.created_at)],
                ...(request.failure_stage
                  ? [["失败阶段", request.failure_stage] as [string, string]]
                  : []),
                ...(request.error_code
                  ? [
                      ["错误代码", <code>{request.error_code}</code>] as [
                        string,
                        React.ReactNode,
                      ],
                    ]
                  : []),
                ...(request.job_id
                  ? [
                      [
                        "媒体任务",
                        <Link to={root + "/media/" + request.job_id}>
                          查看任务与成品
                        </Link>,
                      ] as [string, React.ReactNode],
                    ]
                  : []),
              ]}
            />
          </Panel>
          <Panel title="上游尝试">
            {!request.attempts.length && (
              <Empty title="暂无上游尝试">
                请求可能仍在排队，或在转发前结束。
              </Empty>
            )}
            {request.attempts.map((attempt) => (
              <details
                key={attempt.attempt_no}
                open={request.attempts.length === 1}
              >
                <summary>
                  第 {attempt.attempt_no} 次尝试{" "}
                  <Status value={attempt.status} />
                </summary>
                <Definition
                  items={[
                    ["HTTP 状态", text(attempt.http_status)],
                    ["上游请求 ID", text(attempt.upstream_id)],
                    ["开始时间", date(attempt.started_at)],
                    [
                      "首次输出",
                      duration(attempt.started_at, attempt.first_output_at),
                    ],
                    [
                      "尝试耗时",
                      duration(attempt.started_at, attempt.finished_at),
                    ],
                  ]}
                />
                {attempt.usage.length ? (
                  <UsageTable entries={attempt.usage} />
                ) : (
                  <p className="muted">本次尝试暂无用量记录。</p>
                )}
              </details>
            ))}
          </Panel>
        </>
      )}
    </Page>
  );
}

function duration(from: string, to?: string) {
  const ms = to ? Date.parse(to) - Date.parse(from) : NaN;
  return Number.isFinite(ms) && ms >= 0
    ? ms < 1000
      ? ms + " ms"
      : (ms / 1000).toFixed(2) + " s"
    : "—";
}

export function UsageTable({
  entries,
}: {
  entries: (UsageItem & { operation?: string })[];
}) {
  const multipleOperations = entries.some((item) => item.operation);
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {multipleOperations && <th>操作</th>}
            <th>指标</th>
            <th>数量</th>
            <th>来源</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((item, index) => (
            <tr key={index}>
              {multipleOperations && (
                <td>{operationName(item.operation ?? "")}</td>
              )}
              <td>{item.metric}</td>
              <td>
                {typeof item.quantity === "number"
                  ? item.quantity.toLocaleString("zh-CN", {
                      maximumSignificantDigits: 16,
                    })
                  : item.quantity}{" "}
                {item.unit}
              </td>
              <td>
                {item.source === "reported" || item.source === "upstream"
                  ? "上游报告"
                  : item.source === "estimated"
                    ? "估算"
                    : item.source}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
