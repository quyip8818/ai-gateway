import assert from "node:assert/strict";
import { test } from "node:test";
import { composeEnv, deploymentConfig } from "./config.mjs";

const values = {
  DEPLOY_HOST: "gateway.example.test",
  DEPLOY_USER: "gateway",
  DEPLOY_PORT: "18088",
  POSTGRES_PASSWORD: "test-pg-password",
  KEY_DIGEST_SECRET: Buffer.alloc(32, 1).toString("base64"),
  CONNECTION_SECRET: Buffer.alloc(32, 2).toString("base64"),
};

test("redeployment does not need the original administrator password", () => {
  const { runtime, password } = deploymentConfig(values);
  assert.equal(password, "");
  assert.equal(runtime.PUBLIC_BASE_URL, "http://127.0.0.1:18088");
  assert.equal(runtime.DEPLOY_PORT, "18088");
  assert.ok(!Object.hasOwn(runtime, "JIMENG_NETWORK"));
});

test("administrator password and SSH target stay out of the Compose environment", () => {
  const password = "test#password $value";
  const { runtime, password: bootstrap } = deploymentConfig({
    ...values,
    BOOTSTRAP_EMAIL: "admin@example.test",
    BOOTSTRAP_PASSWORD: password,
    JIMENG_NETWORK: "jimeng-public",
    JIMENG_BASE_URL: "http://jimeng-api:8000/",
  });
  const env = composeEnv(runtime);
  assert.equal(bootstrap, password);
  assert.equal(runtime.JIMENG_BASE_URL, "http://jimeng-api:8000");
  assert.match(env, /^JIMENG_NETWORK='jimeng-public'$/m);
  assert.doesNotMatch(env, /BOOTSTRAP_PASSWORD|DEPLOY_HOST|test#password/);
});

test("initial bootstrap credentials and shared network must be complete", () => {
  assert.throws(
    () =>
      deploymentConfig({ ...values, BOOTSTRAP_PASSWORD: "a-short-password" }),
    /BOOTSTRAP_EMAIL/,
  );
  assert.throws(
    () => deploymentConfig({ ...values, JIMENG_NETWORK: "jimeng-public" }),
    /JIMENG_BASE_URL/,
  );
});
