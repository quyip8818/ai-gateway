import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { data, root } from "./environment.mjs";

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

export async function startDatabase(env, start, run) {
  const bin = postgresBin(env);
  const pg = (name) => (bin ? join(bin, name) : name);
  const cluster = join(data, "postgres");
  const socket = join(data, "pg");
  mkdirSync(socket, { recursive: true, mode: 0o700 });
  if (!existsSync(join(cluster, "PG_VERSION"))) {
    await run(pg("initdb"), [
      "-D",
      cluster,
      "-U",
      "gateway",
      "--auth-local=trust",
      "--auth-host=scram-sha-256",
    ]);
  }
  const server = start(
    pg("postgres"),
    ["-D", cluster, "-k", socket, "-p", "5432", "-c", "listen_addresses="],
    {
      // Ctrl+C belongs to the launcher. It stops PostgreSQL after the gateway drains.
      detached: process.platform !== "win32",
    },
  );
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
        return server;
      }
    }
    await delay(250);
  }
  throw new Error("Local PostgreSQL failed to start");
}
