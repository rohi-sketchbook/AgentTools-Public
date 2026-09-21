---
name: discord-bot
description: Use the local Discord Remote Control / ChatGPT Bridge to read pending Discord requests, reply to them, upload screenshots/logs/build artifacts, send explicit user-requested Discord messages, and inspect or restart the Discord Bot. Trigger when the user says Discord確認, Discordに送って/うｐして/投稿して, Discord Bot, pending queue, or asks to return files/images through Discord. Prefer Local/ChatGPT Queue + DevSpace; never invoke Codex CLI unless the user explicitly asks for Codex.
---

# Discord Bot Agent Tool

Use this skill whenever Discord is part of the requested workflow.

## Canonical paths

```text
<AgentToolsRoot>\discord-bot\codex-discord-connector
<AgentToolsRoot>\discord-bot\discord-codex-bridge
<AgentToolsRoot>\discord-bot\discord-chatgpt-bridge
```

Scheduled task:

```text
AgentTools-DiscordBot
```

The Discord token is stored only in the Windows user environment variable `DISCORD_TOKEN`. Never print, copy, log, or persist it.

## Routing policy

Use this priority:

```text
1. Local operation
2. ChatGPT Queue + DevSpace
3. Codex CLI only when explicitly requested
```

Do not spend Codex usage on directory listings, Git status/diff, log inspection, status checks, file transfer, or other deterministic local operations.

Do not use OpenAI API or browser automation to wake ChatGPT.

## Read pending Discord requests

From `<AgentToolsRoot>\discord-bot\discord-codex-bridge`:

```text
node --import ../codex-discord-connector/node_modules/tsx/dist/loader.mjs scripts/chatgpt-queue.ts pending
```

For a selected request:

```text
node --import ../codex-discord-connector/node_modules/tsx/dist/loader.mjs scripts/chatgpt-queue.ts claim <requestId>
```

Then open the request's `workspaceRoot` / `cwd` in DevSpace and perform the requested work.

Complete using a response JSON that preserves the Inbox `channelId` and `messageId` exactly:

```json
{
  "channelId": "<same channelId>",
  "replyToMessageId": "<same messageId>",
  "content": "回答本文",
  "attachments": []
}
```

Then:

```text
node --import ../codex-discord-connector/node_modules/tsx/dist/loader.mjs scripts/chatgpt-queue.ts complete <requestId> <response.json>
```

Never guess a channel ID or reply message ID.

## Send a user-requested Discord message or artifact

External Discord sending is allowed only when the user has explicitly requested the send/post/upload in the current task. Do not proactively publish artifacts merely because Discord is available.

The standing exception is the AgentTools standardized Work Task notification workflow documented in `agenttools-mcp-gateway/docs/agent-work-orchestration.md`. The user has explicitly authorized terminal `completed` / `failed` / `cancelled` summaries and Codex auto-continuation lifecycle notifications (`continuation_started` / `continuation_completed` / `continuation_failed`). These are produced from Work Task state and delivered through the internal notification spool and existing Outbox Pump; they do **not** authorize arbitrary `discord-agent.ts send` calls, worker-initiated Discord posts, or automatic artifact uploads.

The Agent outbound helper always sends to the configured Discord channel and does not accept an arbitrary channel ID from the caller.

From `<AgentToolsRoot>\discord-bot\discord-codex-bridge`:

```text
node --import ../codex-discord-connector/node_modules/tsx/dist/loader.mjs scripts/discord-agent.ts send --content "message"
```

Attach one or more files:

```text
node --import ../codex-discord-connector/node_modules/tsx/dist/loader.mjs scripts/discord-agent.ts send --content "render result" --attachment "<allowed-output-root>\result.png"
```

For long text, write the text to a file under the configured `multiBackend.chatgptQueue.allowedOutputRoot` and use:

```text
node --import ../codex-discord-connector/node_modules/tsx/dist/loader.mjs scripts/discord-agent.ts send --content-file "<allowed-output-root>\message.txt"
```

Attachments must be files under the configured `multiBackend.chatgptQueue.allowedOutputRoot`; do not assume a fixed drive or parent workspace.

The helper only queues the message. The running Bot's Outbox Pump performs the actual Discord send. A `QUEUED` result is not proof of delivery.

## Bot status

Prefer read-only inspection first:

```powershell
Get-ScheduledTask -TaskName AgentTools-DiscordBot
Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*apps/discord-bot/src/index.ts*') -or
  ($_.Name -eq 'powershell.exe' -and $_.CommandLine -like '*run-localized-bot-supervisor.ps1*')
}
```

The Bot should normally run from:

```text
<AgentToolsRoot>\discord-bot\discord-codex-bridge\run-localized-bot-supervisor.ps1
```

## Start / restart

Starting the Bot is permitted as a necessary part of an explicit request to send through Discord, or when the user explicitly asks to start/restart it.

Use the registered scheduled task rather than launching an unrelated Node process:

```powershell
Start-ScheduledTask -TaskName AgentTools-DiscordBot
```

For an explicit restart request, use:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <AgentToolsRoot>\discord-bot\discord-codex-bridge\restart-localized-bot.ps1
```

Do not stop the service unless the user explicitly asks to stop it or stopping it is required for a clearly authorized maintenance operation.

## Safety

- Discord Role restrictions remain authoritative.
- Never expose `DISCORD_TOKEN`, API keys, cookies, or credentials.
- Arbitrary shell execution from Discord is prohibited; LocalBackend uses an allowlist.
- Do not modify Discord guild/channel/role permissions unless explicitly authorized.
- Do not use `/codex` or Codex CLI unless the user explicitly asks for Codex.
- Sending an arbitrary Discord message/file is an external side effect; require explicit user intent to send/post/upload. AgentTools standardized Work Task notifications are the documented standing exception and remain limited to terminal summaries plus the three Codex auto-continuation lifecycle states.
- `git push`, destructive file operations, credential changes, external publication, and service shutdown still follow the global approval rules.
- Outbox delivery is at-most-once oriented; do not manually requeue a possibly delivered message without checking `processed/outbox` and `state/sending` first.
