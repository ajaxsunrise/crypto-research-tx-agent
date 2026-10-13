import pg from "pg";

/**
 * Connection details for tests.
 *
 * `CRYPTO_TEST_POSTGRES` points at a server the tests may create and drop schemas in. The suite
 * deliberately destroys its schema between cases, so it must never be aimed at anything else.
 */
export const connectionString =
  process.env.CRYPTO_TEST_POSTGRES ?? "postgres:///crypto_research_test";

/** A fresh empty schema, so cases cannot see each other's rows. */
export async function freshSchema(suffix: string): Promise<{ client: pg.Client; schema: string }> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const schema = `t_${process.pid}_${suffix}`.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
  await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET search_path TO "${schema}"`);
  return { client, schema };
}

export async function dropSchema(client: pg.Client, schema: string): Promise<void> {
  await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
  await client.end().catch(() => undefined);
}

/** True when a server is reachable; lets the suite skip instead of failing on a bare machine. */
export async function postgresReachable(): Promise<boolean> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}
