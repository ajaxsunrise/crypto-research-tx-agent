/** 一次已建立的身份：注册或登录得到的 JWT，或直接输入的访问令牌。 */
export type Session = {
  readonly token: string;
  readonly tenantId: string;
  readonly email?: string;
};

export const sessionKey = "crypto-session";

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(value));
}

function parseSession(value: unknown): Session | undefined {
  const record = recordOf(value);
  if (
    record === undefined ||
    typeof record.token !== "string" ||
    record.token === "" ||
    typeof record.tenantId !== "string" ||
    record.tenantId === "" ||
    !(record.email === undefined || typeof record.email === "string")
  ) {
    return undefined;
  }
  return {
    token: record.token,
    tenantId: record.tenantId,
    ...(record.email === undefined ? {} : { email: record.email }),
  };
}

export function loadSession(): Session | undefined {
  const raw = localStorage.getItem(sessionKey);
  if (raw === null) {
    return undefined;
  }
  try {
    return parseSession(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/** 服务端错误响应统一是 { message }；读不出来时退回状态码。 */
export async function errorMessageOf(response: Response): Promise<string> {
  try {
    const record = recordOf(await response.json());
    if (record !== undefined && typeof record.message === "string") {
      return record.message;
    }
  } catch {
    // 响应体不是 JSON 时退回状态码
  }
  return `请求失败，状态 ${response.status}。`;
}
