import assert from "node:assert/strict";
import test from "node:test";

import { computeIntent } from "@crypto/domain/internal";
import { brand, leaseCompute } from "@crypto/domain/lease";

import { createCodeSandbox } from "../src/code.js";

const workspace = brand("test-ws", "WorkspaceRef");
const signal = new AbortController().signal;

function lease(language: string, code: string) {
  const intent = computeIntent(language, code, `run-${language}`);
  return leaseCompute({ workspace, intent, now: brand(Date.now(), "Timestamp") });
}

function longDeadline() {
  return brand(Date.now() + 30_000, "Timestamp");
}

test("bash 命令正常执行返回 stdout", async () => {
  const executor = createCodeSandbox({});
  const l = lease("bash", "echo hello");
  l.deadlineAt = longDeadline();
  const result = await executor(l, signal);
  assert.deepEqual(result, { kind: "ok", text: "hello" });
});

test("python3 代码正常执行返回 stdout", async () => {
  const executor = createCodeSandbox({});
  const l = lease("python3", 'print("world")');
  l.deadlineAt = longDeadline();
  const result = await executor(l, signal);
  assert.deepEqual(result, { kind: "ok", text: "world" });
});

test("退出码非零返回 failed 并包含 stderr", async () => {
  const executor = createCodeSandbox({});
  const l = lease("bash", "echo 'something went wrong' >&2; exit 1");
  l.deadlineAt = longDeadline();
  const result = await executor(l, signal);
  assert.equal(result.kind, "failed");
  assert.ok(result.kind === "failed" && result.message.includes("something went wrong"));
});

test("未支持语言返回 failed", async () => {
  const executor = createCodeSandbox({});
  const l = lease("ruby", 'puts "hi"');
  l.deadlineAt = longDeadline();
  const result = await executor(l, signal);
  assert.equal(result.kind, "failed");
  assert.ok(result.kind === "failed" && /[Uu]nsupported/.test(result.message));
});

test("已取消的 signal 立即返回 cancelled", async () => {
  const executor = createCodeSandbox({});
  const l = lease("bash", "echo hi");
  l.deadlineAt = longDeadline();
  const aborted = new AbortController();
  aborted.abort();
  const result = await executor(l, aborted.signal);
  assert.deepEqual(result, { kind: "cancelled" });
});

test("过期 deadline 返回 timed-out", async () => {
  const executor = createCodeSandbox({});
  const l = lease("bash", "echo hi");
  l.deadlineAt = brand(Date.now() - 1, "Timestamp");
  const result = await executor(l, signal);
  assert.deepEqual(result, { kind: "timed-out" });
});

test("执行期间 abort 返回 cancelled", async () => {
  const executor = createCodeSandbox({});
  const l = lease("bash", "sleep 60");
  l.deadlineAt = longDeadline();
  const controller = new AbortController();
  const resultPromise = executor(l, controller.signal);
  // Give the process a moment to start before aborting
  await new Promise((resolve) => setTimeout(resolve, 50));
  controller.abort();
  const result = await resultPromise;
  assert.deepEqual(result, { kind: "cancelled" });
});
