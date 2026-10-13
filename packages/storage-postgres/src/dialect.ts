/**
 * pi-durable's portable SQLite storage core is database-agnostic behind a small `SqliteDatabase`
 * facade (`exec`/`run`/`get`/`all`/`transaction`/`close`), but it emits SQLite SQL and SQLite DDL.
 * Reusing that core beats forking it, so the dialect gap is closed here.
 *
 * This module is the whole coupling surface to pi-durable's SQL text. It is pinned to 1.1.0; the
 * vendored storage conformance suite in `test/` guards against an upgrade changing that text.
 */

/**
 * Translate one SQLite statement to Postgres.
 *
 * JSON columns stay `TEXT` rather than `jsonb`: the core calls `JSON.parse` on what it reads, which
 * throws on a `jsonb` column because node-pg has already parsed it into an object.
 */
export function toPostgres(sql: string): string {
  return sql
    .split(";")
    .filter((statement) => statement.trim().length > 0)
    .map((statement) => {
      // Numbering restarts per statement. `run`/`get`/`all` send one statement with bindings, while
      // `exec` sends several with none, so restarting keeps every statement self-consistent rather
      // than depending on how many placeholders earlier statements happened to contain.
      let placeholders = 0;
      return translateStatement(statement, () => `$${++placeholders}`);
    })
    .join(";");
}

function translateStatement(statement: string, next: () => string): string {
  // SQLite-only storage classes and CHECK constraints Postgres has no equivalent for.
  let out = statement
    .replace(/\s+STRICT\b/gi, "")
    .replace(/CHECK \(json_valid\([a-z_]+\)\)/gi, "")
    // The suite mints ids up to Number.MAX_SAFE_INTEGER, which overflows Postgres `integer`.
    .replace(/\bINTEGER\b/gi, "BIGINT");

  // `INSERT OR IGNORE` is SQLite's upsert-ignore; the Postgres equivalent is appended below rather
  // than inferred for every bare INSERT.
  const ignoresConflict = /\bINSERT OR IGNORE INTO\b/i.test(out);
  if (ignoresConflict) {
    out = out.replace(/\bINSERT OR IGNORE INTO\b/gi, "INSERT INTO");
  }

  // Positional rewrite is safe only because no string literal in the core's SQL contains a question
  // mark; `test/dialect.test.ts` asserts that against the shipped statements.
  out = out.replace(/\?/g, next);

  // Determinism under equal `created_at`. SQLite resolves those ties by rowid (ascending id) through
  // its `documents_by_address` index; Postgres leaves the order unspecified, so the same decode
  // could otherwise pick a different document incarnation on each run.
  out = out.replace(/ORDER BY created_at DESC(?!\s*,)/g, "ORDER BY created_at DESC, id ASC");

  if (ignoresConflict) {
    out += " ON CONFLICT DO NOTHING";
  }

  return out;
}
