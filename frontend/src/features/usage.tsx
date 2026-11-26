import { Link } from "react-router-dom";
import { operationLabel } from "../products";
import { projectURL, text, useResource } from "../api";
import type { Project, Row } from "../api";
import { Notice, PageHeading, Panel } from "../components";

export function Usage({ project }: { project: Project }) {
  const result = useResource<{
    operations: { operation: string; requests: number; succeeded: number }[];
    usage: Row[];
  }>(projectURL(project.id) + "/usage");
  const totals = result.value?.operations.reduce(
    (total, row) => ({
      requests: total.requests + Number(row.requests),
      succeeded: total.succeeded + Number(row.succeeded),
    }),
    { requests: 0, succeeded: 0 },
  );
  const formatter = new Intl.NumberFormat("zh-CN");
  const metrics = [
    {
      label: "请求总量",
      value: totals ? formatter.format(totals.requests) : "—",
    },
    {
      label: "成功请求",
      value: totals ? formatter.format(totals.succeeded) : "—",
    },
    {
      label: "请求成功占比",
      value: totals?.requests
        ? ((totals.succeeded / totals.requests) * 100).toFixed(1) + "%"
        : "—",
    },
  ];
  return (
    <>
      <PageHeading
        title="运行概览"
        description="当前项目近 30 天的请求结果与上游用量。"
      >
        <Link className="action-link" to="../requests">
          查看请求
        </Link>
        <a
          className="action-link"
          href={projectURL(project.id) + "/usage/export"}
          download
        >
          导出用量 CSV
        </a>
      </PageHeading>
      <Notice error={result.error} />
      <dl className="metric-grid">
        {metrics.map((metric) => (
          <div className="metric" key={metric.label}>
            <dt>{metric.label}</dt>
            <dd>{metric.value}</dd>
          </div>
        ))}
      </dl>
      <div className="grid">
        <Panel title="按操作统计">
          {result.value?.operations.length === 0 && (
            <p className="muted">近 30 天暂无请求。</p>
          )}
          <ul className="rows">
            {result.value?.operations.map((r) => (
              <li key={operationLabel(text(r.operation))}>
                {operationLabel(text(r.operation))}
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
                {operationLabel(text(r.operation))} · {text(r.metric)}
                <span>
                  {text(r.quantity)} {text(r.unit)}
                </span>
              </li>
            ))}
          </ul>
          {result.value?.usage.length === 0 && (
            <p className="muted">暂无上游报告用量。</p>
          )}
        </Panel>
      </div>
    </>
  );
}
