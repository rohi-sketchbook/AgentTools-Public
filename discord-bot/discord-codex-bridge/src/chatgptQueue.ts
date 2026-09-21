import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export interface DiscordDecisionButton {
  type: 2;
  style: 1 | 2 | 3 | 4;
  custom_id: string;
  label: string;
  disabled?: boolean;
}

export interface DiscordDecisionActionRow {
  type: 1;
  components: DiscordDecisionButton[];
}

export interface ChatGptOutboxMessage {
  requestId: string;
  channelId: string;
  replyToMessageId?: string | null;
  content: string;
  attachments?: Array<{ path: string; name?: string }>;
  components?: DiscordDecisionActionRow[];
  createdAt?: string;
}

export interface PendingQueueRequest {
  requestId: string;
  filePath: string;
  data: Record<string, unknown>;
}

export interface AgentDiscordMessageInput {
  channelId: string;
  content: string;
  attachments?: Array<{ path: string; name?: string }>;
  components?: unknown;
  allowedOutputRoot: string;
}

export function normalizeDiscordDecisionComponents(value: unknown): DiscordDecisionActionRow[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("Discord components must be an array.");
  if (value.length > 5) throw new Error("Discord components exceed the 5-row limit.");

  const customIds = new Set<string>();
  return value.map((row, rowIndex) => {
    if (!row || typeof row !== "object" || (row as { type?: unknown }).type !== 1) {
      throw new Error(`Discord component row ${rowIndex + 1} must be an action row.`);
    }
    const buttons = (row as { components?: unknown }).components;
    if (!Array.isArray(buttons) || buttons.length === 0 || buttons.length > 5) {
      throw new Error(`Discord component row ${rowIndex + 1} must contain 1-5 buttons.`);
    }
    return {
      type: 1 as const,
      components: buttons.map((button, buttonIndex) => {
        if (!button || typeof button !== "object" || (button as { type?: unknown }).type !== 2) {
          throw new Error(`Discord component ${rowIndex + 1}.${buttonIndex + 1} must be a button.`);
        }
        const source = button as Record<string, unknown>;
        const customId = typeof source.custom_id === "string" ? source.custom_id.trim() : "";
        const label = typeof source.label === "string" ? source.label.trim() : "";
        const style = Number(source.style);
        if (!customId.startsWith("adv:decision:") || customId.length > 100) {
          throw new Error(`Discord decision button has an invalid custom_id: ${customId}`);
        }
        if (!label || label.length > 80) {
          throw new Error(`Discord decision button has an invalid label at ${rowIndex + 1}.${buttonIndex + 1}.`);
        }
        if (![1, 2, 3, 4].includes(style)) {
          throw new Error(`Discord decision button has an invalid style at ${rowIndex + 1}.${buttonIndex + 1}.`);
        }
        if (customIds.has(customId)) throw new Error(`Duplicate Discord decision button: ${customId}`);
        customIds.add(customId);
        return {
          type: 2 as const,
          style: style as 1 | 2 | 3 | 4,
          custom_id: customId,
          label,
          disabled: source.disabled === true || undefined,
        };
      }),
    };
  });
}

function resolveAllowedAttachmentPath(attachmentPath: string, allowedOutputRoot: string): string {
  const outputRoot = path.resolve(allowedOutputRoot);
  const resolved = path.isAbsolute(attachmentPath)
    ? path.resolve(attachmentPath)
    : path.resolve(outputRoot, attachmentPath);
  const relative = path.relative(outputRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Outbox attachment is outside the allowed root: ${attachmentPath}`);
  }
  return resolved;
}

async function ensureQueueDirs(root: string): Promise<void> {
  await Promise.all([
    "inbox",
    "outbox",
    "processed",
    "processed/inbox",
    "processed/outbox",
    "attachments",
    "state",
    "state/processing",
    "state/sending",
    "logs",
  ].map((name) => mkdir(path.join(root, name), { recursive: true })));
}

export async function enqueueAgentDiscordMessage(
  root: string,
  input: AgentDiscordMessageInput,
): Promise<{ requestId: string; outboxPath: string }> {
  await ensureQueueDirs(root);
  const attachments = input.attachments ?? [];
  if (!input.channelId) throw new Error("Discord channelId is required.");
  if (!input.content && attachments.length === 0) {
    throw new Error("Discord message requires content or at least one attachment.");
  }

  const normalizedAttachments: Array<{ path: string; name?: string }> = [];
  for (const attachment of attachments) {
    const resolved = resolveAllowedAttachmentPath(attachment.path, input.allowedOutputRoot);
    const fileStat = await stat(resolved);
    if (!fileStat.isFile()) throw new Error(`Discord attachment is not a file: ${attachment.path}`);
    normalizedAttachments.push({ path: resolved, name: attachment.name });
  }

  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const requestId = `agent-${timestamp}-${randomUUID().slice(0, 8)}`;
  const requestPath = path.join(root, "inbox", `${requestId}.json`);
  const outboxPath = path.join(root, "outbox", `${requestId}.json`);
  const createdAt = new Date().toISOString();

  const requestRecord = {
    requestId,
    channelId: input.channelId,
    messageId: "",
    status: "outbound",
    source: "agent",
    createdAt,
  };
  await writeFile(requestPath, `${JSON.stringify(requestRecord, null, 2)}\n`, { encoding: "utf8", flag: "wx" });

  const outboxMessage: ChatGptOutboxMessage = {
    requestId,
    channelId: input.channelId,
    replyToMessageId: null,
    content: input.content,
    attachments: normalizedAttachments,
    components: normalizeDiscordDecisionComponents(input.components),
    createdAt,
  };
  await writeFile(outboxPath, `${JSON.stringify(outboxMessage, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return { requestId, outboxPath };
}

export async function listPendingChatGptRequests(root: string): Promise<PendingQueueRequest[]> {
  await ensureQueueDirs(root);
  const inbox = path.join(root, "inbox");
  const names = (await readdir(inbox)).filter((name) => name.endsWith(".json")).sort();
  const requests: PendingQueueRequest[] = [];
  for (const name of names) {
    const filePath = path.join(inbox, name);
    try {
      const data = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
      if (data.status !== "pending") continue;
      requests.push({ requestId: String(data.requestId ?? path.basename(name, ".json")), filePath, data });
    } catch {
      // Invalid JSON stays in inbox for manual inspection.
    }
  }
  return requests;
}

export async function claimChatGptRequest(root: string, requestId: string): Promise<PendingQueueRequest> {
  await ensureQueueDirs(root);
  const source = path.join(root, "inbox", `${requestId}.json`);
  const target = path.join(root, "state", "processing", `${requestId}.json`);
  await rename(source, target);
  const data = JSON.parse(await readFile(target, "utf8")) as Record<string, unknown>;
  data.status = "processing";
  data.processingStartedAt = new Date().toISOString();
  await writeFile(target, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return { requestId, filePath: target, data };
}

export async function completeChatGptRequest(
  root: string,
  requestId: string,
  output: Omit<ChatGptOutboxMessage, "requestId" | "createdAt">,
): Promise<string> {
  await ensureQueueDirs(root);
  const processingPath = path.join(root, "state", "processing", `${requestId}.json`);
  const processedPath = path.join(root, "processed", "inbox", `${requestId}.json`);
  const data = JSON.parse(await readFile(processingPath, "utf8")) as Record<string, unknown>;

  // Create the outbound reply first. If a crash occurs after this point, the reply
  // still exists and the request cannot silently become "completed" with no response.
  const outboxMessage: ChatGptOutboxMessage = {
    requestId,
    ...output,
    createdAt: new Date().toISOString(),
  };
  const outboxPath = path.join(root, "outbox", `${requestId}.json`);
  await writeFile(outboxPath, `${JSON.stringify(outboxMessage, null, 2)}\n`, { encoding: "utf8", flag: "wx" });

  data.status = "completed";
  data.completedAt = new Date().toISOString();
  await writeFile(processingPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(processingPath, processedPath);
  return outboxPath;
}

export async function failChatGptRequest(root: string, requestId: string, error: string): Promise<string> {
  await ensureQueueDirs(root);
  const processingPath = path.join(root, "state", "processing", `${requestId}.json`);
  const processedPath = path.join(root, "processed", "inbox", `${requestId}.json`);
  const data = JSON.parse(await readFile(processingPath, "utf8")) as Record<string, unknown>;
  const channelId = typeof data.channelId === "string" ? data.channelId : "";
  const replyToMessageId = typeof data.messageId === "string" ? data.messageId : null;
  if (channelId) {
    const outboxMessage: ChatGptOutboxMessage = {
      requestId,
      channelId,
      replyToMessageId,
      content: `ChatGPT Queueの処理に失敗しました。\n${error}`,
      attachments: [],
      createdAt: new Date().toISOString(),
    };
    await writeFile(
      path.join(root, "outbox", `${requestId}.json`),
      `${JSON.stringify(outboxMessage, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
  }
  data.status = "failed";
  data.failedAt = new Date().toISOString();
  data.error = error;
  await writeFile(processingPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(processingPath, processedPath);
  return processedPath;
}

export interface DiscordOutboxClient {
  channels: {
    fetch(channelId: string): Promise<unknown>;
  };
}

function isSendableChannel(channel: unknown): channel is {
  send(message: unknown): Promise<unknown>;
  messages?: { fetch(messageId: string): Promise<unknown> };
} {
  return typeof channel === "object" && channel !== null && "send" in channel && typeof (channel as { send?: unknown }).send === "function";
}

function isReplyableMessage(message: unknown): message is { reply(payload: unknown): Promise<unknown> } {
  return typeof message === "object" && message !== null && "reply" in message && typeof (message as { reply?: unknown }).reply === "function";
}

export function normalizeDiscordLineBreaks(content: string): string {
  return content
    .split(/(```[\s\S]*?```|`[^`\r\n]*`)/g)
    .map((segment, index) => index % 2 === 1
      ? segment
      : segment.replace(/\\r\\n|\\n|\\r/g, "\n"))
    .join("");
}

async function findRequestRecord(root: string, requestId: string): Promise<Record<string, unknown> | null> {
  const candidates = [
    path.join(root, "state", "processing", `${requestId}.json`),
    path.join(root, "inbox", `${requestId}.json`),
    path.join(root, "processed", "inbox", `${requestId}.json`),
  ];
  for (const candidate of candidates) {
    try {
      return JSON.parse(await readFile(candidate, "utf8")) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
  }
  return null;
}

async function archiveRequestAfterDelivery(root: string, requestId: string): Promise<void> {
  const candidates = [
    path.join(root, "state", "processing", `${requestId}.json`),
    path.join(root, "inbox", `${requestId}.json`),
  ];
  for (const candidate of candidates) {
    try {
      const data = JSON.parse(await readFile(candidate, "utf8")) as Record<string, unknown>;
      data.status = "completed";
      data.deliveredAt = new Date().toISOString();
      await writeFile(candidate, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      await rename(candidate, path.join(root, "processed", "inbox", `${requestId}.json`));
      return;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      // Delivery itself already succeeded; leave request state for manual audit.
      return;
    }
  }
}

async function deliverOutboxFile(
  root: string,
  client: DiscordOutboxClient,
  fileName: string,
  allowedOutputRoot: string,
): Promise<void> {
  const source = path.join(root, "outbox", fileName);
  const claimed = path.join(root, "state", "sending", fileName);
  let delivered = false;
  try {
    await rename(source, claimed);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }

  try {
    const payload = JSON.parse(await readFile(claimed, "utf8")) as ChatGptOutboxMessage;
    if (!payload.requestId || !payload.channelId || typeof payload.content !== "string") {
      throw new Error("Outbox JSON requires requestId, channelId and content.");
    }
    const requestRecord = await findRequestRecord(root, payload.requestId);
    if (!requestRecord) {
      throw new Error(`Outbox request does not exist: ${payload.requestId}`);
    }
    const expectedChannelId = typeof requestRecord.channelId === "string" ? requestRecord.channelId : "";
    const expectedMessageId = typeof requestRecord.messageId === "string" ? requestRecord.messageId : "";
    if (!expectedChannelId || payload.channelId !== expectedChannelId) {
      throw new Error(`Outbox channelId does not match request: ${payload.requestId}`);
    }
    if (payload.replyToMessageId && expectedMessageId && payload.replyToMessageId !== expectedMessageId) {
      throw new Error(`Outbox replyToMessageId does not match request: ${payload.requestId}`);
    }
    payload.replyToMessageId = payload.replyToMessageId || expectedMessageId || null;
    const channel = await client.channels.fetch(payload.channelId);
    if (!isSendableChannel(channel)) throw new Error(`Discord channel is not sendable: ${payload.channelId}`);

    const files: Array<{ attachment: string | Buffer; name: string }> = (payload.attachments ?? []).map((attachment) => {
      const resolved = resolveAllowedAttachmentPath(attachment.path, allowedOutputRoot);
      return {
        attachment: resolved,
        name: attachment.name ?? path.basename(resolved),
      };
    });
    const fullContent = normalizeDiscordLineBreaks(payload.content);
    if (fullContent.length > 1_900) {
      files.push({ attachment: Buffer.from(fullContent, "utf8"), name: `${payload.requestId}-response.txt` });
    }
    const discordPayload = {
      allowedMentions: { parse: [] as string[] },
      content: fullContent.length <= 1_900
        ? fullContent
        : `${fullContent.slice(0, 1_760)}\n\n... 回答全文は添付テキストを参照してください。`,
      files,
      components: normalizeDiscordDecisionComponents(payload.components),
    };

    let sent = false;
    if (payload.replyToMessageId && channel.messages?.fetch) {
      try {
        const sourceMessage = await channel.messages.fetch(payload.replyToMessageId);
        if (isReplyableMessage(sourceMessage)) {
          await sourceMessage.reply(discordPayload);
          sent = true;
        }
      } catch {
        // Fall back to a normal channel message if the original message no longer exists.
      }
    }
    if (!sent) await channel.send(discordPayload);
    delivered = true;

    const processedPath = path.join(root, "processed", "outbox", fileName);
    await rename(claimed, processedPath);
    await archiveRequestAfterDelivery(root, payload.requestId);
  } catch (error) {
    // At-most-once delivery is more important than automatic retry. If Discord send
    // already succeeded, leave the claimed file in state/sending for manual audit
    // rather than returning it to outbox and risking a duplicate reply.
    if (!delivered) {
      try {
        await rename(claimed, source);
      } catch {
        // Keep the original delivery error.
      }
    }
    throw error;
  }
}

export async function pumpChatGptOutboxOnce(
  root: string,
  client: DiscordOutboxClient,
  allowedOutputRoot = path.dirname(root),
): Promise<number> {
  await ensureQueueDirs(root);
  const files = (await readdir(path.join(root, "outbox"))).filter((name) => name.endsWith(".json")).sort();
  for (const fileName of files) {
    await deliverOutboxFile(root, client, fileName, allowedOutputRoot);
  }
  return files.length;
}

export function startChatGptOutboxPump(input: {
  root: string;
  client: DiscordOutboxClient;
  allowedOutputRoot?: string;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}): () => void {
  let running = false;
  let stopped = false;
  let watcher: FSWatcher | null = null;
  const fallbackIntervalMs = Math.max(30_000, input.intervalMs ?? 30_000);
  const outboxDirectory = path.join(input.root, "outbox");

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await pumpChatGptOutboxOnce(input.root, input.client, input.allowedOutputRoot ?? path.dirname(input.root));
    } catch (error) {
      input.onError?.(error);
    } finally {
      running = false;
    }
  };

  void ensureQueueDirs(input.root)
    .then(() => {
      if (stopped) return;
      try {
        watcher = watch(outboxDirectory, (_eventType, fileName) => {
          if (!fileName || String(fileName).toLowerCase().endsWith(".json")) {
            void tick();
          }
        });
        watcher.on("error", (error) => input.onError?.(error));
        watcher.unref();
      } catch (error) {
        input.onError?.(error);
      }
    })
    .catch((error) => input.onError?.(error));

  void tick();
  // performance-audit: allow-bounded-poll — safety net only; normal delivery is event-driven via fs.watch and fallback is >=30s.
  const timer = setInterval(() => void tick(), fallbackIntervalMs);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
    watcher?.close();
  };
}
