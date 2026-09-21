# Discord Remote Control / ChatGPT Bridge 正式仕様

更新: 2026-07-26

## 1. 目的

Discord BotをCodex専用Botとして扱わない。

主目的は、AI不要のローカル操作のためにCodex利用枠を消費しないこと。

正式な処理優先順位:

```text
1. Local
2. ChatGPT + DevSpace
3. Codex CLI
```

OpenAI APIを通常経路として使用しない。

## 2. アーキテクチャ

```text
Discord
   ↓
codex-discord-connector / Discord Adapter
   ↓
Bridge Router
   ├─ LocalBackend
   │    ↓
   │  Filesystem / Git / 固定Allowlist Command
   │
   ├─ ChatGptQueueBackend
   │    ↓
   │  <AgentToolsRoot>\discord-bot\discord-chatgpt-bridge\inbox
   │    ↓
   │  ChatGPT + DevSpace（ユーザーがChatGPT側で確認した時だけ）
   │    ↓
   │  outbox
   │    ↓
   │  Discord Outbox Pump
   │
   └─ CodexBackend
        ↓
      既存Codex CLI経路
```

上流npmパッケージ本体は直接編集しない。接続は `jp-hooks.mjs`、独自処理は `src/` に分離する。

## 2.1 全Agent共通ツール

Discord連携は特定プロジェクト専用の知識にせず、グローバルAgent Skill `discord-bot` として登録する。

Skill正本:

```text
<AgentToolsRoot>\discord-bot\discord-codex-bridge\skills\discord-bot\SKILL.md
```

グローバル登録先:

```text
<UserProfile>\.agents\skills\discord-bot\SKILL.md
```

グローバル `<UserProfile>\.codex\AGENTS.md` には共有Skill全体の短い発見ルールだけを置き、Discord固有の手順は `skills/discord-bot/SKILL.md` を正本とする。`install-discord-agent-tool.ps1` は互換入口として共通 `<AgentToolsRoot>\install-agenttools-skills.ps1` へ委譲し、Tool別ブロックをグローバルAGENTSへ再追加しない。

以下をSkill起動対象とする。

```text
Discord確認
Discordの依頼を処理
Discordに送る / 投稿 / うｐ
画像・ログ・成果物をDiscordへ返す
Discord Botの状態確認 / 起動 / 再起動
```

Discordへの外部送信はユーザーが現在の依頼で明示した場合のみ実行する。Codex CLIはユーザーがCodexを明示した場合のみ使用する。

## 3. LocalBackend

AI推論を一切使用しない。

公開Allowlist:

```text
status
ls
pwd
git status
git diff
log
build-status
```

既存UI互換の内部Allowlistとして、ファイルブラウザ、git status/diff/check、固定 `pnpm test` / `pnpm typecheck` 等の既知コマンドのみ上流Local Runnerへ通してよい。

任意Shellは許可しない。

## 4. ChatGPT Queue

Queue Root:

```text
<AgentToolsRoot>\discord-bot\discord-chatgpt-bridge
```

構造:

```text
inbox/
outbox/
processed/inbox/
processed/outbox/
attachments/<requestId>/
state/processing/
state/sending/
logs/
AGENTS.md
```

Inbox必須情報:

```text
requestId
guildId
channelId
messageId
authorId
authorName
content
timestamp
attachments
status
```

status:

```text
pending
processing
completed
failed
```

ChatGPTセッションをDiscordイベントから自動起動しない。ユーザーがChatGPTで「Discord確認して」等と依頼した場合にDevSpaceからQueueを処理する。

Playwright等によるブラウザ版ChatGPT自動操作は禁止。

## 5. Outbox

最低限:

```json
{
  "requestId": "...",
  "channelId": "...",
  "replyToMessageId": "...",
  "content": "...",
  "attachments": []
}
```

BotはOutboxをポーリングしDiscordへ返信する。

送信前に `state/sending` へatomic claimする。

送信成功後にローカル整理だけ失敗した場合はOutboxへ戻さない。自動再送よりat-most-onceを優先し、二重送信を防止する。

Outboxの `requestId/channelId/replyToMessageId` は元Requestと照合し、任意チャンネルへの書き換えを拒否する。

長文回答はDiscord本文を短縮し、全文をUTF-8テキスト添付する。

## 6. 添付ファイル

Discord入力添付は:

```text
attachments/<requestId>/
```

へ保存する。

Discord CDN (`cdn.discordapp.com`, `media.discordapp.net`) 以外からの取得は禁止。

上限:

```text
20 files / request
50 MiB / file
```

Outbox添付は `multiBackend.chatgptQueue.allowedOutputRoot` 配下のみ送信可能とし、正式設定は `<WorkspaceRoot>` とする。

Agentからユーザー明示依頼の成果物を送る場合は `scripts/discord-agent.ts` を使用する。送信先channelIdはcallerから指定させず、connector設定の `direct.channelId` を使用する。Helperはsynthetic request + outboxを作成し、実送信は通常のOutbox Pumpへ一本化する。

ChatGPT / Codexの通常開発作業については、ユーザーが承認した作業レポート運用として `agenttools-mcp-gateway/state/tasks.json` の `type=work` Taskをユーザー向け正本とする。運用正本は `agenttools-mcp-gateway/docs/agent-work-orchestration.md`。Control Centerはwork Taskの進捗・履歴を表示し、Discord BotはWork Taskから生成される内部 `state/activity/notifications/*.json` だけをconsumeする。自動通知対象はterminal Task（完了・失敗・中止）とCodex自動継続（開始・完了・失敗）の定型ライフサイクルであり、それ以外の中間進捗はDiscordへ投稿しない。Task通知も送信前に `sending-notifications` へclaimし、Outbox enqueue後は自動再送しないat-most-once方針を適用する。このstanding authorizationは定型システム通知だけに適用し、任意投稿・成果物添付・worker自身によるDiscord送信・`discord-agent.ts send`の自動許可にはしない。

## 7. Codex

Codex CLIは削除しない。

明示指定:

```text
/codex <依頼>
@codex <依頼>
```

およびCodex専用管理コマンドの場合だけ使用する。

既存connectorのCodex経路を維持し、resume、realtime transcript、画像入力、生成画像Discord添付を壊さない。

`/review`、`/fix-tests`、`/summarize`、既存UIのファイル要約/編集・レビュー/修正ボタンはChatGPT Queueへ変更する。

## 8. Router

既定値:

```text
defaultBackend = auto
```

Auto判定:

- status / ls / pwd / git status / git diff / log / build-status系 → Local
- Codexを明示 → Codex
- その他の推論・調査・設計・編集 → ChatGPT Queue

Router判定のためにLLMを呼ばない。

## 9. Discord Command

```text
/ask
/local
/backend
/bridge-status
/confirm
/cancel
/codex
```

`/shell` は登録しない。

古いslash commandキャッシュやテキストから任意Shellが到達してもBridge側で拒否する。

## 10. セキュリティ

既存 `allowedRoleIds` を必ずMultiBackend処理にも適用する。

現在の管理Role:

```text
1530339205111349308
```

危険操作:

```text
ファイル/ディレクトリ削除
git push
git reset
git clean
大量変更
Unity Scene削除
Blender Collection削除
外部公開/本番反映
サービス停止
OS設定変更
Credential操作
API Key操作
```

LocalBackendに危険操作は存在させない。

ChatGPT/Codexへ危険操作を渡す場合は、同一ユーザー・同一チャンネル限定の確認トークンを要求する。確認トークンは10分で失効する。

## 11. Credential

Discord TokenはWindows User Environment Variable `DISCORD_TOKEN` のみから取得する。

`.connect/config.json` のtoken値は空のままとする。

Queue、ログ、README、ソースへToken/API Key/Cookieを保存しない。

## 12. 互換性

以下の既存機能は維持する。

```text
日本語UI
日本語Discordチャンネル名
新規チャンネル非公開
Windows junction
Windows Codex CLI起動
Codex resume
realtime transcript
Discord画像入力
Codex生成画像Discord添付
既存session sync
```

## 13. 正本

今後のDiscord Bot設計判断では、本仕様を `Discord Remote Control / ChatGPT Bridge` の正本として扱う。
