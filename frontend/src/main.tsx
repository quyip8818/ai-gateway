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
  useLocation,
  useParams,
} from "react-router-dom";
import { api, consoleURL, useResource, workspaceURL } from "./api";
import type { Collection, Project } from "./api";
import { Empty, Loading, Notice } from "./components";
import { Setup } from "./features/setup";
import { Keys } from "./features/keys";
import { Media, JobDetail } from "./features/media";
import { RequestList, RequestDetail } from "./features/requests";
import { Usage } from "./features/usage";
import { Admin } from "./features/admin";
import "./styles.css";

function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark" aria-hidden="true">
        ↗
      </span>
      <strong>AI Gateway</strong>
    </div>
  );
}

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
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login">
      <section className="login-brand">
        <Brand />
        <div>
          <h1>账号池网关</h1>
          <p>管理上游账号、接入客户端和追踪项目调用。</p>
        </div>
      </section>
      <section className="login-content">
        <div>
          <h2>登录控制台</h2>
          <form onSubmit={submit}>
            <label>
              用户名
              <input
                name="username"
                autoComplete="username"
                required
                autoFocus
              />
            </label>
            <label>
              密码
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </label>
            <Notice error={error} />
            <button disabled={busy}>{busy ? "正在登录…" : "登录"}</button>
          </form>
        </div>
      </section>
    </main>
  );
}

function App() {
  const session = useResource<{ user_id: string }>(consoleURL + "/session");
  const [error, setError] = useState("");
  async function logout() {
    setError("");
    try {
      await api(consoleURL + "/session", undefined, "DELETE");
      session.refresh();
    } catch (failure) {
      setError((failure as Error).message);
    }
  }
  if (session.status === 401) return <Login onLogin={session.refresh} />;
  if (!session.value)
    return (
      <main className="session-state">
        <Brand />
        {session.error ? (
          <Notice error={session.error} retry={session.refresh} />
        ) : (
          <Loading />
        )}
      </main>
    );
  return (
    <>
      <div className="session-error">
        <Notice error={error} />
      </div>
      <Projects logout={logout} />
    </>
  );
}

function Projects({ logout }: { logout: () => Promise<void> }) {
  const projects = useResource<Collection<Project>>(consoleURL + "/projects");
  if (!projects.value?.data.length)
    return (
      <main className="session-state">
        <Brand />
        {projects.error ? (
          <Notice error={projects.error} retry={projects.refresh} />
        ) : projects.value ? (
          <Empty title="暂无可访问的项目">
            <button className="secondary" onClick={logout}>
              退出登录
            </button>
          </Empty>
        ) : (
          <Loading />
        )}
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
        element={<Navigate to={workspaceURL(list[0])} replace />}
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
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const project = projects.find((p) => p.id === id);
  if (!project) return <Navigate to={workspaceURL(projects[0])} replace />;
  const root = workspaceURL(project);
  const admin = project.role === "admin";
  return (
    <div className="shell">
      <a className="skip" href="#workspace">
        跳到内容
      </a>
      <aside className="sidebar">
        <Brand />
        <div className="project">
          <span className="project-icon" aria-hidden="true">
            {Array.from(project.name)[0]?.toUpperCase() || "P"}
          </span>
          <div>
            {projects.length > 1 ? (
              <select
                aria-label="切换项目"
                value={project.id}
                onChange={(e) => navigate("/app/projects/" + e.target.value)}
              >
                {projects.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            ) : (
              <strong>{project.name}</strong>
            )}
            <small>{admin ? "项目管理员" : "项目成员"}</small>
          </div>
        </div>
        <nav aria-label="项目导航">
          <div className="nav-group">
            <span>接入与创作</span>
            <NavLink to={root} end>
              <i aria-hidden="true">⌘</i>使用
            </NavLink>
            <NavLink to={root + "/media"}>
              <i aria-hidden="true">◫</i>媒体创作
            </NavLink>
          </div>
          <div className="nav-group">
            <span>项目资源</span>
            {admin && (
              <NavLink to={root + "/admin"}>
                <i aria-hidden="true">◎</i>上游账号
              </NavLink>
            )}
            <NavLink to={root + "/keys"}>
              <i aria-hidden="true">◇</i>调用密钥
            </NavLink>
          </div>
          <div className="nav-group">
            <span>可观测性</span>
            <NavLink to={root + "/requests"}>
              <i aria-hidden="true">≡</i>请求记录
            </NavLink>
            <NavLink to={root + "/usage"}>
              <i aria-hidden="true">▥</i>用量
            </NavLink>
          </div>
        </nav>
        <button className="secondary exit" onClick={logout}>
          退出登录
        </button>
      </aside>
      <main className="workspace" id="workspace" key={project.id}>
        <Routes>
          <Route index element={<Setup project={project} />} />
          <Route path="keys" element={<Keys project={project} />} />
          <Route path="media" element={<Media project={project} />} />
          <Route
            path="media/:jobId"
            element={<JobDetail key={pathname} project={project} />}
          />
          <Route path="requests" element={<RequestList project={project} />} />
          <Route
            path="requests/:requestId"
            element={<RequestDetail project={project} />}
          />
          <Route path="usage" element={<Usage project={project} />} />
          <Route
            path="admin"
            element={
              admin ? (
                <Admin project={project} />
              ) : (
                <Navigate to={root} replace />
              )
            }
          />
          <Route path="*" element={<Navigate to={root} replace />} />
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
