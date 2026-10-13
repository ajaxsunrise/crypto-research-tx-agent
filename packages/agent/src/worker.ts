import type { LeaseExecutor, Timestamp } from "@crypto/domain/lease";
import { createSandbox } from "@crypto/sandbox";
import {
  configurePgTypes,
  ensureSchema,
  PostgresDatabase,
  releaseStorageLock,
  tryTakeStorageLock,
  validateSchemaName,
} from "@crypto/storage-postgres";
import type { Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { HarnessSettings } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import pg from "pg";

import { openAgent, type ModelChoice, type OpenedAgent } from "./open.js";

/** Another worker owns this storage. Route the request to that worker or stop it first. */
export class StorageBusy extends Error {
  constructor(schema: string) {
    super(`Storage ${schema} is owned by another worker.`);
    this.name = "StorageBusy";
  }
}

export type AgentWorkerOptions = {
  connectionString: string;
  /** The one Postgres schema every tenant's rows live in. Defaults to `crypto_agent`. */
  schema?: string;
  /** Session workspaces become `<sandboxRoot>/session-<id>`. */
  sandboxRoot?: string;
  /** The model a start runs with when it does not name one. */
  model?: ModelChoice;
  /** Defaults to pi-ai's built-in providers, which read keys from the environment. */
  models?: Models | (() => Models);
  sandbox?: LeaseExecutor;
  settings?: HarnessSettings;
  resumeOnOpen?: boolean;
  now?: () => Timestamp;
};

export type AgentWorker = OpenedAgent;

/**
 * Open the shared storage on this worker, serving every tenant.
 *
 * Tenants are rows, so one worker answers every tenant's commands and the boundary is the owner
 * check on each session. What still needs the whole storage:
 * - pi-durable's record ids come from one sequence, so two writing processes would mint colliding
 *   ids; an advisory lock on the schema keeps this worker the single writer;
 * - the lock is held for the worker's lifetime and dies with its connection, so a crashed worker's
 *   storage can be reopened elsewhere without cleanup.
 *
 * Scale by sharding tenants across databases, each with its own worker and schema.
 */
export async function openAgentWorker(options: AgentWorkerOptions): Promise<AgentWorker> {
  const schema = validateSchemaName(options.schema ?? "crypto_agent");
  configurePgTypes();

  const client = new pg.Client({ connectionString: options.connectionString });
  await client.connect();

  let database: PostgresDatabase | undefined;
  try {
    if (!(await tryTakeStorageLock(client, schema))) {
      throw new StorageBusy(schema);
    }
    await ensureSchema(client, schema);
    await client.query(`SET search_path TO "${schema}"`);

    database = new PostgresDatabase({ client });
    const storage = await SqliteStorage.open(database);

    const models =
      typeof options.models === "function" ? options.models() : (options.models ?? builtinModels());
    const sandbox = options.sandbox ?? createSandbox(options.sandboxRoot, options.now);

    return await openAgent({
      storage,
      models,
      sandbox,
      model: options.model,
      now: options.now,
      settings: options.settings,
      resumeOnOpen: options.resumeOnOpen,
      async onClose() {
        await releaseStorageLock(client, schema);
        await client.end().catch(() => undefined);
      },
    });
  } catch (error) {
    await database?.close().catch(() => undefined);
    await client.end().catch(() => undefined);
    throw error;
  }
}
