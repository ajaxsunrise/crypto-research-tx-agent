import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { brand, type ComputeLease, type LeaseResult, type Timestamp } from "@crypto/domain/lease";

/** 单次代码执行结果的最大字节数；超出部分截断。 */
const MAX_OUTPUT_BYTES = 64 * 1024;

/** docker 模式下容器内的工作目录，主机工作目录挂载到这里。 */
const CONTAINER_WORKDIR = "/workspace";

const INTERPRETERS: Record<string, readonly string[]> = {
  bash: ["/bin/bash", "-c"],
  sh: ["/bin/sh", "-c"],
  python: ["python3", "-c"],
  python3: ["python3", "-c"],
  node: ["node", "--input-type=module", "-e"],
  javascript: ["node", "--input-type=module", "-e"],
};

export type CodeSandboxMode =
  | { kind: "host" }
  | {
      kind: "docker";
      /** 运行代码的镜像；需预先 docker pull，自带 bash、python3 与 node。 */
      image: string;
      /** 容器内存上限；默认 512m。 */
      memory?: string;
      /** 容器可用 CPU 核数上限；默认 1。 */
      cpus?: string;
    };

/** 一次执行的具体进程参数；两种模式共用输出收集与结果判定。 */
type ExecutionPlan = {
  command: string;
  args: string[];
  cwd: string | undefined;
  env: Record<string, string>;
  /** docker 客户端被终止后补一次 docker kill，防止容器继续运行。 */
  stopContainer: (() => void) | undefined;
};

function hostEnv(): Record<string, string> {
  // 模型凭证不进入 sandbox：使用最小化环境，不传递 process.env
  return { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" };
}

/** docker CLI 需要的少量主机变量：找到 docker、连上正确的 daemon，其余一概不传。 */
function dockerCliEnv(): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  };
  for (const name of ["HOME", "DOCKER_HOST", "DOCKER_CONTEXT"] as const) {
    const value = process.env[name];
    if (value !== undefined && value !== "") {
      env[name] = value;
    }
  }
  return env;
}

function killContainer(name: string): void {
  // 容器已退出并因 --rm 清理时这里会失败；那是正常情况，忽略即可。
  const killer = spawn("docker", ["kill", name], { stdio: "ignore" });
  killer.on("error", () => undefined);
}

/**
 * 代码执行 sandbox gateway。host 模式直接在主机子进程中运行（dev / local）；
 * docker 模式把会话工作目录挂载进一次性容器执行（生产）：容器无网络、无凭证，
 * 施加内存与 CPU 配额并丢弃全部 capability。模型凭证不进入任何一种执行环境。
 */
export function createCodeSandbox(input: {
  root?: string;
  mode?: CodeSandboxMode;
  now?: () => Timestamp;
}): (lease: ComputeLease, signal: AbortSignal) => Promise<LeaseResult> {
  const mode = input.mode ?? { kind: "host" };
  const now = input.now ?? (() => brand(Date.now(), "Timestamp"));
  if (mode.kind === "docker" && input.root === undefined) {
    throw new Error("Docker mode needs a workspace root.");
  }

  function workspaceDir(workspace: string): string | undefined {
    if (input.root === undefined) {
      return undefined;
    }
    // docker 的 -v 挂载要求绝对路径
    const dir =
      mode.kind === "docker" ? resolve(input.root, workspace) : join(input.root, workspace);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function plan(language: string, code: string, cwd: string | undefined): ExecutionPlan {
    const [entrypoint, ...rest] = INTERPRETERS[language] as [string, ...string[]];
    if (mode.kind === "host") {
      return {
        command: entrypoint,
        args: [...rest, code],
        cwd,
        env: hostEnv(),
        stopContainer: undefined,
      };
    }
    if (cwd === undefined) {
      throw new Error("Docker mode needs a workspace root.");
    }
    const container = `crypto-sandbox-${randomUUID()}`;
    return {
      command: "docker",
      args: [
        "run",
        "--rm",
        "--name",
        container,
        "--network",
        "none",
        "--memory",
        mode.memory ?? "512m",
        "--cpus",
        mode.cpus ?? "1",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--label",
        "crypto.sandbox=true",
        "-v",
        `${cwd}:${CONTAINER_WORKDIR}`,
        "-w",
        CONTAINER_WORKDIR,
        mode.image,
        entrypoint,
        ...rest,
        code,
      ],
      cwd: undefined,
      env: dockerCliEnv(),
      stopContainer: () => killContainer(container),
    };
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
    const execution = plan(language.toLowerCase(), code, cwd);
    const timeoutMs = Math.max(0, Math.ceil(lease.deadlineAt - now()));

    return new Promise<LeaseResult>((resolve) => {
      const proc = spawn(execution.command, execution.args, {
        cwd: execution.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: execution.env,
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

      const onAbort = () => {
        proc.kill("SIGKILL");
        // 只杀 docker 客户端容器仍会运行，必须显式 kill 容器
        execution.stopContainer?.();
      };
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
          // 超时由 spawn 的 timeout 发出 SIGKILL；docker 模式下客户端死了容器还活着
          execution.stopContainer?.();
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
