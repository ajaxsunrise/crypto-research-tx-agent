import assert from "node:assert/strict";
import test from "node:test";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { ConversationId } from "@earendil-works/pi-durable";
import pg from "pg";

import { openPostgresDatabase } from "../src/database.js";
import {
  ensureSchema,
  releaseStorageLock,
  tryTakeStorageLock,
  validateSchemaName,
} from "../src/index.js";
import { configurePgTypes } from "../src/types.js";
import { connectionString, dropSchema, freshSchema, postgresReachable } from "./harness.js";

configurePgTypes();

test("a schema name must pass validation unchanged", () => {
  assert.equal(validateSchemaName("crypto_agent"), "crypto_agent");
  assert.equal(validateSchemaName("acme_2"), "acme_2");

  // Schema names are external input and interpolated into DDL, which takes no bindings. These are
  // the shapes that must never reach `CREATE SCHEMA`.
  for (const bad of [
    'x"; DROP SCHEMA public; --',
    "Acme",
    "acme-x",
    "",
    "1acme",
    "ac me",
    "a".repeat(64),
  ]) {
    assert.throws(() => validateSchemaName(bad), /not usable/, `accepted ${JSON.stringify(bad)}`);
  }
});

const reachable = await postgresReachable();
/** `node --test` skips when this is a string, and runs when it is false. */
const skip = reachable ? false : `no Postgres reachable at ${connectionString}`;

test("two workers cannot both own one schema", { skip }, async () => {
  const { client: first, schema } = await freshSchema("lock");
  const second = new pg.Client({ connectionString });
  await second.connect();
  try {
    assert.equal(await tryTakeStorageLock(first, schema), true, "the first worker takes the lock");
    assert.equal(
      await tryTakeStorageLock(second, schema),
      false,
      "the second worker must be refused; without this both would mint the same ids",
    );

    await releaseStorageLock(first, schema);
    assert.equal(
      await tryTakeStorageLock(second, schema),
      true,
      "the lock is available once released",
    );
  } finally {
    await second.end().catch(() => undefined);
    await dropSchema(first, schema);
  }
});

test("a dead worker's lock is released by the server, not by cleanup code", { skip }, async () => {
  const { client: first, schema } = await freshSchema("crash");
  const second = new pg.Client({ connectionString });
  await second.connect();
  try {
    assert.equal(await tryTakeStorageLock(first, schema), true);
    // Simulate a crash: end the connection without releasing. A session-scoped advisory lock is
    // released by Postgres here, which is why the lock survives nothing and needs no reaper.
    await first.end();
    assert.equal(
      await tryTakeStorageLock(second, schema),
      true,
      "takeover must succeed after a crash",
    );
  } finally {
    await second.end().catch(() => undefined);
    const cleanup = new pg.Client({ connectionString });
    await cleanup.connect();
    await dropSchema(cleanup, schema);
  }
});

test("without the lock, two workers collide on one schema", { skip }, async () => {
  // Documents the hazard the lock guards against, so the guard is not later removed as
  // "unnecessary". Two storages on one schema share a host, so both mint the same next id and both
  // claim the same sequence number. The visible damage depends on the engine: Postgres rejects one
  // commit on the primary key here, while a write that happens to land on a distinct row would
  // instead succeed and overwrite. The lock is what makes the schema single-writer either way.
  const { client: a, schema } = await freshSchema("race");
  const b = new pg.Client({ connectionString });
  await b.connect();
  await b.query(`SET search_path TO "${schema}"`);
  try {
    const first = await openPostgresDatabase({ client: a });
    const second = await openPostgresDatabase({ client: b });
    const one = await SqliteStorage.open(first);
    const two = await SqliteStorage.open(second);

    const [idOne, idTwo] = await Promise.all([
      one.mintId<ConversationId>(),
      two.mintId<ConversationId>(),
    ]);
    assert.equal(idOne, idTwo, "unsynchronised storages mint the same id");

    const commits = await Promise.allSettled([
      one.commit([{ type: "conversation", value: { id: idOne } }], BACKGROUND_CONTEXT),
      two.commit([{ type: "conversation", value: { id: idTwo } }], BACKGROUND_CONTEXT),
    ]);
    const fulfilled = commits.filter((commit) => commit.status === "fulfilled");
    assert.equal(fulfilled.length, 1, "exactly one writer wins; the other collides on the id");
    const rejected = commits.find((commit) => commit.status === "rejected");
    assert.match(
      String((rejected as PromiseRejectedResult).reason?.message),
      /duplicate key|already exists/i,
    );

    await first.close();
    await second.close();
  } finally {
    await b.end().catch(() => undefined);
    await dropSchema(a, schema);
  }
});

test("ensureSchema creates the schema when it is absent", { skip }, async () => {
  const { client, schema } = await freshSchema("ensure");
  try {
    await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await ensureSchema(client, schema);
    const result = await client.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = $1) AS exists",
      [schema],
    );
    assert.equal(result.rows[0]?.exists, true);
  } finally {
    await dropSchema(client, schema);
  }
});
