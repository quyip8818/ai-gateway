function port(value, name) {
  if (!/^[1-9]\d{0,4}$/.test(value) || Number(value) > 65535) {
    throw new Error(`${name} 必须是 1 到 65535 之间的端口`);
  }
  return value;
}

function serviceURL(value, name, originOnly = false) {
  const url = URL.parse(value);
  if (
    !url ||
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (originOnly && url.pathname !== "/")
  ) {
    throw new Error(`${name} 必须是有效的 HTTP 或 HTTPS 服务地址`);
  }
  return url.href.replace(/\/+$/, "");
}

export function deploymentConfig(values) {
  const {
    DEPLOY_HOST: host = "",
    DEPLOY_USER: user = "",
    DEPLOY_SSH_PORT: sshPort = "22",
    DEPLOY_PORT: appPort = "8088",
    POSTGRES_PASSWORD: dbPassword = "",
    KEY_DIGEST_SECRET: key = "",
    CONNECTION_SECRET: encryption = "",
    BOOTSTRAP_USERNAME: configuredUsername = "",
    BOOTSTRAP_PASSWORD: password = "",
    JIMENG_NETWORK: network = "",
    JIMENG_BASE_URL: jimeng = "",
    JIMENG_DOWNLOAD_HOSTS: downloadHosts = "",
  } = values;
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host) ||
    !/^[a-z_][a-z0-9_-]*$/i.test(user)
  ) {
    throw new Error("请在 deploy/.env 填写有效的 DEPLOY_HOST 和 DEPLOY_USER");
  }
  if (!/^[a-zA-Z0-9._~-]+$/.test(dbPassword)) {
    throw new Error(
      "POSTGRES_PASSWORD 须使用 URL 安全字符，可用 openssl rand -hex 24 生成",
    );
  }
  for (const [name, value] of Object.entries({
    KEY_DIGEST_SECRET: key,
    CONNECTION_SECRET: encryption,
  })) {
    const bytes = Buffer.from(value, "base64");
    if (bytes.length !== 32 || bytes.toString("base64") !== value) {
      throw new Error(
        `${name} 须为 32 字节的 Base64 值，可用 openssl rand -base64 32 生成`,
      );
    }
  }
  const username = configuredUsername.trim();
  if (
    password &&
    (!username ||
      /[\s\0]/.test(username) ||
      /[\r\n\0]/.test(password) ||
      Buffer.byteLength(password) < 12 ||
      Buffer.byteLength(password) > 72)
  ) {
    throw new Error(
      "请填写不含空白的 BOOTSTRAP_USERNAME 和 12 至 72 字节的单行 BOOTSTRAP_PASSWORD",
    );
  }
  if (network && (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(network) || !jimeng)) {
    throw new Error(
      "配置 JIMENG_NETWORK 时，请填写有效的网络名和 JIMENG_BASE_URL",
    );
  }
  const deployPort = port(appPort, "DEPLOY_PORT");
  const runtime = {
    POSTGRES_PASSWORD: dbPassword,
    KEY_DIGEST_SECRET: key,
    CONNECTION_SECRET: encryption,
    PUBLIC_BASE_URL: serviceURL(
      values.PUBLIC_BASE_URL || `http://127.0.0.1:${deployPort}`,
      "PUBLIC_BASE_URL",
      true,
    ),
    SITE_ADDRESS: ":80",
    DEPLOY_PORT: deployPort,
    BOOTSTRAP_USERNAME: username,
    JIMENG_BASE_URL: jimeng && serviceURL(jimeng, "JIMENG_BASE_URL"),
    JIMENG_DOWNLOAD_HOSTS: downloadHosts
      .split(",")
      .map((item) => item.trim())
      .join(","),
    ...(network ? { JIMENG_NETWORK: network } : {}),
  };
  if (Object.values(runtime).some((value) => /[\r\n\0]/.test(value))) {
    throw new Error("部署运行配置须为单行值");
  }
  return {
    host,
    user,
    sshPort: port(sshPort, "DEPLOY_SSH_PORT"),
    deployPort,
    runtime,
    password,
  };
}

export function composeEnv(values) {
  return (
    Object.entries(values)
      .map(([name, value]) => `${name}='${value.replaceAll("'", "\\'")}'`)
      .join("\n") + "\n"
  );
}
