import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

interface FakeMessage {
  userId: string;
  channelId: string;
  content: string;
  roleIds: string[];
  botMentioned: boolean;
  botUserId: string;
  guildId: string;
  authorName: string;
  replies: Array<string | Record<string, unknown>>;
  reply(message: string | Record<string, unknown>): Promise<unknown>;
}

function message(input: Partial<FakeMessage> = {}): FakeMessage {
  const result: FakeMessage = {
    userId: "guest",
    channelId: "public-channel",
    content: "<@bot-id> こんにちは",
    roleIds: [],
    botMentioned: true,
    botUserId: "bot-id",
    guildId: "guild",
    authorName: "guest",
    replies: [],
    async reply(replyMessage) {
      result.replies.push(replyMessage);
      return {};
    },
    ...input,
  };
  return result;
}

test("public channel is mention-only, terminal, read-only Codex routing with admin stop switch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "public-integration-"));
  const previousConfigPath = process.env.CONNECT_CONFIG_PATH;
  try {
    const configPath = path.join(root, "config.json");
    const statePath = path.join(root, "public-state.json");
    const workspaceRoot = path.join(root, "public-workspace");
    const codexHome = path.join(root, "codex-home");
    await writeFile(configPath, JSON.stringify({
      multiBackend: {
        enabled: true,
        defaultBackend: "auto",
        statePath: path.join(root, "multi-state.json"),
        chatgptQueue: {
          root: path.join(root, "queue"),
          allowedOutputRoot: root,
          pollIntervalMs: 2_000,
        },
        publicAssistant: {
          enabled: true,
          channelIds: ["public-channel"],
          channelPersonas: {
            "public-channel": "あなたの名前は『ろひBot』です。自然な猛虎弁を使ってください。",
          },
          requireBotMention: true,
          respondingByDefault: true,
          statePath,
          workspaceRoot,
          codexHome,
          timeoutMs: 120_000,
          maxRequestsPerWindow: 5,
          windowMs: 600_000,
          maxConcurrentTotal: 2,
          conversationTtlMs: 1_800_000,
          maxConversationTurns: 12,
        },
      },
    }), "utf8");
    process.env.CONNECT_CONFIG_PATH = configPath;

    const { tryHandleMultiBackendMessage } = await import(`../src/integration.ts?public-test=${Date.now()}`);
    const channelContext = {
      computerId: "local-dev",
      allowedRoleIds: ["admin-role"],
      workspaceRoot: "D:\\projects",
      cwd: "D:\\projects",
      timeoutMs: 30_000,
    };
    const submitted: Array<Record<string, unknown>> = [];
    const handlerInput = {
      async submitCodexPrompt(input: { payload: Record<string, unknown> }) {
        submitted.push(input.payload);
        return {
          result: {
            status: "completed",
            finalMessage: "こんにちは。何について話しましょうか？",
            sessionId: "public-session-should-not-be-reused",
            stderr: "",
          },
        };
      },
    };

    const withoutMention = message({ botMentioned: false, content: "こんにちは" });
    assert.equal(await tryHandleMultiBackendMessage({ message: withoutMention, channelContext, handlerInput }), true);
    assert.equal(withoutMention.replies.length, 0);
    assert.equal(submitted.length, 0);

    const publicChat = message();
    assert.equal(await tryHandleMultiBackendMessage({ message: publicChat, channelContext, handlerInput }), true);
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0]?.publicMode, true);
    assert.equal(submitted[0]?.sessionId, null);
    assert.equal(submitted[0]?.workspaceRoot, workspaceRoot);
    assert.match(String(submitted[0]?.prompt), /Never run shell commands, Git commands, MCP tools, DevSpace tools/);
    assert.match(String(submitted[0]?.prompt), /ろひBot/);
    assert.match(String(submitted[0]?.prompt), /猛虎弁/);
    assert.equal(publicChat.replies.length, 1);

    const localAttempt = message({ content: "<@bot-id> /local git status" });
    assert.equal(await tryHandleMultiBackendMessage({ message: localAttempt, channelContext, handlerInput }), true);
    assert.equal(submitted.length, 1);
    assert.match(JSON.stringify(localAttempt.replies[0]), /ローカル操作/);

    const adminStop = message({
      userId: "admin",
      content: "__mb_public_assistant stop",
      roleIds: ["admin-role"],
      botMentioned: false,
    });
    assert.equal(await tryHandleMultiBackendMessage({ message: adminStop, channelContext, handlerInput }), true);
    assert.match(String(adminStop.replies[0]), /停止中/);

    const afterStop = message();
    assert.equal(await tryHandleMultiBackendMessage({ message: afterStop, channelContext, handlerInput }), true);
    assert.equal(afterStop.replies.length, 0);
    assert.equal(submitted.length, 1);
  } finally {
    if (previousConfigPath === undefined) delete process.env.CONNECT_CONFIG_PATH;
    else process.env.CONNECT_CONFIG_PATH = previousConfigPath;
    await rm(root, { recursive: true, force: true });
  }
});
