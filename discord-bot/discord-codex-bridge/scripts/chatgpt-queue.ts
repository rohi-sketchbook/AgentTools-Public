import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  claimChatGptRequest,
  completeChatGptRequest,
  failChatGptRequest,
  listPendingChatGptRequests,
} from "../src/chatgptQueue.ts";

const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = process.env.DISCORD_CHATGPT_QUEUE_ROOT || path.resolve(bridgeRoot, "..", "discord-chatgpt-bridge");
const [command = "pending", arg1, arg2] = process.argv.slice(2);

async function main(): Promise<void> {
  switch (command) {
    case "pending": {
      const requests = await listPendingChatGptRequests(root);
      console.log(JSON.stringify(requests.map((request) => ({
        requestId: request.requestId,
        channelId: request.data.channelId,
        authorName: request.data.authorName,
        timestamp: request.data.timestamp,
        content: request.data.content,
        attachments: request.data.attachments,
        cwd: request.data.cwd,
      })), null, 2));
      return;
    }
    case "claim": {
      if (!arg1) throw new Error("Usage: claim <requestId>");
      const request = await claimChatGptRequest(root, arg1);
      console.log(JSON.stringify(request.data, null, 2));
      return;
    }
    case "complete": {
      if (!arg1 || !arg2) throw new Error("Usage: complete <requestId> <response.json>");
      const responsePath = path.resolve(arg2);
      const response = JSON.parse(await readFile(responsePath, "utf8")) as {
        channelId: string;
        replyToMessageId?: string | null;
        content: string;
        attachments?: Array<{ path: string; name?: string }>;
      };
      console.log(await completeChatGptRequest(root, arg1, response));
      return;
    }
    case "fail": {
      if (!arg1 || !arg2) throw new Error("Usage: fail <requestId> <error>");
      console.log(await failChatGptRequest(root, arg1, arg2));
      return;
    }
    default:
      throw new Error("Commands: pending | claim <id> | complete <id> <response.json> | fail <id> <error>");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
