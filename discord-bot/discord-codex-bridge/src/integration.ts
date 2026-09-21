import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { startActivityNotificationPump } from "./activityNotifications.ts";
import { ChatGptQueueBackend } from "./backends/chatGptQueueBackend.ts";
import { CodexBackend } from "./backends/codexBackend.ts";
import { LocalBackend } from "./backends/localBackend.ts";
import { startChatGptOutboxPump } from "./chatgptQueue.ts";
import { loadMultiBackendConfig } from "./config.ts";
import type { Attachment, BackendId, BackendRequest } from "./contracts.ts";
import { ConfirmationManager, detectDangerousOperation } from "./permissions.ts";
import {
  PublicAssistantRateLimiter,
  PublicAssistantStateStore,
  PublicConversationStore,
  createPublicCodexPrompt,
  createPublicDiscordReply,
  extractConnectorCodexResponse,
  isForbiddenPublicCommand,
  parsePublicAssistantAdminCommand,
  publicConversationKey,
  stripBotMention,
} from "./publicAssistant.ts";
import { BackendRegistry } from "./registry.ts";
import { routeMultiBackendMessage } from "./router.ts";
import { ChannelStateStore } from "./state.ts";

interface ChannelContextLike {
  computerId: string;
  allowedRoleIds: string[];
  computerDisplayName?: string;
  workspaceDisplayName?: string;
  workspaceRoot: string;
  cwd: string;
  timeoutMs: number;
  codexSessionId?: string | null;
}

interface IncomingMessageLike {
  userId: string;
  channelId: string;
  content: string;
  roleIds: string[];
  attachments?: Attachment[];
  imageAttachments?: Attachment[];
  messageId?: string;
  guildId?: string;
  authorName?: string;
  timestamp?: string;
  botMentioned?: boolean;
  botUserId?: string;
  reply(message: string | Record<string, unknown>): Promise<unknown>;
}

interface HandlerInputLike {
  submitCodexPrompt?: (input: {
    computerId: string;
    payload: Record<string, unknown>;
    onProgress?: (event: unknown) => Promise<void> | void;
  }) => Promise<unknown>;
}

interface RuntimeState {
  config: Awaited<ReturnType<typeof loadMultiBackendConfig>>;
  state: ChannelStateStore;
  registry: BackendRegistry;
  codex: CodexBackend;
  confirmations: ConfirmationManager;
  publicAssistantState: PublicAssistantStateStore;
  publicRateLimiter: PublicAssistantRateLimiter;
  publicConversations: PublicConversationStore;
}

const execFileAsync = promisify(execFile);
const BRIDGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGENTTOOLS_ROOT = path.resolve(BRIDGE_ROOT, "..", "..");
const AUTODEV_CLI = path.join(AGENTTOOLS_ROOT, "agenttools-mcp-gateway", "src", "cli.js");

let runtimePromise: Promise<RuntimeState> | null = null;

async function runtime(): Promise<RuntimeState> {
  if (!runtimePromise) {
    runtimePromise = loadMultiBackendConfig().then(async (config) => {
      const local = new LocalBackend();
      const chatgpt = new ChatGptQueueBackend(config.chatgptQueue.root);
      const codex = new CodexBackend();
      await chatgpt.ensureDirectories();
      const registry = new BackendRegistry()
        .register(local)
        .register(chatgpt)
        .register(codex);
      return {
        config,
        state: new ChannelStateStore(config.statePath, config.defaultBackend),
        registry,
        codex,
        confirmations: new ConfirmationManager(),
        publicAssistantState: new PublicAssistantStateStore(
          config.publicAssistant.statePath,
          config.publicAssistant.respondingByDefault,
        ),
        publicRateLimiter: new PublicAssistantRateLimiter(config.publicAssistant),
        publicConversations: new PublicConversationStore(
          config.publicAssistant.conversationTtlMs,
          config.publicAssistant.maxConversationTurns,
        ),
      };
    });
  }
  return runtimePromise;
}

function localAlias(content: string): string | null {
  const value = content.trim();
  if (/^__cdc_exec\s+git\s+diff\s+--stat$/i.test(value)) return "git diff";
  if (/^__cdc_exec\s+__cdc_ls(?:\s+\d+)?$/i.test(value)) return "ls";
  if (/^where$/i.test(value)) return "pwd";
  if (/^status$/i.test(value)) return "status";
  return null;
}

function isAllowedLegacyLocalCommand(content: string): boolean {
  const value = content.trim();
  const fileCommand = value.match(/^__cdc_exec\s+__cdc_(?:open|view)\s+(.+)$/i);
  const safeFileCommand = Boolean(
    fileCommand &&
    fileCommand[1] &&
    !/[\0\r\n`$;&|<>/]/.test(fileCommand[1]),
  );
  return (
    /^__cdc_exec\s+__cdc_ls(?:\s+\d+)?$/i.test(value) ||
    safeFileCommand ||
    /^__cdc_exec\s+cd\s+\.\.$/i.test(value) ||
    /^__cdc_exec\s+git\s+status\s+--short$/i.test(value) ||
    /^__cdc_exec\s+git\s+diff\s+--(?:stat|check)$/i.test(value) ||
    /^__cdc_exec\s+pnpm\s+(?:test|typecheck)$/i.test(value) ||
    /^__cdc_exec\s+codex\s+mcp\s+list$/i.test(value)
  );
}

export function normalizeUpstreamControlCommand(content: string): string | null {
  const value = content.trim();
  const reloadSlash = value.match(
    /^\/reload(?:\s+mode:(commands|restart))?(?:\s+confirm:(true|false))?$/i,
  );
  if (reloadSlash) {
    const mode = reloadSlash[1]?.toLowerCase() === "restart" ? "restart" : "commands";
    const confirmed = reloadSlash[2]?.toLowerCase() === "true";
    return `reload ${mode}${mode === "restart" && confirmed ? " confirm" : ""}`;
  }

  const reloadText = value.match(/^\/((?:bot\s+)?reload(?:\s+(?:commands|restart))?(?:\s+confirm)?)$/i);
  return reloadText?.[1] ?? null;
}

export function isUpstreamControlCommand(content: string): boolean {
  const value = content.trim();
  return (
    /^(?:bot\s+)?reload(?:\s+(?:commands|restart))?(?:\s+confirm)?$/i.test(value) ||
    /^\/reload\b/i.test(value) ||
    /^clear(?:\s+(?:all|[1-9]\d{0,2}))?(?:\s+confirm)?$/i.test(value) ||
    /^\/clear\b/i.test(value) ||
    /^(?:codex\s+)?sync\b/i.test(value) ||
    /^\/sync(?:-|\b)/i.test(value) ||
    /^__cdc_schedule\b/i.test(value) ||
    /^schedule\b/i.test(value) ||
    /^\/schedule\b/i.test(value) ||
    /^devlog\s+run$/i.test(value) ||
    /^__cdc_new_chat\b/i.test(value) ||
    /^(?:codex\s+)?(?:chat\s+new|new\s+chat)\b/i.test(value) ||
    /^\/chat-new\b/i.test(value) ||
    /^archive(?:\s+confirm)?$/i.test(value) ||
    /^\/archive\b/i.test(value) ||
    /^(?:model\s+\S+|fast|task|mode\s+(?:default|off|reset|fast|task))$/i.test(value) ||
    /^\/(?:model|fast|task|codex-mode|codex-command|compact|skill)\b/i.test(value) ||
    /^(?:help|!help|\?|maintenance|maint|メンテナンス)$/i.test(value)
  );
}

function isLegacyArbitraryShell(content: string): boolean {
  return /^!(?!\s*$)/s.test(content.trim()) || /^__cdc_exec\b/i.test(content.trim());
}

function backendLabel(id: BackendId | "auto"): string {
  switch (id) {
    case "local": return "Local (AIなし)";
    case "chatgpt": return "ChatGPT Queue + DevSpace";
    case "codex": return "Codex CLI (明示指定のみ)";
    case "auto": return "Auto (Local優先 → ChatGPT)";
  }
}

function resultMessage(result: { status: string; text?: string; error?: string; backendId?: BackendId }): string {
  const label = result.backendId ? backendLabel(result.backendId) : "Backend";
  if (result.status === "completed") {
    return `**${label}**\n${result.text?.trim() || "完了しました。"}`;
  }
  return `**${label} / 失敗**\n${result.error || result.text || "不明なエラー"}`;
}

export function splitDiscordMessage(content: string, maxLength = 1_900): string[] {
  const value = content.trim() || "（出力なし）";
  if (value.length <= maxLength) return [value];

  const chunks: string[] = [];
  let remaining = value;
  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt < Math.floor(maxLength / 2)) splitAt = maxLength;

    // Avoid cutting a UTF-16 surrogate pair in half.
    const previous = remaining.charCodeAt(splitAt - 1);
    const next = remaining.charCodeAt(splitAt);
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      splitAt -= 1;
    }

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }
  if (remaining.trim()) chunks.push(remaining.trim());
  return chunks;
}

function confirmationCommand(content: string): { action: "confirm" | "cancel"; token: string } | null {
  const match = content.trim().match(/^(?:(?:__mb_)?|\/)(confirm|cancel)\s+([0-9a-f]{8})$/i);
  return match ? { action: match[1]!.toLowerCase() as "confirm" | "cancel", token: match[2]!.toLowerCase() } : null;
}

function autoDevDecisionCommand(content: string): { issueId: string; optionId: string } | null {
  const match = content.trim().match(/^__autodev_decide\s+([A-Za-z0-9._-]{1,120})\s+([A-Za-z0-9._-]{1,100})$/);
  return match ? { issueId: match[1]!, optionId: match[2]! } : null;
}

async function handleAutoDevDecision(message: IncomingMessageLike, command: { issueId: string; optionId: string }): Promise<void> {
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      AUTODEV_CLI,
      "autodev",
      "decide",
      "--issueId",
      command.issueId,
      "--option",
      command.optionId,
      "--decidedBy",
      `discord:${message.userId}`,
      "--approveHighRisk",
      "true",
      "--scope",
      `Discord decision ${command.optionId}`,
    ], {
      cwd: path.dirname(AUTODEV_CLI),
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 1024 * 1024 * 4,
    });
    const result = JSON.parse(stdout) as {
      ok?: boolean;
      error?: string;
      alreadyApplied?: boolean;
      issue?: { title?: string; status?: string; decision?: { selectedOption?: string } };
    };
    if (!result.ok) throw new Error(result.error || "AutoDev decision failed.");
    const resumed = result.issue?.status === "new";
    await message.reply({
      allowedMentions: { parse: [] },
      ephemeral: true,
      content: [
        result.alreadyApplied ? "✅ この判断はすでに反映済みです。" : "✅ 判断を反映しました。",
        `課題: ${result.issue?.title || command.issueId}`,
        `選択: ${result.issue?.decision?.selectedOption || command.optionId}`,
        resumed
          ? "自動処理対象へ戻っています。"
          : "保留として記録し、自動処理対象には戻していません。",
      ].join("\n"),
    });
  } catch (error) {
    await message.reply({
      allowedMentions: { parse: [] },
      ephemeral: true,
      content: `判断を反映できませんでした。${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

function isRoleAuthorized(message: IncomingMessageLike, channelContext: ChannelContextLike): boolean {
  return channelContext.allowedRoleIds.length === 0 ||
    message.roleIds.some((roleId) => channelContext.allowedRoleIds.includes(roleId));
}

function isConfiguredPublicChannel(state: RuntimeState, channelId: string): boolean {
  return state.config.publicAssistant.enabled && state.config.publicAssistant.channelIds.includes(channelId);
}

async function handlePublicAssistantAdminCommand(input: {
  state: RuntimeState;
  message: IncomingMessageLike;
  channelContext: ChannelContextLike;
}): Promise<boolean> {
  const action = parsePublicAssistantAdminCommand(input.message.content);
  if (!action) return false;

  if (!isRoleAuthorized(input.message, input.channelContext)) {
    await input.message.reply("この操作を実行できる管理者権限がありません。");
    return true;
  }

  let current;
  if (action === "start") {
    current = await input.state.publicAssistantState.setResponding(true, input.message.userId);
  } else if (action === "stop") {
    current = await input.state.publicAssistantState.setResponding(false, input.message.userId);
    input.state.publicConversations.clear();
  } else {
    current = await input.state.publicAssistantState.get();
  }

  await input.message.reply([
    "**一般向けDiscord Assistant**",
    `応答: **${current.responding ? "再開中" : "停止中"}**`,
    `対象チャンネル: ${input.state.config.publicAssistant.channelIds.length}件`,
    `メンション必須: ${input.state.config.publicAssistant.requireBotMention ? "はい" : "いいえ"}`,
    `更新日時: ${current.updatedAt}`,
  ].join("\n"));
  return true;
}

async function handlePublicAssistantMessage(input: {
  state: RuntimeState;
  message: IncomingMessageLike;
  channelContext: ChannelContextLike;
  handlerInput: HandlerInputLike;
}): Promise<boolean> {
  const { state, message, channelContext, handlerInput } = input;
  if (!isConfiguredPublicChannel(state, message.channelId)) return false;

  // Public channels are terminal routes. Never fall through to Local/DevSpace/admin/Codex session routing.
  const publicState = await state.publicAssistantState.get();
  if (!publicState.responding) return true;
  if (state.config.publicAssistant.requireBotMention && !message.botMentioned) return true;

  const userText = stripBotMention(message.content, message.botUserId);
  if (!userText) {
    await message.reply({
      content: "ご用件をメンションと一緒に書いてください。",
      allowedMentions: { parse: [] },
    });
    return true;
  }

  if ((message.attachments?.length ?? 0) > 0 || (message.imageAttachments?.length ?? 0) > 0) {
    await message.reply({
      content: "一般向けBotでは添付ファイルの読み取りや編集はできません。文章からの会話または画像生成を依頼してください。",
      allowedMentions: { parse: [] },
    });
    return true;
  }

  if (isForbiddenPublicCommand(userText)) {
    await message.reply({
      content: "一般向けBotではローカル操作、管理コマンド、Git、Shell、ファイル操作は利用できません。会話と文章からの画像生成のみ利用できます。",
      allowedMentions: { parse: [] },
    });
    return true;
  }

  if (!handlerInput.submitCodexPrompt) {
    await message.reply({
      content: "現在、会話エンジンへ接続できません。",
      allowedMentions: { parse: [] },
    });
    return true;
  }

  const conversationKey = publicConversationKey({
    guildId: message.guildId,
    channelId: message.channelId,
    userId: message.userId,
  });
  const rateLimit = state.publicRateLimiter.tryBegin(conversationKey);
  if (!rateLimit.ok) {
    await message.reply({ content: rateLimit.reason, allowedMentions: { parse: [] } });
    return true;
  }

  try {
    const history = state.publicConversations.getHistory(conversationKey);
    const prompt = createPublicCodexPrompt({
      userText,
      history,
      authorName: message.authorName,
      persona: state.config.publicAssistant.channelPersonas[message.channelId],
    });
    const response = await handlerInput.submitCodexPrompt({
      computerId: channelContext.computerId,
      payload: {
        workspaceRoot: state.config.publicAssistant.workspaceRoot,
        cwd: state.config.publicAssistant.workspaceRoot,
        prompt,
        timeoutMs: state.config.publicAssistant.timeoutMs,
        sessionId: null,
        mode: "prompt",
        reasoningEffort: "low",
        imageAttachments: [],
        codexHome: state.config.publicAssistant.codexHome,
        publicMode: true,
      },
    });
    const codexResponse = extractConnectorCodexResponse(response);
    const generatedImageRoot = path.join(state.config.publicAssistant.codexHome, "generated_images");
    const rendered = await createPublicDiscordReply(codexResponse, generatedImageRoot);

    if (codexResponse.status === "completed") {
      state.publicConversations.append(conversationKey, "user", userText);
      state.publicConversations.append(conversationKey, "assistant", rendered.historyText);
    }
    await message.reply(rendered.payload as unknown as Record<string, unknown>);
  } catch (error) {
    console.error("public Discord assistant failed", error);
    await message.reply({
      content: "応答の生成に失敗しました。時間を置いてもう一度お試しください。",
      allowedMentions: { parse: [] },
    });
  } finally {
    rateLimit.release();
  }

  return true;
}

async function executeSelectedBackend(
  state: RuntimeState,
  backend: BackendId,
  text: string,
  message: IncomingMessageLike,
  channelContext: ChannelContextLike,
): Promise<boolean> {
  if (backend === "codex") {
    // 既存connectorのCodex経路をそのまま使い、resume/realtime/画像添付などの既存機能を維持する。
    message.content = state.codex.prepareUpstreamContent(text);
    return false;
  }

  const request: BackendRequest = {
    text,
    workspaceRoot: channelContext.workspaceRoot,
    cwd: channelContext.cwd,
    channelId: message.channelId,
    userId: message.userId,
    attachments: message.attachments ?? [],
    timeoutMs: channelContext.timeoutMs,
    metadata: {
      guildId: message.guildId ?? "",
      channelId: message.channelId,
      messageId: message.messageId ?? "",
      authorId: message.userId,
      authorName: message.authorName ?? "",
      timestamp: message.timestamp ?? new Date().toISOString(),
    },
  };

  const result = await state.registry.get(backend).execute(request, {});
  for (const chunk of splitDiscordMessage(resultMessage(result))) {
    await message.reply(chunk);
  }
  return true;
}

export async function tryHandleMultiBackendMessage(input: {
  message: IncomingMessageLike;
  channelContext: ChannelContextLike;
  handlerInput: HandlerInputLike;
}): Promise<boolean> {
  const state = await runtime();
  if (!state.config.enabled) return false;

  const { message, channelContext } = input;
  if (await handlePublicAssistantAdminCommand({ state, message, channelContext })) {
    return true;
  }
  if (await handlePublicAssistantMessage({
    state,
    message,
    channelContext,
    handlerInput: input.handlerInput,
  })) {
    return true;
  }

  const authorized = isRoleAuthorized(message, channelContext);
  if (!authorized) {
    // Upstream router owns the canonical permission-denied response.
    return false;
  }

  const autoDevDecision = autoDevDecisionCommand(message.content);
  if (autoDevDecision) {
    await handleAutoDevDecision(message, autoDevDecision);
    return true;
  }

  const confirmation = confirmationCommand(message.content);
  if (confirmation) {
    if (confirmation.action === "cancel") {
      const cancelled = state.confirmations.cancel(confirmation.token, message.channelId, message.userId);
      await message.reply(cancelled ? "確認待ち操作をキャンセルしました。" : "有効な確認待ち操作が見つかりません。" );
      return true;
    }
    const pending = state.confirmations.consume(confirmation.token, message.channelId, message.userId);
    if (!pending) {
      await message.reply("有効な確認トークンではありません。期限切れ、または別ユーザー/別チャンネルの可能性があります。");
      return true;
    }
    const original = pending.payload ?? {};
    message.attachments = Array.isArray(original.attachments) ? original.attachments as Attachment[] : message.attachments;
    message.imageAttachments = Array.isArray(original.imageAttachments) ? original.imageAttachments as Attachment[] : message.imageAttachments;
    message.messageId = typeof original.messageId === "string" ? original.messageId : message.messageId;
    message.guildId = typeof original.guildId === "string" ? original.guildId : message.guildId;
    message.authorName = typeof original.authorName === "string" ? original.authorName : message.authorName;
    message.timestamp = typeof original.timestamp === "string" ? original.timestamp : message.timestamp;
    return executeSelectedBackend(state, pending.backend === "workflow" ? "chatgpt" : pending.backend, pending.text, message, channelContext);
  }

  const localMapped = localAlias(message.content);
  if (localMapped) {
    return executeSelectedBackend(state, "local", localMapped, message, channelContext);
  }

  const normalizedUpstreamControl = normalizeUpstreamControlCommand(message.content);
  if (normalizedUpstreamControl) {
    // 文字として入力された /reload も、Discordのslash interactionと同じ上流形式へ正規化する。
    message.content = normalizedUpstreamControl;
    return false;
  }

  if (isUpstreamControlCommand(message.content)) {
    // Bot管理・セッション管理・Codex設定は既存connectorのローカル制御へ戻す。
    // Auto Routerへ流すとChatGPT Queueへ誤配送されるため、必ず先に除外する。
    if (message.content.trim().startsWith("/")) {
      await message.reply("この管理コマンドはDiscordのslash command候補から選択して実行してください。任意Shellには渡しません。");
      return true;
    }
    return false;
  }

  if (isAllowedLegacyLocalCommand(message.content)) {
    // These exact upstream commands are themselves the allowlisted Local handler.
    // Let the connector execute them directly so file-browser UI payloads remain intact.
    return false;
  }

  if (isLegacyArbitraryShell(message.content)) {
    await message.reply([
      "任意Shell実行は無効化されています。",
      "Local Modeでは allowlist 済みの status / ls / pwd / git status / git diff / log / build-status / autodev list のみ使用できます。",
    ].join("\n"));
    return true;
  }

  const channelState = await state.state.get(message.channelId);
  const decision = routeMultiBackendMessage({
    content: message.content,
    defaultBackend: channelState.backend,
    attachments: message.attachments,
  });

  if (decision.kind === "passthrough") {
    // 互換用。正式設定ではdefaultBackend=autoなので通常ここには来ない。
    return false;
  }

  if (decision.kind === "set-backend") {
    const next = await state.state.setBackend(message.channelId, decision.backend);
    await message.reply(`このチャンネルの既定処理先を **${backendLabel(next.backend)}** に設定しました。`);
    return true;
  }

  if (decision.kind === "status") {
    const current = await state.state.get(message.channelId);
    const statuses = await state.registry.statuses();
    await message.reply([
      "**Discord Remote Control / ChatGPT Bridge**",
      `Backend: ${backendLabel(current.backend)}`,
      `Workspace: ${current.workspaceRoot ?? channelContext.workspaceRoot}`,
      `CWD: ${channelContext.cwd}`,
      `ChatGPT Queue: ${state.config.chatgptQueue.root}`,
      "優先順位: Local → ChatGPT + DevSpace → Codex(明示指定)",
      "",
      ...statuses.map((status) => `${status.available ? "✓" : "×"} ${status.displayName}: ${status.detail ?? ""}`),
    ].join("\n"));
    return true;
  }

  const backend = decision.kind === "workflow" ? "chatgpt" : decision.backend;
  const text = decision.text;
  if (!text) {
    await message.reply(`依頼内容が空です。例: /${backend === "chatgpt" ? "ask" : backend} <依頼>`);
    return true;
  }

  const dangerous = detectDangerousOperation(text);
  if (dangerous && backend !== "local") {
    const pending = state.confirmations.create({
      channelId: message.channelId,
      userId: message.userId,
      backend,
      text,
      payload: {
        attachments: message.attachments ?? [],
        imageAttachments: message.imageAttachments ?? [],
        messageId: message.messageId ?? "",
        guildId: message.guildId ?? "",
        authorName: message.authorName ?? "",
        timestamp: message.timestamp ?? new Date().toISOString(),
      },
    });
    await message.reply([
      "⚠ **確認が必要です**",
      `対象: ${dangerous}`,
      `処理先: ${backendLabel(backend)}`,
      `実行する場合: \`/confirm ${pending.token}\``,
      `取り消す場合: \`/cancel ${pending.token}\``,
    ].join("\n"));
    return true;
  }

  return executeSelectedBackend(state, backend, text, message, channelContext);
}

export async function startMultiBackendOutboxPump(client: unknown): Promise<() => void> {
  const state = await runtime();
  const compatible = client as { channels?: { fetch(channelId: string): Promise<unknown> } };
  if (!compatible.channels?.fetch) {
    throw new Error("Discord client does not expose channels.fetch().");
  }
  const stops: Array<() => void> = [];
  stops.push(startChatGptOutboxPump({
    root: state.config.chatgptQueue.root,
    allowedOutputRoot: state.config.chatgptQueue.allowedOutputRoot,
    client: compatible as { channels: { fetch(channelId: string): Promise<unknown> } },
    intervalMs: state.config.chatgptQueue.pollIntervalMs,
    onError: (error) => console.error("chatgpt outbox pump failed", error),
  }));
  if (state.config.activityNotifications.enabled) {
    if (!state.config.activityNotifications.channelId) {
      console.warn("activity completion notifications are enabled but no channelId is configured");
    } else {
      stops.push(startActivityNotificationPump({
        root: state.config.activityNotifications.root,
        queueRoot: state.config.chatgptQueue.root,
        channelId: state.config.activityNotifications.channelId,
        allowedOutputRoot: state.config.chatgptQueue.allowedOutputRoot,
        intervalMs: state.config.activityNotifications.pollIntervalMs,
        onError: (error) => console.error("activity notification pump failed", error),
      }));
    }
  }
  return () => {
    for (const stop of stops) stop();
  };
}

export async function describeMultiBackendRuntime(): Promise<string> {
  const state = await runtime();
  return [
    `enabled=${state.config.enabled}`,
    `defaultBackend=${state.config.defaultBackend}`,
    `queueRoot=${path.resolve(state.config.chatgptQueue.root)}`,
    `activityNotify=${state.config.activityNotifications.enabled && state.config.activityNotifications.channelId ? "enabled" : "disabled"}`,
    `publicChannels=${state.config.publicAssistant.channelIds.length}`,
    `publicState=${(await state.publicAssistantState.get()).responding ? "running" : "stopped"}`,
  ].join(" ");
}
