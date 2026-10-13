import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { hashContent } from "@crypto/domain/internal";
import { brand, type LeaseExecutor, type Timestamp } from "@crypto/domain/lease";

type StoredText = {
  hash: string;
  text: string;
};

type WorkspaceFiles = Map<string, StoredText>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readWorkspace(path: string): WorkspaceFiles {
  const files: WorkspaceFiles = new Map();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(raw)) {
      throw new Error(`Sandbox file ${path} is not a workspace.`);
    }
    for (const [name, value] of Object.entries(raw)) {
      if (!isRecord(value) || typeof value.hash !== "string" || typeof value.text !== "string") {
        throw new Error(`Sandbox file ${path} has a bad note.`);
      }
      if (value.hash !== hashContent(value.text)) {
        throw new Error(`Sandbox file ${path} has an invalid content hash.`);
      }
      files.set(name, { hash: value.hash, text: value.text });
    }
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return files;
    }
    throw error;
  }
  return files;
}

function writeWorkspace(path: string, files: WorkspaceFiles): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = Object.fromEntries(files);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(body));
  renameSync(temporary, path);
}

/**
 * One sandbox per worker: the worker passes `sandboxRoot` as `root`, and a lease names only a
 * workspace inside it, so no lease can reach another session's files. Workspace refs are minted by
 * the agent, never by the model.
 */
export function createSandbox(
  root?: string,
  now: () => Timestamp = () => brand(Date.now(), "Timestamp"),
): LeaseExecutor {
  const memory = new Map<string, WorkspaceFiles>();

  function workspaceFiles(workspace: string): WorkspaceFiles {
    const existing = memory.get(workspace);
    if (existing) {
      return existing;
    }
    const created = root === undefined ? new Map() : readWorkspace(join(root, `${workspace}.json`));
    memory.set(workspace, created);
    return created;
  }

  return async function execute(lease, signal) {
    if (!Number.isFinite(lease.deadlineAt)) {
      throw new Error("Lease deadline must be finite.");
    }
    if (signal.aborted) {
      return { kind: "cancelled" };
    }
    if (lease.deadlineAt <= now()) {
      return { kind: "timed-out" };
    }
    if (lease.kind === "external") {
      if (lease.effect.approval.operationId !== lease.task.operationId) {
        return { kind: "failed", message: "The approval does not cover this order." };
      }
      return { kind: "failed", message: "Order execution is not configured." };
    }
    if (lease.task.kind === "read") {
      return { kind: "failed", message: "Market data access is not configured." };
    }
    if (lease.effect.kind !== "idempotent-write") {
      return { kind: "failed", message: "Write lease is missing its content hash." };
    }
    const contentHash = hashContent(lease.task.content);
    if (lease.task.contentHash !== contentHash || lease.effect.contentHash !== contentHash) {
      throw new Error("Write lease content hash does not match its content.");
    }
    const stored = workspaceFiles(lease.workspace);
    const current = stored.get(lease.task.path);
    if (current && current.hash === lease.effect.contentHash) {
      return { kind: "ok", text: current.text };
    }
    const text = lease.task.content;
    const updated = new Map(stored);
    updated.set(lease.task.path, { hash: contentHash, text });
    if (root !== undefined) {
      writeWorkspace(join(root, `${lease.workspace}.json`), updated);
    }
    memory.set(lease.workspace, updated);
    return { kind: "ok", text };
  };
}
