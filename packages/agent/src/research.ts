import { orderIntent, readIntent, writeIntent } from "@crypto/domain/internal";
import {
  brand,
  executeLease,
  freshId,
  leaseReplayable,
  type ExternalResult,
  type LeaseExecutor,
  type LeaseResult,
  type ReplayableIntent,
  type Timestamp,
  type WorkspaceRef,
} from "@crypto/domain/lease";
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  defineDocFamily,
  defineExtension,
  defineTool,
  hook,
  LiveDoc,
  section,
  ToolTask,
  type ConversationId,
  type ToolExecutionApi,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";

/**
 * Durable state the agent keeps next to pi-durable's transcript. Every change to it goes through a
 * Harness commit, so it lands in the same Postgres transaction line as the entries it describes.
 */

/**
 * One per session: the tenant that owns it. The owner row is committed in the same commit as the
 * conversation it names, and every command is checked against it, so a session without an owner or
 * with another tenant's name on it is unreachable.
 */
export const SessionOwnerDoc = defineDocFamily({
  kind: "crypto.session-owner",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed: { tenantId: string }) => ({ tenantId: seed.tenantId }),
});

/** One per idempotency key, namespaced by tenant: which session a `start` created, so a retried start finds it. */
export const StartDoc = defineDocFamily({
  kind: "crypto.start",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed: StartState) => ({ ...seed }),
});

export const ThreadDoc = defineDocFamily({
  kind: "crypto.thread",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed: { conversationId: number }) => ({ ...seed }),
});

/** The model a run was started with, stored so a continuation after a restart uses the same one. */
export type StoredModel = { provider: string; modelId: string };

export type StartState = {
  conversationId: number;
  input?: string;
  model?: StoredModel | null;
  submissionId?: number;
};

export type RunState = {
  runId: string;
  /** The submission whose answer closes the run; replaced when an approval continues it. */
  submissionId: number;
  outcome:
    | { kind: "open" }
    | { kind: "completed"; text: string }
    | { kind: "cancelled" }
    | { kind: "failed"; message: string };
  model: StoredModel | null;
  pendingStart?: string;
};

/** One per session: the latest run and how it ended. */
export const RunDoc = defineDocFamily({
  kind: "crypto.run",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed: RunState) => ({ ...seed }),
});

export type OrderState = {
  conversationId: number;
  callId: string;
  operationId: string;
  /** 发起审批的工具名，用于构建通用外部意图。 */
  toolName: string;
  /** 工具调用的原始参数，透传给 sandbox 执行器。 */
  args: Record<string, string>;
  /**
   * `parked` waits for a person. `dispatched` is committed before the sandbox is called, so a crash
   * after it is recovered as interrupted instead of sending again. `closed` holds the outcome.
   */
  phase: "parked" | "dispatched" | "closed";
  result: ExternalResult | null;
};

/** One per operation id: the order's approval and dispatch record. */
export const OrderDoc = defineDocFamily({
  kind: "crypto.order",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed: OrderState) => ({ ...seed }),
});

/** Sessions with an order that is not closed, so a view need not scan every order. */
export const OpenOrdersDoc = defineDocFamily({
  kind: "crypto.open-orders",
  version: 1,
  scope: "session",
  family: true,
  initial: (_seed: null) => ({ operationIds: [] as string[] }),
});

export function sessionKey(conversationId: ConversationId | number): string {
  return String(conversationId);
}

/**
 * Notes persist per session, so a follow-up run sees what an earlier one wrote. Session ids are
 * unique across every tenant in the shared storage, so one workspace never serves two tenants.
 */
export function workspaceFor(conversationId: ConversationId | number): WorkspaceRef {
  return brand(`session-${conversationId}`, "WorkspaceRef");
}

function textResult(result: LeaseResult): ToolExecutionResult {
  switch (result.kind) {
    case "ok":
      return { content: [{ type: "text", text: result.text }] };
    case "failed":
      return { content: [{ type: "text", text: result.message }], isError: true };
    case "timed-out":
      return { content: [{ type: "text", text: "Timed out." }], isError: true };
    case "cancelled":
      return { content: [{ type: "text", text: "Cancelled." }], isError: true };
  }
}

function signalOf(context: Context): AbortSignal {
  return context.abortSignal ?? new AbortController().signal;
}

async function runReplayable(
  sandbox: LeaseExecutor,
  now: () => Timestamp,
  api: ToolExecutionApi,
  intent: ReplayableIntent,
  context: Context,
): Promise<ToolExecutionResult> {
  const lease = leaseReplayable({
    workspace: workspaceFor(api.conversationId),
    intent,
    now: now(),
  });
  return textResult(await executeLease(sandbox, lease, signalOf(context), now));
}

const systemPrompt = [
  "You research crypto markets.",
  "Use read-market to read a symbol and write-note to store a note.",
  "Call place-order alone, with no other tool calls in the same response. It waits for a person to approve it, and the run ends until they do.",
  "Do not claim an order was sent before you are told its result.",
].join(" ");

/**
 * The research tools. Every lease names the session's workspace, so a tool cannot reach another
 * session's files whatever arguments the model passes.
 *
 * `replay` is the recovery policy pi-durable applies after a crash: a safe call reruns, an unsafe
 * call reports `interrupted` to the model. A read and a content-addressed write are safe to rerun.
 * place-order 持久保存审批请求；外部发送在 approve 中执行。
 */
export function researchExtension(input: { sandbox: LeaseExecutor; now: () => Timestamp }) {
  const readMarket = defineTool({
    name: "read-market",
    description: "Read a market symbol. Safe to run again.",
    parameters: Type.Object({ symbol: Type.String({ minLength: 1 }) }),
    replay: "safe",
    execute: (args, api, context) =>
      runReplayable(input.sandbox, input.now, api, readIntent(args.symbol), context),
  });

  const writeNote = defineTool({
    name: "write-note",
    description: "Write a note. The same content is safe to write again.",
    parameters: Type.Object({
      path: Type.String({ minLength: 1 }),
      content: Type.String(),
    }),
    replay: "safe",
    executionMode: "sequential",
    execute: (args, api, context) =>
      runReplayable(input.sandbox, input.now, api, writeIntent(args.path, args.content), context),
  });

  const placeOrder = defineTool({
    name: "place-order",
    description:
      "Request an order in a response containing only this tool call. Waits for approval.",
    parameters: Type.Object({
      symbol: Type.String({ minLength: 1 }),
      side: Type.Union([Type.Literal("buy"), Type.Literal("sell")]),
      quantity: Type.String({ minLength: 1 }),
    }),
    replay: "safe",
    async execute(args, api, context) {
      // operationId 使用持久 memo，恢复同一次调用时读取相同审批记录。
      const operationId = await api.memo("operationId", freshId("OperationId"), context);
      const intent = orderIntent(args, brand(operationId, "OperationId"));
      await api.commit(async (tx) => {
        const order = await tx.doc(OrderDoc, operationId, {
          conversationId: api.conversationId,
          callId: api.callId,
          operationId,
          toolName: "place-order",
          args: intent.args,
          phase: "parked",
          result: null,
        });
        if (order.phase === "parked") {
          const open = await tx.doc(OpenOrdersDoc, sessionKey(api.conversationId), null);
          if (!open.operationIds.includes(operationId)) {
            open.operationIds.push(operationId);
          }
        }
      }, context);
      return {
        content: [
          {
            type: "text",
            text: `Order ${operationId} is waiting for approval. The run ends here.`,
          },
        ],
        details: { operationId },
        // Ends the run without another model request. The person's decision continues it.
        control: { terminate: true },
      };
    },
  });

  return defineExtension({
    name: "crypto-research",
    sections: [section("preamble", () => systemPrompt, { tag: false })],
    tools: [readMarket, writeNote, placeOrder],
    hooks: [
      hook(ToolTask, {
        async beforeTool(call, api, context) {
          if (call.name === "place-order") {
            const live = await api.snapshot(LiveDoc, api.conversationId, context);
            if (live?.tools?.length !== 1) {
              return { block: "Call place-order alone in a separate response." };
            }
          }
          return undefined;
        },
      }),
    ],
  });
}
