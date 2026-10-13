import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import pg from "pg";

import { PostgresDatabase, type PostgresDatabaseOptions } from "./database.js";
import { configurePgTypes } from "./types.js";

/**
 * Build a pi-durable `Storage` on Postgres.
 *
 * `SqliteStorage.open` applies pi-durable's own migrations through this facade, so the schema is the
 * package's schema translated to Postgres rather than a hand-written copy that could drift.
 */
export async function openPostgresStorage(
  options: PostgresDatabaseOptions,
): Promise<SqliteStorage> {
  configurePgTypes();
  const database = new PostgresDatabase(options);
  await database.connect();
  try {
    return await SqliteStorage.open(database);
  } catch (error) {
    await database.close();
    throw error;
  }
}

/**
 * A schema name safe to interpolate into `CREATE SCHEMA` and `SET search_path`, which take no
 * bindings. The name is external input, so this is a boundary: without it a value such as
 * `x; DROP SCHEMA public` would be executed.
 */
export function validateSchemaName(schema: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) {
    throw new Error(
      `Schema name ${JSON.stringify(schema)} is not usable: lowercase letters, digits and underscores, starting with a letter, at most 63 characters.`,
    );
  }
  return schema;
}

/** Create the schema if it is absent. */
export async function ensureSchema(client: pg.Client, schema: string): Promise<void> {
  // `schema` came from `validateSchemaName`, which rejects quotes.
  await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
}

/**
 * Take the schema's storage lock, or report that another worker holds it.
 *
 * pi-durable requires that one process owns a storage at a time and provides no cross-process
 * locking. Without this lock two workers on one schema both mint the same record ids and commit the
 * same sequence numbers, silently overwriting each other rather than failing.
 *
 * A session-scoped advisory lock is the right primitive: Postgres releases it when the connection
 * ends, so a crashed worker's lock does not need cleaning up by hand.
 */
export async function tryTakeStorageLock(client: pg.Client, schema: string): Promise<boolean> {
  const result = await client.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
    [`crypto-agent:${schema}`],
  );
  return result.rows[0]?.locked === true;
}

export async function releaseStorageLock(client: pg.Client, schema: string): Promise<void> {
  await client
    .query("SELECT pg_advisory_unlock(hashtext($1))", [`crypto-agent:${schema}`])
    .catch(() => undefined);
}

export { PostgresDatabase, type PostgresDatabaseOptions };
export type {
  SqliteDatabase,
  SqliteExecutor,
  SqliteValue,
} from "@earendil-works/pi-durable/storage/sqlite";
export { toPostgres } from "./dialect.js";
export { configurePgTypes } from "./types.js";
