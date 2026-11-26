import { useState } from "react";
import type { FormEvent } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  NavLink,
  Navigate,
  Route,
  Routes,
  useNavigate,
  useParams,
} from "react-router-dom";
import { api, consoleURL, useResource } from "./api";
import type { Project } from "./api";
import { Field, Notice, Panel } from "./components";
import { Keys } from "./features/keys";
import { Setup } from "./features/setup";
import { Media, JobDetail } from "./features/media";
import { RequestList, RequestDetail } from "./features/requests";
import { Usage } from "./features/usage";
import { Admin } from "./features/admin";
import "./styles.css";

function Login({ onLogin }: { onLogin: () => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(
        consoleURL + "/session",
        Object.fromEntries(new FormData(e.currentTarget)),
      );
      onLogin();
    } catch (x) {
      setError((x as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login">
      <div className="brand">
        <span>↗</span> AI Gateway
      </div>
      <Panel title="登录工作台">
        <form onSubmit={submit}>
          <Field name="username" label="用户名" />
          <Field name="password" label="密码" type="password" />
          <Notice error={error} />
          <button disabled={busy}>{busy ? "提交中…" : "登录"}</button>
        </form>
      </Panel>
    </main>
  );
}
function App() {
  const session = useResource<{ user_id: string }>(consoleURL + "/session");
  if (!session.value)
    return session.error ? (
      <Login onLogin={session.refresh} />
    ) : (
      <main className="login">加载会话…</main>
    );
  return (
    <Projects
      logout={() =>
        api(consoleURL + "/session", undefined, "DELETE").then(session.refresh)
      }
    />
  );
}
function Projects({ logout }: { logout: () => Promise<void> }) {
  const projects = useResource<{ data: Project[] }>(consoleURL + "/projects");
  if (projects.error) return <Notice error={projects.error} />;
  if (!projects.value) return <main className="login">加载项目…</main>;
  if (!projects.value.data.length)
    return (
      <main className="login">
        暂无可访问项目 <button onClick={logout}>退出</button>
      </main>
    );
  const list = projects.value.data;
  return (
    <Routes>
      <Route
        path="/app/projects/:id/*"
        element={<Workspace projects={list} logout={logout} />}
      />
      <Route
        path="*"
        element={<Navigate to={"/app/projects/" + list[0].id} replace />}
      />
    </Routes>
  );
}
function Workspace({
  projects,
  logout,
}: {
  projects: Project[];
  logout: () => Promise<void>;
}) {
  const { id } = useParams();
  const goto = useNavigate();
  const p = projects.find((x) => x.id === id);
  if (!p) return <Navigate to={"/app/projects/" + projects[0].id} replace />;
  const root = "/app/projects/" + p.id;
  return (
    <div className="console-shell studio">
      <header className="console-topbar">
        <div className="brand">
          <span aria-hidden="true">↗</span> AI Gateway
        </div>
        <div className="console-actions">
          <label>
            <span>当前项目</span>
            <select
              value={p.id}
              onChange={(e) => goto("/app/projects/" + e.target.value)}
            >
              {projects.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="secondary" onClick={logout}>
            退出登录
          </button>
        </div>
      </header>
      <nav className="console-nav" aria-label="项目导航">
        {[
          ["usage", "运行概览"],
          ["", "产品接入"],
          ["keys", "API 密钥"],
          ["media", "媒体工作台"],
          ["requests", "请求记录"],
          ...(p.role === "admin" ? [["admin", "项目管理"]] : []),
        ].map(([path, label]) => (
          <NavLink key={label} end={!path} to={root + (path ? "/" + path : "")}>
            {label}
          </NavLink>
        ))}
      </nav>
      <main className="console-content" key={p.id}>
        <Routes>
          <Route index element={<Setup project={p} />} />
          <Route path="keys" element={<Keys project={p} />} />
          <Route path="media" element={<Media project={p} />} />
          <Route path="media/:jobId" element={<JobDetail project={p} />} />
          <Route path="requests" element={<RequestList project={p} />} />
          <Route
            path="requests/:requestId"
            element={<RequestDetail project={p} />}
          />
          <Route path="usage" element={<Usage project={p} />} />
          <Route
            path="admin"
            element={
              p.role === "admin" ? (
                <Admin project={p} />
              ) : (
                <Notice error="没有项目管理权限" />
              )
            }
          />
        </Routes>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>,
);
