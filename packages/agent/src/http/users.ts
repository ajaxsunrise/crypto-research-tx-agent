import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

import { validateSchemaName } from "@crypto/storage-postgres";
import pg from "pg";

/** 注册结果：成功带回新租户 id；邮箱已被注册时明确返回。 */
export type RegisterOutcome = { kind: "registered"; tenantId: string } | { kind: "email-taken" };

/**
 * 注册用户目录。一个注册邮箱对应一个租户（终端用户即租户），注册成功时铸造租户 id，
 * 登录成功时返回该租户 id，供 HTTP 层签发 JWT。
 */
export type UserDirectory = {
  register(email: string, password: string): Promise<RegisterOutcome>;
  /** 校验邮箱与密码；通过时返回租户 id，否则返回 undefined。 */
  login(email: string, password: string): Promise<string | undefined>;
  close(): Promise<void>;
};

const SCRYPT_KEYLEN = 64;

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `scrypt:${salt.toString("hex")}:${scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex")}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") {
    return false;
  }
  const salt = Buffer.from(parts[1]!, "hex");
  const expected = Buffer.from(parts[2]!, "hex");
  if (salt.length === 0 || expected.length === 0) {
    return false;
  }
  return timingSafeEqual(scryptSync(password, salt, expected.length), expected);
}

/** 新租户 id：u_ 前缀 + 24 位十六进制随机字符，满足 parseTenantId 的格式约束。 */
function freshTenantId(): string {
  return `u_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

export function memoryUsers(): UserDirectory {
  const rows = new Map<string, { tenantId: string; passwordHash: string }>();
  return {
    async register(email, password) {
      const key = normalize(email);
      if (rows.has(key)) {
        return { kind: "email-taken" };
      }
      const tenantId = freshTenantId();
      rows.set(key, { tenantId, passwordHash: hashPassword(password) });
      return { kind: "registered", tenantId };
    },
    async login(email, password) {
      const row = rows.get(normalize(email));
      return row !== undefined && verifyPassword(password, row.passwordHash)
        ? row.tenantId
        : undefined;
    },
    async close() {},
  };
}

/**
 * 注册用户表放在共享 Postgres schema 的 `crypto_users` 里：email 为主键，tenant_id 唯一。
 * 密码以 scrypt 加盐散列保存，原文从不落库。
 */
export async function postgresUsers(input: {
  connectionString: string;
  schema: string;
}): Promise<UserDirectory> {
  const schema = validateSchemaName(input.schema);
  const pool = new pg.Pool({ connectionString: input.connectionString, max: 2 });
  const table = `"${schema}".crypto_users`;
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${table} (
         email text PRIMARY KEY,
         tenant_id text NOT NULL UNIQUE,
         password_hash text NOT NULL,
         created_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
  } catch (error) {
    try {
      await pool.end();
    } catch (closeError) {
      throw new AggregateError([error, closeError], "User directory initialization failed.");
    }
    throw error;
  }
  return {
    async register(email, password) {
      const key = normalize(email);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const tenantId = freshTenantId();
        try {
          await pool.query(
            `INSERT INTO ${table} (email, tenant_id, password_hash) VALUES ($1, $2, $3)`,
            [key, tenantId, hashPassword(password)],
          );
          return { kind: "registered", tenantId };
        } catch (error) {
          const pgError = error as { code?: string; constraint?: string };
          if (pgError.code === "23505" && pgError.constraint === "crypto_users_pkey") {
            return { kind: "email-taken" };
          }
          if (pgError.code === "23505") {
            // tenant_id 撞上唯一键；换一个 id 重试
            continue;
          }
          throw error;
        }
      }
      throw new Error("Tenant id allocation failed.");
    },
    async login(email, password) {
      const result = await pool.query<{ tenant_id: string; password_hash: string }>(
        `SELECT tenant_id, password_hash FROM ${table} WHERE email = $1`,
        [normalize(email)],
      );
      const row = result.rows[0];
      return row !== undefined && verifyPassword(password, row.password_hash)
        ? row.tenant_id
        : undefined;
    },
    close: () => pool.end(),
  };
}
