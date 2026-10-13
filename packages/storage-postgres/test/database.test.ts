import assert from "node:assert/strict";
import test from "node:test";

import type { SqliteExecutor } from "@earendil-works/pi-durable/storage/sqlite";

import { openPostgresDatabase } from "../src/database.js";
import { connectionString, dropSchema, freshSchema, postgresReachable } from "./harness.js";

const reachable = await postgresReachable();
const skip = reachable ? false : `no Postgres reachable at ${connectionString}`;

test("independent SQL waits for rollback and retains its writes", { skip }, async () => {
  const { client, schema } = await freshSchema("database_queue");
  const database = await openPostgresDatabase({ client });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    await database.exec("CREATE TABLE database_writes (name TEXT PRIMARY KEY)");
    const failure = new Error("Transaction callback failed.");
    const transaction = database.transaction(async (tx) => {
      await tx.run("INSERT INTO database_writes VALUES (?)", "inside");
      entered.resolve();
      await release.promise;
      throw failure;
    });
    const rolledBack = assert.rejects(transaction, (error) => error === failure);
    await entered.promise;
    const independent = Promise.all([
      database.exec("INSERT INTO database_writes VALUES ('exec')"),
      database.run("INSERT INTO database_writes VALUES (?)", "run"),
      database.get("SELECT name FROM database_writes WHERE name = ?", "inside"),
      database.all("SELECT name FROM database_writes ORDER BY name"),
      database.transaction((tx) => tx.run("INSERT INTO database_writes VALUES (?)", "next")),
    ]);
    release.resolve();
    await rolledBack;
    const [, , inside, rows] = await independent;
    assert.equal(inside, undefined);
    assert.deepEqual(rows, [{ name: "exec" }, { name: "run" }]);
    assert.deepEqual(await database.all("SELECT name FROM database_writes ORDER BY name"), [
      { name: "exec" },
      { name: "next" },
      { name: "run" },
    ]);
    await assert.rejects(database.run("INSERT INTO database_writes VALUES (?)", "run"), {
      code: "23505",
    });
    assert.deepEqual(
      await database.get("SELECT name FROM database_writes WHERE name = ?", "next"),
      {
        name: "next",
      },
    );
  } finally {
    release.resolve();
    await database.close();
    await dropSchema(client, schema);
  }
});

test("close drains accepted operations and rejects new operations", { skip }, async () => {
  const { client, schema } = await freshSchema("database_close");
  const database = await openPostgresDatabase({ client });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    await database.exec("CREATE TABLE database_writes (name TEXT PRIMARY KEY)");
    const transaction = database.transaction(async (tx) => {
      await tx.run("INSERT INTO database_writes VALUES (?)", "inside");
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const queued = database.run("INSERT INTO database_writes VALUES (?)", "outside");
    const queuedTransaction = database.transaction((tx) =>
      tx.run("INSERT INTO database_writes VALUES (?)", "queued"),
    );
    const closing = database.close();
    assert.equal(database.close(), closing);
    await Promise.all([
      assert.rejects(database.exec("SELECT 1"), /closed/),
      assert.rejects(database.run("SELECT ?", 1), /closed/),
      assert.rejects(database.get("SELECT ? AS value", 1), /closed/),
      assert.rejects(database.all("SELECT ? AS value", 1), /closed/),
      assert.rejects(
        database.transaction(async () => {}),
        /closed/,
      ),
      assert.rejects(database.connect(), /closed/),
    ]);
    release.resolve();
    await Promise.all([transaction, queued, queuedTransaction, closing]);
    const result = await client.query("SELECT name FROM database_writes ORDER BY name");
    assert.deepEqual(result.rows, [{ name: "inside" }, { name: "outside" }, { name: "queued" }]);
  } finally {
    release.resolve();
    await database.close();
    await dropSchema(client, schema);
  }
});

test("transaction handles expire after successful and failed callbacks", { skip }, async () => {
  const { client, schema } = await freshSchema("database_handle");
  const database = await openPostgresDatabase({ client });
  try {
    await database.exec("CREATE TABLE database_writes (name TEXT PRIMARY KEY)");
    for (const fails of [false, true]) {
      let handle: SqliteExecutor | undefined;
      const failure = new Error("Transaction callback failed.");
      const transaction = database.transaction(async (tx) => {
        handle = tx;
        await tx.run("INSERT INTO database_writes VALUES (?)", fails ? "rollback" : "commit");
        if (fails) {
          throw failure;
        }
        return "completed";
      });
      if (fails) {
        await assert.rejects(transaction, (error) => error === failure);
      } else {
        assert.equal(await transaction, "completed");
      }
      assert.ok(handle);
      await Promise.all([
        assert.rejects(handle.exec("DELETE FROM database_writes"), /no longer active/),
        assert.rejects(
          handle.run("INSERT INTO database_writes VALUES (?)", "expired"),
          /no longer active/,
        ),
        assert.rejects(handle.get("SELECT name FROM database_writes"), /no longer active/),
        assert.rejects(handle.all("SELECT name FROM database_writes"), /no longer active/),
      ]);
    }
    assert.deepEqual(await database.all("SELECT name FROM database_writes"), [{ name: "commit" }]);
  } finally {
    await database.close();
    await dropSchema(client, schema);
  }
});
