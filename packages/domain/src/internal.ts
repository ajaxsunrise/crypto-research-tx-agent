import { createHash } from "node:crypto";

import {
  brand,
  type ApprovalGrant,
  type CallId,
  type ComputeIntent,
  type ContentHash,
  type ExternalIntent,
  type NonEmptyString,
  type OperationId,
  type ReplayableIntent,
  type TenantId,
} from "./lease.js";

export function hashContent(content: string): ContentHash {
  return brand(createHash("sha256").update(content).digest("hex"), "ContentHash");
}

export function readIntent(symbol: string): ReplayableIntent {
  return { kind: "read", name: "read-market", symbol };
}

export function writeIntent(path: string, content: string): ReplayableIntent {
  return {
    kind: "idempotent-write",
    name: "write-note",
    path: brand(path, "WorkspacePath"),
    content,
    contentHash: hashContent(content),
  };
}

// operationId 由调用方生成，不由模型提供，从而防止模型用旧 id 重放历史订单。
export function orderIntent(
  order: { symbol: string; side: "buy" | "sell"; quantity: string },
  operationId: OperationId,
): ExternalIntent {
  return {
    kind: "external",
    name: "place-order",
    operationId,
    args: { symbol: order.symbol, side: order.side, quantity: order.quantity },
  };
}

// computeIntent 供代码执行工具使用；contentHash 保证相同代码产生相同的 replay key。
export function computeIntent(language: string, code: string, toolName: string): ComputeIntent {
  const contentHash = hashContent(code);
  return { kind: "compute", name: toolName, language, code, contentHash };
}

// Only the approval path issues a grant; nothing else can build an external lease without one.
export function issueGrant(operationId: OperationId, callId: CallId): ApprovalGrant {
  return { operationId, callId } as ApprovalGrant;
}

export function nonEmpty(value: unknown): NonEmptyString | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  return brand(value, "NonEmptyString");
}

// A tenant id names the owner of a session and arrives on every request, so it is checked once here.
export function parseTenantId(value: string): TenantId | undefined {
  if (!/^[a-z][a-z0-9_]{0,53}$/.test(value)) {
    return undefined;
  }
  return brand(value, "TenantId");
}
