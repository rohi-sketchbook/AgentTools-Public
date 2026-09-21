import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Attachment, Backend, BackendExecutionContext, BackendRequest, BackendResult } from "../contracts.ts";

const MAX_ATTACHMENTS = 20;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const DISCORD_ATTACHMENT_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

export interface ChatGptQueueRequest {
  requestId: string;
  guildId: string;
  channelId: string;
  messageId: string;
  authorId: string;
  authorName: string;
  content: string;
  timestamp: string;
  attachments: Array<{
    name: string;
    path: string;
    contentType?: string | null;
    size?: number | null;
  }>;
  status: "pending" | "processing" | "completed" | "failed";
  workspaceRoot?: string;
  cwd?: string;
}

function sanitizeFileName(name: string, index: number): string {
  const fallback = `attachment-${index + 1}.bin`;
  const base = path.basename(name || fallback).replace(/[<>:\"/\\|?*\u0000-\u001f]/g, "_").trim();
  return `${String(index + 1).padStart(2, "0")}-${base || fallback}`;
}

function requestIdFor(messageId: string): string {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  const suffix = messageId || randomBytes(5).toString("hex");
  return `${stamp}-${suffix}`;
}

async function materializeAttachment(root: string, requestId: string, attachment: Attachment, index: number) {
  if (attachment.localPath) {
    return {
      name: attachment.name,
      path: attachment.localPath,
      contentType: attachment.contentType,
      size: attachment.size,
    };
  }
  if (!attachment.url) {
    throw new Error(`添付ファイルURLがありません: ${attachment.name}`);
  }
  if (typeof attachment.size === "number" && attachment.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`添付ファイルが大きすぎます: ${attachment.name}`);
  }

  const url = new URL(attachment.url);
  if (url.protocol !== "https:" || !DISCORD_ATTACHMENT_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error(`Discord CDN以外の添付URLを拒否しました: ${url.hostname}`);
  }

  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`添付ファイル取得失敗: ${attachment.name} (HTTP ${response.status})`);
  }
  const finalUrl = new URL(response.url);
  if (finalUrl.protocol !== "https:" || !DISCORD_ATTACHMENT_HOSTS.has(finalUrl.hostname.toLowerCase())) {
    throw new Error(`Discord CDN外へのリダイレクトを拒否しました: ${finalUrl.hostname}`);
  }
  const data = Buffer.from(await response.arrayBuffer());
  if (data.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(`添付ファイルが大きすぎます: ${attachment.name}`);
  }

  const dir = path.join(root, "attachments", requestId);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, sanitizeFileName(attachment.name, index));
  await writeFile(filePath, data);
  return {
    name: attachment.name,
    path: filePath,
    contentType: attachment.contentType,
    size: data.byteLength,
  };
}

export class ChatGptQueueBackend implements Backend {
  readonly id = "chatgpt" as const;
  readonly displayName = "ChatGPT Queue + DevSpace";
  readonly capabilities = {
    read: true,
    write: true,
    imageInput: true,
    imageOutput: true,
    asynchronousQueue: true,
    devspace: true,
  } as const;

  constructor(private readonly root: string) {}

  async ensureDirectories(): Promise<void> {
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
    ].map((name) => mkdir(path.join(this.root, name), { recursive: true })));

    const agentGuide = `# Discord ChatGPT Queue\n\nユーザーから「Discord確認して」等の依頼を受けたら、inbox/*.json の status=pending を確認する。\nrequestのcwd/workspaceRootをDevSpaceで開き、必要な調査・編集を行う。\n処理中はInbox statusをprocessingへ、完了時はoutbox/<requestId>.jsonを作りInbox statusをcompletedへ更新する。\nOutboxは requestId / channelId / replyToMessageId / content / attachments を持つ。channelIdとreplyToMessageIdはInboxの値をそのまま使う。\nOpenAI APIやブラウザ自動操作でChatGPTを起動しない。Codex CLIはユーザーが明示指定した場合のみ使う。\n削除、git push/reset/clean、外部公開、サービス停止、Credential/API Key操作はDiscord側確認済みであることが明確でない限り実行しない。\n`;
    await writeFile(path.join(this.root, "AGENTS.md"), agentGuide, { encoding: "utf8", flag: "wx" }).catch((error) => {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    });
  }

  async execute(request: BackendRequest, _context: BackendExecutionContext): Promise<BackendResult> {
    await this.ensureDirectories();
    const metadata = request.metadata ?? {};
    const messageId = String(metadata.messageId ?? "");
    const requestId = requestIdFor(messageId);
    const attachmentRecords = [];
    for (const [index, attachment] of (request.attachments ?? []).slice(0, MAX_ATTACHMENTS).entries()) {
      attachmentRecords.push(await materializeAttachment(this.root, requestId, attachment, index));
    }

    const queueRequest: ChatGptQueueRequest = {
      requestId,
      guildId: String(metadata.guildId ?? ""),
      channelId: request.channelId ?? String(metadata.channelId ?? ""),
      messageId,
      authorId: request.userId ?? String(metadata.authorId ?? ""),
      authorName: String(metadata.authorName ?? ""),
      content: request.text,
      timestamp: String(metadata.timestamp ?? new Date().toISOString()),
      attachments: attachmentRecords,
      status: "pending",
      workspaceRoot: request.workspaceRoot,
      cwd: request.cwd,
    };

    const inboxPath = path.join(this.root, "inbox", `${requestId}.json`);
    await writeFile(inboxPath, `${JSON.stringify(queueRequest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });

    return {
      status: "completed",
      backendId: this.id,
      text: [
        "ChatGPT Queueへ依頼を登録しました。",
        `Request: ${requestId}`,
        "この時点ではAI推論を実行していません。ChatGPT側でInboxを確認したときにDevSpace経由で処理されます。",
      ].join("\n"),
      metadata: { requestId, inboxPath },
    };
  }

  async status() {
    await this.ensureDirectories();
    return { available: true, detail: `Queue: ${this.root}` };
  }
}
