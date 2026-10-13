import { join } from "node:path";

import type { LeaseExecutor, Timestamp } from "@crypto/domain/lease";
import { createSandbox } from "@crypto/sandbox";
import type { Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { MemoryStorage, type HarnessSettings } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

import { openAgent, type ModelChoice, type OpenedAgent } from "./open.js";
import { researchExtension } from "./research.js";

/**
 * A local agent for development and tests: SQLite in `directory`, or memory without one. Cloud
 * workers use `openAgentWorker`, which puts one Postgres schema behind every tenant's commands.
 */
export async function createResearchAgent(input?: {
  directory?: string;
  model?: ModelChoice;
  /** Defaults to pi-ai's built-in providers, which read keys from the environment. */
  models?: Models;
  sandbox?: LeaseExecutor;
  settings?: HarnessSettings;
  resumeOnOpen?: boolean;
  now?: () => Timestamp;
}): Promise<OpenedAgent> {
  const directory = input?.directory;
  const now = input?.now;
  const storage =
    directory === undefined
      ? new MemoryStorage()
      : await openNodeSqliteStorage(join(directory, "session.sqlite"));
  const sandbox =
    input?.sandbox ??
    createSandbox(directory === undefined ? undefined : join(directory, "sandbox"), now);
  return openAgent({
    storage,
    models: input?.models ?? builtinModels(),
    sandbox,
    extensions: [researchExtension({ sandbox, now: now ?? (() => Date.now() as Timestamp) })],
    model: input?.model,
    now,
    settings: input?.settings,
    resumeOnOpen: input?.resumeOnOpen,
  });
}

export {
  openAgentWorker,
  StorageBusy,
  type AgentWorker,
  type AgentWorkerOptions,
} from "./worker.js";
export type { ModelChoice, OpenedAgent } from "./open.js";
export type {
  AgentCommand,
  CallId,
  ExecuteResult,
  OperationId,
  Rejection,
  ResearchAgent,
  RunStatus,
  SessionId,
  SessionView,
  TenantId,
} from "@crypto/domain/lease";
