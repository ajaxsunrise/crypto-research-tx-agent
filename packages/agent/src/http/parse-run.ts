import { contentToText, type RunAgentInput } from "@ag-ui/core";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";

export type ApprovalDecision = "grant" | "deny";

export type ParsedResume = {
  readonly interruptId: string;
  readonly status: "resolved" | "cancelled";
  readonly decision: ApprovalDecision;
};

export type ParsedRun = {
  readonly threadId: string;
  readonly runId: string;
  readonly question: string | undefined;
  readonly horizon: string | undefined;
  readonly model: string | undefined;
  readonly extension: string | undefined;
  readonly resume: ParsedResume | undefined;
};

export type ParseRunResult =
  | { readonly kind: "ok"; readonly run: ParsedRun }
  | { readonly kind: "invalid"; readonly message: string };

function trimmed(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.trim();
  return text === "" ? undefined : text;
}

function propsOf(value: RunAgentInput["forwardedProps"]): Record<string, unknown> | undefined {
  if (value === undefined) {
    return {};
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value;
}

function decisionOf(payload: unknown): ApprovalDecision | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  if (!("decision" in payload)) {
    return undefined;
  }
  const decision = payload.decision;
  if (decision === "grant" || decision === "deny") {
    return decision;
  }
  return undefined;
}

function lastQuestion(input: RunAgentInput): string | undefined {
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index];
    if (message === undefined || message.role !== "user") {
      continue;
    }
    const text = trimmed(contentToText(message.content));
    if (text !== undefined) {
      return text;
    }
  }
  return undefined;
}

export function parseRun(value: unknown): ParseRunResult {
  const parsed = RunAgentInputSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { kind: "invalid", message: issue?.message ?? "Invalid run input." };
  }
  const input = parsed.data;
  const props = propsOf(input.forwardedProps);
  if (props === undefined) {
    return { kind: "invalid", message: "forwardedProps must be an object." };
  }
  const resumeList = input.resume;
  let resume: ParsedResume | undefined;
  if (resumeList !== undefined) {
    if (resumeList.length !== 1) {
      return { kind: "invalid", message: "resume must address the one open approval." };
    }
    const entry = resumeList[0];
    if (entry === undefined) {
      return { kind: "invalid", message: "resume must address the one open approval." };
    }
    if (entry.status === "cancelled") {
      resume = { interruptId: entry.interruptId, status: "cancelled", decision: "deny" };
    } else {
      const decision = decisionOf(entry.payload);
      if (decision === undefined) {
        return {
          kind: "invalid",
          message: "A resolved resume needs payload.decision of grant or deny.",
        };
      }
      resume = { interruptId: entry.interruptId, status: "resolved", decision };
    }
  }
  const question = lastQuestion(input);
  const horizon = trimmed(props.horizon);
  if (resume === undefined && question === undefined) {
    return {
      kind: "invalid",
      message: "A run needs a user message.",
    };
  }
  return {
    kind: "ok",
    run: {
      threadId: input.threadId,
      runId: input.runId,
      question,
      horizon,
      model: trimmed(props.model),
      extension: trimmed(props.extension),
      resume,
    },
  };
}
