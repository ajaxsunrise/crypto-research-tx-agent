import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { createModels } from "@earendil-works/pi-ai";

import { createResearchAgent } from "../src/index.js";
import { createTenantAuthenticator } from "../src/http/auth.js";
import { loadServerConfig } from "../src/http/config.js";
import { createAgentHttp } from "../src/http/server.js";
import { memoryThreads } from "../src/http/threads.js";
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
  };
  assert.throws(() => loadServerConfig(env), /TENANT_TOKENS/);
  assert.equal(
    loadServerConfig({ ...env, TENANT_TOKENS: JSON.stringify({ alpha: token }) }).tenantTokens,
    JSON.stringify({ alpha: token }),
  );
});

test("HTTP protects API routes and returns missing durable threads without invoking a model", async () => {
  const models = createModels();
  const agent = await createResearchAgent({ models, resumeOnOpen: false });
  const threads = memoryThreads();
  const token = randomBytes(32).toString("hex");
  const app = createAgentHttp({
    agent,
    threads,
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
