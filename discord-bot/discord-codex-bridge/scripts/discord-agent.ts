import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { enqueueAgentDiscordMessage } from "../src/chatgptQueue.ts";

const BRIDGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DISCORD_ROOT = path.resolve(BRIDGE_ROOT, "..");
const AGENTTOOLS_ROOT = path.resolve(DISCORD_ROOT, "..");
const DEFAULT_CONFIG_PATH = path.join(DISCORD_ROOT, "codex-discord-connector", ".connect", "config.json");
const DEFAULT_QUEUE_ROOT = path.join(DISCORD_ROOT, "discord-chatgpt-bridge");

interface CliOptions {
  content?: string;
  contentFile?: string;
  componentsJson?: string;
  attachments: string[];
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { attachments: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--content") {
      options.content = args[++index];
      if (options.content === undefined) throw new Error("--content requires a value.");
      continue;
    }
    if (arg === "--content-file") {
      options.contentFile = args[++index];
      if (options.contentFile === undefined) throw new Error("--content-file requires a value.");
      continue;
    }
    if (arg === "--attachment") {
      const attachment = args[++index];
      if (attachment === undefined) throw new Error("--attachment requires a path.");
      options.attachments.push(attachment);
      continue;
    }
    if (arg === "--components-json") {
      options.componentsJson = args[++index];
      if (options.componentsJson === undefined) throw new Error("--components-json requires a value.");
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.content !== undefined && options.contentFile !== undefined) {
    throw new Error("Use either --content or --content-file, not both.");
  }
  return options;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== "send") {
    throw new Error("Usage: discord-agent.ts send [--content <text> | --content-file <path>] [--components-json <json>] [--attachment <path>]...");
  }

  const options = parseArgs(rest);
  const configPath = process.env.CONNECT_CONFIG_PATH || DEFAULT_CONFIG_PATH;
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  const direct = typeof config.direct === "object" && config.direct !== null
    ? config.direct as Record<string, unknown>
    : {};
  const multiBackend = typeof config.multiBackend === "object" && config.multiBackend !== null
    ? config.multiBackend as Record<string, unknown>
    : {};
  const queueConfig = typeof multiBackend.chatgptQueue === "object" && multiBackend.chatgptQueue !== null
    ? multiBackend.chatgptQueue as Record<string, unknown>
    : {};

  const channelId = typeof direct.channelId === "string" ? direct.channelId : "";
  const queueRoot = typeof queueConfig.root === "string"
    ? queueConfig.root
    : DEFAULT_QUEUE_ROOT;
  const allowedOutputRoot = typeof queueConfig.allowedOutputRoot === "string"
    ? queueConfig.allowedOutputRoot
    : process.env.AGENTTOOLS_ALLOWED_OUTPUT_ROOT || AGENTTOOLS_ROOT;

  if (!channelId) throw new Error("Discord direct.channelId is not configured.");

  const content = options.contentFile !== undefined
    ? await readFile(path.resolve(options.contentFile), "utf8")
    : options.content ?? "";

  const components = options.componentsJson ? JSON.parse(options.componentsJson) : undefined;
  const result = await enqueueAgentDiscordMessage(queueRoot, {
    channelId,
    content,
    attachments: options.attachments.map((attachment) => ({ path: attachment })),
    components,
    allowedOutputRoot,
  });

  console.log(`QUEUED requestId=${result.requestId}`);
  console.log(`OUTBOX ${result.outboxPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
