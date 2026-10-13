import { mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

import { brand, type ComputeLease, type LeaseResult, type Timestamp } from "@crypto/domain/lease";

/** 单次代码执行结果的最大字节数；超出部分截断。 */
const MAX_OUTPUT_BYTES = 64 * 1024;

const INTERPRETERS: Record<string, readonly string[]> = {
  bash: ["/bin/bash", "-c"],
  sh: ["/bin/sh", "-c"],
  python: ["python3", "-c"],
  python3: ["python3", "-c"],
  node: ["node", "--input-type=module", "-e"],
  javascript: ["node", "--input-type=module", "-e"],
};

/**
 * 代码执行 sandbox gateway：每个 workspace 对应一个独立工作目录，
 * bash/Python 在其中以受限子进程运行，不共享 agent 的凭证和环境。
 *
 * 安全说明：这是开发环境实现，直接在主机上执行代码。
 * 生产部署应将此部分替换为容器隔离（Docker / gVisor 等）。
 */
export function createCodeSandbox(
  root?: string,
  now: () => Timestamp = () => brand(Date.now(), "Timestamp"),
): (lease: ComputeLease, signal: AbortSignal) => Promise<LeaseResult> {
  function workspaceDir(workspace: string): string {
    const dir = root !== undefined ? join(root, workspace) : undefined;
    if (dir !== undefined) {
      mkdirSync(dir, { recursive: true });
    }
    return dir ?? "/tmp";
  }

  return async function execute(lease, signal): Promise<LeaseResult> {
    if (!Number.isFinite(lease.deadlineAt)) {
      throw new Error("Lease deadline must be finite.");
    }
    if (signal.aborted) {
      return { kind: "cancelled" };
    }
    if (lease.deadlineAt <= now()) {
      return { kind: "timed-out" };
    }

    const { language, code } = lease.task;
    const interpreterArgs = INTERPRETERS[language.toLowerCase()];
    if (interpreterArgs === undefined) {
      return {
        kind: "failed",
        message: `Unsupported language: ${language}. Supported: ${Object.keys(INTERPRETERS).join(", ")}.`,
      };
    }

    const cwd = workspaceDir(lease.workspace);
    const timeoutMs = Math.max(0, Math.ceil(lease.deadlineAt - now()));

    return new Promise<LeaseResult>((resolve) => {
      const [cmd, ...args] = interpreterArgs as [string, ...string[]];
      const proc = spawn(cmd, [...args, code], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        // 模型凭证不进入 sandbox：使用最小化环境，不传递 process.env
        env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
        timeout: timeoutMs,
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;

      proc.stdout.on("data", (chunk: Buffer) => {
        const remaining = MAX_OUTPUT_BYTES - stdoutBytes;
        if (remaining > 0) {
          stdoutChunks.push(chunk.subarray(0, remaining));
          stdoutBytes += Math.min(chunk.length, remaining);
        }
      });
      proc.stderr.on("data", (chunk: Buffer) => {
        const remaining = MAX_OUTPUT_BYTES - stderrBytes;
        if (remaining > 0) {
          stderrChunks.push(chunk.subarray(0, remaining));
          stderrBytes += Math.min(chunk.length, remaining);
        }
      });

      const onAbort = () => proc.kill("SIGKILL");
      signal.addEventListener("abort", onAbort, { once: true });

      proc.on("close", (code, procSignal) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) {
          resolve({ kind: "cancelled" });
          return;
        }
        const stdout = Buffer.concat(stdoutChunks).toString("utf8").trimEnd();
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trimEnd();
        if (procSignal === "SIGKILL" || (code === null && procSignal !== null)) {
          resolve({ kind: "timed-out" });
          return;
        }
        if (code !== 0) {
          const message = stderr.length > 0 ? stderr : `Process exited with code ${code}.`;
          resolve({ kind: "failed", message });
          return;
        }
        resolve({ kind: "ok", text: stdout });
      });

      proc.on("error", (err) => {
        signal.removeEventListener("abort", onAbort);
        resolve({ kind: "failed", message: err.message });
      });
    });
  };
}
