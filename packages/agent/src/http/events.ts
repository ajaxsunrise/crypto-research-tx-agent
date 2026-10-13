import {
  EventType,
  type RunFinishedEvent,
  type TextMessageContentEvent,
  type TextMessageEndEvent,
  type TextMessageStartEvent,
  type ToolCallArgsEvent,
  type ToolCallEndEvent,
  type ToolCallResultEvent,
  type ToolCallStartEvent,
} from "@ag-ui/core";
import type { SessionView, TranscriptItem } from "@crypto/domain/lease";

export type WireEvent =
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallResultEvent
  | RunFinishedEvent;

function resultText(item: Extract<TranscriptItem, { kind: "tool-result" }>): string {
  switch (item.result.kind) {
    case "ok":
      return item.result.text;
    case "failed":
      return item.result.message;
    case "timed-out":
      return "timed-out";
    case "cancelled":
      return "cancelled";
    case "denied":
      return "denied";
    case "interrupted":
      return "interrupted";
    default: {
      const unreachable: never = item.result;
      return unreachable;
    }
  }
}

function itemEvents(item: TranscriptItem, index: number): WireEvent[] {
  const messageId = `m${index}`;
  switch (item.kind) {
    case "user":
      return [];
    case "assistant":
      return [
        { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: item.text },
        { type: EventType.TEXT_MESSAGE_END, messageId },
      ];
    case "tool-call":
      return [
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: item.callId,
          toolCallName: item.name,
        },
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: item.callId,
          delta: item.arguments === "" ? "{}" : item.arguments,
        },
        { type: EventType.TOOL_CALL_END, toolCallId: item.callId },
      ];
    case "tool-result":
      return [
        {
          type: EventType.TOOL_CALL_RESULT,
          messageId: `result:${item.callId}`,
          toolCallId: item.callId,
          content: resultText(item),
          role: "tool",
        },
      ];
    default: {
      const unreachable: never = item;
      return unreachable;
    }
  }
}

export function eventsForNewItems(
  items: readonly TranscriptItem[],
  startIndex: number,
): WireEvent[] {
  return items.flatMap((item, offset) => itemEvents(item, startIndex + offset));
}

export function finishForView(input: {
  threadId: string;
  runId: string;
  view: SessionView;
}): RunFinishedEvent | { type: EventType.RUN_ERROR; message: string } {
  const status = input.view.status;
  switch (status.kind) {
    case "awaiting-approval": {
      const call = input.view.transcript.find(
        (item): item is Extract<TranscriptItem, { kind: "tool-call" }> =>
          item.kind === "tool-call" && item.callId === status.callId,
      );
      const args = call?.arguments ?? "";
      return {
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
        outcome: {
          type: "interrupt",
          interrupts: [
            {
              id: status.operationId,
              reason: "approval",
              message: `Approve ${status.tool}? ${args}`,
              toolCallId: status.callId,
              responseSchema: {
                type: "object",
                properties: { decision: { enum: ["grant", "deny"] } },
                required: ["decision"],
              },
            },
          ],
        },
      };
    }
    case "completed":
    case "empty":
      return {
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
        outcome: { type: "success" },
      };
    case "cancelled":
      return {
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
        outcome: { type: "cancelled" },
      };
    case "failed":
      return { type: EventType.RUN_ERROR, message: status.message };
    case "running":
    case "needs-resume":
      return { type: EventType.RUN_ERROR, message: `Run is ${status.kind}.` };
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
}
