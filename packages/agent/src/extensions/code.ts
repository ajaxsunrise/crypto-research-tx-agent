import { computeIntent } from "@crypto/domain/internal";
import {
  leaseCompute,
  type ComputeLease,
  type LeaseResult,
  type Timestamp,
} from "@crypto/domain/lease";
import { createCodeSandbox } from "@crypto/sandbox/code";
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  section,
  type ConversationId,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";

import { workspaceFor } from "../research.js";

type CodeExecutor = (lease: ComputeLease, signal: AbortSignal) => Promise<LeaseResult>;

function signalOf(context: Context): AbortSignal {
  return context.abortSignal ?? new AbortController().signal;
}

function textResult(result: LeaseResult): ToolExecutionResult {
  switch (result.kind) {
    case "ok":
      return { content: [{ type: "text", text: result.text || "(no output)" }] };
    case "failed":
      return { content: [{ type: "text", text: result.message }], isError: true };
    case "timed-out":
      return { content: [{ type: "text", text: "Timed out." }], isError: true };
    case "cancelled":
      return { content: [{ type: "text", text: "Cancelled." }], isError: true };
  }
}

async function runCompute(
  executor: CodeExecutor,
  now: () => Timestamp,
  conversationId: ConversationId,
  language: string,
  toolName: string,
  code: string,
  context: Context,
): Promise<ToolExecutionResult> {
  const intent = computeIntent(language, code, toolName);
  const lease = leaseCompute({
    workspace: workspaceFor(conversationId),
    intent,
    now: now(),
  });
  return textResult(await executor(lease, signalOf(context)));
}

const systemPrompt = [
  "You are a general-purpose agent that can execute code.",
  "Use run-bash to run shell commands and run-python to run Python scripts.",
  "Each tool call runs in an isolated workspace directory.",
  "Output is captured from stdout; errors come from stderr.",
].join(" ");

/**
 * 代码执行扩展：在隔离子进程中运行 bash 命令和 Python 脚本。
 * 模型凭证不进入 sandbox；每次执行在会话专属工作目录中运行。
 *
 * rootDir 是所有工作目录的父目录。不传时在系统临时目录执行（无持久化）。
 */
export function codeExtension(input: { rootDir?: string; now: () => Timestamp }) {
  const executor = createCodeSandbox(input.rootDir, input.now);
  const now = input.now;

  const runBash = defineTool({
    name: "run-bash",
    description: "Run a bash command. Returns stdout. Safe to replay.",
    parameters: Type.Object({
      command: Type.String({ minLength: 1, description: "The bash command to execute." }),
    }),
    replay: "safe",
    execute: (args, api, context) =>
      runCompute(executor, now, api.conversationId, "bash", "run-bash", args.command, context),
  });

  const runPython = defineTool({
    name: "run-python",
    description: "Run a Python script. Returns stdout. Safe to replay.",
    parameters: Type.Object({
      code: Type.String({ minLength: 1, description: "The Python code to execute." }),
    }),
    replay: "safe",
    execute: (args, api, context) =>
      runCompute(executor, now, api.conversationId, "python3", "run-python", args.code, context),
  });

  return defineExtension({
    name: "code-execution",
    sections: [section("preamble", () => systemPrompt, { tag: false })],
    tools: [runBash, runPython],
    hooks: [],
  });
}
