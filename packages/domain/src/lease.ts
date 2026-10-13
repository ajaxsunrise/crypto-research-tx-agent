import { randomUUID } from "node:crypto";

type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

// Nominal ids share a primitive at runtime. Call sites pass a value they just checked or generated.
export function brand<Value extends string | number, Name extends string>(
  value: Value,
  name: Name,
): Brand<Value, Name> {
  void name;
  return value as Brand<Value, Name>;
}

export function freshId<Name extends string>(name: Name): Brand<string, Name> {
  return brand(randomUUID(), name);
}

export type TenantId = Brand<string, "TenantId">;
export type SessionId = Brand<string, "SessionId">;
export type CallId = Brand<string, "CallId">;
export type OperationId = Brand<string, "OperationId">;
export type RunId = Brand<string, "RunId">;
export type LeaseId = Brand<string, "LeaseId">;
export type Timestamp = Brand<number, "Timestamp">;
export type WorkspaceRef = Brand<string, "WorkspaceRef">;
export type WorkspacePath = Brand<string, "WorkspacePath">;
export type ContentHash = Brand<string, "ContentHash">;
export type NonEmptyString = Brand<string, "NonEmptyString">;

declare const approvalGrantBrand: unique symbol;

export type ApprovalGrant = {
  readonly [approvalGrantBrand]: "ApprovalGrant";
  readonly operationId: OperationId;
  readonly callId: CallId;
};

// The effect class decides recovery: a read reruns, an idempotent write reruns with the same hash,
// and an external effect is never sent twice.
export const toolEffects = {
  "read-market": "read",
  "write-note": "idempotent-write",
  "place-order": "external",
} as const;

export type ToolName = keyof typeof toolEffects;
export type ToolEffectClass = (typeof toolEffects)[ToolName];

export type ToolNameFor<Effect extends ToolEffectClass> = {
  [Name in ToolName]: (typeof toolEffects)[Name] extends Effect ? Name : never;
}[ToolName];

export type ResearchBrief = {
  question: string;
  horizon: string;
};

export type CheckedBrief = {
  question: NonEmptyString;
  horizon: NonEmptyString;
};

/** Every command names its tenant: one storage holds every tenant's sessions as rows. */
export type AgentCommand =
  | {
      kind: "start";
      tenantId: TenantId;
      idempotencyKey: string;
      brief: ResearchBrief;
      sessionId?: SessionId;
      threadId?: string;
      /** `provider/id`; resolved against the catalog of the agent that runs it. */
      model?: string;
    }
  | { kind: "persist"; tenantId: TenantId; sessionId: SessionId }
  | { kind: "reload"; tenantId: TenantId; sessionId: SessionId; threadId?: never }
  | { kind: "reload"; tenantId: TenantId; threadId: string; sessionId?: never }
  | { kind: "resume"; tenantId: TenantId; sessionId: SessionId }
  | {
      kind: "approve";
      tenantId: TenantId;
      sessionId: SessionId;
      callId: CallId;
      operationId: OperationId;
      decision: "grant" | "deny";
    }
  | { kind: "cancel"; tenantId: TenantId; sessionId: SessionId };

export type Rejection =
  | { kind: "invalid-request"; message: string }
  | { kind: "session-not-found" }
  | { kind: "in-progress" }
  | { kind: "run-open" }
  | { kind: "not-awaiting-approval" }
  | { kind: "approval-mismatch" };

export type RunStatus =
  | { kind: "empty" }
  | { kind: "running"; runId: RunId }
  | {
      kind: "awaiting-approval";
      runId: RunId;
      callId: CallId;
      operationId: OperationId;
      tool: ToolNameFor<"external">;
    }
  | { kind: "needs-resume"; runId: RunId }
  | { kind: "completed"; runId: RunId; text: string }
  | { kind: "cancelled"; runId: RunId }
  | { kind: "failed"; runId: RunId; message: string };

export type ReplayableResult =
  | { kind: "ok"; text: string }
  | { kind: "failed"; message: string }
  | { kind: "timed-out" }
  | { kind: "cancelled" };

export type ExternalResult =
  | ReplayableResult
  | { kind: "denied" }
  | { kind: "interrupted"; operationId: OperationId };

export type ToolResult = ReplayableResult | ExternalResult;

export type TranscriptItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool-call"; callId: CallId; name: string; arguments: string }
  | { kind: "tool-result"; callId: CallId; result: ToolResult };

export type SessionView = {
  sessionId: SessionId;
  /** Number of entries in the active transcript; it only grows. */
  head: number;
  status: RunStatus;
  transcript: readonly TranscriptItem[];
};

export type ExecuteResult =
  | { kind: "ok"; view: SessionView }
  | { kind: "rejected"; rejection: Rejection };

export type ResearchAgent = {
  readonly execute: (command: AgentCommand) => Promise<ExecuteResult>;
};

export type ReplayableIntent =
  | {
      kind: Extract<ToolEffectClass, "read">;
      name: ToolNameFor<"read">;
      symbol: string;
    }
  | {
      kind: Extract<ToolEffectClass, "idempotent-write">;
      name: ToolNameFor<"idempotent-write">;
      path: WorkspacePath;
      content: string;
      contentHash: ContentHash;
    };

export type ExternalIntent = {
  kind: Extract<ToolEffectClass, "external">;
  name: ToolNameFor<"external">;
  operationId: OperationId;
  symbol: string;
  side: "buy" | "sell";
  quantity: string;
};

export type ToolIntent = ReplayableIntent | ExternalIntent;

export type ReplayableEffect =
  | { kind: Extract<ToolEffectClass, "read"> }
  | {
      kind: Extract<ToolEffectClass, "idempotent-write">;
      contentHash: ContentHash;
    };

export type ExternalEffect = {
  kind: Extract<ToolEffectClass, "external">;
  operationId: OperationId;
  approval: ApprovalGrant;
};

export type ToolEffect = ReplayableEffect | ExternalEffect;

export type ReplayableLease = {
  kind: "replayable";
  leaseId: LeaseId;
  workspace: WorkspaceRef;
  deadlineAt: Timestamp;
  effect: ReplayableEffect;
  task: ReplayableIntent;
};

export type ExternalLease = {
  kind: "external";
  leaseId: LeaseId;
  workspace: WorkspaceRef;
  deadlineAt: Timestamp;
  effect: ExternalEffect;
  task: ExternalIntent;
};

export type Lease = ReplayableLease | ExternalLease;

export type LeaseResult =
  | { kind: "ok"; text: string }
  | { kind: "failed"; message: string }
  | { kind: "timed-out" }
  | { kind: "cancelled" };

/** Executes one lease inside the sandbox. A workspace names one session, so leases never share files. */
export type LeaseExecutor = (lease: Lease, signal: AbortSignal) => Promise<LeaseResult>;

export async function executeLease(
  executor: LeaseExecutor,
  lease: Lease,
  signal: AbortSignal,
  now: () => Timestamp = () => brand(Date.now(), "Timestamp"),
): Promise<LeaseResult> {
  const remaining = lease.deadlineAt - now();
  if (!Number.isFinite(lease.deadlineAt) || !Number.isFinite(remaining)) {
    throw new Error("Lease deadline and current time must be finite.");
  }
  if (signal.aborted) {
    return { kind: "cancelled" };
  }
  if (remaining <= 0) {
    return { kind: "timed-out" };
  }
  const timeout = AbortSignal.timeout(Math.ceil(remaining));
  const executionSignal = AbortSignal.any([signal, timeout]);
  let onAbort: () => void;
  const interrupted = new Promise<LeaseResult>((resolve) => {
    onAbort = () => resolve(signal.aborted ? { kind: "cancelled" } : { kind: "timed-out" });
    executionSignal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const result = await Promise.race([executor(lease, executionSignal), interrupted]);
    if (signal.aborted) {
      return { kind: "cancelled" };
    }
    const completedAt = now();
    if (!Number.isFinite(completedAt)) {
      throw new Error("Lease current time must be finite.");
    }
    if (timeout.aborted || completedAt >= lease.deadlineAt) {
      return { kind: "timed-out" };
    }
    return result;
  } finally {
    executionSignal.removeEventListener("abort", onAbort!);
  }
}

const leaseWindowMs = 30_000;

export function leaseDeadline(now: Timestamp): Timestamp {
  return brand(now + leaseWindowMs, "Timestamp");
}

export function leaseReplayable(input: {
  workspace: WorkspaceRef;
  intent: ReplayableIntent;
  now: Timestamp;
}): ReplayableLease {
  const effect: ReplayableEffect =
    input.intent.kind === "read"
      ? { kind: "read" }
      : { kind: "idempotent-write", contentHash: input.intent.contentHash };
  return {
    kind: "replayable",
    leaseId: freshId("LeaseId"),
    workspace: input.workspace,
    deadlineAt: leaseDeadline(input.now),
    effect,
    task: input.intent,
  };
}

export function leaseExternal(input: {
  workspace: WorkspaceRef;
  intent: ExternalIntent;
  approval: ApprovalGrant;
  now: Timestamp;
}): ExternalLease {
  return {
    kind: "external",
    leaseId: freshId("LeaseId"),
    workspace: input.workspace,
    deadlineAt: leaseDeadline(input.now),
    effect: { kind: "external", operationId: input.intent.operationId, approval: input.approval },
    task: input.intent,
  };
}
