import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { MultiBackendConfig } from "./contracts.ts";

const BRIDGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DISCORD_ROOT = path.resolve(BRIDGE_ROOT, "..");
const AGENTTOOLS_ROOT = path.resolve(DISCORD_ROOT, "..");
const CONNECTOR_ROOT = path.join(DISCORD_ROOT, "codex-discord-connector");
const DEFAULT_CONFIG_PATH = path.join(CONNECTOR_ROOT, ".connect", "config.json");
const DEFAULT_STATE_PATH = path.join(CONNECTOR_ROOT, ".connect", "multibackend-state.json");
const DEFAULT_PUBLIC_STATE_PATH = path.join(CONNECTOR_ROOT, ".connect", "public-assistant-state.json");
const DEFAULT_PUBLIC_WORKSPACE = path.join(DISCORD_ROOT, "public-workspace");
const DEFAULT_ACTIVITY_ROOT = path.join(AGENTTOOLS_ROOT, "agenttools-mcp-gateway", "state", "activity");
const DEFAULT_CHATGPT_QUEUE_ROOT = path.join(DISCORD_ROOT, "discord-chatgpt-bridge");
const DEFAULT_ALLOWED_OUTPUT_ROOT = AGENTTOOLS_ROOT;

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([key, text]) => [key.trim(), text.trim()] as const)
      .filter(([key, text]) => key.length > 0 && text.length > 0),
  );
}

function positiveInteger(value: unknown, fallback: number, minimum = 1): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(minimum, Math.trunc(value))
    : fallback;
}

export async function loadMultiBackendConfig(): Promise<MultiBackendConfig> {
  const configPath = process.env.CONNECT_CONFIG_PATH || DEFAULT_CONFIG_PATH;
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }

  const multi = typeof raw.multiBackend === "object" && raw.multiBackend !== null
    ? raw.multiBackend as Record<string, unknown>
    : {};
  const chatgptQueue = typeof multi.chatgptQueue === "object" && multi.chatgptQueue !== null
    ? multi.chatgptQueue as Record<string, unknown>
    : {};
  const activityNotifications = typeof multi.activityNotifications === "object" && multi.activityNotifications !== null
    ? multi.activityNotifications as Record<string, unknown>
    : {};
  const direct = typeof raw.direct === "object" && raw.direct !== null
    ? raw.direct as Record<string, unknown>
    : {};
  const publicAssistant = typeof multi.publicAssistant === "object" && multi.publicAssistant !== null
    ? multi.publicAssistant as Record<string, unknown>
    : {};
  const environmentChannelIds = (process.env.DISCORD_PUBLIC_CHANNEL_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const configuredChannelIds = stringArray(publicAssistant.channelIds);
  const codexHome = typeof publicAssistant.codexHome === "string" && publicAssistant.codexHome.trim()
    ? publicAssistant.codexHome
    : process.env.CODEX_HOME || path.join(os.homedir(), ".codex");

  const defaultBackend = typeof multi.defaultBackend === "string" && ["local", "chatgpt", "codex", "auto"].includes(multi.defaultBackend)
    ? multi.defaultBackend as MultiBackendConfig["defaultBackend"]
    : "codex";

  return {
    enabled: multi.enabled !== false,
    defaultBackend,
    statePath: typeof multi.statePath === "string" ? multi.statePath : DEFAULT_STATE_PATH,
    chatgptQueue: {
      root: typeof chatgptQueue.root === "string"
        ? chatgptQueue.root
        : DEFAULT_CHATGPT_QUEUE_ROOT,
      allowedOutputRoot: typeof chatgptQueue.allowedOutputRoot === "string"
        ? chatgptQueue.allowedOutputRoot
        : process.env.AGENTTOOLS_ALLOWED_OUTPUT_ROOT || DEFAULT_ALLOWED_OUTPUT_ROOT,
      pollIntervalMs: typeof chatgptQueue.pollIntervalMs === "number" && Number.isFinite(chatgptQueue.pollIntervalMs)
        ? Math.max(5_000, Math.trunc(chatgptQueue.pollIntervalMs))
        : 30_000,
    },
    activityNotifications: {
      enabled: activityNotifications.enabled !== false,
      root: typeof activityNotifications.root === "string" && activityNotifications.root.trim()
        ? activityNotifications.root
        : DEFAULT_ACTIVITY_ROOT,
      channelId: typeof activityNotifications.channelId === "string" && activityNotifications.channelId.trim()
        ? activityNotifications.channelId.trim()
        : typeof direct.channelId === "string" ? direct.channelId.trim() : "",
      pollIntervalMs: typeof activityNotifications.pollIntervalMs === "number" && Number.isFinite(activityNotifications.pollIntervalMs)
        ? Math.max(30_000, Math.trunc(activityNotifications.pollIntervalMs))
        : 30_000,
    },
    publicAssistant: {
      enabled: publicAssistant.enabled !== false,
      channelIds: configuredChannelIds.length > 0 ? configuredChannelIds : environmentChannelIds,
      channelPersonas: stringRecord(publicAssistant.channelPersonas),
      requireBotMention: publicAssistant.requireBotMention !== false,
      respondingByDefault: publicAssistant.respondingByDefault === true,
      statePath: typeof publicAssistant.statePath === "string"
        ? publicAssistant.statePath
        : DEFAULT_PUBLIC_STATE_PATH,
      workspaceRoot: typeof publicAssistant.workspaceRoot === "string"
        ? publicAssistant.workspaceRoot
        : DEFAULT_PUBLIC_WORKSPACE,
      codexHome,
      timeoutMs: positiveInteger(publicAssistant.timeoutMs, 120_000, 10_000),
      maxRequestsPerWindow: positiveInteger(publicAssistant.maxRequestsPerWindow, 5),
      windowMs: positiveInteger(publicAssistant.windowMs, 10 * 60 * 1000, 60_000),
      maxConcurrentTotal: positiveInteger(publicAssistant.maxConcurrentTotal, 2),
      conversationTtlMs: positiveInteger(publicAssistant.conversationTtlMs, 30 * 60 * 1000, 60_000),
      maxConversationTurns: positiveInteger(publicAssistant.maxConversationTurns, 12, 2),
    },
  };
}
