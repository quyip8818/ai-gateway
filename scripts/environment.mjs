import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const data = join(root, "data");

export function readEnv(file, { optional = false } = {}) {
  try {
    return parseEnv(readFileSync(join(root, file), "utf8"));
  } catch (error) {
    if (optional && error.code === "ENOENT") return {};
    throw error;
  }
}

export function localEnvironment() {
  const env = { ...readEnv(".env", { optional: true }), ...process.env };
  env.GOCACHE ||= join(data, "go-cache");
  return env;
}
