import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  bootstrapCredentials,
  data,
  localEnvironment,
  readEnv,
  root,
} from "./environment.mjs";
import { replaceLauncher } from "./launcher.mjs";
import { startDatabase } from "./postgres.mjs";
import { stopWorkspaceGateway } from "./processes.mjs";

const backend = join(root, "backend");
const frontend = join(root, "frontend");
const binaries = join(data, "bin");
const gatewayBinary = join(binaries, "gateway");
const reset = process.argv[2] === "--reset";
const children = new Set();
const detached = process.platform !== "win32";
let env;
let database;
let releaseLauncher;
let shutdown;

function start(
  command,
  args,
  { cwd = root, stdio = "inherit", input, childEnv = env } = {},
) {
  if (shutdown) throw new Error("Startup interrupted");
  const child = spawn(command, args, {
    cwd,
    env: childEnv,
    stdio: input === undefined ? stdio : ["pipe", "inherit", "inherit"],
    detached,
  });
  const running = { child, result: null };
  children.add(running);
  running.done = new Promise((resolve) => {
    let inputError;
    const finish = (result) => {
      running.result = result;
      children.delete(running);
      resolve(result);
    };
    child.once("error", (error) => finish(error.message));
    child.once("close", (code, signal) =>
      finish(code === 0 ? (inputError ?? "") : (signal ?? `exit ${code}`)),
    );
    if (input !== undefined) {
      child.stdin.once("error", (error) => {
        inputError = error.message;
      });
      child.stdin.end(input);
    }
  });
  return running;
}

async function run(command, args, options) {
  const result = await start(command, args, options).done;
  if (result) throw new Error(`${command} failed (${result})`);
}

function localSecret(name, generate) {
  const path = join(data, name);
  try {
    writeFileSync(path, generate() + "\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  return readFileSync(path, "utf8").trim();
}

function stopChildren() {
  if (shutdown) return shutdown;
  const active = [...children].filter((running) => running !== database);
  for (const { child } of active) {
    if (!detached) {
      child.kill("SIGTERM");
    } else if (child.pid) {
      try {
        // npm and Go can spawn workers that also need to stop before a restart.
        process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  }
  shutdown = Promise.all(active.map(({ done }) => done));
  return shutdown;
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stopChildren);

try {
  env = localEnvironment();
  const local = !env.DATABASE_URL;
  if (reset && !local) {
    throw new Error(
      "pnpm reset 只支持本地数据库。请取消 DATABASE_URL 后重试。",
    );
  }
  const { username, password } = bootstrapCredentials(
    readEnv("deploy/.env", { optional: true }),
    { required: true },
  );
  env.HTTP_ADDR ||= "127.0.0.1:32270";
  env.PUBLIC_BASE_URL ||= `http://${env.HTTP_ADDR.replace(/^(?:0\.0\.0\.0|\[::\])?:/, "127.0.0.1:")}`;
  env.MEDIA_STORAGE_DIR ||= join(data, "media");
  mkdirSync(data, { recursive: true, mode: 0o700 });
  releaseLauncher = await replaceLauncher(
    join(data, "launcher.sock"),
    stopChildren,
  );
  if (!shutdown) await stopWorkspaceGateway(gatewayBinary);
  if (shutdown) throw new Error("Startup interrupted");
  if (local) {
    const postgres = await startDatabase(env, start, run, { reset });
    database = postgres.server;
    await postgres.ready;
  }
  for (const [name, file] of [
    ["KEY_DIGEST_SECRET", "key-digest"],
    ["CONNECTION_SECRET", "connection-secret"],
  ]) {
    if (env[name] || env[`${name}_FILE`]) continue;
    if (!local)
      throw new Error(`DATABASE_URL requires ${name} or ${name}_FILE`);
    env[name] = localSecret(file, () => randomBytes(32).toString("base64"));
  }

  await run("npm", ["ci", "--prefer-offline", "--no-audit", "--no-fund"], {
    cwd: frontend,
  });
  await run("npm", ["run", "build"], { cwd: frontend });
  const ui = join(backend, "internal/app/ui/dist");
  rmSync(join(ui, "assets"), { recursive: true, force: true });
  cpSync(join(frontend, "dist"), ui, { recursive: true });
  mkdirSync(binaries, { recursive: true });
  await run(
    "go",
    ["build", "-o", binaries + "/", "./cmd/gateway", "./cmd/gatewayctl"],
    { cwd: backend },
  );
  const ctl = join(binaries, "gatewayctl");
  await run(ctl, ["init-db"]);
  await run(ctl, ["bootstrap"], {
    childEnv: { ...env, BOOTSTRAP_USERNAME: username },
    input: password,
  });
  const gateway = start(gatewayBinary, []);
  console.log(`控制台 ${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/app/`);
  const ended = await Promise.race([
    gateway.done.then((result) => ({ name: "Gateway", result })),
    ...(database
      ? [database.done.then((result) => ({ name: "PostgreSQL", result }))]
      : []),
  ]);
  if (!shutdown)
    throw new Error(`${ended.name} stopped (${ended.result || "exit 0"})`);
} catch (error) {
  if (!shutdown) {
    console.error(error.message);
    process.exitCode = 1;
  }
} finally {
  await stopChildren();
  if (database && database.result === null) {
    // PostgreSQL's fast shutdown checkpoints after closing remaining clients.
    database.child.kill("SIGINT");
    await database.done;
  }
  await releaseLauncher?.();
}
