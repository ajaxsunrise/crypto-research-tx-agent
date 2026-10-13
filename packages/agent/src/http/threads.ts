import { validateSchemaName } from "@crypto/storage-postgres";
import pg from "pg";

/** threadId from AG-UI maps to one session id, inside one tenant. */
export type ThreadDirectory = {
  get(threadId: string): Promise<string | undefined>;
  put(threadId: string, sessionId: string): Promise<void>;
};

/** Threads of every tenant, keyed by tenant id at the call site. */
export type TenantThreads = {
  forTenant(tenantId: string): ThreadDirectory;
  close(): Promise<void>;
};

export function memoryThreads(): TenantThreads {
  const threads = new Map<string, string>();
  const scoped = (tenantId: string): ThreadDirectory => {
    const keyOf = (threadId: string) => `${tenantId}\u0000${threadId}`;
    return {
      async get(threadId) {
        return threads.get(keyOf(threadId));
      },
      async put(threadId, sessionId) {
        threads.set(keyOf(threadId), sessionId);
      },
    };
  };
  return { forTenant: scoped, async close() {} };
}

/**
 * The thread directory in the shared Postgres schema. `tenant_id` is a real column and part of the
 * primary key, so one tenant can never read or overwrite another tenant's thread.
 */
export async function postgresThreads(input: {
  connectionString: string;
  schema: string;
}): Promise<TenantThreads> {
  const schema = validateSchemaName(input.schema);
  const pool = new pg.Pool({ connectionString: input.connectionString, max: 4 });
  const table = `"${schema}".crypto_threads`;
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${table} (
         tenant_id text NOT NULL,
         thread_id text NOT NULL,
         session_id text NOT NULL,
         PRIMARY KEY (tenant_id, thread_id)
       )`,
    );
  } catch (error) {
    try {
      await pool.end();
    } catch (closeError) {
      throw new AggregateError([error, closeError], "Thread directory initialization failed.");
    }
    throw error;
  }
  const scoped = (tenantId: string): ThreadDirectory => ({
    async get(threadId) {
      const result = await pool.query<{ session_id: string }>(
        `SELECT session_id FROM ${table} WHERE tenant_id = $1 AND thread_id = $2`,
        [tenantId, threadId],
      );
      return result.rows[0]?.session_id;
    },
    async put(threadId, sessionId) {
      await pool.query(
        `INSERT INTO ${table} (tenant_id, thread_id, session_id) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, thread_id) DO UPDATE SET session_id = EXCLUDED.session_id`,
        [tenantId, threadId, sessionId],
      );
    },
  });
  return { forTenant: scoped, close: () => pool.end() };
}
