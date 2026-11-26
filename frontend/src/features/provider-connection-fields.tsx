import { Copy, Empty } from "../components";

type ExecutorProduct = {
  login: "password" | "keys";
  runtime: string;
  sample: string;
  guide: string;
  hint: string;
};

export type OAuthAction = "keep" | "change" | "clear";

export const executorProducts: Record<string, ExecutorProduct> = {
  jimeng: {
    login: "password",
    runtime: "jimeng-api",
    sample: "http://jimeng-api:8000",
    guide: "https://github.com/zhizinan1997/jimeng-free-api-all",
    hint: "准备一个空账号池的 jimeng-api。连接成功后，在本控制台粘贴 Cookie，网关会自动导入账号并签发内部凭证。",
  },
  codex: {
    login: "keys",
    runtime: "CLIProxyAPI v8",
    sample: "http://codex:8317",
    guide:
      "https://github.com/router-for-me/CLIProxyAPI/blob/main/docs/management-api-v8.md",
    hint: "准备一个凭证目录为空的 CLIProxyAPI v8，启用管理接口，并给网关设置独立的调用密钥。连接后上传 Codex 的 auth.json。",
  },
  kiro: {
    login: "keys",
    runtime: "kiro2api",
    sample: "http://kiro:8080",
    guide: "https://github.com/xwteam/kiro2api/blob/main/docs/en/USAGE.md",
    hint: "准备一个账号池为空的 kiro2api，设置独立的管理和调用密钥。连接后上传包含 refreshToken 的 Kiro 授权文件。",
  },
};

export function ExecutorFields({
  product,
  busy,
}: {
  product: ExecutorProduct;
  busy: boolean;
}) {
  return (
    <>
      <p className="muted">
        {product.hint}{" "}
        <a href={product.guide} target="_blank" rel="noreferrer">
          部署 {product.runtime} ↗
        </a>
      </p>
      <label>
        {product.runtime} 地址
        <input
          name="url"
          type="url"
          required
          placeholder={product.sample}
          disabled={busy}
        />
      </label>
      {product.login === "password" ? (
        <>
          <label>
            管理用户名
            <input name="username" required disabled={busy} />
          </label>
          <label>
            管理密码
            <input
              name="password"
              type="password"
              required
              autoComplete="off"
              disabled={busy}
            />
          </label>
        </>
      ) : (
        <>
          <label>
            管理密钥
            <input
              name="management_key"
              type="password"
              required
              autoComplete="off"
              disabled={busy}
            />
          </label>
          <label>
            服务调用密钥
            <input
              name="runtime_key"
              type="password"
              required
              autoComplete="off"
              disabled={busy}
            />
          </label>
          <small>
            这两把密钥由服务管理员设置。应用和脚本使用本系统签发的调用 Key。
          </small>
        </>
      )}
    </>
  );
}

export function CompatibleFields({
  setup,
  supportsOAuth,
  oauth,
  setOAuth,
  busy,
}: {
  setup: { base_url?: string; oauth_configured: boolean; callback_url: string };
  supportsOAuth: boolean;
  oauth: OAuthAction;
  setOAuth: (value: OAuthAction) => void;
  busy: boolean;
}) {
  return (
    <>
      <p className="muted">
        填写网关可访问、并且直接接受该账号授权的服务根地址。
      </p>
      <label>
        兼容服务地址
        <input
          name="url"
          type="url"
          defaultValue={setup.base_url}
          required
          disabled={busy}
        />
      </label>
      {supportsOAuth && (
        <label>
          浏览器授权
          <select
            value={oauth}
            disabled={busy}
            onChange={(event) => setOAuth(event.target.value as OAuthAction)}
          >
            <option value="keep">
              {setup.oauth_configured ? "保留当前设置" : "暂不配置"}
            </option>
            <option value="change">配置已注册的 OAuth 应用</option>
            {setup.oauth_configured && (
              <option value="clear">关闭浏览器授权</option>
            )}
          </select>
        </label>
      )}
      {supportsOAuth && oauth === "change" && (
        <>
          <label>
            授权地址
            <input name="authorize_url" type="url" required />
          </label>
          <label>
            令牌地址
            <input name="token_url" type="url" required />
          </label>
          <label>
            客户端 ID
            <input name="client_id" required />
          </label>
          <label>
            客户端密钥（可选）
            <input name="client_secret" type="password" autoComplete="off" />
          </label>
          <label>
            授权范围（可选）
            <input name="scope" />
          </label>
          <label>
            资源地址（可选）
            <input name="resource" type="url" />
          </label>
          <Empty title="注册以下回调地址">
            <code>{setup.callback_url}</code>
            <Copy value={setup.callback_url} />
          </Empty>
        </>
      )}
    </>
  );
}
