import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import { hashContent, issueGrant, orderIntent, readIntent } from "@crypto/domain/internal";
import { brand, leaseExternal, leaseReplayable, type ReplayableLease } from "@crypto/domain/lease";

import { createSandbox } from "../src/index.js";

function writeLease(content: string, path = "notes/btc.md"): ReplayableLease {
  const contentHash = hashContent(content);
  return {
    kind: "replayable",
    leaseId: brand("lease-1", "LeaseId"),
    workspace: brand("desk", "WorkspaceRef"),
    deadlineAt: brand(Date.now() + 30_000, "Timestamp"),
    effect: { kind: "idempotent-write", contentHash },
    task: {
      kind: "idempotent-write",
      name: "write-note",
      path: brand(path, "WorkspacePath"),
      content,
      contentHash,
    },
  };
}

function sandboxDirectory(): string {
  const scratch = resolve(".scratch");
  mkdirSync(scratch, { recursive: true });
  return mkdtempSync(join(scratch, "sandbox-test-"));
}

test("相同内容重复执行，新内容更新 note", async () => {
  const executeLease = createSandbox();
  const signal = new AbortController().signal;
  const first = await executeLease(writeLease("funding up"), signal);
  const second = await executeLease(writeLease("funding up"), signal);
  const read = await executeLease(writeLease("replacement"), signal);
  assert.deepEqual(first, { kind: "ok", text: "funding up" });
  assert.deepEqual(second, { kind: "ok", text: "funding up" });
  assert.deepEqual(read, { kind: "ok", text: "replacement" });
});

test("two sandboxes do not share a workspace", async () => {
  const signal = new AbortController().signal;
  const first = createSandbox();
  const second = createSandbox();
  await first(writeLease("funding up"), signal);
  const isolated = await second(writeLease("other text"), signal);
  assert.deepEqual(isolated, { kind: "ok", text: "other text" });
});

test("独立目录保存各自内容，重新创建 sandbox 后读取持久化内容", async () => {
  const base = sandboxDirectory();
  try {
    const signal = new AbortController().signal;
    await createSandbox(join(base, "first"))(writeLease("first note"), signal);
    const other = await createSandbox(join(base, "second"))(writeLease("second note"), signal);
    assert.deepEqual(other, { kind: "ok", text: "second note" });
    const again = await createSandbox(join(base, "first"))(writeLease("first note"), signal);
    assert.deepEqual(again, { kind: "ok", text: "first note" });
    const saved = JSON.parse(readFileSync(join(base, "first", "desk.json"), "utf8"));
    assert.equal(saved["notes/btc.md"].text, "first note");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("保存失败后重试能够写入文件", async () => {
  const root = sandboxDirectory();
  const target = join(root, "desk.json");
  const execute = createSandbox(root);
  const signal = new AbortController().signal;
  try {
    await execute(writeLease("original"), signal);
    rmSync(target);
    mkdirSync(target);
    const lease = writeLease("replacement");
    await assert.rejects(execute(lease, signal));
    rmSync(target, { recursive: true });
    assert.deepEqual(await execute(lease, signal), { kind: "ok", text: "replacement" });
    const saved = JSON.parse(readFileSync(target, "utf8"));
    assert.equal(saved["notes/btc.md"].text, "replacement");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("__proto__ 名称能够持久化", async () => {
  const root = sandboxDirectory();
  try {
    const lease = writeLease("prototype content", "__proto__");
    await createSandbox(root)(lease, new AbortController().signal);
    const saved = JSON.parse(readFileSync(join(root, "desk.json"), "utf8"));
    assert.equal(Object.hasOwn(saved, "__proto__"), true);
    assert.equal(saved.__proto__.text, "prototype content");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("内容 hash 必须同时匹配 task 与 effect", async () => {
  const root = sandboxDirectory();
  try {
    const execute = createSandbox(root);
    const signal = new AbortController().signal;
    const taskMismatch = writeLease("content");
    assert.equal(taskMismatch.task.kind, "idempotent-write");
    if (taskMismatch.task.kind === "idempotent-write") {
      taskMismatch.task.contentHash = hashContent("different content");
    }
    await assert.rejects(execute(taskMismatch, signal), /content hash/);
    const effectMismatch = writeLease("content");
    effectMismatch.effect = { kind: "idempotent-write", contentHash: hashContent("other content") };
    await assert.rejects(execute(effectMismatch, signal), /content hash/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("持久化内容 hash 无效时抛出错误", async () => {
  const root = sandboxDirectory();
  try {
    writeFileSync(
      join(root, "desk.json"),
      JSON.stringify({ "notes/btc.md": { text: "content", hash: hashContent("other content") } }),
    );
    await assert.rejects(
      createSandbox(root)(writeLease("content"), new AbortController().signal),
      /invalid content hash/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("过期与已取消的 lease 不执行写入", async () => {
  const execute = createSandbox();
  const lease = writeLease("content");
  lease.deadlineAt = brand(Date.now() - 1, "Timestamp");
  assert.deepEqual(await execute(lease, new AbortController().signal), { kind: "timed-out" });
  const cancelled = new AbortController();
  cancelled.abort();
  assert.deepEqual(await execute(writeLease("content"), cancelled.signal), { kind: "cancelled" });
});

test("sandbox 执行期限使用提供的真实 clock", async () => {
  const now = () => brand(performance.now(), "Timestamp");
  const lease = writeLease("clock content");
  lease.deadlineAt = brand(now() + 30_000, "Timestamp");
  assert.deepEqual(await createSandbox(undefined, now)(lease, new AbortController().signal), {
    kind: "ok",
    text: "clock content",
  });
});

test("默认 sandbox 返回未配置行情与订单执行能力", async () => {
  const execute = createSandbox();
  const signal = new AbortController().signal;
  const workspace = brand("desk", "WorkspaceRef");
  const now = brand(Date.now(), "Timestamp");
  assert.deepEqual(
    await execute(leaseReplayable({ workspace, intent: readIntent("BTC"), now }), signal),
    { kind: "failed", message: "Market data access is not configured." },
  );
  const operationId = brand("operation-1", "OperationId");
  const intent = orderIntent({ symbol: "BTC", side: "buy", quantity: "1" }, operationId);
  const approval = issueGrant(operationId, brand("call-1", "CallId"));
  assert.deepEqual(await execute(leaseExternal({ workspace, intent, approval, now }), signal), {
    kind: "failed",
    message: "Order execution is not configured.",
  });
});
