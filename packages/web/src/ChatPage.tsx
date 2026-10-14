import { HttpAgent, contentToText, type Interrupt, type Message } from "@ag-ui/client";
import { AppShell } from "@astryxdesign/core/AppShell";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import {
  ChatComposer,
  ChatComposerInput,
  ChatLayout,
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
} from "@astryxdesign/core/Chat";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Divider } from "@astryxdesign/core/Divider";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { Layout, LayoutContent, LayoutHeader } from "@astryxdesign/core/Layout";
import { Markdown } from "@astryxdesign/core/Markdown";
import { Popover } from "@astryxdesign/core/Popover";
import { Selector } from "@astryxdesign/core/Selector";
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { Stack } from "@astryxdesign/core/Stack";
import { StatusDot, type StatusDotVariant } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import type { SessionView } from "@crypto/domain/lease";
import {
  ArrowRightOnRectangleIcon,
  ArrowUpIcon,
  ChartBarIcon,
  PlusIcon,
  AdjustmentsHorizontalIcon,
  StopIcon,
  UserCircleIcon,
} from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";

import type { Session } from "./session.js";
import { styles } from "./styles.js";

type ListedModel = {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
};

type Catalog = {
  readonly defaultModelId: string;
  readonly models: readonly ListedModel[];
};

/** GET /api/threads 返回的一个线程摘要。 */
type ListedThread = {
  readonly threadId: string;
  readonly preview: string;
  readonly status: SessionView["status"]["kind"];
};

const threadStatuses: readonly SessionView["status"]["kind"][] = [
  "empty",
  "running",
  "awaiting-approval",
  "needs-resume",
  "completed",
  "cancelled",
  "failed",
];

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

function parseThreadList(value: unknown): ListedThread[] {
  const record = recordOf(value);
  if (record === undefined || !Array.isArray(record.threads)) {
    throw new Error("会话列表格式无法读取。");
  }
  return record.threads.flatMap((item): ListedThread[] => {
    const row = recordOf(item);
    if (
      row === undefined ||
      typeof row.threadId !== "string" ||
      typeof row.preview !== "string" ||
      typeof row.status !== "string" ||
      !threadStatuses.includes(row.status as ListedThread["status"])
    ) {
      return [];
    }
    return [
      {
        threadId: row.threadId,
        preview: row.preview,
        status: row.status as ListedThread["status"],
      },
    ];
  });
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
      return "用户";
    case "assistant":
      return "研究助手";
    case "tool":
      return "工具";
    default:
      return role;
  }
}

function statusLabel(status: ListedThread["status"]): string {
  switch (status) {
    case "empty":
      return "空闲";
    case "running":
      return "运行中";
    case "awaiting-approval":
      return "等待审批";
    case "needs-resume":
      return "待恢复";
    case "completed":
      return "已完成";
    case "cancelled":
      return "已取消";
    case "failed":
      return "已失败";
  }
}

function statusVariant(status: ListedThread["status"]): StatusDotVariant {
  switch (status) {
    case "running":
      return "accent";
    case "awaiting-approval":
    case "needs-resume":
      return "warning";
    case "completed":
      return "success";
    case "failed":
      return "error";
    default:
      return "neutral";
  }
}

export function ChatPage({
  session,
  onLogout,
}: {
  session: Session;
  onLogout: (message?: string) => void;
}) {
  const agentRef = useRef<HttpAgent | null>(null);
  const sendingRef = useRef(false);
  const [catalog, setCatalog] = useState<Catalog | undefined>();
  const [catalogError, setCatalogError] = useState<string | undefined>();
  const tenant = session.tenantId;
  const token = session.token;
  const [model, setModel] = useState("");
  const [extension, setExtension] = useState(() => extensionFor(session.tenantId));
  const [horizon, setHorizon] = useState("");
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [interrupts, setInterrupts] = useState<Interrupt[]>([]);
  const [runError, setRunError] = useState<string | undefined>();
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<SessionView["status"]["kind"]>("empty");
  const statusRef = useRef<SessionView["status"]["kind"]>("empty");

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
    statusRef.current = view.status.kind;
    setStatus(view.status.kind);
    if (view.status.kind === "failed") {
      setRunError(view.status.message);
    }
    snapshot(current);
  }

  // threadId 按租户保存；登录会话保存在 localStorage，刷新页面后仍在。
  const [activeThread, setActiveThread] = useState<string | undefined>(undefined);
  useEffect(() => {
    const stored = localStorage.getItem(`crypto-thread:${tenant}`);
    setActiveThread(stored ?? crypto.randomUUID());
  }, [tenant]);

  useEffect(() => {
    if (activeThread === undefined) {
      return;
    }
    const threadId = activeThread;
    localStorage.setItem(`crypto-thread:${tenant}`, threadId);
    const headers = { "x-tenant-id": tenant, Authorization: `Bearer ${token}` };
    const current = new HttpAgent({ url: "/agent", threadId, headers });
    agentRef.current = current;
    setMessages([]);
    setInterrupts([]);
    setRunError(undefined);
    statusRef.current = "empty";
    setStatus("empty");
    const controller = new AbortController();
    let reading = false;
    const reload = async () => {
      if (controller.signal.aborted || current.isRunning || reading) {
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
        if (response.status === 401) {
          onLogout("登录状态已失效，请重新登录。");
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
    const polling = setInterval(() => {
      if (statusRef.current === "running") {
        void reload();
      }
    }, 1500);
    const subscription = current.subscribe({
      onEvent() {
        snapshot(current);
      },
      onRunStartedEvent() {
        statusRef.current = "running";
        setStatus("running");
      },
      onRunErrorEvent(params) {
        setRunError(params.event.message);
      },
      onRunFinalized() {
        void reload();
      },
    });
    return () => {
      controller.abort();
      clearInterval(polling);
      subscription.unsubscribe();
      current.abortRun();
    };
  }, [tenant, activeThread]);

  // 会话列表：进入页面或一次运行结束后重新拉取。
  const [threads, setThreads] = useState<ListedThread[]>([]);
  const [threadsTick, setThreadsTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/threads", { headers: { Authorization: `Bearer ${token}`, "x-tenant-id": tenant } })
      .then(async (response) => {
        if (response.status === 401) {
          onLogout("登录状态已失效，请重新登录。");
          return;
        }
        if (!response.ok) {
          throw new Error(`会话列表请求失败，状态 ${response.status}。`);
        }
        const parsed = parseThreadList(await response.json());
        if (!cancelled) {
          setThreads(parsed);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setThreads([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [tenant, token, threadsTick]);

  useEffect(() => {
    let cancelled = false;
    setCatalogError(undefined);
    fetch("/api/models", { headers: { Authorization: `Bearer ${token}`, "x-tenant-id": tenant } })
      .then(async (response) => {
        if (response.status === 401) {
          onLogout("登录状态已失效，请重新登录。");
          return;
        }
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

  function changeExtension(value: string) {
    setExtension(value);
    localStorage.setItem(`crypto-extension:${tenant}`, value);
  }

  /** 恢复或取消后列表里的状态会变化，重新拉取一次。 */
  function afterControl() {
    setThreadsTick((tick) => tick + 1);
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
      setThreadsTick((tick) => tick + 1);
    }
  }

  const isRunning = sending || status === "running";
  const composerDisabled =
    isRunning || status === "needs-resume" || waiting !== undefined || model === "" || token === "";

  function onSubmit(value: string) {
    const text = value.trim();
    if (text === "" || composerDisabled) {
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
      if (response.status === 401) {
        onLogout("登录状态已失效，请重新登录。");
        return;
      }
      if (!response.ok) {
        throw new Error(`会话操作失败，状态 ${response.status}。`);
      }
      if (action === "cancel") {
        current.abortRun();
      }
      restore(current, (await response.json()) as SessionView);
      afterControl();
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "会话操作失败。");
    } finally {
      if (action === "resume") {
        setSending(false);
      }
    }
  }

  function switchThread(threadId: string) {
    if (threadId === activeThread) {
      return;
    }
    localStorage.setItem(`crypto-thread:${tenant}`, threadId);
    setActiveThread(threadId);
  }

  function newThread() {
    const threadId = crypto.randomUUID();
    localStorage.setItem(`crypto-thread:${tenant}`, threadId);
    setActiveThread(threadId);
  }

  const composer = (
    <Stack gap={3} align="stretch">
      {catalogError !== undefined ? (
        <Banner role="alert" status="error" title="模型加载失败" description={catalogError} />
      ) : null}
      {runError !== undefined ? (
        <Banner role="alert" status="error" title="研究遇到问题" description={runError} />
      ) : null}
      {status === "needs-resume" ? (
        <Banner
          role="status"
          status="warning"
          title="研究等待恢复"
          description="恢复任务后可以继续查看研究结果。"
          endContent={
            <Stack direction="horizontal" gap={2} wrap="wrap">
              <Button
                label="恢复任务"
                variant="primary"
                isDisabled={sending}
                onClick={() => void control("resume")}
              />
              <Button label="取消运行" variant="secondary" onClick={() => void control("cancel")} />
            </Stack>
          }
        />
      ) : null}
      {waiting !== undefined ? (
        <Banner
          role="status"
          status="warning"
          title="订单等待审批"
          description={waiting.message ?? "有一笔订单等待决定。"}
          endContent={
            <Stack direction="horizontal" gap={2} wrap="wrap">
              <Button
                label="批准并发送"
                variant="primary"
                isDisabled={sending}
                onClick={() => void run({ decision: "grant" })}
              />
              <Button
                label="拒绝"
                variant="secondary"
                isDisabled={sending}
                onClick={() => void run({ decision: "deny" })}
              />
              <Button label="取消运行" variant="ghost" onClick={() => void control("cancel")} />
            </Stack>
          }
        />
      ) : null}
      <ChatComposer
        elevation="none"
        value={question}
        onChange={setQuestion}
        onSubmit={onSubmit}
        isDisabled={composerDisabled}
        isStopShown={isRunning}
        onStop={() => void control("cancel")}
        xstyle={styles.composer}
        input={
          <ChatComposerInput
            label="研究问题"
            placeholder="提问、分析，探索你的下一个想法…"
            pasteAsToken={false}
            xstyle={styles.composerInput}
          />
        }
        footerActions={
          <Selector
            label="模型"
            isLabelHidden
            variant="ghost"
            size="sm"
            presentation="adaptive"
            placeholder="加载模型…"
            isLoading={catalog === undefined && catalogError === undefined}
            options={choices.map((item) => ({ value: item.id, label: item.name }))}
            value={model}
            onChange={setModel}
            isDisabled={catalog === undefined || sending}
            containerXstyle={styles.modelSelector}
          />
        }
        sendActions={
          <Popover
            label="研究设置"
            closeButtonLabel="关闭研究设置"
            placement="above"
            alignment="end"
            width="20rem"
            padding={4}
            content={
              <Stack gap={4}>
                <Heading level={2}>研究设置</Heading>
                <Selector
                  label="扩展"
                  options={extensions.map((item) => ({ value: item.id, label: item.name }))}
                  value={extension}
                  onChange={changeExtension}
                  isDisabled={sending || waiting !== undefined}
                />
                <TextInput
                  label="Horizon（可选）"
                  value={horizon}
                  isDisabled={sending || waiting !== undefined}
                  onChange={setHorizon}
                />
              </Stack>
            }
          >
            <Button
              label="研究设置"
              icon={<Icon icon={AdjustmentsHorizontalIcon} />}
              isIconOnly
              tooltip="研究设置"
              variant="ghost"
              isDisabled={composerDisabled}
            />
          </Popover>
        }
        sendButton={
          isRunning ? (
            <Button
              label="取消运行"
              icon={<Icon icon={StopIcon} />}
              isIconOnly
              tooltip="取消运行"
              variant="primary"
              onClick={() => void control("cancel")}
            />
          ) : (
            <Button
              label="发送问题"
              icon={<Icon icon={ArrowUpIcon} />}
              isIconOnly
              tooltip="发送问题"
              variant="primary"
              isDisabled={composerDisabled || question.trim() === ""}
              onClick={() => onSubmit(question)}
            />
          )
        }
      />
      <Text as="p" type="supporting" justify="center">
        Enter 发送 · Shift + Enter 换行
      </Text>
    </Stack>
  );

  return (
    <AppShell
      variant="wash"
      contentPadding={0}
      sideNav={
        <SideNav
          aria-label="研究导航"
          collapsible={{ buttonLabel: "收起或展开导航" }}
          header={
            <SideNavHeading
              heading="Crypto Research"
              icon={<Icon icon={ChartBarIcon} size="md" />}
            />
          }
          footer={
            <SideNavSection title="账号" isHeaderHidden>
              <SideNavItem
                label={session.email ?? "访问令牌"}
                icon={UserCircleIcon}
                isSelected={false}
              />
              <SideNavItem
                label="退出登录"
                icon={ArrowRightOnRectangleIcon}
                onClick={() => onLogout()}
              />
            </SideNavSection>
          }
        >
          <SideNavSection title="菜单" isHeaderHidden>
            <SideNavItem label="新建研究" icon={PlusIcon} onClick={newThread} />
          </SideNavSection>
          <Divider />
          {threads.length === 0 ? null : (
            <SideNavSection title="历史会话">
              {threads.map((thread) => (
                <SideNavItem
                  key={thread.threadId}
                  label={thread.preview === "" ? "未命名研究" : thread.preview}
                  isSelected={thread.threadId === activeThread}
                  onClick={() => switchThread(thread.threadId)}
                  endContent={
                    <StatusDot
                      variant={statusVariant(thread.status)}
                      label={statusLabel(thread.status)}
                    />
                  }
                />
              ))}
            </SideNavSection>
          )}
        </SideNav>
      }
    >
      <Layout
        height="fill"
        padding={0}
        header={
          <LayoutHeader label="当前研究">
            <Stack
              direction="horizontal"
              justify="between"
              align="center"
              gap={3}
              paddingInline={4}
              paddingBlock={3}
            >
              {messages.length === 0 ? (
                <Text type="label" color="secondary">
                  新建研究
                </Text>
              ) : (
                <Heading level={1} maxLines={1}>
                  {threads.find((thread) => thread.threadId === activeThread)?.preview ||
                    "研究会话"}
                </Heading>
              )}
              <Stack direction="horizontal" gap={2} align="center" role="status">
                <StatusDot
                  variant={statusVariant(isRunning ? "running" : status)}
                  label={statusLabel(isRunning ? "running" : status)}
                />
                <Text type="supporting" textWrap="nowrap">
                  {statusLabel(isRunning ? "running" : status)}
                </Text>
              </Stack>
            </Stack>
          </LayoutHeader>
        }
        content={
          <LayoutContent padding={0} isScrollable={false} xstyle={styles.chatContent}>
            <ChatLayout
              density="spacious"
              composer={messages.length === 0 ? null : composer}
              emptyState={
                <Stack
                  gap={8}
                  align="stretch"
                  width="100%"
                  maxWidth="48rem"
                  xstyle={styles.welcome}
                >
                  <Stack gap={3} align="center">
                    <Heading
                      level={1}
                      type="display-3"
                      weight="normal"
                      justify="center"
                      textWrap="balance"
                    >
                      你想研究什么？
                    </Heading>
                    <Text as="p" color="secondary" justify="center">
                      从一个问题开始，探索加密市场。
                    </Text>
                  </Stack>
                  {composer}
                </Stack>
              }
            >
              {messages.length === 0 ? null : (
                <ChatMessageList align="top" gap={6} isStreaming={isRunning}>
                  {messages.map((message) => {
                    const text = messageText(message);
                    const calls = toolCalls(message);
                    if (text === "" && calls.length === 0) {
                      return null;
                    }
                    return (
                      <ChatMessage
                        key={message.id}
                        sender={
                          message.role === "user"
                            ? "user"
                            : message.role === "assistant"
                              ? "assistant"
                              : "system"
                        }
                      >
                        <ChatMessageBubble
                          variant={message.role === "user" ? "filled" : "ghost"}
                          width={message.role === "user" ? undefined : "100%"}
                          name={
                            message.role === "user" ? undefined : (
                              <Text type="label" weight="semibold" color="secondary">
                                {roleLabel(message.role)}
                              </Text>
                            )
                          }
                        >
                          <Stack gap={3} align="stretch" xstyle={styles.messageContent}>
                            {text === "" ? null : message.role === "assistant" ? (
                              <Markdown
                                headingLevelStart={2}
                                contentWidth="70ch"
                                isStreaming={isRunning && message.id === messages.at(-1)?.id}
                              >
                                {text}
                              </Markdown>
                            ) : message.role === "tool" ? (
                              <CodeBlock
                                title="工具结果"
                                code={text}
                                isWrapped
                                width="100%"
                                maxHeight="20rem"
                              />
                            ) : (
                              <Text as="p" xstyle={styles.messageText}>
                                {text}
                              </Text>
                            )}
                            {calls.map((call) => (
                              <CodeBlock
                                key={`${message.id}:${call.name}:${call.arguments}`}
                                title={call.name}
                                code={call.arguments}
                                language="json"
                                isWrapped
                                width="100%"
                                maxHeight="20rem"
                              />
                            ))}
                          </Stack>
                        </ChatMessageBubble>
                      </ChatMessage>
                    );
                  })}
                  {isRunning ? (
                    <Text as="p" color="secondary">
                      正在研究…
                    </Text>
                  ) : null}
                </ChatMessageList>
              )}
            </ChatLayout>
          </LayoutContent>
        }
      />
    </AppShell>
  );
}
