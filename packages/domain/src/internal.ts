import { createHash } from "node:crypto";

import {
  brand,
  type ApprovalGrant,
  type CallId,
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

// The operation id is minted by the caller, never taken from the model, so a model cannot replay an
// earlier order by reusing its id.
export function orderIntent(
  order: { symbol: string; side: "buy" | "sell"; quantity: string },
  operationId: OperationId,
): ExternalIntent {
  return {
    kind: "external",
    name: "place-order",
    operationId,
    symbol: order.symbol,
    side: order.side,
    quantity: order.quantity,
  };
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
