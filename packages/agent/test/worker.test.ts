import assert from "node:assert/strict";
import test from "node:test";

import { brand } from "@crypto/domain/lease";
import pg from "pg";

import { openAgentWorker, StorageBusy, type AgentWorkerOptions } from "../src/index.js";
import {
  crashInSandbox,
  crashTenant,
  lastUserText,
  recordingSandbox,
  say,
  scripted,
  view,
  type Reply,
} from "./fixtures.js";

const connectionString = process.env.CRYPTO_TEST_POSTGRES ?? "postgres:///crypto_research_test";
const schema = `agent_${process.pid}`;

async function reachable(): Promise<boolean> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

const skip = (await reachable()) ? false : `no Postgres reachable at ${connectionString}`;

test.after(async () => {
  if (skip !== false) {
    return;
  }
  const client = new pg.Client({ connectionString });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await client.end();
});

function open(replies: Reply[], extra: Partial<AgentWorkerOptions> = {}) {
  const { models, model } = scripted(replies);
  return openAgentWorker({
    connectionString,
    schema,
    models: () => models,
    model,
    ...extra,
  });
}

const brief = (question: string) => `${question}\nHorizon: 24h`;

test("two tenants in one worker own separate sessions", { skip }, async () => {
  const worker = await open([say("answer for a"), say("answer for b")]);
  const alpha = brand("alpha", "TenantId");
  const beta = brand("beta", "TenantId");
  try {
    const a = view(
      await worker.execute({
        kind: "start",
        tenantId: alpha,
        idempotencyKey: "same-key",
        input: brief("question a"),
      }),
    );
    const b = view(
      await worker.execute({
        kind: "start",
        tenantId: beta,
        idempotencyKey: "same-key",
        input: brief("question b"),
      }),
    );
    // One idempotency key per tenant, one session per tenant, in the one shared schema.
    assert.notEqual(a.sessionId, b.sessionId);
    assert.equal(a.status.kind === "completed" ? a.status.text : "", "answer for a");
    assert.equal(b.status.kind === "completed" ? b.status.text : "", "answer for b");

    const cross = await worker.execute({
      kind: "reload",
      tenantId: alpha,
      sessionId: b.sessionId,
    });
    assert.deepEqual(cross, { kind: "rejected", rejection: { kind: "session-not-found" } });
  } finally {
    await worker.close();
  }
});

test("a second worker cannot open a storage that is already open", { skip }, async () => {
  const first = await open([]);
  try {
    await assert.rejects(open([]), StorageBusy);
  } finally {
    await first.close();
  }
  const reopened = await open([]);
  await reopened.close();
});

test("an invalid schema name never reaches the database", async () => {
  await assert.rejects(open([], { schema: 'x"; DROP SCHEMA public; --' }), /not usable/);
});

test("a dead worker's storage is taken over and its order is not resent", { skip }, async () => {
  crashInSandbox("order", `postgres:${schema}`);

  // No cleanup ran in the dead worker; Postgres released its lock when the connection dropped.
  // resumeOnOpen 关闭，让测试自己用 resume 驱动修复；打开时的自动恢复路径由 live-recovery 套件覆盖。
  const { leases, sandbox } = recordingSandbox();
  const worker = await open(
    [
      (context) => {
        assert.match(lastUserText(context), /interrupted/);
        return say("the order may not have been sent");
      },
    ],
    { sandbox, resumeOnOpen: false },
  );
  try {
    const found = view(
      await worker.execute({
        kind: "start",
        tenantId: crashTenant,
        idempotencyKey: "crash",
        input: brief("x"),
      }),
    );
    assert.equal(found.status.kind, "needs-resume");
    const resumed = view(
      await worker.execute({ kind: "resume", tenantId: crashTenant, sessionId: found.sessionId }),
    );
    const result = resumed.transcript.find((item) => item.kind === "tool-result");
    assert.equal(result?.kind === "tool-result" ? result.result.kind : undefined, "interrupted");
    assert.equal(resumed.status.kind, "completed");
    assert.equal(leases.length, 0);
  } finally {
    await worker.close();
  }
});
