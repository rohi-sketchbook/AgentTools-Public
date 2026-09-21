import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { formatActivityCompletionMessage, formatContinuationMessage, pumpActivityNotificationsOnce } from "../src/activityNotifications.ts";

test("activity completion formatter reports who did what", () => {
  const message = formatActivityCompletionMessage({
    id: "act_demo",
    title: "設定UI修正",
    project: "VR Avatar Studio",
    status: "completed",
    summary: "実装と検証が完了",
    startedAt: "2026-08-24T00:00:00.000Z",
    completedAt: "2026-08-24T00:20:00.000Z",
    workLog: [
      { actor: { id: "chatgpt", label: "ChatGPT", model: "GPT-5.6 Sol" }, phase: "設計", message: "入力仕様を整理" },
      { actor: { id: "codex", label: "Codex", model: "Terra" }, phase: "実装", message: "設定UIを実装" },
      { actor: { id: "chatgpt", label: "ChatGPT", model: "GPT-5.6 Sol" }, phase: "レビュー", message: "差分レビューとビルド確認" },
    ],
    changedFiles: ["InputSettings.cs"],
    tests: ["dotnet build: OK"],
  });
  assert.match(message, /ChatGPT \(GPT-5\.6 Sol\).*入力仕様を整理/);
  assert.match(message, /Codex \(Terra\).*設定UIを実装/);
  assert.match(message, /差分レビューとビルド確認/);
  assert.match(message, /実装と検証が完了/);
});

test("continuation formatter distinguishes system notification from arbitrary Discord posts", () => {
  const started = formatContinuationMessage("continuation_started", {
    id: "task_cont",
    title: "長時間作業",
    project: "AgentTools",
    currentWork: "ローカルテストを継続",
  }, {
    attempt: 2,
    model: "gpt-6-astra",
    triggerReason: "chatgpt_execution timeout",
    providerUsage: { usedPercent: 31, remainingPercent: 69 },
    sessionReused: true,
  });
  assert.match(started, /自動継続開始/);
  assert.match(started, /gpt-6-astra/);
  assert.match(started, /引き継ぎ回数: 2回/);
  assert.match(started, /既存Codex contextを継続/);
  assert.match(started, /Codex利用枠: 31%使用 \/ 69%残り/);

  const completed = formatContinuationMessage("continuation_completed", {
    id: "task_cont",
    title: "長時間作業",
  }, {
    attempt: 2,
    model: "gpt-6-astra",
    summary: "ローカルテストまで完了",
  });
  assert.match(completed, /自動継続完了/);
  assert.match(completed, /ChatGPTの最終確認待ち/);
  assert.match(completed, /ローカルテストまで完了/);
  assert.match(completed, /Codex利用枠: 未取得/);
});

test("task notification pump queues one Discord message and archives notification", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "task-notification-test-"));
  const activityRoot = path.join(base, "activity");
  const queueRoot = path.join(base, "queue");
  try {
    await mkdir(path.join(activityRoot, "notifications"), { recursive: true });
    const notification = {
      schema: "agenttools-task-notification/v1",
      taskId: "task_123",
      task: {
        id: "task_123",
        title: "テスト作業",
        status: "completed",
        summary: "完了しました",
        contributors: [{ id: "chatgpt", label: "ChatGPT", model: "GPT-5.6 Sol" }],
        workLog: [{ actor: { id: "chatgpt", label: "ChatGPT", model: "GPT-5.6 Sol" }, phase: "実装", message: "テスト実装" }],
      },
    };
    await writeFile(path.join(activityRoot, "notifications", "task_123.json"), `${JSON.stringify(notification)}\n`, "utf8");

    const count = await pumpActivityNotificationsOnce({
      root: activityRoot,
      queueRoot,
      channelId: "channel-1",
      allowedOutputRoot: base,
    });
    assert.equal(count, 1);
    assert.deepEqual(await readdir(path.join(activityRoot, "notifications")), []);
    assert.deepEqual(await readdir(path.join(activityRoot, "processed-notifications")), ["task_123.json"]);

    const outboxFiles = (await readdir(path.join(queueRoot, "outbox"))).filter((name) => name.endsWith(".json"));
    assert.equal(outboxFiles.length, 1);
    const outbox = JSON.parse(await readFile(path.join(queueRoot, "outbox", outboxFiles[0]!), "utf8")) as Record<string, unknown>;
    assert.equal(outbox.channelId, "channel-1");
    assert.match(String(outbox.content), /AgentTools 作業完了/);
    assert.match(String(outbox.content), /ChatGPT \(GPT-5\.6 Sol\)/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("continuation notification pump emits standardized lifecycle message", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "continuation-notification-test-"));
  const activityRoot = path.join(base, "activity");
  const queueRoot = path.join(base, "queue");
  try {
    await mkdir(path.join(activityRoot, "notifications"), { recursive: true });
    const fileName = "task_cont--continuation_started--1.json";
    const notification = {
      schema: "agenttools-task-notification/v1",
      notificationKind: "continuation_started",
      taskId: "task_cont",
      task: {
        id: "task_cont",
        title: "長時間作業",
        project: "AgentTools",
        currentWork: "ローカルテストを継続",
      },
      continuation: {
        attempt: 1,
        model: "gpt-6-astra",
        triggerReason: "chatgpt_execution timeout",
        providerUsage: { usedPercent: 32, remainingPercent: 68 },
        sessionReused: true,
      },
    };
    await writeFile(path.join(activityRoot, "notifications", fileName), `${JSON.stringify(notification)}\n`, "utf8");

    const count = await pumpActivityNotificationsOnce({
      root: activityRoot,
      queueRoot,
      channelId: "channel-1",
      allowedOutputRoot: base,
    });
    assert.equal(count, 1);
    assert.deepEqual(await readdir(path.join(activityRoot, "processed-notifications")), [fileName]);
    const outboxFiles = (await readdir(path.join(queueRoot, "outbox"))).filter((name) => name.endsWith(".json"));
    assert.equal(outboxFiles.length, 1);
    const outbox = JSON.parse(await readFile(path.join(queueRoot, "outbox", outboxFiles[0]!), "utf8")) as Record<string, unknown>;
    assert.match(String(outbox.content), /AgentTools 自動継続開始/);
    assert.match(String(outbox.content), /Codex利用枠: 32%使用 \/ 68%残り/);
    assert.match(String(outbox.content), /既存Codex contextを継続/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
