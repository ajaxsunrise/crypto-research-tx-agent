import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { EventType, type BaseEvent } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import {
  brand,
  type AgentCommand,
  type CallId,
  type ExecuteResult,
  type OperationId,
  type Rejection,
  type SessionId,
  type SessionView,
  type TenantId,
} from "@crypto/domain/lease";
import type { Models } from "@earendil-works/pi-ai";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { z } from "zod";

import { resolveModel, type OpenedAgent } from "../open.js";
import type { JwtAuth, TenantAuthenticator } from "./auth.js";
import type { ModelCatalogView } from "./catalog.js";
import { eventsForNewItems, finishForView, type WireEvent } from "./events.js";
import type { Logger } from "./logger.js";
import { parseRun, type ParsedRun } from "./parse-run.js";
import type { TenantThreads } from "./threads.js";
import type { UserDirectory } from "./users.js";

export type AgentHttpOptions = {
  readonly agent: OpenedAgent;
  readonly threads: TenantThreads;
  readonly models: Models;
  readonly defaultModel: string;
  readonly catalog: ModelCatalogView;
  readonly authenticate: TenantAuthenticator;
  readonly users: UserDirectory;
  readonly jwt: JwtAuth;
  readonly log: Logger;
  readonly webDistPath?: string;
};

type Ready =
  | {
      readonly kind: "start";
      readonly run: ParsedRun;
      readonly sessionId: SessionId | undefined;
      readonly model: string;
      readonly priorCount: number;
    }
  | {
      readonly kind: "approve";
      readonly run: ParsedRun;
      readonly sessionId: SessionId;
      readonly callId: CallId;
      readonly operationId: OperationId;
      readonly decision: "grant" | "deny";
      readonly priorCount: number;
    }
  | {
      readonly kind: "resume";
      readonly run: ParsedRun;
      readonly sessionId: SessionId;
      readonly priorCount: number;
    }
  | {
      readonly kind: "interrupt";
      readonly run: ParsedRun;
      readonly view: SessionView;
    };

function elapsedMs(started: bigint): number {
  return Math.round((Number(process.hrtime.bigint() - started) / 1e6) * 1000) / 1000;
}

// Every command goes through here so each one lands in the log with its outcome.
async function execute(options: AgentHttpOptions, command: AgentCommand): Promise<ExecuteResult> {
  const started = process.hrtime.bigint();
  const result = await options.agent.execute(command);
  const fields = {
    kind: command.kind,
    tenantId: command.tenantId,
    outcome: result.kind === "ok" ? "ok" : result.rejection.kind,
    durationMs: elapsedMs(started),
    ...("threadId" in command && command.threadId !== undefined
      ? { threadId: command.threadId }
      : {}),
    ...("sessionId" in command && command.sessionId !== undefined
      ? { sessionId: command.sessionId }
      : {}),
  };
  // reload also serves the 250ms polling, so it stays at DEBUG.
  if (result.kind === "ok") {
    if (command.kind === "reload") {
      options.log.debug("agent command", fields);
    } else {
      options.log.info("agent command", fields);
    }
  } else {
    options.log.warning("agent command rejected", fields);
  }
  return result;
}

async function loadThread(
  options: AgentHttpOptions,
  tenantId: TenantId,
  threadId: string,
): Promise<ExecuteResult> {
  const durable = await execute(options, { kind: "reload", tenantId, threadId });
  if (durable.kind === "ok" || durable.rejection.kind !== "session-not-found") {
    return durable;
  }
  const stored = await options.threads.forTenant(tenantId).get(threadId);
  if (stored === undefined) {
    return durable;
  }
  return execute(options, { kind: "reload", tenantId, sessionId: brand(stored, "SessionId") });
}

async function prepare(
  options: AgentHttpOptions,
  run: ParsedRun,
  tenantId: TenantId,
): Promise<Ready | { kind: "invalid"; message: string }> {
  const current = await loadThread(options, tenantId, run.threadId);
  if (current.kind !== "ok" && current.rejection.kind !== "session-not-found") {
    return { kind: "invalid", message: rejectionMessage(current.rejection) };
  }
  const view = current.kind === "ok" ? current.view : undefined;
  const sessionId = view?.sessionId;
  if (run.resume !== undefined) {
    if (view === undefined) {
      return { kind: "invalid", message: "This thread has no session to resume." };
    }
    if (view.status.kind !== "awaiting-approval") {
      return { kind: "invalid", message: "This thread is not waiting for approval." };
    }
    if (view.status.operationId !== run.resume.interruptId) {
      return { kind: "invalid", message: "interruptId does not match the parked order." };
    }
    return {
      kind: "approve",
      run,
      sessionId: view.sessionId,
      callId: view.status.callId,
      operationId: view.status.operationId,
      decision: run.resume.decision,
      priorCount: view.transcript.length,
    };
  }

  if (view !== undefined) {
    if (view.status.kind === "awaiting-approval") {
      return { kind: "interrupt", run, view };
    }
    if (view.status.kind === "running") {
      return { kind: "invalid", message: "in-progress" };
    }
    if (view.status.kind === "needs-resume") {
      return { kind: "resume", run, sessionId: view.sessionId, priorCount: view.transcript.length };
    }
  }

  const choice = run.model ?? options.defaultModel;
  try {
    if (resolveModel(options.models, choice) === undefined) {
      return { kind: "invalid", message: `Missing model ${choice}.` };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown model.";
    return { kind: "invalid", message };
  }
  return { kind: "start", run, sessionId, model: choice, priorCount: view?.transcript.length ?? 0 };
}

async function startRun(
  options: AgentHttpOptions,
  tenantId: TenantId,
  ready: Extract<Ready, { kind: "start" }>,
) {
  const question = ready.run.question;
  if (question === undefined) {
    throw new Error("A run needs a user message.");
  }
  const horizon = ready.run.horizon;
  const input = horizon !== undefined ? `${question}\nHorizon: ${horizon}` : question;
  return execute(options, {
    kind: "start",
    tenantId,
    idempotencyKey: JSON.stringify([ready.run.threadId, ready.run.runId]),
    threadId: ready.run.threadId,
    input,
    model: ready.model,
    extension: ready.run.extension,
    ...(ready.sessionId === undefined ? {} : { sessionId: ready.sessionId }),
  });
}

function rejectionMessage(rejection: Rejection): string {
  return rejection.kind === "invalid-request" ? rejection.message : rejection.kind;
}

function rejectionStatus(rejection: Rejection): 400 | 404 | 409 {
  if (rejection.kind === "session-not-found") {
    return 404;
  }
  return rejection.kind === "invalid-request" ? 400 : 409;
}

const authBodySchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Email is not valid."),
  password: z.string().min(8, "Password must be at least 8 characters."),
});

async function authBodyOf(c: {
  req: { json(): Promise<unknown> };
}): Promise<
  | { kind: "valid"; value: { email: string; password: string } }
  | { kind: "invalid"; message: string }
> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { kind: "invalid", message: "Request body must be JSON." };
  }
  const parsed = authBodySchema.safeParse(body);
  if (!parsed.success) {
    return { kind: "invalid", message: parsed.error.issues[0]?.message ?? "Invalid body." };
  }
  return { kind: "valid", value: parsed.data };
}

async function writeEvents(
  write: (event: BaseEvent) => Promise<void>,
  events: readonly WireEvent[],
): Promise<void> {
  for (const event of events) {
    await write(event);
  }
}

export function createAgentHttp(
  options: AgentHttpOptions,
): Hono<{ Variables: { tenantId: TenantId } }> {
  const app = new Hono<{ Variables: { tenantId: TenantId } }>();
  app.use("*", async (c, next) => {
    let tenant: string | undefined;
    const openAccess = c.req.path === "/api/auth/register" || c.req.path === "/api/auth/login";
    if (!openAccess && (c.req.path === "/agent" || c.req.path.startsWith("/api/"))) {
      const tenantId = await options.authenticate(c.req.raw);
      if (tenantId === undefined) {
        options.log.warning("authentication failed", { method: c.req.method, path: c.req.path });
        return c.json({ message: "Authentication required." }, 401);
      }
      tenant = tenantId;
      c.set("tenantId", tenantId);
    }
    const started = process.hrtime.bigint();
    await next();
    options.log.info("request", {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: elapsedMs(started),
      ...(tenant === undefined ? {} : { tenant }),
    });
  });
  app.post("/api/auth/register", async (c) => {
    const body = await authBodyOf(c);
    if (body.kind === "invalid") {
      return c.json({ message: body.message }, 400);
    }
    const outcome = await options.users.register(body.value.email, body.value.password);
    if (outcome.kind === "email-taken") {
      options.log.warning("registration rejected", { reason: "email-taken" });
      return c.json({ message: "This email is already registered." }, 409);
    }
    options.log.info("user registered", { tenantId: outcome.tenantId });
    return c.json({ tenantId: outcome.tenantId }, 201);
  });
  app.post("/api/auth/login", async (c) => {
    const body = await authBodyOf(c);
    if (body.kind === "invalid") {
      return c.json({ message: body.message }, 400);
    }
    const tenantId = await options.users.login(body.value.email, body.value.password);
    if (tenantId === undefined) {
      options.log.warning("login failed", {});
      return c.json({ message: "Email or password is wrong." }, 401);
    }
    const token = await options.jwt.issue({ tenantId });
    options.log.info("user login", { tenantId });
    return c.json({ token, tenantId });
  });
  app.get("/api/models", (c) => c.json(options.catalog));
  app.get("/api/threads", async (c) => {
    const result = await options.agent.listThreads(c.get("tenantId"));
    if (result.kind !== "ok") {
      return c.json(
        { message: rejectionMessage(result.rejection) },
        rejectionStatus(result.rejection),
      );
    }
    return c.json({ threads: result.threads });
  });
  app.get("/api/threads/:threadId", async (c) => {
    const result = await loadThread(options, c.get("tenantId"), c.req.param("threadId"));
    if (result.kind !== "ok") {
      return c.json(
        { message: rejectionMessage(result.rejection) },
        rejectionStatus(result.rejection),
      );
    }
    return c.json(result.view);
  });
  for (const kind of ["resume", "cancel"] as const) {
    app.post(`/api/threads/:threadId/${kind}`, async (c) => {
      const tenantId = c.get("tenantId");
      const current = await loadThread(options, tenantId, c.req.param("threadId"));
      if (current.kind !== "ok") {
        return c.json(
          { message: rejectionMessage(current.rejection) },
          rejectionStatus(current.rejection),
        );
      }
      const result = await execute(options, { kind, tenantId, sessionId: current.view.sessionId });
      if (result.kind !== "ok") {
        return c.json(
          { message: rejectionMessage(result.rejection) },
          rejectionStatus(result.rejection),
        );
      }
      return c.json(result.view);
    });
  }
  app.post("/agent", async (c) => {
    const tenantId = c.get("tenantId");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ message: "Request body must be JSON." }, 400);
    }
    const parsed = parseRun(body);
    if (parsed.kind === "invalid") {
      return c.json({ message: parsed.message }, 400);
    }
    const ready = await prepare(options, parsed.run, tenantId);
    if (ready.kind === "invalid") {
      return c.json({ message: ready.message }, 400);
    }
    const encoder = new EventEncoder({ accept: c.req.header("accept") });
    c.header("Content-Type", encoder.getContentType());
    c.header("Cache-Control", "no-cache");
    return stream(c, async (out) => {
      const write = async (event: BaseEvent) => {
        if (!out.aborted && !out.closed) {
          await out.write(encoder.encode(event));
        }
      };
      const abort = () => out.abort();
      c.req.raw.signal.addEventListener("abort", abort, { once: true });
      const disconnected = new Promise<{ kind: "disconnected" }>((resolve) => {
        out.onAbort(() => resolve({ kind: "disconnected" }));
        if (out.aborted || c.req.raw.signal.aborted) {
          abort();
          resolve({ kind: "disconnected" });
        }
      });
      await write({
        type: EventType.RUN_STARTED,
        threadId: ready.run.threadId,
        runId: ready.run.runId,
      });
      try {
        if (ready.kind === "interrupt") {
          await write(
            finishForView({
              threadId: ready.run.threadId,
              runId: ready.run.runId,
              view: ready.view,
            }),
          );
          options.log.info("run finished", {
            threadId: ready.run.threadId,
            runId: ready.run.runId,
            status: "awaiting-approval",
          });
          return;
        }

        const execution =
          ready.kind === "approve"
            ? execute(options, {
                kind: "approve",
                tenantId,
                sessionId: ready.sessionId,
                callId: ready.callId,
                operationId: ready.operationId,
                decision: ready.decision,
              })
            : ready.kind === "resume"
              ? execute(options, { kind: "resume", tenantId, sessionId: ready.sessionId })
              : startRun(options, tenantId, ready);
        const completion = execution.then(
          (result) => ({ kind: "completed" as const, result }),
          (error: unknown) => ({ kind: "failed" as const, error }),
        );
        let priorCount = ready.priorCount;
        const append = async (view: SessionView) => {
          await writeEvents(
            write,
            eventsForNewItems(view.transcript.slice(priorCount), priorCount),
          );
          priorCount = view.transcript.length;
        };
        let result: ExecuteResult;
        for (;;) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const tick = new Promise<{ kind: "tick" }>((resolve) => {
            timer = setTimeout(() => resolve({ kind: "tick" }), 250);
          });
          const next = await Promise.race([completion, tick, disconnected]);
          clearTimeout(timer);
          if (next.kind === "disconnected" || out.aborted) {
            return;
          }
          if (next.kind === "failed") {
            throw next.error;
          }
          if (next.kind === "completed") {
            result = next.result;
            break;
          }
          const current = await loadThread(options, tenantId, ready.run.threadId);
          if (current.kind === "ok") {
            await append(current.view);
          } else if (current.rejection.kind !== "session-not-found") {
            throw new Error(rejectionMessage(current.rejection));
          }
        }
        if (result.kind !== "ok") {
          await write({ type: EventType.RUN_ERROR, message: rejectionMessage(result.rejection) });
          options.log.warning("run rejected", {
            threadId: ready.run.threadId,
            runId: ready.run.runId,
            rejection: rejectionMessage(result.rejection),
          });
          return;
        }
        await append(result.view);
        await write(
          finishForView({
            threadId: ready.run.threadId,
            runId: ready.run.runId,
            view: result.view,
          }),
        );
        options.log.info("run finished", {
          threadId: ready.run.threadId,
          runId: ready.run.runId,
          status: result.view.status.kind,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "failed";
        await write({ type: EventType.RUN_ERROR, message });
        options.log.error("run failed", {
          threadId: ready.run.threadId,
          runId: ready.run.runId,
          error: message,
        });
      } finally {
        c.req.raw.signal.removeEventListener("abort", abort);
      }
    });
  });
  if (options.webDistPath !== undefined) {
    if (!existsSync(options.webDistPath)) {
      throw new Error(`WEB_DIST ${options.webDistPath} does not exist.`);
    }
    app.use("/*", serveStatic({ root: options.webDistPath }));
    // SPA 前端路由（如 /login）的回退：非 API 路径一律返回 index.html。
    app.get("*", async (c) => {
      if (c.req.path === "/agent" || c.req.path.startsWith("/api/")) {
        return c.json({ message: "Not found." }, 404);
      }
      const index = await readFile(join(options.webDistPath!, "index.html"), "utf8");
      return c.html(index);
    });
  }
  return app;
}

export function listenAgentHttp(
  app: { fetch: (request: Request) => Response | Promise<Response> },
  host: string,
  port: number,
): Promise<{ url: string; close(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
      const address = info.address.includes(":") ? `[${info.address}]` : info.address;
      server.removeListener("error", reject);
      resolve({
        url: `http://${address}:${info.port}`,
        close() {
          return new Promise((done, fail) => {
            server.close((error) => (error === undefined ? done() : fail(error)));
          });
        },
      });
    });
    server.once("error", reject);
  });
}
