import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { computeIntent } from "@crypto/domain/internal";
import { brand, leaseCompute } from "@crypto/domain/lease";

import { createCodeSandbox } from "../src/code.js";

// docker 集成测试只在 CRYPTO_DOCKER_TESTS=1 且 docker 可用时运行；
// 其余环境（本地无 docker、CI）跳过。
const enabled = process.env.CRYPTO_DOCKER_TESTS === "1";
const image = process.env.CRYPTO_DOCKER_IMAGE ?? "python:3.12-slim";

function dockerAvailable(): boolean {
  const probe = spawnSync("docker", ["info"], { encoding: "utf8", timeout: 15_000 });
  return probe.status === 0;
}

/** 镜像需已存在或可拉取；docker run 内不会自动等一次大拉取。 */
function imageReady(): boolean {
  const inspect = spawnSync("docker", ["image", "inspect", image], { timeout: 30_000 });
  if (inspect.status === 0) {
    return true;
  }
  const pull = spawnSync("docker", ["pull", image], { timeout: 300_000 });
  return pull.status === 0;
}

const live = enabled && dockerAvailable() && imageReady();
if (enabled && !live) {
  console.error("CRYPTO_DOCKER_TESTS=1 但 docker 或镜像不可用，docker 用例跳过。");
}

function lease(language: string, code: string, workspace = "ws-docker") {
  const intent = computeIntent(language, code, `run-${language}`);
  return leaseCompute({
    workspace: brand(workspace, "WorkspaceRef"),
    intent,
    now: brand(Date.now(), "Timestamp"),
  });
}

function longDeadline() {
  return brand(Date.now() + 120_000, "Timestamp");
}

function makeExecutor(root: string) {
  return createCodeSandbox({
    root,
    mode: { kind: "docker", image },
  });
}

test("docker 模式在容器内执行 bash 并返回 stdout", { skip: !live, timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "crx-docker-"));
  try {
    const executor = makeExecutor(root);
    const l = lease("bash", "echo from-container");
    l.deadlineAt = longDeadline();
    const result = await executor(l, new AbortController().signal);
    assert.deepEqual(result, { kind: "ok", text: "from-container" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "docker 模式把会话工作目录挂载进容器并在多次执行间保留",
  { skip: !live, timeout: 120_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "crx-docker-ws-"));
    try {
      const executor = makeExecutor(root);
      const write = lease("bash", "echo persisted > note.txt");
      write.deadlineAt = longDeadline();
      assert.equal((await executor(write, new AbortController().signal)).kind, "ok");
      // 工作目录挂载在主机 root 下，文件直接可见
      assert.equal(existsSync(join(root, "ws-docker", "note.txt")), true);
      const read = lease("bash", "cat note.txt");
      read.deadlineAt = longDeadline();
      const result = await executor(read, new AbortController().signal);
      assert.deepEqual(result, { kind: "ok", text: "persisted" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("docker 容器没有网络，联网代码以失败结束", { skip: !live, timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "crx-docker-net-"));
  try {
    const executor = makeExecutor(root);
    const l = lease("python3", "import socket; socket.getaddrinfo('example.com', 80)");
    l.deadlineAt = longDeadline();
    const result = await executor(l, new AbortController().signal);
    assert.equal(result.kind, "failed");
    assert.ok(result.kind === "failed" && /[Ee]rror|failed/.test(result.message));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("执行期间 abort 终止容器且不留残留", { skip: !live, timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "crx-docker-abort-"));
  try {
    const executor = makeExecutor(root);
    const l = lease("bash", "sleep 60");
    l.deadlineAt = longDeadline();
    const controller = new AbortController();
    const pending = executor(l, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    controller.abort();
    const result = await pending;
    assert.deepEqual(result, { kind: "cancelled" });
    // docker kill 之后 --rm 清理容器；给 daemon 一点时间
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const leftover = execFileSync(
      "docker",
      ["ps", "-aq", "--filter", "label=crypto.sandbox=true"],
      { encoding: "utf8" },
    ).trim();
    assert.equal(leftover, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("docker 模式缺少 root 时构造直接失败", () => {
  assert.throws(
    () => createCodeSandbox({ mode: { kind: "docker", image } }),
    /Docker mode needs a workspace root/,
  );
});
