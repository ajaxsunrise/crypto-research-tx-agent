import { createHash, timingSafeEqual } from "node:crypto";

import { parseTenantId } from "@crypto/domain/internal";
import type { TenantId } from "@crypto/domain/lease";
import { z } from "zod";

export type TenantAuthenticator = (request: Request) => TenantId | undefined;

const tokenConfig = z.record(z.string().min(32).regex(/^\S+$/));

function digest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export function createTenantAuthenticator(value: string): TenantAuthenticator {
  const entries = Object.entries(tokenConfig.parse(JSON.parse(value)));
  if (entries.length === 0) {
    throw new Error("TENANT_TOKENS must configure at least one tenant.");
  }
  const tokens = new Set<string>();
  const tenants = entries.map(([name, token]) => {
    const tenantId = parseTenantId(name);
    if (tenantId === undefined) {
      throw new Error("TENANT_TOKENS contains an invalid tenant id.");
    }
    if (tokens.has(token)) {
      throw new Error("TENANT_TOKENS contains a duplicate token.");
    }
    tokens.add(token);
    return { tenantId, hash: digest(token) };
  });
  return (request) => {
    const authorization = request.headers.get("authorization");
    const matched = /^Bearer (\S+)$/i.exec(authorization ?? "");
    if (matched === null) {
      return undefined;
    }
    const hash = digest(matched[1]!);
    let tenantId: TenantId | undefined;
    for (const tenant of tenants) {
      if (timingSafeEqual(hash, tenant.hash)) {
        tenantId = tenant.tenantId;
      }
    }
    const requested = request.headers.get("x-tenant-id");
    if (requested !== null && requested !== tenantId) {
      return undefined;
    }
    return tenantId;
  };
}
