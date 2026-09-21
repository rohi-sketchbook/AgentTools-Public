import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ChatGptQueueBackend } from "../src/backends/chatGptQueueBackend.ts";

const sampleWorkspace = path.join(os.tmpdir(), "discord-chatgpt-sample-workspace");
import {
  claimChatGptRequest,
  completeChatGptRequest,
  enqueueAgentDiscordMessage,
  listPendingChatGptRequests,
  normalizeDiscordLineBreaks,
  pumpChatGptOutboxOnce,
  startChatGptOutboxPump,
} from "../src/chatgptQueue.ts";

test("Discord送信文の文字列改行コードを実改行へ正規化する", () => {
  assert.equal(
    normalizeDiscordLineBreaks("見出し\\n本文\\r\\n末尾 `\\n`"),
    "見出し\n本文\n末尾 `\\n`",
  );
});

test("ChatGPT queue request moves inbox -> processing -> outbox", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discord-chatgpt-queue-test-"));
  const backend = new ChatGptQueueBackend(root);
  const result = await backend.execute({
    text: "変更点を調査して",
    workspaceRoot: sampleWorkspace,
    cwd: sampleWorkspace,
    channelId: "channel-1",
    userId: "user-1",
    metadata: {
      guildId: "guild-1",
      messageId: "message-1",
      authorName: "example-user",
      timestamp: "2026-07-25T12:34:56+09:00",
    },
  }, {});

  assert.equal(result.status, "completed");
  const requestId = String(result.metadata?.requestId);
  const pending = await listPendingChatGptRequests(root);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.requestId, requestId);
  assert.equal(pending[0]?.data.status, "pending");

  const claimed = await claimChatGptRequest(root, requestId);
  assert.equal(claimed.data.status, "processing");

  const outboxPath = await completeChatGptRequest(root, requestId, {
    channelId: "channel-1",
    replyToMessageId: "message-1",
    content: "調査完了",
    attachments: [],
  });
  const outbox = JSON.parse(await readFile(outboxPath, "utf8")) as Record<string, unknown>;
  assert.equal(outbox.requestId, requestId);
  assert.equal(outbox.channelId, "channel-1");
  assert.equal(outbox.content, "調査完了");
});

test("Discord CDN attachment is materialized under the ChatGPT queue", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discord-chatgpt-attachment-test-"));
  const backend = new ChatGptQueueBackend(root);
  const originalFetch = globalThis.fetch;
  const attachmentBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

  globalThis.fetch = (async (url: string | URL | Request) => ({
    ok: true,
    status: 200,
    url: String(url),
    async arrayBuffer() {
      return attachmentBytes.buffer.slice(
        attachmentBytes.byteOffset,
        attachmentBytes.byteOffset + attachmentBytes.byteLength,
      );
    },
  })) as typeof fetch;

  try {
    const result = await backend.execute({
      text: "この画像を確認して",
      workspaceRoot: sampleWorkspace,
      cwd: sampleWorkspace,
      channelId: "channel-attachment",
      userId: "user-attachment",
      attachments: [{
        url: "https://cdn.discordapp.com/attachments/1/2/image.png",
        name: "image.png",
        contentType: "image/png",
        size: attachmentBytes.byteLength,
      }],
      metadata: { messageId: "message-attachment" },
    }, {});

    const requestId = String(result.metadata?.requestId);
    const pending = await listPendingChatGptRequests(root);
    const attachment = pending[0]?.data.attachments?.[0] as { path?: string; size?: number } | undefined;
    assert.equal(pending[0]?.requestId, requestId);
    assert.ok(attachment?.path);
    assert.equal(attachment?.size, attachmentBytes.byteLength);
    assert.deepEqual(await readFile(attachment.path), attachmentBytes);
    assert.match(path.normalize(attachment.path), new RegExp(`${path.sep}attachments${path.sep}`.replace(/\\/g, "\\\\")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("outbox pump replies once and archives the claimed JSON", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discord-chatgpt-outbox-test-"));
  const backend = new ChatGptQueueBackend(root);
  const queued = await backend.execute({
    text: "調査して",
    workspaceRoot: path.dirname(root),
    cwd: path.dirname(root),
    channelId: "channel-1",
    userId: "user-1",
    metadata: { messageId: "message-2" },
  }, {});
  const requestId = String(queued.metadata?.requestId);
  await claimChatGptRequest(root, requestId);
  await completeChatGptRequest(root, requestId, {
    channelId: "channel-1",
    replyToMessageId: "message-2",
    content: "x".repeat(2_100),
    attachments: [],
  });

  const sentPayloads: unknown[] = [];
  const fakeClient = {
    channels: {
      async fetch() {
        return {
          messages: {
            async fetch() {
              return { async reply(payload: unknown) { sentPayloads.push(payload); } };
            },
          },
          async send(payload: unknown) { sentPayloads.push(payload); },
        };
      },
    },
  };

  assert.equal(await pumpChatGptOutboxOnce(root, fakeClient), 1);
  assert.equal(sentPayloads.length, 1);
  const payload = sentPayloads[0] as { content: string; files: Array<{ attachment: unknown; name: string }> };
  assert.match(payload.content, /回答全文は添付テキスト/);
  assert.equal(payload.files.at(-1)?.name, `${requestId}-response.txt`);
  await stat(path.join(root, "processed", "outbox", `${requestId}.json`));
  assert.equal(await pumpChatGptOutboxOnce(root, fakeClient), 0);
  assert.equal(sentPayloads.length, 1);
});

test("outbox pump reacts to filesystem events without waiting for fallback polling", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "discord-outbox-watch-test-"));
  const root = path.join(base, "queue");
  const sentPayloads: unknown[] = [];
  const fakeClient = {
    channels: {
      async fetch() {
        return { async send(payload: unknown) { sentPayloads.push(payload); } };
      },
    },
  };
  const stop = startChatGptOutboxPump({
    root,
    client: fakeClient,
    allowedOutputRoot: base,
    intervalMs: 60_000,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await enqueueAgentDiscordMessage(root, {
      channelId: "channel-watch",
      content: "event-driven",
      allowedOutputRoot: base,
    });
    const deadline = Date.now() + 3_000;
    while (sentPayloads.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(sentPayloads.length, 1);
  } finally {
    stop();
  }
});

test("agent outbound message can attach a file from an explicit allowed output root", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "discord-agent-outbound-test-"));
  const root = path.join(base, "discord-bot", "discord-chatgpt-bridge");
  const artifactDir = path.join(base, "backgrounds");
  await import("node:fs/promises").then(({ mkdir }) => Promise.all([
    mkdir(root, { recursive: true }),
    mkdir(artifactDir, { recursive: true }),
  ]));
  const artifact = path.join(artifactDir, "render.png");
  await writeFile(artifact, Buffer.from([1, 2, 3]));

  const queued = await enqueueAgentDiscordMessage(root, {
    channelId: "channel-agent",
    content: "render\\ncompleted",
    attachments: [{ path: artifact }],
    allowedOutputRoot: base,
  });

  const sentPayloads: unknown[] = [];
  const fakeClient = {
    channels: {
      async fetch() {
        return { async send(payload: unknown) { sentPayloads.push(payload); } };
      },
    },
  };

  assert.equal(await pumpChatGptOutboxOnce(root, fakeClient, base), 1);
  assert.equal(sentPayloads.length, 1);
  const payload = sentPayloads[0] as { content: string; files: Array<{ attachment: string; name: string }> };
  assert.equal(payload.content, "render\ncompleted");
  assert.equal(payload.files[0]?.attachment, artifact);
  await stat(path.join(root, "processed", "outbox", `${queued.requestId}.json`));
});

test("agent outbound decision message preserves validated Discord buttons", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "discord-agent-decision-test-"));
  const root = path.join(base, "queue");
  const queued = await enqueueAgentDiscordMessage(root, {
    channelId: "channel-agent",
    content: "判断してください",
    components: [{
      type: 1,
      components: [{
        type: 2,
        style: 3,
        custom_id: "adv:decision:issue-123:recommended",
        label: "推奨案で進める",
      }],
    }],
    allowedOutputRoot: base,
  });

  const sentPayloads: unknown[] = [];
  const fakeClient = {
    channels: {
      async fetch() {
        return { async send(payload: unknown) { sentPayloads.push(payload); } };
      },
    },
  };

  assert.equal(await pumpChatGptOutboxOnce(root, fakeClient, base), 1);
  const payload = sentPayloads[0] as { components: Array<{ components: Array<{ custom_id: string }> }> };
  assert.equal(payload.components[0]?.components[0]?.custom_id, "adv:decision:issue-123:recommended");
  await stat(path.join(root, "processed", "outbox", `${queued.requestId}.json`));

  await assert.rejects(() => enqueueAgentDiscordMessage(root, {
    channelId: "channel-agent",
    content: "invalid",
    components: [{
      type: 1,
      components: [{ type: 2, style: 3, custom_id: "cdc:unsafe", label: "unsafe" }],
    }],
    allowedOutputRoot: base,
  }), /invalid custom_id/);
});

test("agent outbound message rejects attachment outside allowed output root", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "discord-agent-boundary-test-"));
  const root = path.join(base, "queue");
  const outside = await mkdtemp(path.join(os.tmpdir(), "discord-agent-outside-test-"));
  const artifact = path.join(outside, "outside.txt");
  await writeFile(artifact, "x", "utf8");

  await assert.rejects(() => enqueueAgentDiscordMessage(root, {
    channelId: "channel-agent",
    content: "nope",
    attachments: [{ path: artifact }],
    allowedOutputRoot: base,
  }), /outside the allowed root/);
});

test("outbox pump rejects channelId tampering", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discord-chatgpt-tamper-test-"));
  const backend = new ChatGptQueueBackend(root);
  const queued = await backend.execute({
    text: "調査して",
    workspaceRoot: path.dirname(root),
    cwd: path.dirname(root),
    channelId: "channel-1",
    userId: "user-1",
    metadata: { messageId: "message-3" },
  }, {});
  const requestId = String(queued.metadata?.requestId);
  await claimChatGptRequest(root, requestId);
  const outboxPath = await completeChatGptRequest(root, requestId, {
    channelId: "channel-1",
    replyToMessageId: "message-3",
    content: "ok",
    attachments: [],
  });
  const payload = JSON.parse(await readFile(outboxPath, "utf8")) as Record<string, unknown>;
  payload.channelId = "channel-other";
  await writeFile(outboxPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  let sendCount = 0;
  const fakeClient = {
    channels: {
      async fetch() {
        return { async send() { sendCount += 1; } };
      },
    },
  };
  await assert.rejects(() => pumpChatGptOutboxOnce(root, fakeClient), /channelId does not match/);
  assert.equal(sendCount, 0);
  await stat(outboxPath);
});
