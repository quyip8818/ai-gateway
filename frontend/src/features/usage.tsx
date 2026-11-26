import { projectURL, text, useResource } from "../api";
import type { Project, Row } from "../api";
import { Notice, Panel } from "../components";

export function Usage({ project }: { project: Project }) {
  const result = useResource<{ operations: Row[]; usage: Row[] }>(
    projectURL(project.id) + "/usage",
  );
  return (
    <>
      <h1>近 30 天用量</h1>
      <a href={projectURL(project.id) + "/usage/export"} download>
        导出上游用量 CSV
      </a>
      <Notice error={result.error} />
      <div className="grid">
        <Panel title="请求">
          <ul className="rows">
            {result.value?.operations.map((r) => (
              <li key={text(r.operation)}>
                {text(r.operation)}
                <span>
                  {text(r.succeeded)} / {text(r.requests)} 成功
                </span>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title="上游报告用量">
          <ul className="rows">
            {result.value?.usage.map((r, i) => (
              <li key={i}>
                {text(r.operation)} · {text(r.metric)}
                <span>
                  {text(r.quantity)} {text(r.unit)}
                </span>
              </li>
            ))}
          </ul>
          {!result.value?.usage.length && <p>暂无上游报告用量</p>}
        </Panel>
      </div>
    </>
  );
}
