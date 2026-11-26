import { spawnSync } from "node:child_process";
import { localEnvironment } from "./environment.mjs";

const result = spawnSync("go", ["vet", "./..."], {
  cwd: new URL("../backend/", import.meta.url),
  env: localEnvironment(),
  stdio: "inherit",
});

if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
