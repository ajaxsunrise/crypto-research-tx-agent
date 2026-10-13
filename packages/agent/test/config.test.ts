import assert from "node:assert/strict";
import test from "node:test";

import { loadServerConfig } from "../src/http/config.js";

const base: NodeJS.ProcessEnv = {
  HTTP_HOST: "127.0.0.1",
  HTTP_PORT: "8787",
  SANDBOX_ROOT: "./dev/sandbox",
  DEFAULT_MODEL: "faux/faux-1",
  CATALOG_PATH: "./model_providers.json",
  TENANT_TOKENS: '{"local":"0123456789abcdef0123456789abcdef"}',
  DB_HOST: "localhost",
  DB_PORT: "5432",
  DB_USER: "postgres",
  DB_PASSWORD: "secret",
  DB_NAME: "crypto_research_test",
};

test("代码执行 sandbox 默认在主机上运行", () => {
  assert.deepEqual(loadServerConfig({ ...base }).codeSandbox, { kind: "host" });
  assert.deepEqual(loadServerConfig({ ...base, CODE_SANDBOX_MODE: "host" }).codeSandbox, {
    kind: "host",
  });
});

test("docker 模式解析镜像与配额，缺少镜像直接失败", () => {
  assert.deepEqual(
    loadServerConfig({
      ...base,
      CODE_SANDBOX_MODE: "docker",
      CODE_SANDBOX_IMAGE: "python:3.12-slim",
      CODE_SANDBOX_MEMORY: "1g",
      CODE_SANDBOX_CPUS: "2",
    }).codeSandbox,
    { kind: "docker", image: "python:3.12-slim", memory: "1g", cpus: "2" },
  );
  assert.deepEqual(
    loadServerConfig({
      ...base,
      CODE_SANDBOX_MODE: "docker",
      CODE_SANDBOX_IMAGE: "python:3.12-slim",
    }).codeSandbox,
    { kind: "docker", image: "python:3.12-slim" },
  );
  assert.throws(
    () => loadServerConfig({ ...base, CODE_SANDBOX_MODE: "docker" }),
    /Missing CODE_SANDBOX_IMAGE/,
  );
});

test("未知的 sandbox 模式直接失败", () => {
  assert.throws(
    () => loadServerConfig({ ...base, CODE_SANDBOX_MODE: "vm" }),
    /CODE_SANDBOX_MODE must be host or docker/,
  );
});
