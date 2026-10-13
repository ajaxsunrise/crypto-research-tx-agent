import { createHash, timingSafeEqual } from "node:crypto";

import { parseTenantId } from "@crypto/domain/internal";
import type { TenantId } from "@crypto/domain/lease";
import { sign, verify } from "hono/jwt";
import { z } from "zod";

/** 静态 token 认证保持同步；JWT 校验是异步的，两种实现都满足这个类型。 */
export type TenantAuthenticator = (
  request: Request,
) => TenantId | undefined | Promise<TenantId | undefined>;

const tokenConfig = z.record(z.string(), z.string().min(32).regex(/^\S+$/));

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
    const matched = bearerOf(request);
    if (matched === undefined) {
      return undefined;
    }
    const hash = digest(matched);
    let tenantId: TenantId | undefined;
    for (const tenant of tenants) {
      if (timingSafeEqual(hash, tenant.hash)) {
        tenantId = tenant.tenantId;
      }
    }
    return tenantOf(tenantId, request);
  };
}

function bearerOf(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  const matched = /^Bearer (\S+)$/i.exec(authorization ?? "");
  return matched === null ? undefined : matched[1];
}

function tenantOf(tenantId: TenantId | undefined, request: Request): TenantId | undefined {
  const requested = request.headers.get("x-tenant-id");
  if (requested !== null && requested !== tenantId) {
    return undefined;
  }
  return tenantId;
}

/** JWT 签发与校验；HS256，租户 id 放在 sub 声明里。 */
export type JwtAuth = {
  issue(input: { tenantId: string }): Promise<string>;
  /** 校验签名与有效期；无效 token 返回 undefined，表示这个请求没有可用的身份。 */
  tenantOf(token: string): Promise<TenantId | undefined>;
};

export function createJwtAuth(secret: string, ttlSeconds: number): JwtAuth {
  return {
    async issue({ tenantId }) {
      const now = Math.floor(Date.now() / 1000);
      return sign({ sub: tenantId, iat: now, exp: now + ttlSeconds }, secret, "HS256");
    },
    async tenantOf(token) {
      try {
        const payload = await verify(token, secret, "HS256");
        if (typeof payload.sub !== "string") {
          return undefined;
        }
        return parseTenantId(payload.sub);
      } catch {
        // 签名不符、过期、格式损坏都属于“没有可用的身份”
        return undefined;
      }
    },
  };
}

/**
 * 组合两种凭据：先查静态 token 表（运维与本地开发），再校验 JWT（注册用户登录所得）。
 * x-tenant-id 一旦提供必须与最终命中的租户一致。
 */
export function withJwtAuth(base: TenantAuthenticator, jwt: JwtAuth): TenantAuthenticator {
  return async (request) => {
    const fromTokens = await base(request);
    if (fromTokens !== undefined) {
      return fromTokens;
    }
    const bearer = bearerOf(request);
    if (bearer === undefined) {
      return undefined;
    }
    return tenantOf(await jwt.tenantOf(bearer), request);
  };
}
