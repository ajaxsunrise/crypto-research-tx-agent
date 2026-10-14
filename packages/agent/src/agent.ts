import { issueGrant, nonEmpty, parseTenantId } from "@crypto/domain/internal";
import {
  brand,
  executeLease,
  leaseExternal,
  type AgentCommand,
  type CallId,
  type ExecuteResult,
  type ExternalResult,
  type LeaseExecutor,
  type ListedThread,
  type ListThreadsResult,
  type OperationId,
  type ResearchAgent,
  type RunStatus,
  type SessionId,
  type SessionView,
  type TenantId,
  type Timestamp,
  type ToolResult,
  type TranscriptItem,
} from "@crypto/domain/lease";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  Conversation,
  ConversationId,
  Cursor,
  EntryRecord,
  Extension,
  Harness,
  ModelRef,
  Storage,
  SubmissionId,
  Tx,
} from "@earendil-works/pi-durable";

import {
  OpenOrdersDoc,
  OrderDoc,
  RunDoc,
  SessionOwnerDoc,
  StartDoc,
  ThreadDoc,
  sessionKey,
  workspaceFor,
  type OrderState,
  type RunState,
  type StoredModel,
} from "./research.js";

const context = BACKGROUND_CONTEXT;

/**
 * Read an order inside a commit. `tx.doc` takes a seed for the absent case; every caller reaches an
 * order through the open-orders list or a lookup that found it, so the seed is never used.
 */
function orderIn(tx: Tx, operationId: string) {
  return tx.doc(OrderDoc, operationId, null as unknown as OrderState);
}

/** An order outcome as a transcript entry, appended in the commit that closes the order. */
const orderResultKind = "agent.order-result";

export type AgentOptions = {
  harness: Harness;
  /** 底层存储；会话列表经它扫描 ThreadDoc。 */
  storage: Storage;
  /** The sandbox. External leases go through it only after a grant. */
  sandbox: LeaseExecutor;
  /** 已安装的扩展；start 携带的 extension 选择在其中解析为会话的扩展集合。 */
  extensions: readonly Extension[];
  /** 每次新运行都会保留的全局扩展。 */
  globalExtensions: readonly Extension[];
  /** The model a start runs with when it does not name one. */
  model: ModelRef | undefined;
  /** Resolves the `model` choice a start carries; throws on an id the catalog does not know. */
  resolveChoice: (choice: string) => ModelRef;
  now: () => Timestamp;
};

function rejected(kind: "session-not-found" | "in-progress" | "run-open"): ExecuteResult {
  return { kind: "rejected", rejection: { kind } };
}

function sessionIdOf(conversationId: ConversationId | number): SessionId {
  return brand(String(conversationId), "SessionId");
}

function storedModelOf(model: ModelRef | undefined): StoredModel | null {
  return model === undefined ? null : { provider: model.provider, modelId: model.modelId };
}

function modelRefOf(stored: StoredModel | null | undefined): ModelRef | undefined {
  return stored === undefined || stored === null
    ? undefined
    : { provider: stored.provider, modelId: stored.modelId };
}

function textOf(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((block: { type?: string; text?: string }) =>
      block.type === "text" && typeof block.text === "string" ? [block.text] : [],
    )
    .join("");
}

function isExternalResult(value: unknown): value is ExternalResult {
  return typeof value === "object" && value !== null && "kind" in value;
}

/** The transcript a client sees, derived from pi-durable entries. */
function transcriptOf(
  entries: readonly EntryRecord[],
  suppressCallIds: ReadonlySet<string>,
): TranscriptItem[] {
  // order-result 条目覆盖同一 callId 的 pi-durable toolResult，所以先收集已覆盖的 callId 集合。
  const coveredCallIds = new Set<string>(suppressCallIds);
  for (const entry of entries) {
    if (entry.kind === orderResultKind) {
      const data = entry.data as { callId?: string } | undefined;
      if (data?.callId !== undefined) {
        coveredCallIds.add(data.callId);
      }
    }
  }
  const items: TranscriptItem[] = [];
  for (const entry of entries) {
    if (entry.kind === orderResultKind) {
      const data = entry.data as { callId?: string; result?: unknown } | undefined;
      if (data?.callId !== undefined && isExternalResult(data.result)) {
        items.push({
          kind: "tool-result",
          callId: brand(data.callId, "CallId"),
          result: data.result,
        });
      }
      continue;
    }
    for (const message of entry.model ?? []) {
      if (message.role === "user") {
        items.push({ kind: "user", text: textOf(message.content) });
      } else if (message.role === "assistant") {
        const text = textOf(message.content);
        if (text.length > 0) {
          items.push({ kind: "assistant", text });
        }
        for (const block of message.content) {
          if (block.type === "toolCall") {
            items.push({
              kind: "tool-call",
              callId: brand(block.id, "CallId"),
              name: block.name,
              arguments: JSON.stringify(block.arguments),
            });
          }
        }
      } else if (message.role === "toolResult") {
        // 审批等待结果由 order-result 记录提供；此 callId 已被覆盖（已关闭或仍待处理）的 toolResult 跳过。
        if (coveredCallIds.has(message.toolCallId) && !message.isError) {
          continue;
        }
        const text = textOf(message.content);
        const result: ToolResult = message.isError
          ? { kind: "failed", message: text }
          : { kind: "ok", text };
        items.push({ kind: "tool-result", callId: brand(message.toolCallId, "CallId"), result });
      }
    }
  }
  return items;
}

function lastAssistantText(entries: readonly EntryRecord[]): string {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    for (const message of [...(entries[index]?.model ?? [])].reverse()) {
      if (message.role === "assistant") {
        const text = textOf(message.content);
        if (text.length > 0) {
          return text;
        }
      }
    }
  }
  return "";
}

function resultText(operationId: string, result: ExternalResult): string {
  switch (result.kind) {
    case "ok":
      return `Order ${operationId} was approved and sent: ${result.text}`;
    case "failed":
      return `Order ${operationId} was approved but failed: ${result.message}`;
    case "timed-out":
      return `Order ${operationId} was approved but timed out. It may or may not have been sent.`;
    case "cancelled":
      return `Order ${operationId} was cancelled before it was sent.`;
    case "denied":
      return `Order ${operationId} was denied by a person and was not sent.`;
    case "interrupted":
      return `Order ${operationId} was interrupted while being sent. It may or may not have been sent; it will not be sent again.`;
  }
}

export function createAgent(options: AgentOptions): ResearchAgent & {
  recover(): Promise<void>;
  close(): Promise<void>;
} {
  const { harness, storage, sandbox, now, resolveChoice } = options;
  // One worker owns the storage (the storage lock enforces it), so an in-process set is enough to
  // keep two commands from driving one session at once. Conversation ids are unique across tenants,
  // so one set serves every tenant.
  const busy = new Set<number>();
  const active = new Map<number, { controller: AbortController; done: Promise<void> }>();
  let closing = false;

  /**
   * The session a command may touch. The owner row decides: a session with no owner, or one owned by
   * another tenant, is reported as not found. Failing closed here is the whole row-level boundary.
   */
  async function conversationOf(
    tenantId: TenantId,
    sessionId: SessionId,
  ): Promise<Conversation | undefined> {
    const id = Number(sessionId);
    if (!Number.isSafeInteger(id) || id <= 1) {
      return undefined;
    }
    const owner = await harness.snapshot(SessionOwnerDoc, String(id), context);
    if (owner?.tenantId !== tenantId) {
      return undefined;
    }
    return harness.conversation(id as ConversationId, context);
  }

  async function runOf(conversationId: number): Promise<RunState | undefined> {
    return harness.snapshot(RunDoc, sessionKey(conversationId), context) as Promise<
      RunState | undefined
    >;
  }

  async function openOrdersOf(conversationId: number): Promise<OrderState[]> {
    const open = await harness.snapshot(OpenOrdersDoc, sessionKey(conversationId), context);
    const orders: OrderState[] = [];
    for (const operationId of open?.operationIds ?? []) {
      const order = await harness.snapshot(OrderDoc, operationId, context);
      if (order !== undefined) {
        orders.push(order as OrderState);
      }
    }
    return orders;
  }

  async function statusOf(conversationId: number, run: RunState | undefined): Promise<RunStatus> {
    if (run === undefined) {
      return { kind: "empty" };
    }
    const runId = brand(run.runId, "RunId");
    switch (run.outcome.kind) {
      case "completed":
        return { kind: "completed", runId, text: run.outcome.text };
      case "cancelled":
        return { kind: "cancelled", runId };
      case "failed":
        return { kind: "failed", runId, message: run.outcome.message };
      case "open":
        break;
    }
    const orders = await openOrdersOf(conversationId);
    const parked = orders.find((order) => order.phase === "parked");
    if (orders.some((order) => order.phase !== "parked")) {
      // Dispatched, or closed but not yet reported to the model: only resume finishes it.
      return busy.has(conversationId)
        ? { kind: "running", runId }
        : { kind: "needs-resume", runId };
    }
    if (parked !== undefined) {
      return {
        kind: "awaiting-approval",
        runId,
        callId: brand(parked.callId, "CallId"),
        operationId: brand(parked.operationId, "OperationId"),
        tool: parked.toolName,
      };
    }
    if (busy.has(conversationId)) {
      return { kind: "running", runId };
    }
    // Open with nobody driving it: a previous worker stopped mid-run, or before it recorded how the
    // run ended. Resume picks it up either way.
    return { kind: "needs-resume", runId };
  }

  async function view(conversation: Conversation): Promise<SessionView> {
    const state = await conversation.viewState(context);
    try {
      const entries = state.value?.entries ?? [];
      const orders = await openOrdersOf(conversation.id);
      // 未关闭订单的 callId 也需要压制 pi-durable 的 toolResult（它只是停靠提示，不是最终结果）。
      const pendingCallIds = new Set(
        orders.filter((o) => o.phase !== "closed").map((o) => o.callId),
      );
      return {
        sessionId: sessionIdOf(conversation.id),
        head: entries.length,
        status: await statusOf(conversation.id, await runOf(conversation.id)),
        transcript: transcriptOf(entries, pendingCallIds),
      };
    } finally {
      state.dispose();
    }
  }

  async function ok(conversation: Conversation): Promise<ExecuteResult> {
    return { kind: "ok", view: await view(conversation) };
  }

  /** Wait for the run's current submission and record how the run ended. */
  async function settle(conversation: Conversation): Promise<void> {
    const run = await runOf(conversation.id);
    if (run === undefined || run.outcome.kind !== "open") {
      return;
    }
    const submission = await harness.submission(run.submissionId as SubmissionId, context);
    if (submission === undefined) {
      return;
    }
    const settled = await submission.wait(context);
    const orders = await openOrdersOf(conversation.id);
    if (orders.length > 0) {
      // Parked for a person, or an order still needs reporting. The run stays open.
      return;
    }
    let outcome: RunState["outcome"];
    if (settled.status === "done") {
      const state = await conversation.viewState(context);
      try {
        const text = lastAssistantText(state.value?.entries ?? []);
        outcome = { kind: "completed", text: text.length > 0 ? text : "Model returned no text." };
      } finally {
        state.dispose();
      }
    } else if (settled.reason === "aborted") {
      outcome = { kind: "cancelled" };
    } else {
      outcome = {
        kind: "failed",
        message: typeof settled.detail === "string" ? settled.detail : (settled.reason ?? "failed"),
      };
    }
    await harness.commit(async (tx) => {
      const current = await tx.doc(RunDoc, sessionKey(conversation.id), run);
      // Only the submission this settle waited for may close the run.
      if (current.outcome.kind === "open" && current.submissionId === run.submissionId) {
        current.outcome = outcome;
      }
    }, context);
  }

  async function drive(
    conversation: Conversation,
    work: () => Promise<void | ExecuteResult>,
  ): Promise<ExecuteResult> {
    if (closing) {
      throw new Error("This agent is closed.");
    }
    if (busy.has(conversation.id)) {
      return rejected("in-progress");
    }
    busy.add(conversation.id);
    let finish!: () => void;
    active.set(conversation.id, {
      controller: new AbortController(),
      done: new Promise<void>((resolve) => {
        finish = resolve;
      }),
    });
    try {
      const result = await work();
      if (result?.kind === "rejected") {
        return result;
      }
      if (!active.get(conversation.id)!.controller.signal.aborted) {
        await settle(conversation);
      }
      return await ok(conversation);
    } finally {
      busy.delete(conversation.id);
      active.delete(conversation.id);
      finish();
    }
  }

  /**
   * Submit input and point the run at it. A new run gets a fresh id, an open outcome, and the model
   * it was started with; a continuation (an order result) keeps the run and only moves which
   * submission closes it, configuring the conversation with the model the run already recorded.
   */
  async function submitInput(
    conversation: Conversation,
    content: string,
    requestId: string,
    kind: "new-run" | "continuation",
    model: ModelRef | undefined,
    extension: Extension | undefined,
  ): Promise<boolean> {
    const prior = await runOf(conversation.id);
    if (prior?.outcome.kind !== "open" || active.get(conversation.id)?.controller.signal.aborted) {
      return false;
    }
    const configureWith =
      kind === "new-run" ? model : modelRefOf((await runOf(conversation.id))?.model);
    if (configureWith !== undefined) {
      await conversation.configure({ model: configureWith }, context);
    }
    // 新一次 start 携带的扩展选择决定会话加载哪些扩展；全局扩展始终保留。
    if (kind === "new-run") {
      await conversation.configure(
        {
          extensions:
            extension === undefined
              ? [...options.globalExtensions, ...options.extensions]
              : [...options.globalExtensions, extension],
        },
        context,
      );
    }
    if (active.get(conversation.id)?.controller.signal.aborted) {
      return false;
    }
    const submission = await conversation.submit({ type: "input", content, requestId }, context);
    return harness.commit(async (tx) => {
      const run = await tx.doc(RunDoc, sessionKey(conversation.id), {
        runId: String(submission.id),
        submissionId: submission.id,
        outcome: { kind: "open" },
        model: storedModelOf(model),
      });
      if (run.outcome.kind !== "open") {
        return false;
      }
      if (kind === "new-run") {
        run.runId = String(submission.id);
        run.model = storedModelOf(model);
        if (run.pendingStart === undefined) {
          throw new Error("A new run has no pending start.");
        }
        const started = await tx.doc(StartDoc, run.pendingStart, {
          conversationId: conversation.id,
        });
        started.submissionId = submission.id;
        delete run.pendingStart;
      }
      run.submissionId = submission.id;
      return true;
    }, context);
  }

  async function submitStart(conversation: Conversation): Promise<void> {
    const run = await runOf(conversation.id);
    if (run?.pendingStart === undefined || run.outcome.kind !== "open") {
      return;
    }
    const started = await harness.snapshot(StartDoc, run.pendingStart, context);
    if (started?.input === undefined) {
      throw new Error(`Start ${run.pendingStart} has no stored input.`);
    }
    const extensionName = started.extension ?? undefined;
    const extension =
      extensionName === undefined
        ? undefined
        : options.extensions.find((item) => item.name === extensionName);
    if (extensionName !== undefined && extension === undefined) {
      throw new Error(`Start ${run.pendingStart} names an unknown extension ${extensionName}.`);
    }
    await submitInput(
      conversation,
      started.input,
      `start:${run.pendingStart}`,
      "new-run",
      modelRefOf(started.model),
      extension,
    );
  }

  async function start(command: Extract<AgentCommand, { kind: "start" }>): Promise<ExecuteResult> {
    const key = nonEmpty(command.idempotencyKey);
    const input = nonEmpty(command.input);
    if (key === undefined || input === undefined) {
      return {
        kind: "rejected",
        rejection: {
          kind: "invalid-request",
          message: "idempotencyKey and input must be non-empty.",
        },
      };
    }
    const threadId = command.threadId === undefined ? undefined : nonEmpty(command.threadId);
    if (command.threadId !== undefined && threadId === undefined) {
      return {
        kind: "rejected",
        rejection: { kind: "invalid-request", message: "threadId must be non-empty." },
      };
    }
    let model = options.model;
    if (command.model !== undefined) {
      try {
        model = resolveChoice(command.model);
      } catch (error) {
        return {
          kind: "rejected",
          rejection: {
            kind: "invalid-request",
            message: error instanceof Error ? error.message : `Unknown model ${command.model}.`,
          },
        };
      }
    }
    if (
      command.extension !== undefined &&
      !options.extensions.some((item) => item.name === command.extension)
    ) {
      return {
        kind: "rejected",
        rejection: {
          kind: "invalid-request",
          message: `Unknown extension ${command.extension}.`,
        },
      };
    }

    let target: Conversation | undefined;
    if (command.sessionId !== undefined) {
      target = await conversationOf(command.tenantId, command.sessionId);
      if (target === undefined) {
        return rejected("session-not-found");
      }
    }

    // The key is scoped to the tenant and claimed in one commit with the conversation it names, so
    // a retried or concurrent start with the same key always lands on the same session, and two
    // tenants using one key each get their own.
    const scopedKey = `t:${command.tenantId}:${key}`;
    const claim = await harness.commit(async (tx: Tx) => {
      const started = await tx.doc(StartDoc, scopedKey, { conversationId: 0 });
      const thread =
        threadId === undefined
          ? undefined
          : await tx.doc(ThreadDoc, `t:${command.tenantId}:${threadId}`, { conversationId: 0 });
      if (started.conversationId !== 0) {
        const owner = await tx.doc(SessionOwnerDoc, String(started.conversationId), {
          tenantId: "",
        });
        if (owner.tenantId !== command.tenantId) {
          return { kind: "session-not-found" as const };
        }
        if (
          thread !== undefined &&
          thread.conversationId !== 0 &&
          thread.conversationId !== started.conversationId
        ) {
          return { kind: "thread-mismatch" as const };
        }
        if (thread !== undefined) {
          thread.conversationId = started.conversationId;
          thread.preview = input.slice(0, 120);
        }
        if (started.input !== undefined) {
          return { kind: "existing" as const, conversationId: started.conversationId };
        }
        const submission = await tx.submissionByRequest(
          started.conversationId as ConversationId,
          `start:${scopedKey}`,
        );
        if (submission !== undefined) {
          started.submissionId = submission.id;
          await tx.doc(RunDoc, sessionKey(started.conversationId), {
            runId: String(submission.id),
            submissionId: submission.id,
            outcome: { kind: "open" },
            model: storedModelOf(model),
          });
          return { kind: "existing" as const, conversationId: started.conversationId };
        }
      }
      let conversationId: number;
      const targetId = started.conversationId || thread?.conversationId || target?.id;
      if (target !== undefined && thread?.conversationId && target.id !== thread.conversationId) {
        return { kind: "thread-mismatch" as const };
      }
      if (targetId === undefined) {
        conversationId = (await tx.createConversation({ ownership: { kind: "ownerless" } })).id;
        // The owner row lands in the same commit as the conversation, so no session ever exists
        // without its tenant.
        await tx.doc(SessionOwnerDoc, String(conversationId), { tenantId: command.tenantId });
      } else {
        const owner = await tx.doc(SessionOwnerDoc, String(targetId), { tenantId: "" });
        if (owner.tenantId !== command.tenantId) {
          return { kind: "session-not-found" as const };
        }
        const run = await tx.doc(RunDoc, sessionKey(targetId), {
          runId: "",
          submissionId: 0,
          outcome: { kind: "open" },
          model: null,
        });
        if (
          busy.has(targetId) ||
          (run.outcome.kind === "open" &&
            (run.submissionId !== 0 || run.pendingStart !== undefined))
        ) {
          return { kind: "run-open" as const };
        }
        conversationId = targetId;
      }
      started.conversationId = conversationId;
      started.input = input;
      started.model = storedModelOf(model);
      started.extension = command.extension ?? null;
      if (thread !== undefined) {
        thread.conversationId = conversationId;
        thread.preview = input.slice(0, 120);
      }
      const run = await tx.doc(RunDoc, sessionKey(conversationId), {
        runId: scopedKey,
        submissionId: 0,
        outcome: { kind: "open" },
        model: storedModelOf(model),
      });
      run.runId = scopedKey;
      run.submissionId = 0;
      run.outcome = { kind: "open" };
      run.model = storedModelOf(model);
      run.pendingStart = scopedKey;
      return { kind: "claimed" as const, conversationId };
    }, context);

    if (claim.kind === "run-open") {
      return rejected("run-open");
    }
    if (claim.kind === "session-not-found") {
      return rejected("session-not-found");
    }
    if (claim.kind === "thread-mismatch") {
      return {
        kind: "rejected",
        rejection: { kind: "invalid-request", message: "threadId names a different session." },
      };
    }
    const conversation = await conversationOf(command.tenantId, sessionIdOf(claim.conversationId));
    if (conversation === undefined) {
      return rejected("session-not-found");
    }
    const run = await runOf(conversation.id);
    if (
      claim.kind === "existing" &&
      (run?.pendingStart !== scopedKey || busy.has(conversation.id))
    ) {
      // A retry of a start that already submitted: report it, do not run it again.
      return ok(conversation);
    }
    return drive(conversation, () => submitStart(conversation));
  }

  /**
   * Close an order and tell the model, in that order. The close and the transcript entry share one
   * commit; the continuation is idempotent by request id, so a crash between them is repaired by
   * resume without reporting twice.
   */
  async function closeOrder(
    conversation: Conversation,
    operationId: string,
    result: ExternalResult,
  ): Promise<void> {
    await harness.commit(async (tx) => {
      const order = await orderIn(tx, operationId);
      if (order.phase === "closed") {
        return;
      }
      order.phase = "closed";
      order.result = result;
      await tx.appendEntry(conversation.id, {
        kind: orderResultKind,
        data: { callId: order.callId, operationId, result },
      });
    }, context);
    await reportOrder(conversation, operationId);
  }

  async function reportOrder(conversation: Conversation, operationId: string): Promise<void> {
    const order = (await harness.snapshot(OrderDoc, operationId, context)) as
      | OrderState
      | undefined;
    if (
      order?.result === null ||
      order === undefined ||
      (await runOf(conversation.id))?.outcome.kind !== "open"
    ) {
      return;
    }
    const submitted = await submitInput(
      conversation,
      resultText(operationId, order.result),
      `order:${operationId}`,
      "continuation",
      undefined,
      undefined,
    );
    if (!submitted) {
      return;
    }
    await harness.commit(async (tx) => {
      const open = await tx.doc(OpenOrdersDoc, sessionKey(conversation.id), null);
      open.operationIds = open.operationIds.filter((id) => id !== operationId);
    }, context);
  }

  /** Finish orders a previous worker left half done. Never sends an order. */
  async function recoverOrders(conversation: Conversation): Promise<void> {
    for (const order of await openOrdersOf(conversation.id)) {
      if (order.phase === "dispatched") {
        // The send may or may not have happened. Reporting it as interrupted is the only answer
        // that cannot cause a second order.
        await closeOrder(conversation, order.operationId, {
          kind: "interrupted",
          operationId: brand(order.operationId, "OperationId"),
        });
      } else if (order.phase === "closed") {
        await reportOrder(conversation, order.operationId);
      }
    }
  }

  async function resume(
    command: Extract<AgentCommand, { kind: "resume" }>,
  ): Promise<ExecuteResult> {
    const conversation = await conversationOf(command.tenantId, command.sessionId);
    if (conversation === undefined) {
      return rejected("session-not-found");
    }
    return drive(conversation, async () => {
      harness.resume();
      await submitStart(conversation);
      await recoverOrders(conversation);
      await conversation.waitForIdle(context);
    });
  }

  async function approve(
    command: Extract<AgentCommand, { kind: "approve" }>,
  ): Promise<ExecuteResult> {
    if (command.decision !== "grant" && command.decision !== "deny") {
      return {
        kind: "rejected",
        rejection: { kind: "invalid-request", message: "decision must be grant or deny." },
      };
    }
    const conversation = await conversationOf(command.tenantId, command.sessionId);
    if (conversation === undefined) {
      return rejected("session-not-found");
    }
    return drive(conversation, async (): Promise<void | ExecuteResult> => {
      const parked = (await openOrdersOf(conversation.id)).filter(
        (order) => order.phase === "parked",
      );
      if (parked.length === 0) {
        return { kind: "rejected", rejection: { kind: "not-awaiting-approval" } };
      }
      const order = parked.find(
        (candidate) =>
          candidate.operationId === command.operationId && candidate.callId === command.callId,
      );
      if (order === undefined) {
        return { kind: "rejected", rejection: { kind: "approval-mismatch" } };
      }

      if (command.decision === "deny") {
        await closeOrder(conversation, order.operationId, { kind: "denied" });
        return;
      }

      // 发送之前持久保存 dispatched，每个 operationId 最多发起一次执行。
      const won = await harness.commit(async (tx) => {
        const current = await orderIn(tx, order.operationId);
        if (current.phase !== "parked") {
          return false;
        }
        const run = await tx.doc(RunDoc, sessionKey(conversation.id), null as unknown as RunState);
        if (run.outcome.kind !== "open" || active.get(conversation.id)?.controller.signal.aborted) {
          return false;
        }
        current.phase = "dispatched";
        return true;
      }, context);
      if (!won) {
        return { kind: "rejected", rejection: { kind: "not-awaiting-approval" } };
      }

      const operationId = brand(order.operationId, "OperationId") as OperationId;
      const lease = leaseExternal({
        workspace: workspaceFor(conversation.id),
        intent: {
          kind: "external",
          name: order.toolName,
          operationId,
          args: order.args,
        },
        approval: issueGrant(operationId, brand(order.callId, "CallId") as CallId),
        now: now(),
      });
      // If the sandbox call throws, the order stays `dispatched` and resume reports it interrupted.
      const result = await executeLease(
        sandbox,
        lease,
        active.get(conversation.id)!.controller.signal,
        now,
      );
      if (active.get(conversation.id)!.controller.signal.aborted) {
        return;
      }
      await closeOrder(conversation, order.operationId, result);
    });
  }

  async function cancel(
    command: Extract<AgentCommand, { kind: "cancel" }>,
  ): Promise<ExecuteResult> {
    const conversation = await conversationOf(command.tenantId, command.sessionId);
    if (conversation === undefined) {
      return rejected("session-not-found");
    }
    active.get(conversation.id)?.controller.abort();
    const run = await runOf(conversation.id);
    if (run === undefined || run.outcome.kind !== "open") {
      return ok(conversation);
    }
    await harness.commit(async (tx) => {
      const open = await tx.doc(OpenOrdersDoc, sessionKey(conversation.id), null);
      for (const operationId of open.operationIds) {
        const order = await orderIn(tx, operationId);
        let result: ExternalResult | undefined;
        if (order.phase === "parked") {
          // Never approved, so never sent.
          result = { kind: "cancelled" };
        } else if (order.phase === "dispatched") {
          result = { kind: "interrupted", operationId: brand(operationId, "OperationId") };
        }
        if (result !== undefined) {
          order.phase = "closed";
          order.result = result;
          await tx.appendEntry(conversation.id, {
            kind: orderResultKind,
            data: { callId: order.callId, operationId, result },
          });
        }
      }
      open.operationIds = [];
      const current = await tx.doc(RunDoc, sessionKey(conversation.id), run);
      if (current.outcome.kind === "open") {
        current.outcome = { kind: "cancelled" };
        delete current.pendingStart;
      }
    }, context);
    await conversation.abort(context);
    return ok(conversation);
  }

  async function read(command: {
    sessionId: SessionId;
    tenantId: TenantId;
  }): Promise<ExecuteResult> {
    const conversation = await conversationOf(command.tenantId, command.sessionId);
    if (conversation === undefined) {
      return rejected("session-not-found");
    }
    return ok(conversation);
  }

  async function reload(
    command: Extract<AgentCommand, { kind: "reload" }>,
  ): Promise<ExecuteResult> {
    if (command.sessionId !== undefined) {
      return read({ tenantId: command.tenantId, sessionId: command.sessionId });
    }
    const threadId = nonEmpty(command.threadId);
    if (threadId === undefined) {
      return {
        kind: "rejected",
        rejection: { kind: "invalid-request", message: "threadId must be non-empty." },
      };
    }
    const thread = await harness.snapshot(ThreadDoc, `t:${command.tenantId}:${threadId}`, context);
    if (!thread?.conversationId) {
      return rejected("session-not-found");
    }
    return read({ tenantId: command.tenantId, sessionId: sessionIdOf(thread.conversationId) });
  }

  /**
   * 会话列表的数据源是 durable 的 ThreadDoc（key 形如 `t:<tenant>:<threadId>`）：按租户前缀
   * 过滤扫描结果，每条再读归属与运行状态。扫描按 id 升序，返回前倒序，最新创建的排在前面。
   */
  async function listThreads(tenantId: TenantId): Promise<ListThreadsResult> {
    if (closing) {
      throw new Error("This agent is closed.");
    }
    if (typeof tenantId !== "string" || parseTenantId(tenantId) === undefined) {
      return {
        kind: "rejected",
        rejection: { kind: "invalid-request", message: "Invalid tenantId." },
      };
    }
    const prefix = `t:${tenantId}:`;
    const threads: ListedThread[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await storage.scanDocuments(
        { scope: { kind: "session" }, at: "current", kind: ThreadDoc.definition.kind },
        100,
        cursor,
        context,
      );
      for (const record of page.items) {
        if (record.key === undefined || !record.key.startsWith(prefix)) {
          continue;
        }
        const thread = await harness.snapshot(ThreadDoc, record.key, context);
        if (thread === undefined || !Number.isSafeInteger(thread.conversationId)) {
          continue;
        }
        const owner = await harness.snapshot(
          SessionOwnerDoc,
          String(thread.conversationId),
          context,
        );
        if (owner?.tenantId !== tenantId) {
          continue;
        }
        threads.push({
          threadId: record.key.slice(prefix.length),
          preview: thread.preview ?? "",
          status: (await statusOf(thread.conversationId, await runOf(thread.conversationId))).kind,
        });
      }
      cursor = page.next;
    } while (cursor !== undefined);
    threads.reverse();
    return { kind: "ok", threads };
  }

  return {
    listThreads,
    async recover() {
      let cursor: Cursor | undefined;
      do {
        if (closing) {
          return;
        }
        const page = await harness.commit((tx) => tx.scanConversations({}, 100, cursor), context);
        await Promise.all(
          page.items.map(async (record) => {
            const owner = await harness.snapshot(SessionOwnerDoc, String(record.id), context);
            const run = await runOf(record.id);
            if (!closing && owner !== undefined && run?.outcome.kind === "open") {
              await resume({
                kind: "resume",
                tenantId: brand(owner.tenantId, "TenantId"),
                sessionId: sessionIdOf(record.id),
              });
            }
          }),
        );
        cursor = page.next;
      } while (cursor !== undefined);
    },
    async close() {
      closing = true;
      const running = [...active.values()];
      for (const item of running) {
        item.controller.abort();
      }
      await Promise.all(running.map((item) => item.done));
    },
    async execute(command) {
      if (closing) {
        throw new Error("This agent is closed.");
      }
      if (typeof command.tenantId !== "string" || parseTenantId(command.tenantId) === undefined) {
        return {
          kind: "rejected",
          rejection: { kind: "invalid-request", message: "Invalid tenantId." },
        };
      }
      switch (command.kind) {
        case "start":
          return start(command);
        // Every commit is durable once it resolves, so persist has nothing left to flush.
        case "persist":
          return read(command);
        case "reload":
          return reload(command);
        case "resume":
          return resume(command);
        case "approve":
          return approve(command);
        case "cancel":
          return cancel(command);
        default:
          return {
            kind: "rejected",
            rejection: { kind: "invalid-request", message: "Unknown command." },
          };
      }
    },
  };
}
