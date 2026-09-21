# Discord Remote Control / ChatGPT Bridge Agent Rules

このファイルは、この配下で常時適用する最小限の制約だけを置く。具体的な操作手順は`skills/discord-bot/SKILL.md`を正本とする。

- 正式名称は`Discord Remote Control / ChatGPT Bridge`。
- 新規・通常のSkill登録は`<AgentToolsRoot>\install-agenttools-skills.ps1`を使用し、Discord固有手順をグローバル`AGENTS.md`へ複製しない。
- ユーザーがChatGPT Queueの処理を依頼した場合、Codex CLIではなく`discord-chatgpt-bridge`のpending requestを扱う。Codex CLIは明示指定時だけ使用する。
- channelId / replyToMessageId等の外部宛先情報を推測・変更しない。
- Discord Token、API Key、Cookie等の認証情報をQueue、ログ、回答へ書かない。
- 任意Discord投稿・成果物添付は現在のユーザーによる明示依頼が必要。
- terminal Work Taskから生成される定型完了通知だけは、`agenttools-mcp-gateway/docs/agent-work-orchestration.md`で定義されたstanding authorizationを利用できる。中間進捗や任意投稿へ流用しない。
- `git push`、削除、外部公開、サービス停止、OS設定、Credential変更等はグローバル安全ルールに従う。
