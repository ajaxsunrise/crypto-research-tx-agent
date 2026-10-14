import assert from "node:assert/strict";
import test from "node:test";

import { brand } from "@crypto/domain/lease";
import pg from "pg";

import { openAgentWorker } from "../src/index.js";
import { say, scripted, view } from "./fixtures.js";

const connectionString = process.env.CRYPTO_TEST_POSTGRES ?? "postgres:///crypto_research_test";
const schema = `threads_${process.pid}`;

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

test("listThreads scans ThreadDocs on Postgres and scopes them per tenant", { skip }, async () => {
  const { models, model } = scripted([say("answer for a"), say("answer for b")]);
  const worker = await openAgentWorker({ connectionString, schema, models: () => models, model });
  try {
    const alpha = brand("alpha", "TenantId");
    const beta = brand("beta", "TenantId");
    view(
      await worker.execute({
        kind: "start",
        tenantId: alpha,
        idempotencyKey: "key-a",
        threadId: "thread-a",
        input: "question from alpha",
      }),
    );
    view(
      await worker.execute({
        kind: "start",
        tenantId: beta,
        idempotencyKey: "key-b",
        threadId: "thread-b",
        input: "question from beta",
      }),
    );

    const alphaThreads = await worker.listThreads(alpha);
    assert.equal(alphaThreads.kind, "ok");
    if (alphaThreads.kind !== "ok") {
      return;
    }
    assert.equal(alphaThreads.threads.length, 1);
    assert.equal(alphaThreads.threads[0]?.threadId, "thread-a");
    assert.equal(alphaThreads.threads[0]?.preview, "question from alpha");
    assert.equal(alphaThreads.threads[0]?.status, "completed");

    const betaThreads = await worker.listThreads(beta);
    assert.equal(betaThreads.kind, "ok");
    if (betaThreads.kind !== "ok") {
      return;
    }
    assert.equal(betaThreads.threads.length, 1);
    assert.equal(betaThreads.threads[0]?.threadId, "thread-b");
    assert.equal(betaThreads.threads[0]?.preview, "question from beta");
  } finally {
    await worker.close();
  }
});
