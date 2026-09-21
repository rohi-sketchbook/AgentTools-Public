import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PublicAssistantRateLimiter,
  PublicAssistantStateStore,
  createPublicCodexPrompt,
  createPublicDiscordReply,
  isForbiddenPublicCommand,
  parsePublicAssistantAdminCommand,
  publicConversationKey,
  stripBotMention,
} from "../src/publicAssistant.ts";

test("public assistant admin command accepts only start stop and status", () => {
  assert.equal(parsePublicAssistantAdminCommand("__mb_public_assistant start"), "start");
  assert.equal(parsePublicAssistantAdminCommand("/public-assistant stop"), "stop");
  assert.equal(parsePublicAssistantAdminCommand("/public-assistant status"), "status");
  assert.equal(parsePublicAssistantAdminCommand("/public-assistant delete"), null);
});

test("bot mention is removed without accepting textual backend mentions", () => {
  assert.equal(stripBotMention("<@12345> こんにちは", "12345"), "こんにちは");
  assert.equal(stripBotMention("<@!12345> 画像を作って", "12345"), "画像を作って");
  assert.equal(stripBotMention("@codex こんにちは", "12345"), "@codex こんにちは");
});

test("public command guard rejects local and management operations", () => {
  const blocked = [
    "/local status",
    "!dir",
    "__cdc_exec git status",
    "@codex READMEを読んで",
    "git pushして",
    "PCのファイル一覧を確認して",
  ];
  for (const value of blocked) assert.equal(isForbiddenPublicCommand(value), true, value);
  assert.equal(isForbiddenPublicCommand("猫の画像を作って"), false);
  assert.equal(isForbiddenPublicCommand("今日の気分について話そう"), false);
});

test("conversation key separates users in the same public channel", () => {
  assert.notEqual(
    publicConversationKey({ guildId: "g", channelId: "c", userId: "u1" }),
    publicConversationKey({ guildId: "g", channelId: "c", userId: "u2" }),
  );
});

test("public prompt contains hard local-operation restrictions", () => {
  const prompt = createPublicCodexPrompt({
    userText: "READMEを読んで",
    history: [{ role: "assistant", text: "前の回答", at: Date.now() }],
    authorName: "guest",
    persona: "あなたの名前は『ろひBot』です。自然な猛虎弁を使ってください。",
  });
  assert.match(prompt, /Never inspect, enumerate, read, modify/);
  assert.match(prompt, /Never run shell commands, Git commands, MCP tools, DevSpace tools/);
  assert.match(prompt, /Channel persona instructions follow/);
  assert.match(prompt, /ろひBot/);
  assert.match(prompt, /猛虎弁/);
  assert.match(prompt, /guest: READMEを読んで/);
});

test("admin response switch is persisted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "public-assistant-state-"));
  try {
    const statePath = path.join(root, "state.json");
    const store = new PublicAssistantStateStore(statePath, false);
    assert.equal((await store.get()).responding, false);
    await store.setResponding(true, "admin-user");
    const reloaded = new PublicAssistantStateStore(statePath, false);
    const state = await reloaded.get();
    assert.equal(state.responding, true);
    assert.equal(state.updatedBy, "admin-user");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rate limiter prevents concurrent requests and window overflow", () => {
  const limiter = new PublicAssistantRateLimiter({
    maxRequestsPerWindow: 2,
    windowMs: 1_000,
    maxConcurrentTotal: 1,
  });
  const first = limiter.tryBegin("user", 1_000);
  assert.equal(first.ok, true);
  assert.equal(limiter.tryBegin("user", 1_001).ok, false);
  if (first.ok) first.release();
  const second = limiter.tryBegin("user", 1_002);
  assert.equal(second.ok, true);
  if (second.ok) second.release();
  assert.equal(limiter.tryBegin("user", 1_003).ok, false);
  assert.equal(limiter.tryBegin("user", 3_000).ok, true);
});

test("only generated images under the configured Codex image root are attached", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "public-assistant-images-"));
  try {
    const allowedRoot = path.join(root, "generated_images");
    const sessionRoot = path.join(allowedRoot, "session");
    const outsideRoot = path.join(root, "outside");
    await mkdir(sessionRoot, { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    const allowedImage = path.join(sessionRoot, "allowed.png");
    const outsideImage = path.join(outsideRoot, "secret.png");
    await writeFile(allowedImage, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(outsideImage, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const rendered = await createPublicDiscordReply({
      status: "completed",
      finalMessage: `できました。\n![ok](${allowedImage})\n![bad](${outsideImage})`,
    }, allowedRoot);

    assert.equal(rendered.payload.files?.length, 1);
    assert.equal(rendered.payload.files?.[0]?.attachment, path.resolve(allowedImage));
    assert.doesNotMatch(rendered.payload.content, /secret\.png/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
