import assert from "node:assert/strict";
import test from "node:test";

import pg from "pg";

import { postgresUsers } from "../src/http/users.js";

const connectionString = process.env.CRYPTO_TEST_POSTGRES ?? "postgres:///crypto_research_test";
const schema = `users_${process.pid}`;

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

test.before(async () => {
  if (skip !== false) {
    return;
  }
  const client = new pg.Client({ connectionString });
  await client.connect();
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.end();
});

test.after(async () => {
  if (skip !== false) {
    return;
  }
  const client = new pg.Client({ connectionString });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await client.end();
});

test("the user table registers, refuses duplicates, and verifies logins", { skip }, async () => {
  const users = await postgresUsers({ connectionString, schema });
  try {
    const outcome = await users.register("User@Example.com", "correct horse battery");
    assert.deepEqual(outcome.kind, "registered");
    if (outcome.kind !== "registered") {
      return;
    }
    assert.match(outcome.tenantId, /^u_[0-9a-f]{24}$/);

    assert.deepEqual(await users.register("user@example.com", "another password"), {
      kind: "email-taken",
    });
    assert.equal(await users.login("USER@example.com", "correct horse battery"), outcome.tenantId);
    assert.equal(await users.login("user@example.com", "wrong password"), undefined);
    assert.equal(await users.login("nobody@example.com", "correct horse battery"), undefined);

    // 密码以散列保存，原文从不入库
    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      const rows = await client.query<{ password_hash: string }>(
        `SELECT password_hash FROM "${schema}".crypto_users WHERE email = $1`,
        ["user@example.com"],
      );
      assert.equal(rows.rows.length, 1);
      assert.match(rows.rows[0]!.password_hash, /^scrypt:[0-9a-f]+:[0-9a-f]+$/);
    } finally {
      await client.end();
    }
  } finally {
    await users.close();
  }
});
