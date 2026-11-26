import { operationName, projectURL, useResource } from "../api";
import type { Project, UsageItem } from "../api";
import { Empty, Loading, Notice, Page, Panel } from "../components";
import { UsageTable } from "./requests";

type Count = { operation: string; requests: number; succeeded: number };
type Summary = {
  operations: Count[];
  usage: (UsageItem & { operation: string })[];
  days: number;
};

export function Usage({ project }: { project: Project }) {
  const base = projectURL(project.id);
  const result = useResource<Summary>(base + "/usage");
  const summary = result.value;
  const total =
    summary?.operations.reduce((count, item) => count + item.requests, 0) ?? 0;
  const successful =
    summary?.operations.reduce((count, item) => count + item.succeeded, 0) ?? 0;
  const count = (value: number) => value.toLocaleString("zh-CN");
  return (
    <Page
      title="调用用量"
      description={`近 ${summary?.days ?? 30} 天 · ${project.role === "admin" ? "项目内请求" : "我的请求"}`}
      actions={
        <a className="button secondary" href={base + "/usage/export"} download>
          导出用量 CSV
        </a>
      }
    >
      <Notice error={result.error} retry={result.refresh} />
      {!summary && !result.error && <Loading />}
      {summary && (
        <>
          <div className="metrics">
            <div>
              <small>总请求</small>
              <strong>{count(total)}</strong>
            </div>
            <div>
              <small>成功请求</small>
              <strong>{count(successful)}</strong>
            </div>
            <div>
              <small>成功请求占比</small>
              <strong>
                {total ? ((100 * successful) / total).toFixed(1) + "%" : "—"}
              </strong>
            </div>
          </div>
          <Panel title="按操作查看请求">
            {!summary.operations.length ? (
              <Empty title="暂无请求数据" />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>操作</th>
                      <th>总请求</th>
                      <th>成功请求</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.operations.map((item) => (
                      <tr key={item.operation}>
                        <td>{operationName(item.operation)}</td>
                        <td>{count(item.requests)}</td>
                        <td>{count(item.succeeded)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
          <Panel title="用量明细">
            {summary.usage.length ? (
              <UsageTable entries={summary.usage} />
            ) : (
              <Empty title="暂无用量记录">
                用量按上游响应中可采集的数据统计。
              </Empty>
            )}
          </Panel>
        </>
      )}
    </Page>
  );
}
