import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { data, root } from "./environment.mjs";
import { processCommand } from "./processes.mjs";

function postgresBin(env) {
  if (env.POSTGRES_BIN) return env.POSTGRES_BIN;
  if (
    spawnSync("initdb", ["--version"], { cwd: root, env, stdio: "ignore" })
      .status === 0
  )
    return "";
  const brew = spawnSync("brew", ["--prefix", "postgresql@16"], {
    cwd: root,
    encoding: "utf8",
    env,
  });
  if (brew.status === 0) {
    const bin = join(brew.stdout.trim(), "bin");
    if (existsSync(join(bin, "initdb"))) return bin;
  }
  throw new Error(
    "Install PostgreSQL 16, set POSTGRES_BIN, or configure DATABASE_URL",
  );
}

function postmasterPID(cluster) {
  try {
    return Number(
      readFileSync(join(cluster, "postmaster.pid"), "utf8").split("\n", 1)[0],
    );
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function stopLocalPostgres(cluster, args, pgCtl, run) {
  const recordedPID = postmasterPID(cluster);
  if (recordedPID === null) return;
  const pid = Math.abs(recordedPID);
  if (!Number.isInteger(pid) || pid < 1 || pid > 0x7fff_ffff) {
    throw new Error(
      `PostgreSQL PID 文件无效：${join(cluster, "postmaster.pid")}`,
    );
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return;
    throw error;
  }
  const command = processCommand(pid);
  if (!command) return;
  // Match the command used to launch this cluster before asking pg_ctl to stop it.
  const suffix = " " + args.join(" ");
  if (
    recordedPID < 0 ||
    !command.endsWith(suffix) ||
    basename(command.slice(0, -suffix.length)) !== "postgres" ||
    postmasterPID(cluster) !== recordedPID
  ) {
    throw new Error(
      `无法确认 PID ${pid} 属于本工作区的 PostgreSQL，请先检查该进程。`,
    );
  }
  await run(pgCtl, ["stop", "-D", cluster, "-m", "fast", "-w"]);
}

function installCluster(staging, cluster, reset) {
  if (!reset || !existsSync(cluster)) {
    renameSync(staging, cluster);
    return;
  }

  const backup = mkdtempSync(join(dirname(cluster), "postgres-backup."));
  const previous = join(backup, "postgres");
  try {
    renameSync(cluster, previous);
    try {
      renameSync(staging, cluster);
    } catch (error) {
      try {
        renameSync(previous, cluster);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `无法安装新数据库或恢复旧数据库，旧库目录：${previous}`,
        );
      }
      throw error;
    }
    rmSync(previous, { recursive: true });
  } finally {
    // Leave the old cluster available for recovery if the rollback failed.
    if (!existsSync(previous)) rmSync(backup, { recursive: true });
  }
}

export async function startDatabase(env, start, run, { reset = false } = {}) {
  const bin = postgresBin(env);
  const pg = (name) => (bin ? join(bin, name) : name);
  const cluster = join(data, "postgres");
  const socket = join(data, "pg");
  const args = [
    "-D",
    cluster,
    "-k",
    socket,
    "-p",
    "5432",
    "-c",
    "listen_addresses=",
  ];
  mkdirSync(socket, { recursive: true, mode: 0o700 });
  let staging;
  try {
    if (reset || !existsSync(join(cluster, "PG_VERSION"))) {
      // A replacement during initdb must never open a partially built cluster.
      staging = mkdtempSync(join(data, "postgres-init."));
      await run(pg("initdb"), [
        "-D",
        staging,
        "-U",
        "gateway",
        "--auth-local=trust",
        "--auth-host=scram-sha-256",
      ]);
    }
    await stopLocalPostgres(cluster, args, pg("pg_ctl"), run);
    if (staging) installCluster(staging, cluster, reset);
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
  }
  const server = start(pg("postgres"), args);
  return {
    server,
    ready: waitForDatabase(env, start, server, pg, cluster, socket),
  };
}

async function waitForDatabase(env, start, server, pg, cluster, socket) {
  for (let attempt = 0; attempt < 60 && server.result === null; attempt++) {
    if (postmasterPID(cluster) === server.child.pid) {
      const ready = start(
        pg("pg_isready"),
        [
          "-q",
          "-h",
          socket,
          "-p",
          "5432",
          "-U",
          "gateway",
          "-d",
          "postgres",
          "-t",
          "1",
        ],
        { stdio: "ignore" },
      );
      if (!(await ready.done) && server.result === null) {
        env.DATABASE_URL = `postgresql://gateway@/postgres?host=${encodeURIComponent(socket)}&port=5432`;
        return;
      }
    }
    await delay(250);
  }
  throw new Error("Local PostgreSQL failed to start");
}
