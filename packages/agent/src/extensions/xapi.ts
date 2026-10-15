import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  section,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";

/** xapi 动作网关；请求方式与 xapi-to CLI 自身使用的端点一致。 */
const ACTION_HOST = "https://action.xapi.to";

/** 单次调用结果的最大字符数；超出部分截断。 */
const MAX_RESULT_CHARS = 64 * 1024;

/** 单次请求的截止时间；会话取消信号与该截止时间共同生效。 */
const REQUEST_TIMEOUT_MS = 30_000;

function signalOf(context: Context): AbortSignal {
  return context.abortSignal ?? new AbortController().signal;
}

function truncate(text: string): string {
  return text.length > MAX_RESULT_CHARS
    ? `${text.slice(0, MAX_RESULT_CHARS)}\n... (truncated)`
    : text;
}

function textResult(text: string): ToolExecutionResult {
  return { content: [{ type: "text", text: truncate(text) }] };
}

function errorResult(message: string): ToolExecutionResult {
  return { content: [{ type: "text", text: truncate(message) }], isError: true };
}

async function requestXapi(
  apiKey: string,
  path: string,
  init: RequestInit,
  context: Context,
): Promise<ToolExecutionResult> {
  try {
    const response = await fetch(`${ACTION_HOST}${path}`, {
      ...init,
      headers: { "content-type": "application/json", "xapi-key": apiKey, ...init.headers },
      signal: AbortSignal.any([signalOf(context), AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    const body = await response.text();
    if (!response.ok) {
      return errorResult(`xapi HTTP ${response.status}: ${truncate(body)}`);
    }
    return textResult(truncate(body));
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}

const systemPrompt = [
  "xapi actions are reachable through xapi-get and xapi-call.",
  "Read an action's live schema with xapi-get immediately before calling it; never call from memory.",
  "Binance Web3 API actions are prefixed binance-web3-api. and their chain ids are Binance ids such as 1 (Ethereum), 56 (BSC) and CT_501 (Solana).",
  "Only GET actions are callable. The provider envelope reports code 0 on success; 40304 is a regional restriction and 40104 a permission gap, and neither is retried.",
  "The service allows 10 requests per second shared across all its endpoints.",
  "The project skill xapi documents the full catalog; read it with read-skill for details.",
].join(" ");

/**
 * xapi 扩展：把 xapi 动作目录暴露给模型。
 * XAPI_API_KEY 由 worker 持有并只发给 action.xapi.to，模型与代码执行 sandbox 都接触不到它。
 * 两个工具都只读（GET），重放安全。
 */
export function xapiExtension(input: { apiKey?: string }) {
  const apiKey = input.apiKey;

  const xapiGet = defineTool({
    name: "xapi-get",
    description:
      "Read the live schema of an xapi action by its id, for example binance-web3-api.api_v1_dex_market_token_search. Safe to run again.",
    parameters: Type.Object({ action: Type.String({ minLength: 1 }) }),
    replay: "safe",
    execute: (args, _api, context) => {
      if (apiKey === undefined) {
        return Promise.resolve(errorResult("XAPI_API_KEY is not configured."));
      }
      return requestXapi(
        apiKey,
        `/v1/actions/${encodeURIComponent(args.action)}`,
        { method: "GET" },
        context,
      );
    },
  });

  const xapiCall = defineTool({
    name: "xapi-call",
    description:
      "Execute a GET xapi action with query params and optional path params, returning the provider envelope. Safe to run again.",
    parameters: Type.Object({
      action: Type.String({ minLength: 1 }),
      params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      pathParams: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    replay: "safe",
    execute: (args, _api, context) => {
      if (apiKey === undefined) {
        return Promise.resolve(errorResult("XAPI_API_KEY is not configured."));
      }
      const actionInput: Record<string, unknown> = {};
      if (args.params !== undefined) {
        actionInput.params = args.params;
      }
      if (args.pathParams !== undefined) {
        actionInput.pathParams = args.pathParams;
      }
      return requestXapi(
        apiKey,
        "/v1/actions/execute",
        {
          method: "POST",
          body: JSON.stringify({ action_id: args.action, method: "GET", input: actionInput }),
        },
        context,
      );
    },
  });

  return defineExtension({
    name: "xapi",
    sections: [section("xapi", () => systemPrompt, { tag: false })],
    tools: [xapiGet, xapiCall],
    hooks: [],
  });
}
