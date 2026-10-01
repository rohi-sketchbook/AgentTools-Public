# AgentTools MCP Gateway Docs

Gatewayの詳細資料索引です。READMEやAGENTSへ詳細手順を重複させず、目的に応じてこの一覧から必要な文書だけを読みます。

## Current canonical documents

| Document | Role |
|---|---|
| [`agent-work-orchestration.md`](agent-work-orchestration.md) | ChatGPT / DevSpace / Codex / Work Task / Control Center / Discord完了通知の設計・運用境界 |
| [`background-performance-policy.md`](background-performance-policy.md) | 常駐処理、timer、watchdog、polling、queue pumpの性能ポリシー |
| [`skill-improvement-workflow.md`](skill-improvement-workflow.md) | Skill改善候補の保存・diffレビュー・承認/却下・安全な適用フロー |
| [`devspace-recovery.md`](devspace-recovery.md) | DevSpace health、diagnose、recovery、手動lifecycle設計 |
| [`unity-worktree-validation.md`](unity-worktree-validation.md) | AutoDevから独立したUnity Worktree検証、依存Junction、Editor起動、孤児Unity cleanupの共通安全基盤 |

## Validation / reference

| Document | Role |
|---|---|
| [`completion-checklist.md`](completion-checklist.md) | Gateway機能の実装・検証チェックリスト。現行仕様の正本ではない |
| [`static-audit-report.md`](static-audit-report.md) | 静的監査の時点記録。現在仕様を判断する場合はコード・Policy・現行docsを優先 |
| [`incident-2026-08-21-discord-codex-sync-load.md`](incident-2026-08-21-discord-codex-sync-load.md) | 2026-08-21高負荷インシデント記録 |

## Operational procedures

Agentが実行する具体的なコマンド列は、docsではなく共有Skillを正本にします。

- Work Task: `agenttools-mcp-gateway/skill/SKILL.md`（global skill名: `work-task`）
- Skill改善候補: `agenttools-mcp-gateway/skill-improvement/SKILL.md`（global skill名: `skill-improvement`）
- Git: `git-helper/skill/SKILL.md`
- Discord: `discord-bot/.../skills/discord-bot/SKILL.md`
- Local AI: `local-ai/skill/SKILL.md`
- Blender: `blender-mcp/skill/SKILL.md`
- XR: `xr-automation/skill/SKILL.md`

## Maintenance rule

- 現行Policyを変える: canonical document / config / codeを更新する。
- Agent操作を変える: 対応`SKILL.md`を更新する。
- README: 概要・入口だけ更新する。
- 過去の監査・incident文書は履歴として保持し、現行仕様と誤認されないよう冒頭に位置付けを明記する。
