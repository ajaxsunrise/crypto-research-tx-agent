import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";

import { writeIntent } from "../src/internal.js";
import {
  brand,
  executeLease,
  leaseReplayable,
  type LeaseExecutor,
  type LeaseResult,
} from "../src/lease.js";

function noteLease() {
  return leaseReplayable({
    workspace: brand("desk", "WorkspaceRef"),
    intent: writeIntent("note.md", "content"),
    now: brand(Date.now(), "Timestamp"),
  });
}

for (const kind of ["timed-out", "cancelled"] as const) {
  test(`等待文件输入期间${kind}，后续执行成功不能改变返回结果`, async () => {
    const scratch = resolve(".scratch");
    mkdirSync(scratch, { recursive: true });
    const root = mkdtempSync(join(scratch, "lease-test-"));
    const input = join(root, "input");
    const output = join(root, "note.md");
    execFileSync("mkfifo", [input]);
    const controller = new AbortController();
    const lease = noteLease();
    if (kind === "timed-out") {
      lease.deadlineAt = brand(Date.now() + 30, "Timestamp");
    }
    let pending: Promise<LeaseResult> | undefined;
    let release: Promise<void> | undefined;
    let executionSignal: AbortSignal | undefined;
    const executor: LeaseExecutor = (activeLease, signal) => {
      executionSignal = signal;
      pending = (async () => {
        assert.ok(activeLease.task.kind === "idempotent-write");
        await readFile(input, "utf8");
        const content = activeLease.task.content;
        await writeFile(output, content);
        return { kind: "ok", text: content };
      })();
      return pending;
    };
    try {
      const execution = executeLease(executor, lease, controller.signal);
      assert.ok(pending);
      release = setTimeout(100).then(() => writeFile(input, "input ready"));
      if (kind === "cancelled") {
        controller.abort();
      }
      assert.deepEqual(await execution, { kind });
      assert.equal(executionSignal?.aborted, true);
      await release;
      assert.deepEqual(await pending, { kind: "ok", text: "content" });
      assert.equal(await readFile(output, "utf8"), "content");
    } finally {
      await release;
      await pending;
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("正常文件执行错误直接抛出", async () => {
  const scratch = resolve(".scratch");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "lease-test-"));
  const executor: LeaseExecutor = async () => {
    const text = await readFile(join(root, "missing.md"), "utf8");
    return { kind: "ok", text };
  };
  try {
    await assert.rejects(executeLease(executor, noteLease(), new AbortController().signal), {
      code: "ENOENT",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("非有限执行期限抛出错误", async () => {
  const lease = noteLease();
  lease.deadlineAt = brand(Number.NaN, "Timestamp");
  const executor: LeaseExecutor = async () => {
    const text = await readFile(import.meta.filename, "utf8");
    return { kind: "ok", text };
  };
  await assert.rejects(
    executeLease(executor, lease, new AbortController().signal),
    /must be finite/,
  );
});

test("执行期限跟随提供的真实 clock", async () => {
  const now = () => brand(performance.now(), "Timestamp");
  const lease = leaseReplayable({
    workspace: brand("desk", "WorkspaceRef"),
    intent: writeIntent("note.md", "content"),
    now: now(),
  });
  const executor: LeaseExecutor = async () => {
    const text = await readFile(import.meta.filename, "utf8");
    return { kind: "ok", text };
  };
  assert.deepEqual(await executeLease(executor, lease, new AbortController().signal, now), {
    kind: "ok",
    text: await readFile(import.meta.filename, "utf8"),
  });
});
