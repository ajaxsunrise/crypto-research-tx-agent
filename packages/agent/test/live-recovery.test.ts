import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout } from "node:timers/promises";

import {
  brand,
  type ExecuteResult,
  type LeaseExecutor,
  type SessionId,
  type SessionView,
} from "@crypto/domain/lease";
import { createSandbox } from "@crypto/sandbox";
import pg from "pg";

import { readCatalog, registerCatalog } from "../src/http/catalog.js";
import { loadEnvFile, loadServerConfig } from "../src/http/config.js";
import { openAgentWorker, type AgentWorker } from "../src/index.js";
import type { RunState } from "../src/research.js";

const live = process.env.CRYPTO_LIVE_TESTS === "1";
if (live) {
  loadEnvFile();
}
const config = live
  ? loadServerConfig({
      ...process.env,
      TENANT_TOKENS: JSON.stringify({ live_alpha: randomUUID() + randomUUID() }),
    })
  : undefined;
const models =
  config === undefined ? undefined : registerCatalog(await readCatalog(config.catalogPath));
const alpha = brand("live_alpha", "TenantId");
const beta = brand("live_beta", "TenantId");

function view(result: ExecuteResult): SessionView {
  assert.ok(result.kind === "ok", JSON.stringify(result));
  return result.view;
}

function awaiting(session: SessionView) {
  assert.ok(session.status.kind === "awaiting-approval", JSON.stringify(session.status));
  return session.status;
}

function orderBrief() {
  return {
    question: [
      "Call place-order exactly once with symbol BTC-USDT, side buy, quantity 0.0001.",
      "Call place-order alone in one response containing no other tool calls.",
      "The order requires human approval. Stop after making the approval request.",
      "After receiving its approval result, describe that result in one sentence and call no tools.",
    ].join(" "),
    horizon: "24h",
  };
}

async function setup(t: TestContext) {
  assert.ok(config);
  assert.ok(models);
  const schema = `live_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: config.connectionString });
  await admin.connect();
  const database = await admin.query<{ name: string }>("SELECT current_database() AS name");
  assert.match(database.rows[0].name, /test/i, "真实集成测试必须使用 test 数据库。");
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const scratch = resolve(".scratch");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "live-agent-"));
  const workers = new Set<AgentWorker>();
  const blocked = new Set<string>();
  const actualSandbox = createSandbox(root);
  const sandbox: LeaseExecutor = async (lease, signal) => {
    if (lease.kind === "external") {
      await appendFile(join(root, `operation-${lease.task.operationId}.calls`), "1");
      if (blocked.has(lease.task.operationId)) {
        await readFile(join(root, `release-${lease.task.operationId}`), "utf8");
      }
    }
    return actualSandbox(lease, signal);
  };
  t.after(async () => {
    try {
      for (const operationId of blocked) {
        if (existsSync(join(root, `operation-${operationId}.calls`))) {
          await appendFile(join(root, `release-${operationId}`), "continue");
        }
      }
      await Promise.all([...workers].map((worker) => worker.close()));
    } finally {
      try {
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await admin.end();
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
  return {
    schema,
    root,
    admin,
    blockExecution(operationId: string) {
      execFileSync("mkfifo", [join(root, `release-${operationId}`)]);
      blocked.add(operationId);
    },
    async waitForExecution(operationId: string) {
      const path = join(root, `operation-${operationId}.calls`);
      const deadline = Date.now() + 10_000;
      while (!existsSync(path) && Date.now() < deadline) {
        await setTimeout(10);
      }
      assert.ok(existsSync(path), "订单执行器没有开始工作。");
    },
    async releaseExecution(operationId: string) {
      await appendFile(join(root, `release-${operationId}`), "continue");
      blocked.delete(operationId);
    },
    async open() {
      const worker = await openAgentWorker({
        connectionString: config.connectionString,
        schema,
        sandboxRoot: root,
        sandbox,
        model: config.defaultModel,
        models,
      });
      workers.add(worker);
      await worker.recovery;
      return worker;
    },
    async close(worker: AgentWorker) {
      await worker.close();
      workers.delete(worker);
    },
    async continuations(sessionId: SessionId, operationId: string) {
      const result = await admin.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM "${schema}".submissions
         WHERE conversation_id = $1 AND request_id = $2`,
        [Number(sessionId), JSON.stringify(`order:${operationId}`)],
      );
      return Number(result.rows[0].count);
    },
    async executions(operationId: string) {
      const path = join(root, `operation-${operationId}.calls`);
      return existsSync(path) ? (await readFile(path, "utf8")).length : 0;
    },
  };
}

test(
  "真实模型审批、取消、并发控制与多租户 thread 持久化",
  { skip: !live, timeout: 180_000 },
  async (t) => {
    const state = await setup(t);
    let worker = await state.open();
    const threadId = randomUUID();
    const deniedStart = view(
      await worker.execute({
        kind: "start",
        tenantId: alpha,
        idempotencyKey: "shared-key",
        threadId,
        brief: orderBrief(),
      }),
    );
    const deniedOrder = awaiting(deniedStart);
    assert.equal(
      view(await worker.execute({ kind: "reload", tenantId: alpha, threadId })).sessionId,
      deniedStart.sessionId,
    );
    for (const command of [
      { kind: "reload", tenantId: beta, sessionId: deniedStart.sessionId } as const,
      { kind: "reload", tenantId: beta, threadId } as const,
      {
        kind: "approve",
        tenantId: beta,
        sessionId: deniedStart.sessionId,
        callId: deniedOrder.callId,
        operationId: deniedOrder.operationId,
        decision: "grant",
      } as const,
    ]) {
      assert.deepEqual(await worker.execute(command), {
        kind: "rejected",
        rejection: { kind: "session-not-found" },
      });
    }
    const other = view(
      await worker.execute({
        kind: "start",
        tenantId: beta,
        idempotencyKey: "shared-key",
        threadId,
        brief: { question: "Reply with two words about crypto. Call no tools.", horizon: "24h" },
      }),
    );
    assert.equal(other.status.kind, "completed");
    assert.notEqual(other.sessionId, deniedStart.sessionId);
    assert.equal(
      view(await worker.execute({ kind: "reload", tenantId: beta, threadId })).sessionId,
      other.sessionId,
    );

    const denial = {
      kind: "approve",
      tenantId: alpha,
      sessionId: deniedStart.sessionId,
      callId: deniedOrder.callId,
      operationId: deniedOrder.operationId,
      decision: "deny",
    } as const;
    const parallel = await Promise.all([
      worker.execute(denial),
      worker.execute({ kind: "resume", tenantId: alpha, sessionId: deniedStart.sessionId }),
    ]);
    assert.ok(
      parallel.every(
        (result) =>
          result.kind === "ok" ||
          (result.kind === "rejected" && result.rejection.kind === "in-progress"),
      ),
    );
    let denied = view(await worker.execute({ kind: "reload", tenantId: alpha, threadId }));
    if (denied.status.kind === "awaiting-approval") {
      denied = view(await worker.execute(denial));
    }
    assert.equal(denied.status.kind, "completed");
    const deniedResults = denied.transcript.filter(
      (item) => item.kind === "tool-result" && item.callId === deniedOrder.callId,
    );
    assert.deepEqual(deniedResults, [
      { kind: "tool-result", callId: deniedOrder.callId, result: { kind: "denied" } },
    ]);
    assert.equal(await state.executions(deniedOrder.operationId), 0);
    assert.equal(await state.continuations(denied.sessionId, deniedOrder.operationId), 1);

    const grantThread = randomUUID();
    const grantStart = view(
      await worker.execute({
        kind: "start",
        tenantId: alpha,
        idempotencyKey: "grant",
        threadId: grantThread,
        brief: orderBrief(),
      }),
    );
    const grantOrder = awaiting(grantStart);
    const grant = {
      kind: "approve",
      tenantId: alpha,
      sessionId: grantStart.sessionId,
      callId: grantOrder.callId,
      operationId: grantOrder.operationId,
      decision: "grant",
    } as const;
    const granted = view(await worker.execute(grant));
    assert.equal(granted.status.kind, "completed");
    const grantResults = granted.transcript.filter(
      (item) => item.kind === "tool-result" && item.callId === grantOrder.callId,
    );
    assert.deepEqual(grantResults, [
      {
        kind: "tool-result",
        callId: grantOrder.callId,
        result: { kind: "failed", message: "Order execution is not configured." },
      },
    ]);
    assert.deepEqual(await worker.execute(grant), {
      kind: "rejected",
      rejection: { kind: "not-awaiting-approval" },
    });
    assert.equal(await state.executions(grantOrder.operationId), 1);
    assert.equal(await state.continuations(granted.sessionId, grantOrder.operationId), 1);
    const resumed = view(
      await worker.execute({ kind: "resume", tenantId: alpha, sessionId: granted.sessionId }),
    );
    assert.deepEqual(resumed, granted);
    assert.equal(await state.executions(grantOrder.operationId), 1);

    const cancelStart = view(
      await worker.execute({
        kind: "start",
        tenantId: alpha,
        idempotencyKey: "cancel",
        threadId: randomUUID(),
        brief: orderBrief(),
      }),
    );
    const cancelOrder = awaiting(cancelStart);
    state.blockExecution(cancelOrder.operationId);
    const approving = worker.execute({
      kind: "approve",
      tenantId: alpha,
      sessionId: cancelStart.sessionId,
      callId: cancelOrder.callId,
      operationId: cancelOrder.operationId,
      decision: "grant",
    });
    await state.waitForExecution(cancelOrder.operationId);
    const cancelled = view(
      await worker.execute({ kind: "cancel", tenantId: alpha, sessionId: cancelStart.sessionId }),
    );
    assert.equal(cancelled.status.kind, "cancelled");
    await approving;
    await state.releaseExecution(cancelOrder.operationId);
    const cancelledResume = view(
      await worker.execute({ kind: "resume", tenantId: alpha, sessionId: cancelled.sessionId }),
    );
    assert.equal(cancelledResume.status.kind, "cancelled");
    assert.equal(await state.continuations(cancelled.sessionId, cancelOrder.operationId), 0);
    assert.equal(await state.executions(cancelOrder.operationId), 1);

    const closeStart = view(
      await worker.execute({
        kind: "start",
        tenantId: alpha,
        idempotencyKey: "close",
        threadId: randomUUID(),
        brief: orderBrief(),
      }),
    );
    const closeOrder = awaiting(closeStart);
    state.blockExecution(closeOrder.operationId);
    const closingApproval = worker.execute({
      kind: "approve",
      tenantId: alpha,
      sessionId: closeStart.sessionId,
      callId: closeOrder.callId,
      operationId: closeOrder.operationId,
      decision: "grant",
    });
    await state.waitForExecution(closeOrder.operationId);
    const closing = state.close(worker);
    await closingApproval;
    await state.releaseExecution(closeOrder.operationId);
    await closing;
    worker = await state.open();
    const recoveredOrder = view(
      await worker.execute({
        kind: "reload",
        tenantId: alpha,
        sessionId: closeStart.sessionId,
      }),
    );
    assert.equal(recoveredOrder.status.kind, "completed");
    assert.ok(
      recoveredOrder.transcript.some(
        (item) =>
          item.kind === "tool-result" &&
          item.callId === closeOrder.callId &&
          item.result.kind === "interrupted",
      ),
    );
    assert.equal(await state.executions(closeOrder.operationId), 1);
    assert.equal(await state.continuations(closeStart.sessionId, closeOrder.operationId), 1);

    await state.close(worker);
    worker = await state.open();
    assert.deepEqual(
      view(await worker.execute({ kind: "reload", tenantId: alpha, threadId })),
      denied,
    );
    assert.deepEqual(
      view(await worker.execute({ kind: "reload", tenantId: beta, threadId })),
      other,
    );
    assert.deepEqual(
      view(await worker.execute({ kind: "reload", tenantId: alpha, threadId: grantThread })),
      granted,
    );
    assert.equal(await state.executions(grantOrder.operationId), 1);
    assert.equal(await state.continuations(granted.sessionId, grantOrder.operationId), 1);
    assert.equal(
      view(
        await worker.execute({ kind: "reload", tenantId: alpha, sessionId: cancelled.sessionId }),
      ).status.kind,
      "cancelled",
    );
    assert.equal(await state.continuations(cancelled.sessionId, cancelOrder.operationId), 0);
  },
);

test(
  "SIGKILL 后 openAgentWorker 自动恢复已持久保存的 pending start",
  { skip: !live, timeout: 90_000 },
  async (t) => {
    const state = await setup(t);
    const child = fork(resolve(".scratch/live-recovery-child.mjs"), [state.schema, state.root], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      execArgv: [],
    });
    const exited = once(child, "exit");
    let locked = false;
    try {
      await Promise.race([
        once(child, "message").then(([message]) => assert.deepEqual(message, { kind: "ready" })),
        exited.then(([code, signal]) => {
          throw new Error(`Worker exited before ready: ${code} ${signal}`);
        }),
      ]);
      await state.admin.query("BEGIN");
      await state.admin.query(`LOCK TABLE "${state.schema}".submissions IN ACCESS EXCLUSIVE MODE`);
      locked = true;
      const threadId = randomUUID();
      child.send({
        kind: "start",
        tenantId: alpha,
        idempotencyKey: "pending",
        threadId,
        brief: {
          question: "Reply with one sentence about Bitcoin. Call no tools.",
          horizon: "24h",
        },
      });
      let sessionId: SessionId | undefined;
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && sessionId === undefined) {
        const records = await state.admin.query<{ key_value: string; content: string }>(
          `SELECT d.key_value, r.content FROM "${state.schema}".documents d
         JOIN "${state.schema}".document_revisions r ON r.document_id = d.id
         WHERE d.kind = $1 AND r.kind = 'base' ORDER BY r.seq DESC LIMIT 1`,
          [JSON.stringify("crypto.run")],
        );
        const record = records.rows[0];
        if (record !== undefined) {
          const run = JSON.parse(record.content) as RunState;
          if (run.pendingStart === "t:live_alpha:pending") {
            assert.equal(run.submissionId, 0);
            assert.deepEqual(run.outcome, { kind: "open" });
            sessionId = brand(JSON.parse(record.key_value) as string, "SessionId");
          }
        }
        if (sessionId === undefined) {
          await setTimeout(10);
        }
      }
      assert.ok(sessionId, "必须观察到已经提交的 pending start。");
      child.kill("SIGKILL");
      const [code, signal] = await exited;
      assert.equal(code, null);
      assert.equal(signal, "SIGKILL");
      await state.admin.query("ROLLBACK");
      locked = false;
      const worker = await state.open();
      const recovered = view(await worker.execute({ kind: "reload", tenantId: alpha, threadId }));
      assert.equal(recovered.sessionId, sessionId);
      assert.equal(recovered.status.kind, "completed");
      assert.equal(recovered.transcript.filter((item) => item.kind === "user").length, 1);
      const retried = view(
        await worker.execute({
          kind: "start",
          tenantId: alpha,
          idempotencyKey: "pending",
          threadId,
          brief: {
            question: "Reply with one sentence about Bitcoin. Call no tools.",
            horizon: "24h",
          },
        }),
      );
      assert.deepEqual(retried, recovered);
      assert.deepEqual(await worker.execute({ kind: "reload", tenantId: beta, sessionId }), {
        kind: "rejected",
        rejection: { kind: "session-not-found" },
      });
      await state.close(worker);
      const reopened = await state.open();
      assert.deepEqual(
        view(await reopened.execute({ kind: "reload", tenantId: alpha, threadId })),
        recovered,
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
      if (locked) {
        await state.admin.query("ROLLBACK");
      }
    }
  },
);
