import { spawnSync } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEnv, root } from "../scripts/environment.mjs";
import { composeEnv, deploymentConfig } from "./config.mjs";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} 执行失败（${result.signal ?? result.status}）`);
}

function deploy() {
  let values;
  try {
    values = readEnv("deploy/.env");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new Error("请复制 deploy/.env.example 到 deploy/.env 并填写部署配置");
  }
  const { host, user, sshPort, deployPort, runtime, password } =
    deploymentConfig(values);
  const temp = mkdtempSync(join(tmpdir(), "ai-gateway-deploy-"));
  try {
    const archive = join(temp, "source.tar.gz");
    writeFileSync(join(temp, "release.env"), composeEnv(runtime), {
      mode: 0o600,
    });
    writeFileSync(join(temp, ".bootstrap-password"), password, { mode: 0o600 });
    run(
      "tar",
      [
        "--exclude=.env",
        "--exclude=.env.*",
        "--exclude=.git",
        "--exclude=secrets",
        "--exclude=backend/internal/app/ui/dist/assets",
        "--exclude=backend/internal/app/ui/dist/index.html",
        "-czf",
        archive,
        "Dockerfile",
        ".dockerignore",
        "backend/go.mod",
        "backend/go.sum",
        "backend/cmd",
        "backend/internal",
        "frontend/package.json",
        "frontend/package-lock.json",
        "frontend/index.html",
        "frontend/tsconfig.json",
        "frontend/vite.config.ts",
        "frontend/src",
        "deploy/compose.yaml",
        "deploy/compose.remote.yaml",
        "deploy/compose.jimeng.yaml",
        "deploy/Caddyfile",
        "deploy/remote.sh",
        "-C",
        temp,
        "release.env",
        ".bootstrap-password",
      ],
      { env: { ...process.env, COPYFILE_DISABLE: "1" } },
    );
    const input = openSync(archive, "r");
    try {
      const remote = [
        "set -eu",
        "umask 077",
        "work=$(mktemp -d)",
        "trap 'rm -rf -- \"$work\"' EXIT",
        'tar -xzf - -C "$work"',
        `bash "$work/deploy/remote.sh" "$work" ${deployPort}`,
      ].join("\n");
      run(
        "ssh",
        [
          "-T",
          "-o",
          "BatchMode=yes",
          "-o",
          "StrictHostKeyChecking=yes",
          "-o",
          "ConnectTimeout=15",
          "-p",
          sshPort,
          `${user}@${host}`,
          remote,
        ],
        { stdio: [input, "inherit", "inherit"] },
      );
    } finally {
      closeSync(input);
    }
    console.log(`部署完成。服务器 127.0.0.1:${deployPort}/readyz 检查通过`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

try {
  deploy();
} catch (error) {
  console.error(`部署失败。${error.message}`);
  process.exitCode = 1;
}
