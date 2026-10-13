import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export type LogLevel = "DEBUG" | "INFO" | "WARNING" | "ERROR";

const LEVELS: readonly LogLevel[] = ["DEBUG", "INFO", "WARNING", "ERROR"];

export type LogFields = Record<string, string | number | boolean | null>;

export type Logger = {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warning(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(name: string, fields?: LogFields): Logger;
  close(): Promise<void>;
};

export type LogConfig = {
  readonly level: LogLevel;
  readonly format: "auto" | "json" | "text";
  readonly dir: string;
  readonly consoleEnabled: boolean;
  readonly fileEnabled: boolean;
  readonly queueSize: number;
  readonly fileMaxBytes: number;
  readonly fileBackupCount: number;
};

function oneOf<T extends string>(
  env: NodeJS.ProcessEnv,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const hit = allowed.find((item) => item.toLowerCase() === raw.toLowerCase());
  if (hit === undefined) {
    throw new Error(`${name} must be one of ${allowed.join(", ")}.`);
  }
  return hit;
}

function booleanOf(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const lower = raw.toLowerCase();
  if (lower !== "true" && lower !== "false") {
    throw new Error(`${name} must be true or false.`);
  }
  return lower === "true";
}

function integerOf(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer of at least ${minimum}.`);
  }
  return value;
}

export function loadLogConfig(env: NodeJS.ProcessEnv): LogConfig {
  return {
    level: oneOf(env, "LOG_LEVEL", LEVELS, "INFO"),
    format: oneOf(env, "LOG_FORMAT", ["auto", "json", "text"] as const, "auto"),
    dir: env.LOG_DIR?.trim() || "./logs",
    consoleEnabled: booleanOf(env, "LOG_CONSOLE_ENABLED", true),
    fileEnabled: booleanOf(env, "LOG_FILE_ENABLED", true),
    queueSize: integerOf(env, "LOG_QUEUE_SIZE", 10_000, 1),
    fileMaxBytes: integerOf(env, "LOG_FILE_MAX_BYTES", 20_971_520, 1),
    fileBackupCount: integerOf(env, "LOG_FILE_BACKUP_COUNT", 14, 0),
  };
}

/** 控制台输出流；默认 process.stdout / process.stderr，测试里换成捕获用的对象。 */
export type LogOutputs = {
  out: { write(text: string): void };
  err: { write(text: string): void };
  /** auto 格式依据它选择文本或 JSON；默认看 process.stdout.isTTY。 */
  interactive?: boolean;
};

const RESERVED = new Set(["time", "level", "logger", "message"]);

type LogRecord = { time: string; level: LogLevel; logger: string; message: string } & LogFields;

export function openLogger(env: NodeJS.ProcessEnv, outputs?: LogOutputs): Logger {
  const config = loadLogConfig(env);
  const out = outputs?.out ?? process.stdout;
  const err = outputs?.err ?? process.stderr;
  const interactive = outputs?.interactive ?? process.stdout.isTTY === true;
  const jsonConsole = config.format === "json" || (config.format === "auto" && !interactive);
  const threshold = LEVELS.indexOf(config.level);

  // 文件一侧：记录先进内存队列，所有写入串行排在 chain 上，按大小轮转。
  const file = join(config.dir, "agent.log");
  let queue: string[] = [];
  let dropped = 0;
  let size = 0;
  let fileUsable = config.fileEnabled;
  let closed = false;
  let chain: Promise<void> = Promise.resolve();
  let closePromise: Promise<void> | undefined;

  function disableFile(error: unknown): void {
    fileUsable = false;
    queue = [];
    dropped = 0;
    const reason = error instanceof Error ? error.message : String(error);
    err.write(`[logger] file logging disabled: ${reason}\n`);
  }

  const opened = (async () => {
    try {
      await mkdir(config.dir, { recursive: true });
    } catch (error) {
      disableFile(error);
      return;
    }
    try {
      size = (await stat(file)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        disableFile(error);
      }
    }
  })();

  async function moveIfExists(from: string, to: string): Promise<void> {
    try {
      await rename(from, to);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  async function rotate(): Promise<void> {
    if (config.fileBackupCount === 0) {
      await rm(file, { force: true });
      size = 0;
      return;
    }
    await rm(`${file}.${config.fileBackupCount}`, { force: true });
    for (let index = config.fileBackupCount; index >= 2; index--) {
      await moveIfExists(`${file}.${index - 1}`, `${file}.${index}`);
    }
    await moveIfExists(file, `${file}.1`);
    size = 0;
  }

  async function runDrain(): Promise<void> {
    await opened;
    while (fileUsable && (queue.length > 0 || dropped > 0)) {
      const lines: string[] = [];
      if (dropped > 0) {
        lines.push(
          `${JSON.stringify({
            time: new Date().toISOString(),
            level: "WARNING",
            logger: "logger",
            message: "log records dropped",
            count: dropped,
          })}\n`,
        );
        dropped = 0;
      }
      lines.push(...queue);
      queue = [];
      for (const line of lines) {
        try {
          if (size + Buffer.byteLength(line) > config.fileMaxBytes) {
            await rotate();
          }
          await appendFile(file, line);
          size += Buffer.byteLength(line);
        } catch (error) {
          disableFile(error);
          return;
        }
      }
    }
  }

  function schedule(): void {
    if (closed || !fileUsable) {
      return;
    }
    chain = chain.then(runDrain);
  }

  function close(): Promise<void> {
    closePromise ??= (async () => {
      closed = true;
      await chain;
    })();
    return closePromise;
  }

  function writeConsole(record: LogRecord): void {
    let line: string;
    if (jsonConsole) {
      line = JSON.stringify(record);
    } else {
      const extra = Object.entries(record)
        .filter(([key]) => !RESERVED.has(key))
        .map(([key, value]) => ` ${key}=${JSON.stringify(value)}`)
        .join("");
      line = `${record.time} ${record.level.padEnd(7)} [${record.logger}] ${record.message}${extra}`;
    }
    const sink = record.level === "DEBUG" || record.level === "INFO" ? out : err;
    sink.write(`${line}\n`);
  }

  function merged(base: LogFields, extra: LogFields | undefined): LogFields {
    const fields = { ...base, ...extra };
    for (const key of Object.keys(fields)) {
      if (RESERVED.has(key)) {
        throw new Error(`Log field ${key} is reserved.`);
      }
    }
    return fields;
  }

  function emit(level: LogLevel, name: string, fields: LogFields, message: string): void {
    if (closed || LEVELS.indexOf(level) < threshold) {
      return;
    }
    const record: LogRecord = {
      time: new Date().toISOString(),
      level,
      logger: name,
      message,
      ...fields,
    };
    if (config.consoleEnabled) {
      writeConsole(record);
    }
    if (!fileUsable) {
      return;
    }
    if (queue.length >= config.queueSize) {
      dropped++;
      return;
    }
    queue.push(`${JSON.stringify(record)}\n`);
    schedule();
  }

  function makeLogger(name: string, base: LogFields): Logger {
    return {
      debug: (message, fields) => emit("DEBUG", name, merged(base, fields), message),
      info: (message, fields) => emit("INFO", name, merged(base, fields), message),
      warning: (message, fields) => emit("WARNING", name, merged(base, fields), message),
      error: (message, fields) => emit("ERROR", name, merged(base, fields), message),
      child: (childName, fields) => makeLogger(`${name}.${childName}`, merged(base, fields)),
      close,
    };
  }

  return makeLogger("agent", {});
}
