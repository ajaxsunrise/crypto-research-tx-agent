import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createResearchAgent } from "../src/index.js";
import {
  crashInSandbox,
  crashTenant,
  lastToolResultText,
  lastUserText,
  recordingSandbox,
  say,
  scripted,
  view,
} from "./fixtures.js";

const brief = { question: "What changed?", horizon: "24h" };

test("a read interrupted by a dead process reruns on resume", async () => {
  const directory = mkdtempSync(join(tmpdir(), "crx-crash-read-"));
  try {
    crashInSandbox("read", directory);

    const { leases, sandbox } = recordingSandbox();
    const { models, model } = scripted([
      (context) => {
        // The rerun read's result, not an interruption notice: reads are replay-safe.
        assert.equal(lastToolResultText(context), "market BTC");
        return say("funding was flat");
      },
    ]);
    // resumeOnOpen 关闭，让测试自己用 resume 驱动恢复；打开时的自动恢复路径由 live-recovery 套件覆盖。
    const agent = await createResearchAgent({
      directory,
      models,
      model,
      sandbox,
      resumeOnOpen: false,
    });
    try {
      // The same key finds the session the dead process created.
      const found = view(
        await agent.execute({
          kind: "start",
          tenantId: crashTenant,
          idempotencyKey: "crash",
          brief,
        }),
      );
      const resumed = view(
        await agent.execute({ kind: "resume", tenantId: crashTenant, sessionId: found.sessionId }),
      );
      assert.equal(resumed.status.kind, "completed");
      assert.equal(leases.length, 1, "the read ran exactly once more");
    } finally {
      await agent.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an order interrupted by a dead process is never sent again", async () => {
  const directory = mkdtempSync(join(tmpdir(), "crx-crash-order-"));
  try {
    crashInSandbox("order", directory);

    const { leases, sandbox } = recordingSandbox();
    const { models, model } = scripted([
      (context) => {
        assert.match(lastUserText(context), /interrupted/);
        return say("the order may not have landed");
      },
    ]);
    // resumeOnOpen 关闭，让测试自己用 resume 驱动修复；打开时的自动恢复路径由 live-recovery 套件覆盖。
    const agent = await createResearchAgent({
      directory,
      models,
      model,
      sandbox,
      resumeOnOpen: false,
    });
    try {
      const found = view(
        await agent.execute({
          kind: "start",
          tenantId: crashTenant,
          idempotencyKey: "crash",
          brief,
        }),
      );
      assert.equal(found.status.kind, "needs-resume");
      const resumed = view(
        await agent.execute({ kind: "resume", tenantId: crashTenant, sessionId: found.sessionId }),
      );
      const result = resumed.transcript.find((item) => item.kind === "tool-result");
      assert.equal(result?.kind === "tool-result" ? result.result.kind : undefined, "interrupted");
      assert.equal(resumed.status.kind, "completed");
      assert.equal(leases.length, 0, "recovery must not resend an order");
    } finally {
      await agent.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
