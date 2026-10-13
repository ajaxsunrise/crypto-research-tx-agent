import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createResearchAgent } from "../src/index.js";
import { createJwtAuth, createTenantAuthenticator, withJwtAuth } from "../src/http/auth.js";
import { catalogView, parseCatalog } from "../src/http/catalog.js";
import { openLogger } from "../src/http/logger.js";
import { listenAgentHttp, createAgentHttp } from "../src/http/server.js";
import { memoryThreads } from "../src/http/threads.js";
import { memoryUsers } from "../src/http/users.js";
import { call, quietLogger, recordingSandbox, say, scripted } from "./fixtures.js";

const tenantTokens: Record<string, string> = Object.fromEntries(
  ["local", "alpha", "beta"].map((tenantId) => [tenantId, randomBytes(32).toString("hex")]),
);
const jwt = createJwtAuth("http-test-secret-value-0123456789abcdef", 3_600);
const authenticate = withJwtAuth(createTenantAuthenticator(JSON.stringify(tenantTokens)), jwt);

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(value));
}

function eventsOf(body: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const block of body.split("\n\n")) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .join("\n");
    if (data === "") {
      continue;
    }
    const parsed: unknown = JSON.parse(data);
    const record = recordOf(parsed);
    if (record !== undefined) {
      events.push(record);
    }
  }
  return events;
}

async function postRun(url: string, body: unknown, tenantId = "local"): Promise<Response> {
  return fetch(`${url}/agent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      "x-tenant-id": tenantId,
      authorization: `Bearer ${tenantTokens[tenantId]}`,
    },
    body: JSON.stringify(body),
  });
}

test("a catalog view lists models and omits keys", () => {
  const file = parseCatalog({
    providers: {
      deepseek: {
        baseUrl: "https://api.deepseek.com/anthropic",
        apiKey: "secret-value",
        api: "anthropic-messages",
        models: [{ id: "deepseek-flash", name: "DeepSeek Flash" }],
      },
    },
  });
  const view = catalogView(file, "deepseek/deepseek-flash");
  assert.deepEqual(view, {
    defaultModelId: "deepseek/deepseek-flash",
    models: [{ provider: "deepseek", id: "deepseek-flash", name: "DeepSeek Flash" }],
  });
  assert.equal(JSON.stringify(view).includes("secret-value"), false);
});

test("a run streams the assistant text and a repeat of the same runId does not ask the model again", async () => {
  const { models, model } = scripted([say("funding was flat"), say("must not be asked")]);
  const agent = await createResearchAgent({ models, model });
  const app = createAgentHttp({
    authenticate,
    agent,
    threads: memoryThreads(),
    users: memoryUsers(),
    jwt,
    models,
    defaultModel: model,
    catalog: { defaultModelId: model, models: [] },
    log: quietLogger(),
  });
  const server = await listenAgentHttp(app, "127.0.0.1", 0);
  try {
    const body = {
      threadId: "thread-1",
      runId: "run-1",
      messages: [{ id: "user-1", role: "user", content: "What changed in BTC funding?" }],
      forwardedProps: { horizon: "24h" },
    };
    const first = await postRun(server.url, body);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("content-type"), "text/event-stream");
    const firstEvents = eventsOf(await first.text());
    assert.equal(firstEvents[0]?.type, "RUN_STARTED");
    assert.equal(
      firstEvents.some(
        (event) => event.type === "TEXT_MESSAGE_CONTENT" && event.delta === "funding was flat",
      ),
      true,
    );
    assert.equal(firstEvents.at(-1)?.type, "RUN_FINISHED");
    assert.equal(JSON.stringify(firstEvents).includes("must not be asked"), false);

    const second = await postRun(server.url, body);
    const secondEvents = eventsOf(await second.text());
    assert.equal(secondEvents.at(-1)?.type, "RUN_FINISHED");
    assert.equal(JSON.stringify(secondEvents).includes("must not be asked"), false);
    assert.equal(
      secondEvents.some((event) => event.type === "TEXT_MESSAGE_CONTENT"),
      false,
    );
  } finally {
    await server.close();
    await agent.close();
  }
});

test("the page is served from WEB_DIST", async () => {
  const { models, model } = scripted([say("unused")]);
  const agent = await createResearchAgent({ models, model });
  const pageRoot = fileURLToPath(new URL("../../test/page", import.meta.url));
  const app = createAgentHttp({
    authenticate,
    agent,
    threads: memoryThreads(),
    users: memoryUsers(),
    jwt,
    models,
    defaultModel: model,
    catalog: { defaultModelId: model, models: [] },
    log: quietLogger(),
    webDistPath: pageRoot,
  });
  const server = await listenAgentHttp(app, "127.0.0.1", 0);
  try {
    const response = await fetch(`${server.url}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /research-page-fixture/);
  } finally {
    await server.close();
    await agent.close();
  }
});

test("a missing user message is rejected before the stream starts", async () => {
  const { models, model } = scripted([say("unused")]);
  const agent = await createResearchAgent({ models, model });
  const app = createAgentHttp({
    authenticate,
    agent,
    threads: memoryThreads(),
    users: memoryUsers(),
    jwt,
    models,
    defaultModel: model,
    catalog: { defaultModelId: model, models: [] },
    log: quietLogger(),
  });
  const server = await listenAgentHttp(app, "127.0.0.1", 0);
  try {
    const response = await postRun(server.url, {
      threadId: "thread-1",
      runId: "run-1",
      messages: [],
    });
    assert.equal(response.status, 400);
    const body: unknown = await response.json();
    assert.deepEqual(body, { message: "A run needs a user message." });
  } finally {
    await server.close();
    await agent.close();
  }
});

test("a run without authentication is rejected", async () => {
  const { models, model } = scripted([say("unused")]);
  const agent = await createResearchAgent({ models, model });
  const app = createAgentHttp({
    authenticate,
    agent,
    threads: memoryThreads(),
    users: memoryUsers(),
    jwt,
    models,
    defaultModel: model,
    catalog: { defaultModelId: model, models: [] },
    log: quietLogger(),
  });
  const server = await listenAgentHttp(app, "127.0.0.1", 0);
  try {
    const response = await fetch(`${server.url}/agent`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        threadId: "thread-1",
        runId: "run-1",
        messages: [{ id: "user-1", role: "user", content: "hello" }],
        forwardedProps: { horizon: "24h" },
      }),
    });
    assert.equal(response.status, 401);
    const body: unknown = await response.json();
    assert.equal(typeof (body as { message?: string }).message, "string");
  } finally {
    await server.close();
    await agent.close();
  }
});

test("requests and authentication failures land in the log", async () => {
  const { models, model } = scripted([say("unused")]);
  const out: string[] = [];
  const errors: string[] = [];
  const log = openLogger(
    { LOG_CONSOLE_ENABLED: "true", LOG_FILE_ENABLED: "false", LOG_FORMAT: "json" },
    {
      out: { write: (text) => out.push(text) },
      err: { write: (text) => errors.push(text) },
      interactive: false,
    },
  );
  const agent = await createResearchAgent({ models, model });
  const app = createAgentHttp({
    authenticate,
    agent,
    threads: memoryThreads(),
    users: memoryUsers(),
    jwt,
    models,
    defaultModel: model,
    catalog: { defaultModelId: model, models: [] },
    log,
  });
  const server = await listenAgentHttp(app, "127.0.0.1", 0);
  try {
    const denied = await fetch(`${server.url}/api/models`);
    assert.equal(denied.status, 401);
    const allowed = await fetch(`${server.url}/api/models`, {
      headers: { authorization: `Bearer ${tenantTokens.local}` },
    });
    assert.equal(allowed.status, 200);
  } finally {
    await server.close();
    await agent.close();
    await log.close();
  }
  const failures = errors.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(
    failures.some(
      (record) =>
        record.level === "WARNING" &&
        record.message === "authentication failed" &&
        record.path === "/api/models",
    ),
    true,
  );
  const requests = out.map((line) => JSON.parse(line) as Record<string, unknown>);
  const access = requests.find(
    (record) =>
      record.message === "request" && record.path === "/api/models" && record.status === 200,
  );
  assert.equal(typeof access?.durationMs, "number");
  assert.equal(access?.tenant, "local");
});

test("the same thread id in two tenants is two sessions", async () => {
  const { models, model } = scripted([
    call("place-order", { symbol: "BTC", side: "buy", quantity: "1" }),
    say("answer for b"),
  ]);
  const agent = await createResearchAgent({ models, model });
  const app = createAgentHttp({
    authenticate,
    agent,
    threads: memoryThreads(),
    users: memoryUsers(),
    jwt,
    models,
    defaultModel: model,
    catalog: { defaultModelId: model, models: [] },
    log: quietLogger(),
  });
  const server = await listenAgentHttp(app, "127.0.0.1", 0);
  try {
    const body = {
      threadId: "thread-1",
      messages: [{ id: "user-1", role: "user", content: "What changed in BTC funding?" }],
      forwardedProps: { horizon: "24h" },
    };
    // Tenant alpha's run parks an order, so its thread is waiting for approval.
    const first = await postRun(server.url, { ...body, runId: "run-1" }, "alpha");
    const firstEvents = eventsOf(await first.text());
    assert.equal(
      firstEvents.some((event) => event.type === "TOOL_CALL_START"),
      true,
    );

    // The same thread id under tenant beta starts its own session and runs; were the thread
    // shared, this request would replay alpha's waiting-for-approval state instead.
    const second = await postRun(server.url, { ...body, runId: "run-2" }, "beta");
    const secondEvents = eventsOf(await second.text());
    assert.equal(
      secondEvents.some(
        (event) => event.type === "TEXT_MESSAGE_CONTENT" && event.delta === "answer for b",
      ),
      true,
    );
    assert.deepEqual(secondEvents.at(-1)?.outcome, { type: "success" });
  } finally {
    await server.close();
    await agent.close();
  }
});

test("a run forwards the extension choice to the thread", async () => {
  const { models, model } = scripted([
    call("run-bash", { command: "echo code-ran" }),
    say("code done"),
  ]);
  const agent = await createResearchAgent({ models, model });
  const app = createAgentHttp({
    authenticate,
    agent,
    threads: memoryThreads(),
    users: memoryUsers(),
    jwt,
    models,
    defaultModel: model,
    catalog: { defaultModelId: model, models: [] },
    log: quietLogger(),
  });
  const server = await listenAgentHttp(app, "127.0.0.1", 0);
  try {
    const response = await postRun(server.url, {
      threadId: "thread-1",
      runId: "run-1",
      messages: [{ id: "user-1", role: "user", content: "Run echo." }],
      forwardedProps: { extension: "code-execution" },
    });
    assert.equal(response.status, 200);
    const events = eventsOf(await response.text());
    assert.equal(
      events.some((event) => event.type === "TOOL_CALL_RESULT" && event.content === "code-ran"),
      true,
    );
    assert.deepEqual(events.at(-1)?.outcome, { type: "success" });
  } finally {
    await server.close();
    await agent.close();
  }
});

test("a run naming an unknown extension streams an error", async () => {
  const { models, model } = scripted([say("unused")]);
  const agent = await createResearchAgent({ models, model });
  const app = createAgentHttp({
    authenticate,
    agent,
    threads: memoryThreads(),
    users: memoryUsers(),
    jwt,
    models,
    defaultModel: model,
    catalog: { defaultModelId: model, models: [] },
    log: quietLogger(),
  });
  const server = await listenAgentHttp(app, "127.0.0.1", 0);
  try {
    const response = await postRun(server.url, {
      threadId: "thread-1",
      runId: "run-1",
      messages: [{ id: "user-1", role: "user", content: "hello" }],
      forwardedProps: { extension: "nope" },
    });
    assert.equal(response.status, 200);
    const events = eventsOf(await response.text());
    const error = events.find((event) => event.type === "RUN_ERROR");
    assert.equal(typeof error?.message, "string");
    assert.match(error?.message as string, /Unknown extension nope/);
  } finally {
    await server.close();
    await agent.close();
  }
});

test("a parked order ends as an interrupt and a grant resume sends it once", async () => {
  const { models, model } = scripted([
    call("place-order", { symbol: "BTC", side: "buy", quantity: "1" }),
    say("order recorded"),
  ]);
  // recordingSandbox 让 grant 之后订单真实派发一次，供下方"只发送一次"的断言使用。
  const { leases, sandbox } = recordingSandbox();
  const agent = await createResearchAgent({ models, model, sandbox });
  const app = createAgentHttp({
    authenticate,
    agent,
    threads: memoryThreads(),
    users: memoryUsers(),
    jwt,
    models,
    defaultModel: model,
    catalog: { defaultModelId: model, models: [] },
    log: quietLogger(),
  });
  const server = await listenAgentHttp(app, "127.0.0.1", 0);
  try {
    const parked = await postRun(server.url, {
      threadId: "thread-1",
      runId: "run-1",
      messages: [{ id: "user-1", role: "user", content: "Buy one BTC" }],
      forwardedProps: { horizon: "24h" },
    });
    const parkedEvents = eventsOf(await parked.text());
    const tool = parkedEvents.find((event) => event.type === "TOOL_CALL_START");
    assert.equal(tool?.toolCallName, "place-order");
    const finished = parkedEvents.at(-1);
    assert.equal(finished?.type, "RUN_FINISHED");
    const outcome = recordOf(finished?.outcome);
    assert.equal(outcome?.type, "interrupt");
    const interrupts = outcome?.interrupts;
    assert.equal(Array.isArray(interrupts), true);
    const interrupt = recordOf(Array.isArray(interrupts) ? interrupts[0] : undefined);
    const interruptId = interrupt?.id;
    assert.equal(typeof interruptId, "string");

    const granted = await postRun(server.url, {
      threadId: "thread-1",
      runId: "run-2",
      messages: [{ id: "user-1", role: "user", content: "Buy one BTC" }],
      resume: [{ interruptId, status: "resolved", payload: { decision: "grant" } }],
    });
    const grantedEvents = eventsOf(await granted.text());
    assert.equal(
      grantedEvents.some(
        (event) => event.type === "TOOL_CALL_RESULT" && event.content === "order BTC buy 1",
      ),
      true,
    );
    assert.equal(
      grantedEvents.some(
        (event) => event.type === "TEXT_MESSAGE_CONTENT" && event.delta === "order recorded",
      ),
      true,
    );
    assert.deepEqual(grantedEvents.at(-1)?.outcome, { type: "success" });
    assert.equal(leases.length, 1, "the grant sends the order exactly once");

    const again = await postRun(server.url, {
      threadId: "thread-1",
      runId: "run-3",
      messages: [{ id: "user-1", role: "user", content: "Buy one BTC" }],
      resume: [{ interruptId, status: "resolved", payload: { decision: "grant" } }],
    });
    assert.equal(again.status, 400);
    const rejected: unknown = await again.json();
    assert.deepEqual(rejected, { message: "This thread is not waiting for approval." });
  } finally {
    await server.close();
    await agent.close();
  }
});

test("registration mints a tenant and login issues a JWT that authenticates requests", async () => {
  const { models, model } = scripted([say("unused")]);
  const agent = await createResearchAgent({ models, model });
  const app = createAgentHttp({
    authenticate,
    agent,
    threads: memoryThreads(),
    users: memoryUsers(),
    jwt,
    models,
    defaultModel: model,
    catalog: { defaultModelId: model, models: [] },
    log: quietLogger(),
  });
  const server = await listenAgentHttp(app, "127.0.0.1", 0);
  const post = async (path: string, body: unknown) =>
    fetch(`${server.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const invalid = await post("/api/auth/register", {
      email: "not-an-email",
      password: "12345678",
    });
    assert.equal(invalid.status, 400);
    const weak = await post("/api/auth/register", { email: "user@example.com", password: "short" });
    assert.equal(weak.status, 400);

    const registered = await post("/api/auth/register", {
      email: "User@Example.com",
      password: "correct horse battery",
    });
    assert.equal(registered.status, 201);
    const created = (await registered.json()) as { tenantId: string };
    assert.match(created.tenantId, /^u_[0-9a-f]{24}$/);

    const duplicate = await post("/api/auth/register", {
      email: "user@example.com",
      password: "another password",
    });
    assert.equal(duplicate.status, 409);

    const wrong = await post("/api/auth/login", {
      email: "user@example.com",
      password: "wrong password",
    });
    assert.equal(wrong.status, 401);
    const unknown = await post("/api/auth/login", {
      email: "nobody@example.com",
      password: "whatever pass",
    });
    assert.equal(unknown.status, 401);

    const login = await post("/api/auth/login", {
      email: "USER@example.com",
      password: "correct horse battery",
    });
    assert.equal(login.status, 200);
    const session = (await login.json()) as { token: string; tenantId: string };
    assert.equal(session.tenantId, created.tenantId);

    const allowed = await fetch(`${server.url}/api/models`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.equal(allowed.status, 200);
    const conflicting = await fetch(`${server.url}/api/models`, {
      headers: { authorization: `Bearer ${session.token}`, "x-tenant-id": "local" },
    });
    assert.equal(conflicting.status, 401);
    const garbage = await fetch(`${server.url}/api/models`, {
      headers: { authorization: "Bearer not-a-jwt" },
    });
    assert.equal(garbage.status, 401);
  } finally {
    await server.close();
    await agent.close();
  }
});
