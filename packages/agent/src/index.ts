import { join } from "node:path";

import type { LeaseExecutor, Timestamp } from "@crypto/domain/lease";
import { createSandbox } from "@crypto/sandbox";
import type { CodeSandboxMode } from "@crypto/sandbox/code";
import type { Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { MemoryStorage, type HarnessSettings } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

import { codeExtension } from "./extensions/code.js";
import { openAgent, type ModelChoice, type OpenedAgent } from "./open.js";
import { researchExtension } from "./research.js";
import { skillsExtension } from "./skills.js";

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
  /** 代码执行 sandbox 的运行方式；缺省在主机子进程执行。 */
  codeSandbox?: CodeSandboxMode;
  /** Project skill directories containing `SKILL.md`; defaults to `./skills`. */
  skillsRoot?: string;
  settings?: HarnessSettings;
  resumeOnOpen?: boolean;
  now?: () => Timestamp;
}): Promise<OpenedAgent> {
  const directory = input?.directory;
  const now = input?.now;
  const clock = now ?? (() => Date.now() as Timestamp);
  const sandboxRoot = directory === undefined ? undefined : join(directory, "sandbox");
  const projectSkills = await skillsExtension(input?.skillsRoot ?? "./skills");
  const storage =
    directory === undefined
      ? new MemoryStorage()
      : await openNodeSqliteStorage(join(directory, "session.sqlite"));
  const sandbox = input?.sandbox ?? createSandbox(sandboxRoot, now, process.env.FIRECRAWL_API_KEY);
  return openAgent({
    storage,
    models: input?.models ?? builtinModels(),
    sandbox,
    extensions: [
      researchExtension({ sandbox, now: clock }),
      codeExtension({ rootDir: sandboxRoot, mode: input?.codeSandbox, now: clock }),
    ],
    globalExtensions: [projectSkills],
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
export { discoverSkills, readSkill, skillsExtension, type Skill } from "./skills.js";
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
