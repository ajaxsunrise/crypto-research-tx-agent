import pg from "pg";

/**
 * pi-durable's portable SQLite storage core is database-agnostic behind a small `SqliteDatabase`
 * facade (`exec`/`run`/`get`/`all`/`transaction`/`close`), but it emits SQLite SQL and SQLite DDL.
 * Reusing that core beats forking it, so the dialect gap is closed here.
 *
 * This module is the whole coupling surface to pi-durable's SQL text. It is pinned to 1.1.0; the
 * vendored storage conformance suite in `test/` guards against an upgrade changing that text.
 */

let typesConfigured = false;

/**
 * node-pg returns `int8` as a string to protect values beyond 2^53. The durable core expects
 * numbers: it does `Number(next_id)` itself and compares ids arithmetically. Minted ids stay at or
 * below `Number.MAX_SAFE_INTEGER` — the conformance suite mints exactly that value to test
 * exhaustion — so parsing to a number is lossless here.
 *
 * `pg.types` is a module-level singleton, so this is idempotent and process-wide. Call it before any
 * query; `openPostgresStorage` does.
 */
export function configurePgTypes(): void {
  if (typesConfigured) {
    return;
  }
  typesConfigured = true;
  pg.types.setTypeParser(20, (value: string) => Number(value));
}
