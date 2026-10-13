import pg from "pg";
import type {
  SqliteDatabase,
  SqliteExecutor,
  SqliteValue,
} from "@earendil-works/pi-durable/storage/sqlite";

import { toPostgres } from "./dialect.js";

/**
 * `SqliteDatabase` facade over one Postgres connection.
 *
 * One connection per storage, deliberately. pi-durable requires that one process owns a storage at a
 * time, and a single connection gives that exclusivity somewhere to live: the session-scoped
 * advisory lock is taken on this connection and Postgres releases it the moment the connection dies,
 * which is exactly the crash-takeover behaviour a cloud worker needs.
 *
 * `search_path` is per-connection too, so pinning one connection is also the simplest way to bind a
 * storage to a tenant schema — a pool would have to reapply it to every new connection and could
 * hand out one that never got it.
 */

export class PostgresExecutor implements SqliteExecutor {
  protected readonly client: pg.Client;

  constructor(
    client: pg.Client,
    private readonly assertActive?: () => void,
  ) {
    this.client = client;
  }

  async exec(sql: string): Promise<void> {
    await this.query(sql);
  }

  async run(sql: string, ...params: SqliteValue[]): Promise<void> {
    await this.query(sql, params);
  }

  async get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
    const result = await this.query(sql, params);
    return result.rows[0] as T | undefined;
  }

  async all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
    const result = await this.query(sql, params);
    return result.rows as T[];
  }

  protected async query(sql: string, params: SqliteValue[] = []): Promise<pg.QueryResult> {
    this.assertActive?.();
    return this.client.query(toPostgres(sql), params);
  }
}

export type PostgresDatabaseOptions = {
  /** Postgres connection string. Ignored when `client` is supplied. */
  readonly connectionString?: string;
  /** An already-connected client, for tests and for callers that own the connection. */
  readonly client?: pg.Client;
};

export class PostgresDatabase extends PostgresExecutor implements SqliteDatabase {
  private readonly ownsClient: boolean;
  private tail: Promise<unknown> = Promise.resolve();
  private closing: Promise<void> | undefined;

  constructor(options: PostgresDatabaseOptions) {
    const client =
      options.client ?? new pg.Client({ connectionString: requireConnectionString(options) });
    super(client);
    this.ownsClient = options.client === undefined;
  }

  /** Connect an owned client. A caller-supplied client is assumed to be connected already. */
  async connect(): Promise<void> {
    this.assertOpen();
    if (this.ownsClient) {
      await this.client.connect();
    }
  }

  protected override query(sql: string, params: SqliteValue[] = []): Promise<pg.QueryResult> {
    return this.enqueue(() => super.query(sql, params));
  }

  /** 同一连接上的独立 SQL 和 transaction 按接收顺序执行。 */
  transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      await this.client.query("BEGIN");
      let active = true;
      const transaction = new PostgresExecutor(this.client, () => {
        if (!active) {
          throw new Error("This transaction handle is no longer active.");
        }
      });
      try {
        let result: T;
        try {
          result = await callback(transaction);
        } finally {
          active = false;
        }
        await this.client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await this.client.query("ROLLBACK");
        } catch (rollbackError) {
          // 同时保留两项错误，让调用者知道 transaction 未能确认撤销。
          throw new AggregateError(
            [error, rollbackError],
            "Transaction failed and its rollback also failed.",
          );
        }
        throw error;
      }
    });
  }

  private async enqueue<T>(run: () => Promise<T>): Promise<T> {
    this.assertOpen();
    const queued = this.tail.then(run);
    this.tail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  /** 拒绝新操作，等待已接收的操作，再关闭自有连接。 */
  close(): Promise<void> {
    if (this.closing === undefined) {
      this.closing = this.tail.then(async () => {
        if (this.ownsClient) {
          await this.client.end();
        }
      });
    }
    return this.closing;
  }

  private assertOpen(): void {
    if (this.closing !== undefined) {
      throw new Error("This storage is closed.");
    }
  }
}

function requireConnectionString(options: PostgresDatabaseOptions): string {
  if (options.connectionString === undefined) {
    throw new Error("PostgresDatabase needs a client or a connection string.");
  }
  return options.connectionString;
}

/** Connect and return a facade ready for `SqliteStorage.open`. */
export async function openPostgresDatabase(
  options: PostgresDatabaseOptions,
): Promise<PostgresDatabase> {
  const database = new PostgresDatabase(options);
  await database.connect();
  return database;
}
