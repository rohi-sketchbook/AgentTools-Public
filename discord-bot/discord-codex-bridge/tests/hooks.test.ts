import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { localizeSourceForTest } from "../jp-hooks.mjs";
import { routeDiscordComponent } from "../../codex-discord-connector/apps/discord-bot/src/componentRouter.ts";

const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const connectorRoot = path.resolve(bridgeRoot, "..", "codex-discord-connector");
const require = createRequire(import.meta.url);
const esbuild = require(path.join(connectorRoot, "node_modules", "esbuild", "lib", "main.js")) as {
  transform(source: string, options: { loader: string; format: string }): Promise<unknown>;
};

async function transformed(relativePath: string): Promise<string> {
  return localizeSourceForTest(await readFile(path.join(connectorRoot, relativePath), "utf8"));
}

test("message handler injects MultiBackend routing before upstream Codex routing", async () => {
  const source = await transformed("apps/discord-bot/src/messageHandler.ts");
  assert.match(source, /tryHandleMultiBackendMessage/);
  assert.match(source, /handlerInput: input/);
  await esbuild.transform(source, { loader: "ts", format: "esm" });
});

test("Discord client forwards metadata and all attachments", async () => {
  const source = await transformed("apps/discord-bot/src/discordClient.ts");
  assert.match(source, /bridgeAttachments/);
  assert.match(source, /messageId: discordMessage\.id/);
  assert.match(source, /authorName:/);
  assert.match(source, /botMentioned:/);
  assert.match(source, /botUserId:/);
  await esbuild.transform(source, { loader: "ts", format: "esm" });
});

test("application commands include new routes and remove arbitrary shell", async () => {
  const source = await transformed("apps/discord-bot/src/applicationCommands.ts");
  assert.match(source, /name: "ask"/);
  assert.match(source, /name: "local"/);
  assert.match(source, /name: "backend"/);
  assert.match(source, /name: "confirm"/);
  assert.match(source, /name: "public-assistant"/);
  assert.match(source, /__mb_public_assistant/);
  assert.doesNotMatch(source, /name: "shell"/);
  assert.match(source, /case "fix-tests":\n\s+return "@chatgpt /);
  assert.match(source, /case "summarize":\n\s+return `@chatgpt /);
  assert.match(source, /case "review":\n\s+return `@chatgpt /);
  await esbuild.transform(source, { loader: "ts", format: "esm" });
});

test("AutoDev decision buttons route to the guarded local decision command", () => {
  assert.equal(
    routeDiscordComponent("adv:decision:issue-123:split"),
    "__autodev_decide issue-123 split",
  );
  assert.equal(routeDiscordComponent("adv:decision:../unsafe:split"), null);
});

test("component actions no longer invoke Codex for review/fix/file AI work", async () => {
  const source = await transformed("apps/discord-bot/src/componentRouter.ts");
  assert.match(source, /@chatgpt 選択したファイルを要約してください/);
  assert.match(source, /@chatgpt 現在の変更内容をレビューし、危険な箇所を教えてください/);
  assert.match(source, /@chatgpt テスト失敗を分析して修正してください/);
  await esbuild.transform(source, { loader: "ts", format: "esm" });
});

test("direct mode resolves configured public channels to the isolated workspace", async () => {
  const configSource = await transformed("apps/discord-bot/src/connectConfig.ts");
  const clientSource = await transformed("apps/discord-bot/src/directControlClient.ts");
  assert.match(configSource, /publicAssistant\?:/);
  assert.match(clientSource, /configuredPublicChannelIds/);
  assert.match(clientSource, /Public Discord Assistant/);
  assert.match(clientSource, /public-workspace/);
  await esbuild.transform(configSource, { loader: "ts", format: "esm" });
  await esbuild.transform(clientSource, { loader: "ts", format: "esm" });
});

test("public Codex mode is ephemeral read-only and ignores local config", async () => {
  const source = await transformed("apps/local-agent/src/codexRunner.ts");
  assert.match(source, /publicMode\?: boolean/);
  assert.match(source, /--ignore-user-config/);
  assert.match(source, /--ignore-rules/);
  assert.match(source, /--ephemeral/);
  assert.match(source, /\"--sandbox\", \"read-only\"/);
  assert.match(source, /\"--disable\", \"shell_tool\"/);
  assert.match(source, /\"--disable\", \"computer_use\"/);
  assert.match(source, /\"--disable\", \"plugins\"/);
  assert.doesNotMatch(source, /\"--disable\", \"image_generation\"/);
  assert.match(source, /env: input\.publicMode/);
  await esbuild.transform(source, { loader: "ts", format: "esm" });
});

test("Windows background helper processes are hidden", async () => {
  const codexRunner = await transformed("apps/local-agent/src/codexRunner.ts");
  const shellRunner = await transformed("apps/local-agent/src/runner.ts");
  const parser = await transformed("packages/codex-adapter/src/parser.ts");
  const connectCli = await transformed("apps/connect-cli/src/index.ts");

  assert.match(codexRunner, /windowsHide: true/);
  assert.match(shellRunner, /windowsHide: true/);
  assert.match(parser, /windowsHide: true/);
  assert.match(connectCli, /windowsHide: true/);

  await esbuild.transform(codexRunner, { loader: "ts", format: "esm" });
  await esbuild.transform(shellRunner, { loader: "ts", format: "esm" });
  await esbuild.transform(parser, { loader: "ts", format: "esm" });
  await esbuild.transform(connectCli, { loader: "ts", format: "esm" });
});

test("bot index starts ChatGPT outbox pump", async () => {
  const source = await transformed("apps/discord-bot/src/index.ts");
  assert.match(source, /startMultiBackendOutboxPump/);
  await esbuild.transform(source, { loader: "ts", format: "esm" });
});

test("supervisor reads UTF-8 config so Japanese personas remain valid JSON", async () => {
  const source = await readFile(new URL("../run-localized-bot-supervisor.ps1", import.meta.url), "utf8");
  assert.match(source, /Get-Content -Raw -Encoding UTF8 -LiteralPath \$configPath \| ConvertFrom-Json/);
});
