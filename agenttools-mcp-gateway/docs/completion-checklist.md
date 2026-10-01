# AgentTools MCP Gateway Completion Checklist

> **位置付け:** 実装・検証状況を記録するチェックリストです。現行仕様の正本ではありません。現在の設計判断は`docs/README.md`から案内されるcanonical document、実行Policyは`config/`とコードを優先してください。

既存運用を停止しない範囲での実装状況と、ライブ復旧解禁前に残る項目を分けて管理する。

## Gateway基盤

- [x] CLI入口 `src/cli.js`
- [x] stdio prototype `src/mcp/stdio-prototype.js`
- [x] `server/discover` / `tools/list` / `tools/call`
- [x] concrete input schema
- [x] `gateway.health`
- [x] `gateway.info`
- [x] `Start-AgentToolsGateway.bat`
- [x] `Status-AgentToolsGateway.bat`
- [x] `Doctor-AgentToolsGateway.bat`
- [x] allowed path policy
- [x] safety flags
- [x] confirmToken発行/検証
- [x] secret redaction
- [x] taskStore / task runner / tailLog

## DevSpace独立管理

- [x] 固定DevSpace設定 `config/devspace.json`
- [x] process + parent PID/command line取得
- [x] configured portのlistening PID確認
- [x] `GET /healthz` probe
- [x] `/mcp` route responsiveness probe
- [x] version / pinned commit確認
- [x] executable / package / node_modules確認
- [x] user config安全読取
- [x] workspace SQLite read-only診断
- [x] `devspace.status`
- [x] `devspace.health`
- [x] `devspace.logs`
- [x] `devspace.start`
- [x] `devspace.stop`
- [x] `devspace.restart`
- [x] `devspace.diagnose`
- [x] `devspace.recover`
- [x] healthy時の二重起動防止
- [x] Gateway supervisor graceful restart -> optional force escalation
- [x] force escalationをdestructive扱いに分離
- [x] pinned installation破損時の自動reinstall/update拒否
- [x] 停止直前のprocess ownership再検証
- [x] Gateway起動DevSpaceのstdout/stderr log保存
- [x] Gateway supervisorからDevSpace `shutdownHttpServer(httpServer, close)` を呼ぶgraceful stop経路
- [x] supervisor管理外DevSpaceの非force stop拒否
- [x] fake runtimeで本番DevSpaceを止めずに復旧ロジック試験
- [x] fake DevSpace modules + 一時HTTP serverでsupervisor graceful shutdown統合試験

## Filesystem

- [x] `fs.exists`
- [x] `fs.stat`
- [x] `fs.list`
- [x] `fs.readText`
- [x] `fs.delete`
- [x] `fs.deleteRecursive`
- [x] allowed root制限
- [x] canonicalization / root escape拒否
- [x] junction/symlink escape検証
- [x] allowed rootそのものの削除禁止
- [x] non-empty directoryとrecursive deleteの分離
- [x] destructive confirmation
- [x] 確認後fingerprint/canonical path再検証

## Process

- [x] `process.list`
- [x] `process.find`
- [x] `process.info`
- [x] `process.status`
- [x] allowlist型 `process.start`
- [x] allowlist型 `process.stop`
- [x] arbitrary `exec(command)` を作らない
- [x] process query値をPowerShell sourceへ直接連結しない

## Git

- [x] `git.status`
- [x] `git.log`
- [x] `git.diff`
- [x] `git.diffSummary`
- [x] 既存commit/pushとread-only診断を分離

## 既存AgentTools adapter

- [x] Git adapter
- [x] Discord adapter
- [x] Image adapter
- [x] Blender adapter
- [x] Remotion adapter
- [x] HyperFrames adapter
- [x] Unity adapter

## 自動検証

- [x] Windows `/` / `\` path
- [x] 空白 / 日本語
- [x] `()` / `&` / `'` / `"` / `$()` 等
- [x] drive root
- [x] UNC pathのallowed-root外拒否
- [x] junction/symlink escape
- [x] PowerShell UTF-16LE EncodedCommand
- [x] JSON環境変数によるPowerShell argument transport
- [x] process literal queryのshell-looking text
- [x] direct `.bat/.cmd` / arbitrary task executable拒否
- [x] adapter argument tampering拒否
- [x] fake DevSpace start/stop/restart/recover
- [x] fake HTTP health probe
- [x] 本番DevSpace read-only health/diagnose

## 実運用の個別許可 / 引き続き禁止

- [x] legacy `writeActionsEnabled=false` を維持
- [x] legacy `externalActionsEnabled=false` を維持
- [x] `destructiveActionsEnabled=false` を維持
- [x] `longRunningActionsEnabled=false` を維持
- [x] action-scoped allowlistを導入し、policy欠落/無効時はfail-closed
- [x] `discord.post` は `userExplicitlyRequested=true` + matching `confirmToken` + allowed pathでのみ許可
- [x] `git.commit` / `git.push` はユーザー明示依頼assertion + matching `confirmToken`がある場合だけ許可
- [x] commit/pushは個別actionに一本化し、一括実行actionは廃止
- [ ] 本番DevSpaceの実stop/restart/recover
- [ ] 実filesystem delete
- [ ] 実registered process stop/start
- [x] Avatar Dev Loopのユーザー承認済みDiscord送信
- [x] terminal Work Task (`succeeded` / `failed` / `cancelled`)からの定型Discord通知
- [x] ユーザー明示依頼のinteractive `discord.post`（Gateway経由）
- [ ] `discord.restart`
- [ ] 任意external/network action
- [ ] 実画像コピー
- [x] `task.run` はユーザー明示依頼 + confirmToken + 登録済みtrusted adapter + `taskCommandPolicy`検証時のみ許可
- [x] Unity/Blender/LocalAI/Remotion/HyperFramesの登録済みlong-running taskを任意commandと分離
- [ ] `requiresNetwork=true` のlong-running task（`allowedNetworkTaskAdapters` は空）
- [x] ユーザー承認済みUnity Worktree検証（AutoDev非依存の共通安全基盤）

## ライブ自己復旧成立までに残る項目

1. [x] DevSpace Watchdogの連続失敗判定・cooldown・force escalation・circuit breakerを実装する。
2. [x] fake runtimeでstopped/unresponsive/force/rate-limitを検証する。
3. [x] Windows Scheduled Task登録/解除スクリプトを作成し、PowerShell構文とScheduledTask object生成を検証する。
4. [ ] `AgentTools-DevSpaceWatchdog` Scheduled Taskを実際に登録し、Watchdogの常駐を確認する。
5. [ ] 必要時のみ、本番DevSpace停止試験で自動startを確認する。

Gatewayの独立MCP登録と正式MCP SDK化は、SPOF対策の必須条件ではなく将来拡張へ移動した。

## 現時点の運用ルール

- ChatGPT側の既存DevSpace MCP登録は変更しない。
- 本番DevSpace/Discord Botは単なるテスト目的では停止・変更しない。ユーザー承認済み機能のruntime反映に必要な場合だけ、正式なgraceful restart経路を使う。
- Watchdogは固定DevSpace recovery coreのみを呼び、任意command/reinstall/update/config rewriteを行わない。
- interactive destructive操作はtool-levelの確認/policy gateを維持する。
- Watchdogのforce復旧は `config/watchdog.json` の連続失敗閾値とPID所有権再検証を必須にする。
- state/log/historyはGit管理しない。
- ChatGPT/Codex Work Task、Control Center進行表示、Discord terminal通知の設計正本は`agent-work-orchestration.md`。具体的なTask操作は`../skill/SKILL.md`を参照する。
