import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { createModels } from "@earendil-works/pi-ai";

import { createResearchAgent } from "../src/index.js";
import { createJwtAuth, createTenantAuthenticator, withJwtAuth } from "../src/http/auth.js";
import { loadServerConfig } from "../src/http/config.js";
import { createAgentHttp } from "../src/http/server.js";
import { memoryThreads } from "../src/http/threads.js";
import { memoryUsers } from "../src/http/users.js";
import { quietLogger } from "./fixtures.js";

test("Bearer authentication determines the tenant and rejects conflicting tenant headers", () => {
  const alpha = randomBytes(32).toString("hex");
  const beta = randomBytes(32).toString("hex");
  const authenticate = createTenantAuthenticator(JSON.stringify({ alpha, beta }));
  const request = (headers: HeadersInit) => new Request("https://agent.example/agent", { headers });
  assert.equal(authenticate(request({ authorization: `Bearer ${alpha}` })), "alpha");
  assert.equal(
    authenticate(request({ authorization: `Bearer ${beta}`, "x-tenant-id": "beta" })),
    "beta",
  );
  assert.equal(
    authenticate(request({ authorization: `Bearer ${alpha}`, "x-tenant-id": "beta" })),
    undefined,
  );
  assert.equal(authenticate(request({ "x-tenant-id": "alpha" })), undefined);
  assert.equal(
    authenticate(request({ authorization: `Bearer ${randomBytes(32).toString("hex")}` })),
    undefined,
  );
  assert.equal(authenticate(request({ authorization: "Basic dGVzdA==" })), undefined);
});

test("tenant token configuration rejects invalid ids, weak tokens and duplicate tokens", () => {
  const token = randomBytes(32).toString("hex");
  for (const value of [
    {},
    [],
    { alpha: "short" },
    { "alpha:beta": token },
    { alpha: token, beta: token },
    { alpha: `${token} whitespace` },
  ]) {
    assert.throws(() => createTenantAuthenticator(JSON.stringify(value)));
  }
  assert.throws(() => createTenantAuthenticator("invalid JSON"));
  const env = {
    HTTP_HOST: "127.0.0.1",
    HTTP_PORT: "8787",
    DB_HOST: "localhost",
    DB_PORT: "5432",
    DB_USER: "postgres",
    DB_NAME: "agent",
    SANDBOX_ROOT: ".scratch/auth-sandbox",
    DEFAULT_MODEL: "provider/model",
    CATALOG_PATH: "model_providers.json",
    AUTH_JWT_SECRET: randomBytes(32).toString("hex"),
  };
  assert.throws(() => loadServerConfig(env), /TENANT_TOKENS/);
  const withTokens = {
    ...env,
    TENANT_TOKENS: JSON.stringify({ alpha: token }),
    AUTH_JWT_SECRET: "auth-test-secret-value-0123456789abcd",
  };
  assert.equal(loadServerConfig(withTokens).tenantTokens, JSON.stringify({ alpha: token }));
});

test("JWT configuration requires a usable secret and parses the ttl", () => {
  const token = randomBytes(32).toString("hex");
  const base = {
    HTTP_HOST: "127.0.0.1",
    HTTP_PORT: "8787",
    DB_HOST: "localhost",
    DB_PORT: "5432",
    DB_USER: "postgres",
    DB_NAME: "agent",
    SANDBOX_ROOT: ".scratch/auth-sandbox",
    DEFAULT_MODEL: "provider/model",
    CATALOG_PATH: "model_providers.json",
    TENANT_TOKENS: JSON.stringify({ alpha: token }),
  };
  const secret = randomBytes(32).toString("hex");
  assert.throws(() => loadServerConfig(base), /AUTH_JWT_SECRET/);
  assert.throws(
    () => loadServerConfig({ ...base, AUTH_JWT_SECRET: "too-short" }),
    /AUTH_JWT_SECRET must be at least 32 characters/,
  );
  assert.deepEqual(loadServerConfig({ ...base, AUTH_JWT_SECRET: secret }).jwtTtlSeconds, 86_400);
  assert.deepEqual(
    loadServerConfig({ ...base, AUTH_JWT_SECRET: secret, AUTH_JWT_TTL_SECONDS: "3600" })
      .jwtTtlSeconds,
    3_600,
  );
  assert.throws(
    () => loadServerConfig({ ...base, AUTH_JWT_SECRET: secret, AUTH_JWT_TTL_SECONDS: "0" }),
    /AUTH_JWT_TTL_SECONDS must be a positive integer/,
  );
});

test("a login JWT carries its tenant and invalid tokens carry none", async () => {
  const jwt = createJwtAuth("auth-test-secret-value-0123456789abcd", 60);
  const token = await jwt.issue({ tenantId: "u_0123456789abcdef01234567" });
  assert.equal((await jwt.tenantOf(token)) ?? "", "u_0123456789abcdef01234567");

  const other = createJwtAuth("another-secret-value-0123456789abcdef", 60);
  assert.equal(await other.tenantOf(token), undefined);
  assert.equal(await jwt.tenantOf("not-a-jwt"), undefined);
  assert.equal(await jwt.tenantOf(`${token}x`), undefined);

  const expired = createJwtAuth("auth-test-secret-value-0123456789abcd", -1);
  assert.equal(
    await jwt.tenantOf(await expired.issue({ tenantId: "u_0123456789abcdef01234567" })),
    undefined,
  );

  const staticToken = randomBytes(32).toString("hex");
  const authenticate = withJwtAuth(
    createTenantAuthenticator(JSON.stringify({ alpha: staticToken })),
    jwt,
  );
  const request = (headers: HeadersInit) => new Request("https://agent.example/agent", { headers });
  assert.equal(await authenticate(request({ authorization: `Bearer ${staticToken}` })), "alpha");
  assert.equal(
    await authenticate(request({ authorization: `Bearer ${token}` })),
    "u_0123456789abcdef01234567",
  );
  assert.equal(
    await authenticate(request({ authorization: `Bearer ${token}`, "x-tenant-id": "alpha" })),
    undefined,
  );
  assert.equal(await authenticate(request({})), undefined);
});

test("HTTP protects API routes and returns missing durable threads without invoking a model", async () => {
  const models = createModels();
  const agent = await createResearchAgent({ models, resumeOnOpen: false });
  const threads = memoryThreads();
  const token = randomBytes(32).toString("hex");
  const app = createAgentHttp({
    agent,
    threads,
    users: memoryUsers(),
    jwt: createJwtAuth("auth-test-secret-value-0123456789abcd", 3_600),
    models,
    defaultModel: "",
    catalog: { defaultModelId: "", models: [] },
    authenticate: createTenantAuthenticator(JSON.stringify({ alpha: token })),
    log: quietLogger(),
  });
  const headers = { authorization: `Bearer ${token}` };
  try {
    assert.equal((await app.request("/api/models")).status, 401);
    assert.equal((await app.request("/agent", { method: "POST" })).status, 401);
    const catalog = await app.request("/api/models", { headers });
    assert.equal(catalog.status, 200);
    assert.deepEqual(await catalog.json(), { defaultModelId: "", models: [] });
    assert.equal(catalog.headers.get("access-control-allow-origin"), null);
    const missing = await app.request("/api/threads/missing", { headers });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { message: "session-not-found" });
    for (const kind of ["resume", "cancel"]) {
      const result = await app.request(`/api/threads/missing/${kind}`, { method: "POST", headers });
      assert.equal(result.status, 404);
    }
    const conflict = await app.request("/api/threads/missing", {
      headers: { ...headers, "x-tenant-id": "beta" },
    });
    assert.equal(conflict.status, 401);
  } finally {
    await agent.close();
    await threads.close();
  }
});
