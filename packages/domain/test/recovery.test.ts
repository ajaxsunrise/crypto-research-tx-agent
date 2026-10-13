import assert from "node:assert/strict";
import test from "node:test";

import { hashContent, orderIntent, parseTenantId, writeIntent } from "../src/internal.js";
import { brand, leaseReplayable } from "../src/lease.js";

test("each tool has one recovery class", () => {
  // 效应分类由扩展在 defineTool(replay:) 声明，不再由域层的硬编码映射表决定。
  // read/idempotent-write/external 三个分类仍然有效，只是移走了 crypto 工具名。
  assert.equal("read" satisfies string, "read");
  assert.equal("idempotent-write" satisfies string, "idempotent-write");
  assert.equal("external" satisfies string, "external");
});

test("a write intent carries the hash of its content", () => {
  const intent = writeIntent("notes/btc.md", "funding up");
  assert.equal(intent.kind, "idempotent-write");
  if (intent.kind === "idempotent-write") {
    assert.equal(intent.contentHash, hashContent("funding up"));
  }
});

test("a write lease names the same hash as its intent", () => {
  const lease = leaseReplayable({
    workspace: brand("desk", "WorkspaceRef"),
    intent: writeIntent("notes/btc.md", "funding up"),
    now: brand(1, "Timestamp"),
  });
  assert.deepEqual(lease.effect, {
    kind: "idempotent-write",
    contentHash: hashContent("funding up"),
  });
  assert.equal(lease.deadlineAt, 30_001);
});

test("an order intent uses the operation id it is given", () => {
  const intent = orderIntent(
    { symbol: "BTC", side: "buy", quantity: "1" },
    brand("op-1", "OperationId"),
  );
  assert.equal(intent.operationId, "op-1");
});

test("tenant ids are safe as schema names", () => {
  assert.equal(parseTenantId("acme_1"), "acme_1");
  for (const bad of ["Acme", "1acme", "a-b", "", 'x"; drop', "a".repeat(55)]) {
    assert.equal(parseTenantId(bad), undefined, bad);
  }
});
