import {
  brand,
  type LeaseExecutor,
  type ResearchAgent,
  type Timestamp,
} from "@crypto/domain/lease";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  type Extension,
  type HarnessSettings,
  type ModelRef,
  type Storage,
} from "@earendil-works/pi-durable";

import { createAgent } from "./agent.js";

export type ModelChoice = string | ModelRef;

export type OpenedAgent = ResearchAgent & {
  recovery: Promise<void>;
  /** 停止调度和工具执行，等待已接收的操作，关闭 storage。 */
  close(): Promise<void>;
};

/** Accept `provider/id` or a ref, and fail before any run if the catalog does not know it. */
export function resolveModel(
  models: Models,
  choice: ModelChoice | undefined,
): ModelRef | undefined {
  if (choice === undefined) {
    return undefined;
  }
  let ref: ModelRef;
  if (typeof choice === "string") {
    const slash = choice.indexOf("/");
    if (slash <= 0 || slash === choice.length - 1) {
      throw new Error(`Unknown model ${choice}.`);
    }
    ref = { provider: choice.slice(0, slash), modelId: choice.slice(slash + 1) };
  } else {
    ref = choice;
  }
  if (models.getModel(ref.provider, ref.modelId) === undefined) {
    throw new Error(`Unknown model ${ref.provider}/${ref.modelId}.`);
  }
  return ref;
}

export async function openAgent(input: {
  storage: Storage;
  models: Models;
  sandbox: LeaseExecutor;
  /** 扩展列表，每个扩展提供工具、system prompt 和 hook。调用方决定加载哪些扩展。 */
  extensions: readonly Extension[];
  /** The model a start runs with when it does not name one. */
  model?: ModelChoice;
  now?: () => Timestamp;
  settings?: HarnessSettings;
  /**
   * Start the task scheduler on open, so work a dead worker left behind continues at once: an
   * interrupted read or write reruns, an interrupted order is never resent. Off, it waits for a
   * `resume` command.
   */
  resumeOnOpen?: boolean;
  onClose?: () => Promise<void>;
}): Promise<OpenedAgent> {
  const model = resolveModel(input.models, input.model);
  const now = input.now ?? (() => brand(Date.now(), "Timestamp"));
  const registry = createRegistry();
  for (const ext of input.extensions) {
    registry.install(ext);
  }

  const harness = await Harness.open(
    input.storage,
    { models: input.models, registry, settings: input.settings },
    BACKGROUND_CONTEXT,
  );
  const agent = createAgent({
    harness,
    storage: input.storage,
    sandbox: input.sandbox,
    extensions: input.extensions,
    model,
    resolveChoice: (choice: string) => resolveModel(input.models, choice) as ModelRef,
    now,
  });
  const recovery = (input.resumeOnOpen ?? true) ? agent.recover() : Promise.resolve();
  let closed: Promise<void> | undefined;

  return {
    execute: agent.execute,
    listThreads: agent.listThreads,
    recovery,
    close() {
      if (closed === undefined) {
        closed = (async () => {
          const results: PromiseSettledResult<void>[] = [];
          results.push(...(await Promise.allSettled([agent.close()])));
          results.push(...(await Promise.allSettled([recovery])));
          results.push(...(await Promise.allSettled([harness.close(BACKGROUND_CONTEXT)])));
          try {
            await input.onClose?.();
          } catch (error) {
            results.push({ status: "rejected", reason: error });
          }
          const failures = results.filter((result) => result.status === "rejected");
          if (failures.length > 0) {
            throw new AggregateError(
              failures.map((result) => result.reason),
              "Agent close failed.",
            );
          }
        })();
      }
      return closed;
    },
  };
}
