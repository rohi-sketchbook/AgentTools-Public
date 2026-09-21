import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, readdir, rename } from "node:fs/promises";
import path from "node:path";

import { enqueueAgentDiscordMessage } from "./chatgptQueue.ts";

interface ActivityActor {
  id?: string;
  label?: string;
  model?: string | null;
}

interface ActivityWorkLogEntry {
  actor?: ActivityActor;
  phase?: string | null;
  message?: string | null;
}

interface ActivityRecord {
  id?: string;
  title?: string;
  project?: string | null;
  status?: string;
  summary?: string | null;
  phase?: string | null;
  currentWork?: string | null;
  owner?: ActivityActor;
  contributors?: ActivityActor[];
  workLog?: ActivityWorkLogEntry[];
  changedFiles?: string[];
  tests?: string[];
  startedAt?: string;
  completedAt?: string | null;
}

interface ContinuationUsage {
  usedPercent?: number;
  remainingPercent?: number;
}

interface ContinuationNotification {
  attempt?: number;
  model?: string | null;
  triggerReason?: string | null;
  summary?: string | null;
  error?: string | null;
  providerUsage?: ContinuationUsage | null;
  sessionReused?: boolean;
}

interface ActivityNotification {
  notificationKind?: "terminal" | "continuation_started" | "continuation_completed" | "continuation_failed";
  activityId?: string;
  activity?: ActivityRecord;
  taskId?: string;
  task?: ActivityRecord;
  continuation?: ContinuationNotification;
}

interface ActivityNotificationPaths {
  incoming: string;
  sending: string;
  processed: string;
}

function activityPaths(root: string): ActivityNotificationPaths {
  return {
    incoming: path.join(root, "notifications"),
    sending: path.join(root, "sending-notifications"),
    processed: path.join(root, "processed-notifications"),
  };
}

async function ensureActivityDirs(root: string): Promise<ActivityNotificationPaths> {
  const paths = activityPaths(root);
  await Promise.all(Object.values(paths).map((directory) => mkdir(directory, { recursive: true })));
  return paths;
}

function actorDisplay(actor: ActivityActor | undefined): string {
  const label = actor?.label?.trim() || actor?.id?.trim() || "Unknown";
  const model = actor?.model?.trim();
  return model ? `${label} (${model})` : label;
}

function uniqueShort(values: string[], maxItems: number): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, maxItems);
}

function groupedWork(activity: ActivityRecord): string[] {
  const groups = new Map<string, string[]>();
  for (const entry of activity.workLog ?? []) {
    const display = actorDisplay(entry.actor);
    const message = entry.message?.trim();
    if (!message || message === "作業を開始") continue;
    const phase = entry.phase?.trim();
    const detail = phase && !message.startsWith(phase) ? `${phase}: ${message}` : message;
    const current = groups.get(display) ?? [];
    current.push(detail);
    groups.set(display, current);
  }

  if (groups.size === 0) {
    for (const actor of activity.contributors ?? []) groups.set(actorDisplay(actor), []);
  }

  return [...groups.entries()].map(([actor, messages]) => {
    const work = uniqueShort(messages, 4);
    return work.length > 0 ? `- ${actor}: ${work.join(" / ")}` : `- ${actor}`;
  });
}

function elapsedText(activity: ActivityRecord): string | null {
  const start = activity.startedAt ? Date.parse(activity.startedAt) : Number.NaN;
  const end = activity.completedAt ? Date.parse(activity.completedAt) : Number.NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const totalMinutes = Math.max(0, Math.round((end - start) / 60_000));
  if (totalMinutes < 60) return `${totalMinutes}分`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}時間${minutes}分` : `${hours}時間`;
}

function trimDiscordMessage(value: string, maxLength = 1900): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 20).trimEnd()}\n…（以下省略）`;
}

export function formatActivityCompletionMessage(activity: ActivityRecord): string {
  const status = activity.status ?? "completed";
  const icon = status === "completed" ? "✅" : status === "failed" ? "❌" : "⏹️";
  const statusLabel = status === "completed" ? "完了" : status === "failed" ? "失敗" : "中止";
  const lines = [
    `${icon} **AgentTools 作業${statusLabel}**`,
    `**${activity.title?.trim() || activity.id || "名称未設定"}**`,
  ];
  if (activity.project) lines.push(`Project: ${activity.project}`);
  const elapsed = elapsedText(activity);
  if (elapsed) lines.push(`所要時間: ${elapsed}`);

  const work = groupedWork(activity);
  if (work.length > 0) {
    lines.push("", "**担当・実施内容**", ...work);
  }

  if (activity.summary) lines.push("", `**結果**\n${activity.summary}`);

  const changedFiles = uniqueShort(activity.changedFiles ?? [], 8);
  if (changedFiles.length > 0) {
    const suffix = (activity.changedFiles?.length ?? 0) > changedFiles.length ? ` ほか${(activity.changedFiles?.length ?? 0) - changedFiles.length}件` : "";
    lines.push("", `**変更** ${changedFiles.join(", ")}${suffix}`);
  }

  const tests = uniqueShort(activity.tests ?? [], 6);
  if (tests.length > 0) lines.push("", `**検証** ${tests.join(" / ")}`);
  return trimDiscordMessage(lines.join("\n"));
}

function continuationUsageText(usage: ContinuationUsage | null | undefined): string | null {
  const rawUsed = usage?.usedPercent;
  const rawRemaining = usage?.remainingPercent;
  const hasUsed = rawUsed !== null && rawUsed !== undefined && Number.isFinite(Number(rawUsed));
  const hasRemaining = rawRemaining !== null && rawRemaining !== undefined && Number.isFinite(Number(rawRemaining));
  if (!hasUsed && !hasRemaining) return "Codex利用枠: 未取得";
  if (hasUsed && hasRemaining) return `Codex利用枠: ${Number(rawUsed)}%使用 / ${Number(rawRemaining)}%残り`;
  if (hasUsed) return `Codex利用枠: ${Number(rawUsed)}%使用`;
  return `Codex利用枠: ${Number(rawRemaining)}%残り`;
}

export function formatContinuationMessage(
  kind: "continuation_started" | "continuation_completed" | "continuation_failed",
  activity: ActivityRecord,
  continuation: ContinuationNotification | undefined,
): string {
  const model = continuation?.model?.trim() || "Codex";
  const attempt = Number(continuation?.attempt);
  const title = activity.title?.trim() || activity.id || "名称未設定";
  const lines = kind === "continuation_started"
    ? ["🔄 **AgentTools 自動継続開始**", `**${title}**`, `ChatGPTの実行停止を検知し、Codex (${model})へ引き継ぎました。`]
    : kind === "continuation_completed"
      ? ["✅ **AgentTools 自動継続完了**", `**${title}**`, `Codex (${model})のローカル作業が完了しました。ChatGPTの最終確認待ちです。`]
      : ["⚠️ **AgentTools 自動継続失敗**", `**${title}**`, `Codex (${model})で継続できなかったため、ChatGPTでの再開待ちです。`];

  if (activity.project) lines.push(`Project: ${activity.project}`);
  if (Number.isFinite(attempt) && attempt > 0) lines.push(`引き継ぎ回数: ${attempt}回`);
  if (kind === "continuation_started" && continuation?.sessionReused) lines.push("Session: 既存Codex contextを継続");
  if (kind === "continuation_started" && continuation?.triggerReason) lines.push(`理由: ${continuation.triggerReason}`);
  if (activity.currentWork) lines.push(`次の作業: ${activity.currentWork}`);
  const usage = continuationUsageText(continuation?.providerUsage);
  if (usage) lines.push(usage);
  if (kind === "continuation_completed" && continuation?.summary) lines.push("", `**Codex結果**\n${continuation.summary}`);
  if (kind === "continuation_failed" && continuation?.error) lines.push("", `**エラー**\n${continuation.error}`);
  return trimDiscordMessage(lines.join("\n"));
}

function formatNotificationMessage(payload: ActivityNotification, activity: ActivityRecord): string {
  if (payload.notificationKind === "continuation_started"
    || payload.notificationKind === "continuation_completed"
    || payload.notificationKind === "continuation_failed") {
    return formatContinuationMessage(payload.notificationKind, activity, payload.continuation);
  }
  return formatActivityCompletionMessage(activity);
}

async function deliverActivityNotification(input: {
  root: string;
  fileName: string;
  queueRoot: string;
  channelId: string;
  allowedOutputRoot: string;
}): Promise<void> {
  const paths = await ensureActivityDirs(input.root);
  const source = path.join(paths.incoming, input.fileName);
  const claimed = path.join(paths.sending, input.fileName);
  const processed = path.join(paths.processed, input.fileName);

  try {
    await rename(source, claimed);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }

  let queued = false;
  try {
    const payload = JSON.parse(await readFile(claimed, "utf8")) as ActivityNotification;
    const activity = payload.task ?? payload.activity;
    const notificationId = payload.taskId ?? payload.activityId;
    if (!notificationId || !activity || activity.id !== notificationId) {
      throw new Error(`Invalid task notification: ${input.fileName}`);
    }
    await enqueueAgentDiscordMessage(input.queueRoot, {
      channelId: input.channelId,
      content: formatNotificationMessage(payload, activity),
      attachments: [],
      allowedOutputRoot: input.allowedOutputRoot,
    });
    queued = true;
    await rename(claimed, processed);
  } catch (error) {
    if (!queued) {
      try { await rename(claimed, source); } catch { /* best effort; leave for manual recovery */ }
    }
    throw error;
  }
}

export async function pumpActivityNotificationsOnce(input: {
  root: string;
  queueRoot: string;
  channelId: string;
  allowedOutputRoot: string;
}): Promise<number> {
  if (!input.channelId.trim()) return 0;
  const paths = await ensureActivityDirs(input.root);
  const files = (await readdir(paths.incoming)).filter((name) => name.endsWith(".json")).sort();
  for (const fileName of files) {
    await deliverActivityNotification({ ...input, fileName });
  }
  return files.length;
}

export function startActivityNotificationPump(input: {
  root: string;
  queueRoot: string;
  channelId: string;
  allowedOutputRoot: string;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}): () => void {
  let running = false;
  let stopped = false;
  let watcher: FSWatcher | null = null;
  const fallbackIntervalMs = Math.max(30_000, input.intervalMs ?? 30_000);

  const tick = async () => {
    if (stopped || running || !input.channelId.trim()) return;
    running = true;
    try {
      await pumpActivityNotificationsOnce(input);
    } catch (error) {
      input.onError?.(error);
    } finally {
      running = false;
    }
  };

  void ensureActivityDirs(input.root)
    .then((paths) => {
      if (stopped) return;
      try {
        watcher = watch(paths.incoming, (_eventType, fileName) => {
          if (!fileName || String(fileName).toLowerCase().endsWith(".json")) void tick();
        });
        watcher.on("error", (error) => input.onError?.(error));
        watcher.unref();
      } catch (error) {
        input.onError?.(error);
      }
    })
    .catch((error) => input.onError?.(error));

  void tick();
  // performance-audit: allow-bounded-poll — safety fallback only; normal delivery is event-driven through fs.watch.
  const timer = setInterval(() => void tick(), fallbackIntervalMs);
  timer.unref();

  return () => {
    stopped = true;
    clearInterval(timer);
    watcher?.close();
  };
}
