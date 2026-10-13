import assert from "node:assert/strict";
import test from "node:test";

import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { createStorageConformance } from "@earendil-works/pi-durable/testing";
import type { Storage } from "@earendil-works/pi-durable";

import { openPostgresDatabase } from "../src/database.js";
import { configurePgTypes } from "../src/types.js";
import { conformanceAssertions } from "../src/testing.js";
import { connectionString, dropSchema, freshSchema, postgresReachable } from "./harness.js";

/**
 * pi-durable's own conformance suite, run against the Postgres backend.
 *
 * This is the guard on the dialect translation: the translation rewrites pi-durable's SQL, so it is
 * only correct for the version it was written against. An upgrade that changes the schema or query
 * shapes fails here rather than in production.
 */

configurePgTypes();

let caseCounter = 0;

const cases = createStorageConformance({
  assertions: conformanceAssertions,
  withStorage: async (use: (storage: Storage) => Promise<void>) => {
    const { client, schema } = await freshSchema(`conf${caseCounter++}`);
    const database = await openPostgresDatabase({ client });
    // `SqliteStorage.open` applies the package's own migrations through the translating facade, so
    // the schema under test is the package's rather than a hand-maintained copy that could drift.
    const storage = await SqliteStorage.open(database);
    try {
      await use(storage);
    } finally {
      await database.close();
      await dropSchema(client, schema);
    }
  },
});

const reachable = await postgresReachable();

if (!reachable) {
  test(
    "postgres storage conformance",
    { skip: `no Postgres reachable at ${connectionString}` },
    () => {},
  );
} else {
  test("postgres storage conformance", async (t) => {
    for (const storageCase of cases) {
      await t.test(storageCase.name, async () => {
        await storageCase.run();
      });
    }
  });
}

test("the suite is the full one, not a subset", () => {
  assert.ok(cases.length >= 20, `expected the full conformance suite, got ${cases.length} cases`);
});
