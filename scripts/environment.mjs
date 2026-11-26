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

export function bootstrapCredentials(values, { required = false } = {}) {
  const username = (values.BOOTSTRAP_USERNAME ?? "").trim();
  const password = values.BOOTSTRAP_PASSWORD ?? "";
  const bytes = Buffer.byteLength(password);
  if (
    (required || password) &&
    (!username ||
      /[\s\0]/.test(username) ||
      /[\r\n\0]/.test(password) ||
      bytes < 12 ||
      bytes > 72)
  ) {
    throw new Error(
      "请在 deploy/.env 填写不含空白的 BOOTSTRAP_USERNAME 和 12 至 72 字节的单行 BOOTSTRAP_PASSWORD",
    );
  }
  return { username, password };
}

export function localEnvironment() {
  const env = { ...readEnv(".env", { optional: true }), ...process.env };
  env.GOCACHE ||= join(data, "go-cache");
  return env;
}
