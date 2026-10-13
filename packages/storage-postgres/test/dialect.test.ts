import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { SQLITE_MIGRATIONS } from "@earendil-works/pi-durable/storage/sqlite";

import { toPostgres } from "../src/dialect.js";

const shippedStatements = SQLITE_MIGRATIONS.flatMap((migration) => migration.statements);

/**
 * The dialect translation rewrites pi-durable's SQL text, so it is only correct for the text that
 * version actually ships. These tests read that text out of the installed package rather than
 * restating it, so an upgrade that changes the SQL fails here instead of in production.
 */
test("the shipped migrations are the ones this translation was written against", () => {
  assert.ok(shippedStatements.length > 0, "expected pi-durable to ship migrations");
  assert.equal(SQLITE_MIGRATIONS.at(-1)?.version, 1);
});

test("no question mark hides inside a string literal", () => {
  // Positional `?` -> `$n` rewriting is only sound if no literal contains a `?`. Checked against the
  // shipped statements because this is the assumption that would silently corrupt a query.
  for (const statement of shippedStatements) {
    for (const literal of statement.matchAll(/'[^']*'/g)) {
      assert.equal(
        literal[0].includes("?"),
        false,
        `literal ${literal[0]} in ${statement.slice(0, 60)}... contains a question mark`,
      );
    }
  }
});

test("migrations lose SQLite-only syntax", () => {
  for (const statement of shippedStatements) {
    const translated = toPostgres(statement);
    assert.equal(
      /\bSTRICT\b/i.test(translated),
      false,
      `STRICT survived: ${translated.slice(0, 80)}`,
    );
    assert.equal(
      /json_valid/i.test(translated),
      false,
      `json_valid survived: ${translated.slice(0, 80)}`,
    );
    assert.equal(/\?/.test(translated), false, `placeholder survived: ${translated.slice(0, 80)}`);
    assert.equal(
      /\bINTEGER\b/i.test(translated),
      false,
      `INTEGER survived: ${translated.slice(0, 80)}`,
    );
  }
});

test("ids become BIGINT because the conformance suite mints MAX_SAFE_INTEGER", () => {
  const translated = toPostgres(
    "CREATE TABLE t (id INTEGER PRIMARY KEY, next_seq INTEGER NOT NULL)",
  );
  assert.equal(translated.includes("BIGINT PRIMARY KEY"), true);
  assert.equal(translated.includes("next_seq BIGINT"), true);
});

test("INSERT OR IGNORE becomes an ON CONFLICT DO NOTHING insert", () => {
  const translated = toPostgres(
    "INSERT OR IGNORE INTO durable_schema (singleton, version) VALUES (1, 0)",
  );
  assert.equal(translated.startsWith("INSERT INTO"), true);
  assert.equal(translated.endsWith("ON CONFLICT DO NOTHING"), true);
});

test("placeholders are numbered across a whole statement, in order", () => {
  const translated = toPostgres(
    "SELECT record FROM documents WHERE kind = ? AND scope_kind = ? AND owner_id = ? LIMIT 1",
  );
  assert.equal(translated.includes("kind = $1"), true);
  assert.equal(translated.includes("scope_kind = $2"), true);
  assert.equal(translated.includes("owner_id = $3"), true);
});

test("placeholder numbering restarts per statement so multi-statement exec stays valid", () => {
  const translated = toPostgres("SELECT 1 FROM a WHERE x = ?; SELECT 2 FROM b WHERE y = ?");
  assert.equal(translated.includes("x = $1"), true);
  assert.equal(translated.includes("y = $1"), true);
});

test("created_at ordering keeps SQLite's rowid tie-break", () => {
  const translated = toPostgres(
    "SELECT record FROM documents WHERE kind = $1 ORDER BY created_at DESC LIMIT 1",
  );
  assert.equal(translated.includes("ORDER BY created_at DESC, id ASC"), true);
});

test("an existing tie-break is not duplicated", () => {
  const translated = toPostgres("SELECT record FROM documents ORDER BY created_at DESC, id DESC");
  assert.equal(translated.includes("id ASC"), false);
});

test("the real document-address query keeps its tie-break", () => {
  // The exact shape from the core's materializeDocument, which the conformance suite exercises.
  const statement = `SELECT record FROM documents
WHERE kind = ? AND scope_kind = ? AND owner_id = ? AND family = ? AND key_value = ?
AND created_at <= ? AND (retired_at IS NULL OR retired_at > ?)
ORDER BY created_at DESC LIMIT 1`;
  const translated = toPostgres(statement);
  assert.equal(translated.includes("ORDER BY created_at DESC, id ASC"), true);
  assert.equal(translated.includes("created_at <= $6"), true);
  assert.equal(translated.includes("retired_at > $7"), true);
});

test("the installed core carries no DDL of its own", async () => {
  // `storage.js` builds its queries by interpolation; migrations are its only DDL. If a future
  // version starts issuing CREATE/STRICT directly, the dialect rules above would miss it. Resolve
  // the module through the package rather than guessing at a pnpm store path.
  const entry = import.meta.resolve("@earendil-works/pi-durable/storage/sqlite");
  const core = readFileSync(fileURLToPath(new URL("storage.js", entry)), "utf8");
  assert.equal(/CREATE TABLE/i.test(core), false, "the core now issues DDL of its own");
  assert.equal(/\bSTRICT\b/.test(core), false, "the core now issues STRICT DDL");
});
