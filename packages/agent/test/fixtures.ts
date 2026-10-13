import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { ExecuteResult, Lease, LeaseResult, SessionView } from "@crypto/domain/lease";
import { brand } from "@crypto/domain/lease";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  type MutableModels,
  type TranscriptContext,
} from "@earendil-works/pi-ai";

export const question = "What changed in BTC funding over 24h?";

/** The tenant most tests act as. */
export const tenant = brand("local", "TenantId");

/** The tenant the crash child and its parent both use, so the owner row matches across processes. */
export const crashTenant = brand("worker", "TenantId");

export type Reply = AssistantMessage | ((context: TranscriptContext) => AssistantMessage);

/** A model catalog with one scripted provider. `model` is what the agent is opened with. */
export function scripted(
  replies: Reply[],
  provider = "faux",
): { models: MutableModels; model: string } {
  const faux = fauxProvider({ provider });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(replies);
  const model = faux.getModel();
  return { models, model: `${model.provider}/${model.id}` };
}

export const say = (text: string): AssistantMessage => fauxAssistantMessage([fauxText(text)]);

export const call = (name: string, args: Record<string, string>): AssistantMessage =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

export function lastToolResultText(context: TranscriptContext): string {
  for (const message of [...context.messages].reverse()) {
    if (message.role === "toolResult") {
      const block = message.content.find((part) => part.type === "text");
      return block !== undefined && block.type === "text" ? block.text : "";
    }
  }
  return "";
}

export function lastUserText(context: TranscriptContext): string {
  for (const message of [...context.messages].reverse()) {
    if (message.role === "user") {
      return typeof message.content === "string"
        ? message.content
        : message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    }
  }
  return "";
}

/** A sandbox that records every lease it is given. */
export function recordingSandbox(
  answer: (lease: Lease) => Promise<LeaseResult> | LeaseResult = (lease) =>
    lease.kind === "external"
      ? { kind: "ok", text: `order ${lease.task.symbol} ${lease.task.side} ${lease.task.quantity}` }
      : lease.task.kind === "read"
        ? { kind: "ok", text: `market ${lease.task.symbol}` }
        : { kind: "ok", text: lease.task.content },
) {
  const leases: Lease[] = [];
  return {
    leases,
    sandbox: async (lease: Lease): Promise<LeaseResult> => {
      leases.push(lease);
      return answer(lease);
    },
  };
}

/** Settings that make a provider error fail the run at once instead of retrying with backoff. */
export const noRetry = { retry: { enabled: false, maxRetries: 0 } };

const child = fileURLToPath(new URL("./crash-child.js", import.meta.url));

/** Run the child until it dies inside the sandbox, the way a worker dies mid-tool. */
export function crashInSandbox(scenario: "read" | "order", target: string): void {
  const result = spawnSync(process.execPath, [child, scenario, target], {
    encoding: "utf8",
    env: process.env,
    timeout: 30_000,
  });
  assert.equal(
    result.status,
    9,
    `the child should die inside the sandbox; exit ${result.status}\n${result.stderr}`,
  );
}

export function view(result: ExecuteResult): SessionView {
  if (result.kind !== "ok") {
    assert.fail(`expected ok, got ${JSON.stringify(result.rejection)}`);
  }
  return result.view;
}
