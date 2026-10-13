import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { brand } from "@crypto/domain/lease";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";

import { createResearchAgent, type ExecuteResult, type SessionView } from "../src/index.js";
import {
  call,
  lastToolResultText,
  lastUserText,
  noRetry,
  question,
  recordingSandbox,
  say,
  scripted,
  tenant,
} from "./fixtures.js";

function view(result: ExecuteResult): SessionView {
  if (result.kind !== "ok") {
    assert.fail(`expected ok, got ${JSON.stringify(result.rejection)}`);
  }
  return result.view;
}

const brief = { question, horizon: "24h" };

test("an unknown model is rejected before a run starts", async () => {
  const { models } = scripted([]);
  await assert.rejects(
    createResearchAgent({ models, model: "nope/nope" }),
    /Unknown model nope\/nope/,
  );
  await assert.rejects(createResearchAgent({ models, model: "nope" }), /Unknown model nope/);
});

test("a start naming a model the catalog does not know is rejected", async () => {
  const { models, model } = scripted([]);
  const agent = await createResearchAgent({ models, model });
  try {
    const result = await agent.execute({
      kind: "start",
      tenantId: tenant,
      idempotencyKey: "model",
      brief,
      model: "nope/nope",
    });
    if (result.kind !== "rejected" || result.rejection.kind !== "invalid-request") {
      assert.fail(`expected an invalid-request rejection, got ${JSON.stringify(result)}`);
    }
    assert.match(result.rejection.message, /Unknown model nope\/nope/);
  } finally {
    await agent.close();
  }
});

test("two tenants in one agent own separate sessions", async () => {
  const { models, model } = scripted([say("answer for a"), say("answer for b")]);
  const agent = await createResearchAgent({ models, model });
  const alpha = brand("alpha", "TenantId");
  const beta = brand("beta", "TenantId");
  try {
    const a = view(
      await agent.execute({
        kind: "start",
        tenantId: alpha,
        idempotencyKey: "same-key",
        brief: { question: "question a", horizon: "24h" },
      }),
    );
    const b = view(
      await agent.execute({
        kind: "start",
        tenantId: beta,
        idempotencyKey: "same-key",
        brief: { question: "question b", horizon: "24h" },
      }),
    );
    // One idempotency key per tenant: the same key starts two sessions.
    assert.notEqual(a.sessionId, b.sessionId);
    assert.equal(a.status.kind === "completed" ? a.status.text : "", "answer for a");
    assert.equal(b.status.kind === "completed" ? b.status.text : "", "answer for b");

    // A retried start finds its own tenant's session and does not run it again.
    const retry = view(
      await agent.execute({
        kind: "start",
        tenantId: beta,
        idempotencyKey: "same-key",
        brief: { question: "question b again", horizon: "24h" },
      }),
    );
    assert.equal(retry.sessionId, b.sessionId);
    assert.equal(retry.head, b.head);

    // The owner row is the boundary: another tenant cannot reach the session.
    const cross = await agent.execute({ kind: "reload", tenantId: alpha, sessionId: b.sessionId });
    assert.deepEqual(cross, { kind: "rejected", rejection: { kind: "session-not-found" } });
  } finally {
    await agent.close();
  }
});

test("two starts with one key keep the same session and run once", async () => {
  const { models, model } = scripted([say("funding was flat"), say("must not be asked")]);
  const agent = await createResearchAgent({ models, model });
  try {
    const first = view(
      await agent.execute({ kind: "start", tenantId: tenant, idempotencyKey: "k", brief }),
    );
    assert.equal(first.status.kind, "completed");
    if (first.status.kind === "completed") {
      assert.equal(first.status.text, "funding was flat");
    }
    assert.equal(first.transcript[0]?.kind, "user");

    const second = view(
      await agent.execute({
        kind: "start",
        tenantId: tenant,
        idempotencyKey: "k",
        brief: { question: "A different question", horizon: "1h" },
      }),
    );
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(second.head, first.head);
    assert.deepEqual(second.status, first.status);

    const reloaded = view(
      await agent.execute({ kind: "reload", tenantId: tenant, sessionId: first.sessionId }),
    );
    assert.deepEqual(reloaded, first);
    const persisted = view(
      await agent.execute({ kind: "persist", tenantId: tenant, sessionId: first.sessionId }),
    );
    assert.deepEqual(persisted, first);
  } finally {
    await agent.close();
  }
});

test("an empty brief is rejected", async () => {
  const { models, model } = scripted([]);
  const agent = await createResearchAgent({ models, model });
  try {
    const result = await agent.execute({
      kind: "start",
      tenantId: tenant,
      idempotencyKey: "k",
      brief: { question: " ", horizon: "24h" },
    });
    assert.equal(result.kind, "rejected");
  } finally {
    await agent.close();
  }
});

test("a read-market call reads once through the sandbox and completes", async () => {
  const { leases, sandbox } = recordingSandbox();
  const { models, model } = scripted([
    call("read-market", { symbol: "BTC" }),
    (context) => {
      assert.equal(lastToolResultText(context), "market BTC");
      return say("funding was flat");
    },
  ]);
  const agent = await createResearchAgent({ models, model, sandbox });
  try {
    const started = view(
      await agent.execute({ kind: "start", tenantId: tenant, idempotencyKey: "read", brief }),
    );
    assert.equal(started.status.kind, "completed");
    assert.equal(leases.length, 1);
    assert.equal(leases[0]?.kind, "replayable");
    const result = started.transcript.find((item) => item.kind === "tool-result");
    assert.deepEqual(result?.kind === "tool-result" ? result.result : undefined, {
      kind: "ok",
      text: "market BTC",
    });
  } finally {
    await agent.close();
  }
});

test("place-order parks for approval and one grant sends it once", async () => {
  const { leases, sandbox } = recordingSandbox();
  const { models, model } = scripted([
    // A model-supplied operation id is not a parameter; the tool mints its own.
    call("place-order", { symbol: "BTC", side: "buy", quantity: "1" }),
    (context) => {
      assert.match(lastUserText(context), /approved and sent: order BTC buy 1/);
      return say("order sent");
    },
  ]);
  const agent = await createResearchAgent({ models, model, sandbox });
  try {
    const started = view(
      await agent.execute({ kind: "start", tenantId: tenant, idempotencyKey: "order", brief }),
    );
    if (started.status.kind !== "awaiting-approval") {
      assert.fail(`expected awaiting-approval, got ${started.status.kind}`);
    }
    assert.equal(started.status.tool, "place-order");
    assert.equal(leases.length, 0, "nothing is sent before a grant");
    const { callId, operationId } = started.status;

    const resumed = view(
      await agent.execute({ kind: "resume", tenantId: tenant, sessionId: started.sessionId }),
    );
    assert.equal(resumed.status.kind, "awaiting-approval", "resume does not send a parked order");
    assert.equal(leases.length, 0);

    const mismatched = await agent.execute({
      kind: "approve",
      tenantId: tenant,
      sessionId: started.sessionId,
      callId,
      operationId: "someone-else" as typeof operationId,
      decision: "grant",
    });
    assert.deepEqual(mismatched, { kind: "rejected", rejection: { kind: "approval-mismatch" } });

    const approved = view(
      await agent.execute({
        kind: "approve",
        tenantId: tenant,
        sessionId: started.sessionId,
        callId,
        operationId,
        decision: "grant",
      }),
    );
    assert.equal(approved.status.kind, "completed");
    assert.equal(leases.length, 1);
    const lease = leases[0];
    assert.equal(lease?.kind, "external");
    if (lease?.kind === "external") {
      assert.equal(lease.task.operationId, operationId);
      assert.equal(lease.effect.approval.operationId, operationId);
    }
    const result = approved.transcript.find((item) => item.kind === "tool-result");
    assert.deepEqual(result?.kind === "tool-result" ? result.result : undefined, {
      kind: "ok",
      text: "order BTC buy 1",
    });

    const again = await agent.execute({
      kind: "approve",
      tenantId: tenant,
      sessionId: started.sessionId,
      callId,
      operationId,
      decision: "grant",
    });
    assert.deepEqual(again, { kind: "rejected", rejection: { kind: "not-awaiting-approval" } });
    assert.equal(leases.length, 1, "a second approve does not send again");
  } finally {
    await agent.close();
  }
});

test("deny closes the order without calling the sandbox", async () => {
  const { leases, sandbox } = recordingSandbox();
  const { models, model } = scripted([
    call("place-order", { symbol: "ETH", side: "buy", quantity: "3" }),
    say("the order was denied"),
  ]);
  const agent = await createResearchAgent({ models, model, sandbox });
  try {
    const started = view(
      await agent.execute({ kind: "start", tenantId: tenant, idempotencyKey: "deny", brief }),
    );
    if (started.status.kind !== "awaiting-approval") {
      assert.fail("expected the order to park");
    }
    const denied = view(
      await agent.execute({
        kind: "approve",
        tenantId: tenant,
        sessionId: started.sessionId,
        callId: started.status.callId,
        operationId: started.status.operationId,
        decision: "deny",
      }),
    );
    const result = denied.transcript.find((item) => item.kind === "tool-result");
    assert.deepEqual(result?.kind === "tool-result" ? result.result : undefined, {
      kind: "denied",
    });
    assert.equal(denied.status.kind, "completed");
    assert.equal(leases.length, 0);
  } finally {
    await agent.close();
  }
});

test("a sandbox failure during an order is reported interrupted on resume, never resent", async () => {
  let sends = 0;
  const { sandbox } = recordingSandbox(() => {
    sends += 1;
    throw new Error("worker lost");
  });
  const { models, model } = scripted([
    call("place-order", { symbol: "BTC", side: "sell", quantity: "2" }),
    (context) => {
      assert.match(lastUserText(context), /interrupted/);
      return say("the order may not have landed");
    },
  ]);
  const agent = await createResearchAgent({ models, model, sandbox });
  try {
    const started = view(
      await agent.execute({ kind: "start", tenantId: tenant, idempotencyKey: "lost", brief }),
    );
    if (started.status.kind !== "awaiting-approval") {
      assert.fail("expected the order to park");
    }
    const { callId, operationId } = started.status;
    await assert.rejects(
      agent.execute({
        kind: "approve",
        tenantId: tenant,
        sessionId: started.sessionId,
        callId,
        operationId,
        decision: "grant",
      }),
      /worker lost/,
    );
    const lost = view(
      await agent.execute({ kind: "reload", tenantId: tenant, sessionId: started.sessionId }),
    );
    assert.equal(lost.status.kind, "needs-resume");

    const resumed = view(
      await agent.execute({ kind: "resume", tenantId: tenant, sessionId: started.sessionId }),
    );
    const result = resumed.transcript.find((item) => item.kind === "tool-result");
    assert.deepEqual(result?.kind === "tool-result" ? result.result : undefined, {
      kind: "interrupted",
      operationId,
    });
    assert.equal(resumed.status.kind, "completed");
    assert.equal(sends, 1);
  } finally {
    await agent.close();
  }
});

test("cancel closes an open run once and never sends its order", async () => {
  const { leases, sandbox } = recordingSandbox();
  const { models, model } = scripted([
    call("place-order", { symbol: "BTC", side: "buy", quantity: "1" }),
  ]);
  const agent = await createResearchAgent({ models, model, sandbox });
  try {
    const started = view(
      await agent.execute({ kind: "start", tenantId: tenant, idempotencyKey: "cancel", brief }),
    );
    assert.equal(started.status.kind, "awaiting-approval");
    const cancelled = view(
      await agent.execute({ kind: "cancel", tenantId: tenant, sessionId: started.sessionId }),
    );
    assert.equal(cancelled.status.kind, "cancelled");
    const again = view(
      await agent.execute({ kind: "cancel", tenantId: tenant, sessionId: started.sessionId }),
    );
    assert.deepEqual(again, cancelled);
    assert.equal(leases.length, 0);
  } finally {
    await agent.close();
  }
});

test("a provider error closes the run as failed", async () => {
  const { models, model } = scripted([
    fauxAssistantMessage([], { stopReason: "error", errorMessage: "no key" }),
  ]);
  const agent = await createResearchAgent({ models, model, settings: noRetry });
  try {
    const started = view(
      await agent.execute({ kind: "start", tenantId: tenant, idempotencyKey: "fail", brief }),
    );
    assert.equal(started.status.kind, "failed");
  } finally {
    await agent.close();
  }
});

test("a later run in the same session sees the earlier transcript", async () => {
  const { models, model } = scripted([say("first answer"), say("second answer")]);
  const agent = await createResearchAgent({ models, model });
  try {
    const first = view(
      await agent.execute({ kind: "start", tenantId: tenant, idempotencyKey: "one", brief }),
    );
    const second = view(
      await agent.execute({
        kind: "start",
        tenantId: tenant,
        idempotencyKey: "two",
        brief,
        sessionId: first.sessionId,
      }),
    );
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(second.status.kind, "completed");
    if (second.status.kind === "completed" && first.status.kind === "completed") {
      assert.equal(second.status.text, "second answer");
      assert.notEqual(second.status.runId, first.status.runId);
    }
    assert.equal(second.transcript.filter((item) => item.kind === "user").length, 2);
  } finally {
    await agent.close();
  }
});

test("a session survives a new process on the same directory", async () => {
  const directory = mkdtempSync(join(tmpdir(), "crx-"));
  try {
    const first = scripted([say("funding was flat")]);
    const one = await createResearchAgent({ directory, models: first.models, model: first.model });
    const started = view(
      await one.execute({ kind: "start", tenantId: tenant, idempotencyKey: "disk", brief }),
    );
    await one.close();

    const second = scripted([]);
    const two = await createResearchAgent({
      directory,
      models: second.models,
      model: second.model,
    });
    try {
      const reloaded = view(
        await two.execute({ kind: "reload", tenantId: tenant, sessionId: started.sessionId }),
      );
      assert.deepEqual(reloaded, started);
    } finally {
      await two.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an approval survives a restart and still sends exactly once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "crx-approve-"));
  try {
    const first = scripted([call("place-order", { symbol: "BTC", side: "buy", quantity: "1" })]);
    const one = await createResearchAgent({ directory, models: first.models, model: first.model });
    const parked = view(
      await one.execute({ kind: "start", tenantId: tenant, idempotencyKey: "restart", brief }),
    );
    await one.close();
    if (parked.status.kind !== "awaiting-approval") {
      assert.fail("expected the order to park");
    }

    const { leases, sandbox } = recordingSandbox();
    const second = scripted([say("order sent")]);
    // resumeOnOpen 关闭，重开后由测试自己的 approve 驱动发送；打开时的自动恢复路径由 live-recovery 套件覆盖。
    const two = await createResearchAgent({
      directory,
      models: second.models,
      model: second.model,
      sandbox,
      resumeOnOpen: false,
    });
    try {
      const reloaded = view(
        await two.execute({ kind: "reload", tenantId: tenant, sessionId: parked.sessionId }),
      );
      assert.equal(reloaded.status.kind, "awaiting-approval");
      const approved = view(
        await two.execute({
          kind: "approve",
          tenantId: tenant,
          sessionId: parked.sessionId,
          callId: parked.status.callId,
          operationId: parked.status.operationId,
          decision: "grant",
        }),
      );
      assert.equal(approved.status.kind, "completed");
      assert.equal(leases.length, 1);
    } finally {
      await two.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
