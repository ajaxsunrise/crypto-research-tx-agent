import { HttpAgent, contentToText, type Interrupt, type Message } from "@ag-ui/client";
import type { SessionView } from "@crypto/domain/lease";
import { useEffect, useRef, useState, type FormEvent } from "react";

type ListedModel = {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
};

type Catalog = {
  readonly defaultModelId: string;
  readonly models: readonly ListedModel[];
};

type Choice = "grant" | "deny";

/** 两个可选的扩展类型：crypto 研究工具与代码执行工具。 */
const extensions = [
  { id: "crypto-research", name: "crypto 研究" },
  { id: "code-execution", name: "代码执行" },
] as const;

function extensionFor(tenantId: string): string {
  const stored = localStorage.getItem(`crypto-extension:${tenantId}`);
  return stored !== null && extensions.some((item) => item.id === stored)
    ? stored
    : extensions[0].id;
}

function restoredMessages(view: SessionView): Message[] {
  return view.transcript.map((item, index): Message => {
    const id = `m${index}`;
    switch (item.kind) {
      case "user":
      case "assistant":
        return { id, role: item.kind, content: item.text };
      case "tool-call":
        return {
          id,
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: item.callId,
              type: "function",
              function: { name: item.name, arguments: item.arguments },
            },
          ],
        };
      case "tool-result":
        return {
          id: `result:${item.callId}`,
          role: "tool",
          toolCallId: item.callId,
          content:
            item.result.kind === "ok"
              ? item.result.text
              : item.result.kind === "failed"
                ? item.result.message
                : item.result.kind,
        };
    }
  });
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(value));
}

function parseCatalog(value: unknown): Catalog {
  const record = recordOf(value);
  const models = record?.models;
  if (record === undefined || typeof record.defaultModelId !== "string" || !Array.isArray(models)) {
    throw new Error("模型目录缺少 defaultModelId 或 models。");
  }
  return {
    defaultModelId: record.defaultModelId,
    models: models.map((item) => {
      const row = recordOf(item);
      if (
        row === undefined ||
        typeof row.provider !== "string" ||
        typeof row.id !== "string" ||
        typeof row.name !== "string"
      ) {
        throw new Error("模型目录里有一条无法读取的模型。");
      }
      return { provider: row.provider, id: row.id, name: row.name };
    }),
  };
}

function modelId(model: ListedModel): string {
  return `${model.provider}/${model.id}`;
}

function messageText(message: Message): string {
  switch (message.role) {
    case "user":
    case "assistant":
    case "tool":
      return contentToText(message.content);
    default:
      return "";
  }
}

function toolCalls(message: Message): { name: string; arguments: string }[] {
  if (message.role !== "assistant") {
    return [];
  }
  return (message.toolCalls ?? []).map((call) => ({
    name: call.function.name,
    arguments: call.function.arguments,
  }));
}

function roleLabel(role: Message["role"]): string {
  switch (role) {
    case "user":
      return "你";
    case "assistant":
      return "助手";
    case "tool":
      return "工具";
    default:
      return role;
  }
}

export function App() {
  const agentRef = useRef<HttpAgent | null>(null);
  const sendingRef = useRef(false);
  const [catalog, setCatalog] = useState<Catalog | undefined>();
  const [catalogError, setCatalogError] = useState<string | undefined>();
  const [tenant, setTenant] = useState("local");
  const [token, setToken] = useState("");
  const [model, setModel] = useState("");
  const [extension, setExtension] = useState(() => extensionFor("local"));
  const [horizon, setHorizon] = useState("");
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [interrupts, setInterrupts] = useState<Interrupt[]>([]);
  const [runError, setRunError] = useState<string | undefined>();
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<SessionView["status"]["kind"]>("empty");

  function agent(): HttpAgent {
    if (agentRef.current === null) {
      throw new Error("The agent is not open yet.");
    }
    return agentRef.current;
  }

  function snapshot(current = agent()) {
    if (agentRef.current !== current) {
      return;
    }
    setMessages(current.messages.map((item) => structuredClone(item)));
    setInterrupts(current.pendingInterrupts.map((item) => structuredClone(item)));
  }

  function restore(current: HttpAgent, view: SessionView) {
    if (agentRef.current !== current) {
      return;
    }
    current.setMessages(restoredMessages(view));
    current.pendingInterrupts =
      view.status.kind === "awaiting-approval"
        ? [
            {
              id: view.status.operationId,
              reason: "approval",
              toolCallId: view.status.callId,
              message: "有一笔订单等待决定。",
            },
          ]
        : [];
    setStatus(view.status.kind);
    if (view.status.kind === "failed") {
      setRunError(view.status.message);
    }
    snapshot(current);
  }

  // threadId 按租户保存；token 只保存在当前页面内存。
  useEffect(() => {
    const key = `crypto-thread:${tenant}`;
    const threadId = localStorage.getItem(key) ?? crypto.randomUUID();
    localStorage.setItem(key, threadId);
    const headers = { "x-tenant-id": tenant, Authorization: `Bearer ${token}` };
    const current = new HttpAgent({ url: "/agent", threadId, headers });
    agentRef.current = current;
    setMessages([]);
    setInterrupts([]);
    setStatus("empty");
    const controller = new AbortController();
    let reading = false;
    const reload = async () => {
      if (token === "" || current.isRunning || reading) {
        return;
      }
      reading = true;
      try {
        const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}`, {
          headers,
          signal: controller.signal,
        });
        if (response.status === 404) {
          return;
        }
        if (!response.ok) {
          throw new Error(`会话读取失败，状态 ${response.status}。`);
        }
        restore(current, (await response.json()) as SessionView);
      } catch (error) {
        if (!controller.signal.aborted && agentRef.current === current) {
          setRunError(error instanceof Error ? error.message : "会话读取失败。");
        }
      } finally {
        reading = false;
      }
    };
    void reload();
    const polling = setInterval(() => void reload(), 1500);
    const subscription = current.subscribe({
      onEvent() {
        snapshot(current);
      },
      onRunErrorEvent(params) {
        setRunError(params.event.message);
      },
    });
    return () => {
      controller.abort();
      clearInterval(polling);
      subscription.unsubscribe();
      current.abortRun();
    };
  }, [tenant, token]);

  useEffect(() => {
    let cancelled = false;
    if (token === "") {
      setCatalog(undefined);
      return;
    }
    setCatalogError(undefined);
    fetch("/api/models", { headers: { Authorization: `Bearer ${token}`, "x-tenant-id": tenant } })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`模型目录请求失败，状态 ${response.status}。`);
        }
        const body: unknown = await response.json();
        const parsed = parseCatalog(body);
        if (!cancelled) {
          setCatalog(parsed);
          setModel(parsed.defaultModelId);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setCatalogError(error instanceof Error ? error.message : "模型目录请求失败。");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [tenant, token]);

  const waiting = interrupts[0];
  const choices =
    catalog === undefined
      ? []
      : catalog.models.map((item) => ({ id: modelId(item), name: item.name }));
  if (model !== "" && !choices.some((item) => item.id === model)) {
    choices.unshift({ id: model, name: model });
  }

  function changeTenant(value: string) {
    setTenant(value);
    setExtension(extensionFor(value));
    setMessages([]);
    setInterrupts([]);
    setRunError(undefined);
  }

  function changeExtension(value: string) {
    setExtension(value);
    localStorage.setItem(`crypto-extension:${tenant}`, value);
  }

  async function run(input: { question?: string; decision?: Choice }) {
    if (sendingRef.current || model === "" || tenant.trim() === "" || token === "") {
      return;
    }
    sendingRef.current = true;
    setSending(true);
    setRunError(undefined);
    const current = agent();
    if (input.question !== undefined) {
      current.addMessage({ id: crypto.randomUUID(), role: "user", content: input.question });
      setQuestion("");
      snapshot();
    }
    try {
      await current.runAgent({
        runId: crypto.randomUUID(),
        forwardedProps: {
          model,
          extension,
          ...(horizon.trim() === "" ? {} : { horizon: horizon.trim() }),
        },
        ...(input.decision === undefined || waiting === undefined
          ? {}
          : {
              resume: [
                {
                  interruptId: waiting.id,
                  status: "resolved" as const,
                  payload: { decision: input.decision },
                },
              ],
            }),
      });
      snapshot();
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "这次运行失败。");
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = question.trim();
    if (text === "" || waiting !== undefined) {
      return;
    }
    void run({ question: text });
  }

  async function control(action: "resume" | "cancel") {
    const current = agent();
    setRunError(undefined);
    if (action === "resume") {
      setSending(true);
    }
    try {
      const response = await fetch(
        `/api/threads/${encodeURIComponent(current.threadId)}/${action}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "x-tenant-id": tenant },
        },
      );
      if (!response.ok) {
        throw new Error(`会话操作失败，状态 ${response.status}。`);
      }
      if (action === "cancel") {
        current.abortRun();
      }
      restore(current, (await response.json()) as SessionView);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "会话操作失败。");
    } finally {
      if (action === "resume") {
        setSending(false);
      }
    }
  }

  return (
    <main className="page">
      <header className="mast">
        <p className="eyebrow">Agent</p>
        <h1>会话</h1>
      </header>
      <section className="composer">
        <form onSubmit={onSubmit}>
          <label>
            租户
            <input
              value={tenant}
              disabled={sending || waiting !== undefined}
              onChange={(event) => changeTenant(event.target.value)}
            />
          </label>
          <label>
            访问 token
            <input
              type="password"
              autoComplete="off"
              value={token}
              disabled={sending}
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
          <label>
            模型
            <select
              value={model}
              disabled={catalog === undefined || sending}
              onChange={(event) => setModel(event.target.value)}
            >
              {choices.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            扩展
            <select
              value={extension}
              disabled={sending || waiting !== undefined}
              onChange={(event) => changeExtension(event.target.value)}
            >
              {extensions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Horizon（可选）
            <input
              value={horizon}
              disabled={sending || waiting !== undefined}
              onChange={(event) => setHorizon(event.target.value)}
            />
          </label>
          <label>
            问题
            <textarea
              value={question}
              rows={5}
              disabled={sending || waiting !== undefined}
              onChange={(event) => setQuestion(event.target.value)}
            />
          </label>
          <button
            type="submit"
            disabled={
              sending ||
              status === "running" ||
              status === "needs-resume" ||
              waiting !== undefined ||
              model === "" ||
              token === "" ||
              question.trim() === ""
            }
          >
            发送
          </button>
        </form>
        {catalogError !== undefined ? <p className="error">{catalogError}</p> : null}
        {runError !== undefined ? <p className="error">{runError}</p> : null}
        {status === "needs-resume" ? (
          <button type="button" disabled={sending} onClick={() => void control("resume")}>
            恢复任务
          </button>
        ) : null}
        {sending || status === "running" || status === "needs-resume" || waiting !== undefined ? (
          <button type="button" className="quiet" onClick={() => void control("cancel")}>
            取消运行
          </button>
        ) : null}
        {waiting !== undefined ? (
          <div className="approval">
            <p>{waiting.message ?? "有一笔订单等待决定。"}</p>
            <div className="actions">
              <button
                type="button"
                disabled={sending}
                onClick={() => void run({ decision: "grant" })}
              >
                批准并发送
              </button>
              <button
                type="button"
                className="quiet"
                disabled={sending}
                onClick={() => void run({ decision: "deny" })}
              >
                拒绝
              </button>
            </div>
          </div>
        ) : null}
      </section>
      <section className="transcript" aria-live="polite">
        {messages.length === 0 ? <p className="empty">会话还是空的。</p> : null}
        {messages.map((message) => {
          const text = messageText(message);
          const calls = toolCalls(message);
          if (text === "" && calls.length === 0) {
            return null;
          }
          return (
            <article key={message.id} className={`entry ${message.role}`}>
              <h2>{roleLabel(message.role)}</h2>
              {text === "" ? null : <p>{text}</p>}
              {calls.map((call) => (
                <p className="call" key={`${message.id}:${call.name}:${call.arguments}`}>
                  {call.name} {call.arguments}
                </p>
              ))}
            </article>
          );
        })}
        {sending ? <p className="pending">正在运行。</p> : null}
      </section>
    </main>
  );
}
