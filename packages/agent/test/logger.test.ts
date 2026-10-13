import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { loadLogConfig, openLogger, type LogOutputs } from "../src/http/logger.js";

function capture(): { outputs: LogOutputs; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    outputs: {
      out: { write: (text) => out.push(text) },
      err: { write: (text) => err.push(text) },
      interactive: false,
    },
    out,
    err,
  };
}

function parseLines(lines: string[]): Record<string, unknown>[] {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

// 测试产物放在仓库内被 gitignore 的 dev/ 目录，不使用系统临时目录。
function testDir(name: string): string {
  mkdirSync("dev", { recursive: true });
  return `dev/logger-${name}-${process.pid}`;
}

test("log config defaults and the rejection of bad values", () => {
  assert.deepEqual(loadLogConfig({}), {
    level: "INFO",
    format: "auto",
    dir: "./logs",
    consoleEnabled: true,
    fileEnabled: true,
    queueSize: 10_000,
    fileMaxBytes: 20_971_520,
    fileBackupCount: 14,
  });
  assert.throws(() => loadLogConfig({ LOG_LEVEL: "LOUD" }), /LOG_LEVEL/);
  assert.throws(() => loadLogConfig({ LOG_FORMAT: "pretty" }), /LOG_FORMAT/);
  assert.throws(() => loadLogConfig({ LOG_CONSOLE_ENABLED: "yes" }), /LOG_CONSOLE_ENABLED/);
  assert.throws(() => loadLogConfig({ LOG_QUEUE_SIZE: "0" }), /LOG_QUEUE_SIZE/);
  assert.throws(() => loadLogConfig({ LOG_FILE_BACKUP_COUNT: "-1" }), /LOG_FILE_BACKUP_COUNT/);
});

test("records below the level never reach a sink", async () => {
  const { outputs, out, err } = capture();
  const logger = openLogger(
    { LOG_LEVEL: "WARNING", LOG_FORMAT: "json", LOG_FILE_ENABLED: "false" },
    outputs,
  );
  logger.debug("d");
  logger.info("i");
  logger.warning("w", { code: 7 });
  logger.error("e", { reason: "boom" });
  await logger.close();
  assert.deepEqual(out, []);
  const records = parseLines(err);
  assert.deepEqual(
    records.map((record) => record.level),
    ["WARNING", "ERROR"],
  );
  assert.equal(records[0]?.message, "w");
  assert.equal(records[0]?.code, 7);
});

test("auto format picks text on an interactive terminal and children carry their fields", async () => {
  const { outputs, out } = capture();
  const logger = openLogger(
    { LOG_FORMAT: "auto", LOG_FILE_ENABLED: "false" },
    { ...outputs, interactive: true },
  );
  logger.child("http", { tenant: "local" }).info("request done", { status: 200 });
  await logger.close();
  assert.equal(out.length, 1);
  assert.match(out[0]!.trim(), / INFO +\[agent\.http\] request done tenant="local" status=200$/);
});

test("file output rotates and keeps the backup count", async () => {
  const dir = testDir("rotate");
  try {
    const logger = openLogger({
      LOG_CONSOLE_ENABLED: "false",
      LOG_DIR: dir,
      LOG_FILE_MAX_BYTES: "300",
      LOG_FILE_BACKUP_COUNT: "2",
      LOG_FORMAT: "json",
    });
    for (let index = 0; index < 40; index++) {
      logger.info(`rotation line ${index} ${"x".repeat(30)}`);
    }
    await logger.close();
    assert.deepEqual(readdirSync(dir).sort(), ["agent.log", "agent.log.1", "agent.log.2"]);
    for (const name of readdirSync(dir)) {
      assert.ok(
        readFileSync(join(dir, name)).byteLength <= 300,
        `${name} exceeds LOG_FILE_MAX_BYTES`,
      );
    }
    const newest = parseLines(readFileSync(join(dir, "agent.log"), "utf8").trim().split("\n"));
    assert.equal(
      newest.every((record) => record.logger === "agent"),
      true,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a full queue drops records and reports the count", async () => {
  const dir = testDir("queue");
  try {
    const logger = openLogger({
      LOG_CONSOLE_ENABLED: "false",
      LOG_DIR: dir,
      LOG_QUEUE_SIZE: "2",
      LOG_FORMAT: "json",
    });
    for (let index = 0; index < 10; index++) {
      logger.info(`burst ${index}`);
    }
    await logger.close();
    const records = parseLines(readFileSync(join(dir, "agent.log"), "utf8").trim().split("\n"));
    assert.equal(records.length, 3);
    assert.equal(records[0]?.message, "log records dropped");
    assert.equal(records[0]?.count, 8);
    assert.equal(records[1]?.message, "burst 0");
    assert.equal(records[2]?.message, "burst 1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unusable log directory disables the file with one notice", async () => {
  mkdirSync("dev", { recursive: true });
  const blocker = `dev/logger-blocker-${process.pid}`;
  writeFileSync(blocker, "x");
  try {
    const { outputs, err } = capture();
    const logger = openLogger(
      { LOG_CONSOLE_ENABLED: "false", LOG_DIR: `${blocker}/logs`, LOG_FORMAT: "json" },
      outputs,
    );
    logger.info("unreachable");
    await logger.close();
    assert.equal(err.length, 1);
    assert.match(err[0]!, /file logging disabled/);
    assert.equal(existsSync(blocker), true);
  } finally {
    rmSync(blocker, { force: true });
  }
});

test("reserved field names are rejected", async () => {
  const { outputs } = capture();
  const logger = openLogger({ LOG_FILE_ENABLED: "false" }, outputs);
  assert.throws(() => logger.info("x", { level: "DEBUG" }), /reserved/);
  await logger.close();
});

test("close is idempotent and records after it are ignored", async () => {
  const { outputs, out } = capture();
  const logger = openLogger({ LOG_FILE_ENABLED: "false" }, outputs);
  logger.info("before");
  await logger.close();
  await logger.close();
  logger.info("after");
  assert.deepEqual(
    out.map((line) => (JSON.parse(line) as { message: string }).message),
    ["before"],
  );
});
