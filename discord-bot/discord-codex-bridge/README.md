# Discord Remote Control / ChatGPT Bridge

`codex-discord-connector` のDiscord受信・送信・セッション同期機能を再利用しつつ、通常操作でCodex CLIを起動しないためのローカルBridgeです。

## 正式な優先順位

```text
1. Local
2. ChatGPT Queue + DevSpace
3. Codex CLI（明示指定のみ）
```

通常の自然文は `auto` ルーティングされます。

- AI不要の安全な状態確認 → Local
- 調査・設計・レビュー・編集など推論が必要 → ChatGPT Queue
- `@codex` / `/codex` 等で明示 → 既存Codex CLI経路

OpenAI APIを常用しません。ChatGPT QueueはChatGPTセッションを自動起動せず、ローカルJSON Queueとしてのみ動作します。

## Agent共通ツール

Discord連携はグローバルAgent Skill `discord-bot` として利用できる構成にする。

Skill正本:

```text
<AgentToolsRoot>\discord-bot\discord-codex-bridge\skills\discord-bot\SKILL.md
```

グローバル登録先:

```text
<UserProfile>\.agents\skills\discord-bot\SKILL.md
```

新規・通常のSkill登録はAgentTools共通インストーラを正本とする。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <AgentToolsRoot>\install-agenttools-skills.ps1
```

`discord-codex-bridge\install-discord-agent-tool.ps1` は既存運用向けの互換入口で、実際には上記共通インストーラへ委譲する。Global Skillを登録し、グローバル `<UserProfile>\.codex\AGENTS.md` にはTool別の長い手順を置かず、全共有Skill共通の短い発見ブロックだけを維持する。

これにより、VR Avatar Viewer、Blender背景制作など別のDevSpace作業中でも「Discord確認して」「Discordに画像を送って」等の依頼からDiscord Toolを発見できる。

## 構成

```text
Discord
   ↓
codex-discord-connector + jp-hooks.mjs
   ↓
MultiBackend routing
   ├─ LocalBackend
   │    └─ Windows / Git / Filesystem（Allowlistのみ）
   ├─ ChatGptQueueBackend
   │    └─ <AgentToolsRoot>\discord-bot\discord-chatgpt-bridge
   └─ Codex
        └─ 既存connector経路をそのまま利用
```

MultiBackend本体は `src/` 配下に置き、`jp-hooks.mjs` は上流connectorとの接続点と互換パッチに限定します。

現在の正式配置は次の3層です。

```text
<AgentToolsRoot>\discord-bot\codex-discord-connector   # connector本体
<AgentToolsRoot>\discord-bot\discord-codex-bridge                  # Runtime Hook / MultiBackend / 日本語化
<AgentToolsRoot>\discord-bot\discord-chatgpt-bridge                # ChatGPT Inbox/Outbox Queue / 添付保存
```

Botはconnector本体を直接起動せず、`discord-codex-bridge\run-localized-bot-supervisor.ps1` 経由で起動します。Windowsログオン時の自動起動は `install-localized-bot-autostart.ps1` でタスク `AgentTools-DiscordBot` を登録します。既存環境では `AGENTTOOLS_DISCORD_TASK_NAME` またはGatewayの `config/discord.local.json` で旧タスク名を維持できます。Discord TokenはWindows User Environment Variable `DISCORD_TOKEN` からSupervisorが起動時に読み直します。

## Discordコマンド

### Local

```text
/local status
/local ls
/local pwd
/local git status
/local git diff
/local log
/local build-status
/local autodev list
```

任意Shellは実行できません。旧 `/shell` はslash command登録から除外し、古い登録が残っていても `!command` / `__cdc_exec` の任意実行はBridge側で拒否します。

`/diff`、`/where`、`/status`、`/browse` など既存の安全な操作もLocalへ吸収します。

### ChatGPT Queue

```text
/ask <依頼>
@chatgpt <依頼>
```

`/review`、`/fix-tests`、`/summarize` もChatGPT Queueへ寄せています。

Queueへ登録された時点ではAI推論は行われません。

### Codex

```text
/codex <依頼>
@codex <依頼>
```

既存connectorのCodex処理をそのまま利用するため、session resume、realtime transcript、画像入力/生成画像添付などの既存挙動を維持します。

### 一般向けDiscord Assistant

設定した一般チャンネルでは、Botへの実メンションがある投稿だけをCodexで処理します。
一般側は既存のLocal／DevSpace／管理コマンドへフォールスルーせず、会話と文章からの画像生成だけを許可します。

管理者用スイッチ:

```text
/public-assistant start
/public-assistant stop
/public-assistant status
```

- `start`: 一般向け応答を再開
- `stop`: 一般向け応答を停止し、メモリ上の会話履歴を消去
- `status`: 現在の応答状態と対象チャンネル数を表示

停止中は一般チャンネルで完全に無応答です。スイッチ操作は既存の `allowedRoleIds` を持つ管理者だけが実行できます。

公開対象は `.connect/config.json` の `multiBackend.publicAssistant.channelIds`、または環境変数 `DISCORD_PUBLIC_CHANNEL_IDS` のカンマ区切りで指定します。安全のため、初期設定は空配列かつ停止状態です。

```json
{
  "multiBackend": {
    "publicAssistant": {
      "enabled": true,
      "channelIds": ["GENERAL_CHANNEL_ID"],
      "requireBotMention": true,
      "respondingByDefault": false,
      "workspaceRoot": "<AgentToolsRoot>\\discord-bot\\public-workspace",
      "codexHome": "<UserProfile>\\.codex",
      "timeoutMs": 120000,
      "maxRequestsPerWindow": 5,
      "windowMs": 600000,
      "maxConcurrentTotal": 2,
      "conversationTtlMs": 1800000,
      "maxConversationTurns": 12
    }
  }
}
```

公開用Codexは毎回 `--ephemeral --sandbox read-only --ignore-user-config --ignore-rules` で起動し、専用の空Workspaceを使用します。さらに `shell_tool`、`unified_exec`、MCP Apps、Plugin、Browser、Computer Use、Multi-Agent等をCLI機能フラグで無効化し、画像生成だけを残します。子プロセスへ渡す環境変数もOS起動・Codex認証に必要なものだけへ絞り、`DISCORD_TOKEN`等は渡しません。ユーザー別会話履歴はBotのメモリ上だけで保持し、30分で失効します。

### Backend

```text
/backend auto
/backend local
/backend chatgpt
/backend codex
/bridge-status
```

正式既定値は `auto` です。

## ChatGPT Queue

既定Root:

```text
<AgentToolsRoot>\discord-bot\discord-chatgpt-bridge
```

Bot起動時またはQueue初回利用時に以下を自動作成します。

```text
discord-chatgpt-bridge
├─ inbox
├─ outbox
├─ processed
│  ├─ inbox
│  └─ outbox
├─ attachments
├─ state
│  ├─ processing
│  └─ sending
└─ logs
```

Inbox JSON:

```json
{
  "requestId": "20260725-123456-DiscordMessageId",
  "guildId": "...",
  "channelId": "...",
  "messageId": "...",
  "authorId": "...",
  "authorName": "example-user",
  "content": "VR_AvaterViewerの現在の変更点を調べて",
  "timestamp": "...",
  "attachments": [],
  "status": "pending",
  "workspaceRoot": "D:\\projects",
  "cwd": "D:\\projects\\..."
}
```

Discord添付ファイルは `attachments/<requestId>/` へ保存します。Discord CDN以外からのダウンロードは拒否し、1ファイル50MiB、最大20件に制限しています。

## ChatGPT側の処理

ChatGPTを外部イベントから自動起動する処理は実装しません。ブラウザ版ChatGPTのPlaywright操作も行いません。

ChatGPTセッションからDevSpaceでInboxを確認する場合の補助CLI:

```text
node --import ../codex-discord-connector/node_modules/tsx/dist/loader.mjs scripts/chatgpt-queue.ts pending
node --import ../codex-discord-connector/node_modules/tsx/dist/loader.mjs scripts/chatgpt-queue.ts claim <requestId>
```

処理後、以下形式のresponse JSONを用意して `complete` します。

```json
{
  "channelId": "...",
  "replyToMessageId": "...",
  "content": "調査結果...",
  "attachments": []
}
```

```text
node --import ../codex-discord-connector/node_modules/tsx/dist/loader.mjs scripts/chatgpt-queue.ts complete <requestId> <response.json>
```

BotのOutbox PumpがDiscordへ返信します。

### AgentTools定型通知

全体運用の正本は `..\..\agenttools-mcp-gateway\docs\agent-work-orchestration.md`。ChatGPT / Codexのユーザー作業は `agenttools-mcp-gateway/state/tasks.json` の `type=work` Taskを正本とします。AgentTools Control Centerはwork Taskを直接読み取り、Discord BotはWork Taskから生成された `state/activity/notifications/*.json` の内部delivery eventだけをconsumeします。

自動通知の対象はterminal Task（完了・失敗・中止）と、ChatGPT切断後のCodex自動継続ライフサイクル（開始・完了・失敗）です。Codex継続開始では引き継ぎ先/model/回数/理由、完了ではCodex結果とChatGPT最終確認待ち、失敗ではChatGPT再開待ちを定型表示し、利用可能ならCodex quota使用率スナップショットも含めます。それ以外の中間進捗はDiscordへ送らず、Control Centerだけに表示します。

これらの定型システム通知はユーザー承認済みのstanding authorizationです。ただし、この承認は任意のDiscord投稿や成果物添付へは拡張しません。Codex worker自身がDiscordへ投稿することも許可せず、通常の`discord-agent.ts send`は引き続き、その依頼でDiscord送信のユーザー意図がある場合だけ使用します。

```json
{
  "multiBackend": {
    "activityNotifications": {
      "enabled": true,
      "root": "<AgentToolsRoot>\\agenttools-mcp-gateway\\state\\activity",
      "pollIntervalMs": 30000
    }
  }
}
```

`channelId` を省略した場合は既存の `direct.channelId` を使用します。通常は `fs.watch` でイベント駆動し、30秒以上のpollはwatch取りこぼし対策のfallbackだけです。通知ファイルは送信処理前に `sending-notifications/` へatomic claimし、Discord Outboxへのenqueue成功後に `processed-notifications/` へ移動します。enqueue成功後の整理だけ失敗した場合は自動再送せず、二重投稿を避けます。

### Agentから明示的にDiscordへ送信

ユーザーが現在の依頼でDiscordへの送信・投稿・アップロードを明示した場合だけ、Agent outbound helperを使用できる。

```text
node --import ../codex-discord-connector/node_modules/tsx/dist/loader.mjs scripts/discord-agent.ts send --content "message"
```

ファイル添付:

```text
node --import ../codex-discord-connector/node_modules/tsx/dist/loader.mjs scripts/discord-agent.ts send --content "render result" --attachment "<WorkspaceRoot>\backgrounds\result.png"
```

送信先channelIdはcallerから指定できず、connectorの `direct.channelId` を使用する。添付は `multiBackend.chatgptQueue.allowedOutputRoot`（正式設定では `<WorkspaceRoot>`）配下だけ許可する。HelperはQueueへ登録するだけで、実送信はBotのOutbox Pumpが行う。

## 二重送信防止

Outboxは送信前に `state/sending` へatomic renameしてclaimします。

Discord送信に成功した後でローカルファイル整理だけ失敗した場合、そのJSONは `state/sending` に残し、Outboxへ戻しません。自動再送より **at-most-once** を優先し、二重返信を防止します。

## セキュリティ

- 管理機能のDiscord Role制限は既存 `allowedRoleIds` をそのまま適用
- 一般向けチャンネルはBotへの実メンション時だけ応答
- 一般向け経路はLocal／Git／Shell／DevSpace／管理コマンドへフォールスルーしない
- 一般向けCodexはephemeral・read-only・ユーザー設定/ルール無視・専用空Workspace
- 一般向けCodexではShell／統合実行／MCP Apps／Plugin／Browser／Computer Useを機能フラグで無効化
- 一般向けCodex子プロセスへ`DISCORD_TOKEN`等の不要な環境変数を継承しない
- 生成画像のDiscord添付はCodexの`generated_images`配下だけ許可
- `DISCORD_TOKEN` はWindows User Environment Variableのみ
- `.connect/config.json` のtoken欄は空
- LocalBackendはworkspaceRoot外へ移動不可
- 任意Shell禁止
- Local操作はAllowlistのみ
- ChatGPT Queue添付URLはDiscord CDNのみ
- Outbox添付は `<WorkspaceRoot>` 配下のみ
- ファイル削除、`git push`、`git reset`、大量変更、外部公開等は確認トークンを要求
- 確認トークンは同一ユーザー・同一チャンネル限定、10分で期限切れ

## 主な実装ファイル

```text
src/contracts.ts
src/config.ts
src/router.ts
src/state.ts
src/permissions.ts
src/publicAssistant.ts
src/integration.ts
src/chatgptQueue.ts
src/backends/localBackend.ts
src/backends/chatGptQueueBackend.ts
src/backends/codexBackend.ts
scripts/chatgpt-queue.ts
jp-hooks.mjs
```

上流 `codex-discord-connector` npmパッケージ本体は直接編集しません。
