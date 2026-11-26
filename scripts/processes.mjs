import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

function runningCommands(selector) {
  const locale = process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
  const result = spawnSync(
    "ps",
    ["-ww", ...selector, "-o", "pid=,stat=,args="],
    { encoding: "utf8", env: { ...process.env, LC_ALL: locale } },
  );
  if (result.error) throw result.error;
  if (
    result.status !== 0 &&
    !(result.status === 1 && !result.stdout.trim() && !result.stderr.trim())
  ) {
    throw new Error(
      result.stderr.trim() || `ps failed (${result.signal ?? result.status})`,
    );
  }
  const commands = new Map();
  for (const line of result.stdout.split("\n")) {
    const entry = line.match(/^\s*(\d+)\s+(\S+)\s+(.+)$/);
    if (entry && !entry[2].startsWith("Z"))
      commands.set(Number(entry[1]), entry[3]);
  }
  return commands;
}

export function processCommand(pid) {
  return runningCommands(["-p", String(pid)]).get(pid);
}

export async function stopWorkspaceGateway(binary) {
  const uid = process.getuid?.();
  if (uid === undefined) return;
  const pids = [];
  for (const [pid, command] of runningCommands(["-U", String(uid)])) {
    if (command !== binary || processCommand(pid) !== binary) continue;
    try {
      process.kill(pid, "SIGTERM");
      pids.push(pid);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  const deadline = performance.now() + 35_000;
  while (pids.some((pid) => processCommand(pid) === binary)) {
    if (performance.now() >= deadline) {
      throw new Error("等待本工作区的旧网关退出超时");
    }
    await delay(250);
  }
}
