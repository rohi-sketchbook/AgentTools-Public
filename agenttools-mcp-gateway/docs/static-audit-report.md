# Static Audit Report

> **位置付け:** 監査時点の記録です。現行仕様の正本ではありません。現在の設計・運用は`docs/README.md`から案内されるcanonical document、実行許可は`config/safety.json`とコードを優先してください。

対象: `<AgentToolsRoot>\agenttools-mcp-gateway`

初回監査日: 2026-07-28

実運用policy更新: 2026-09-03

## 結論

Windows / PowerShell / cmd / Node.js / path canonicalization / process lifecycle / DevSpace recovery / Watchdog境界を重点監査した。

初回監査（2026-07-28）では既存運用へ影響する実処理は行っていない。本番DevSpace、Discord Bot、既存Scheduled Task、DevSpace version/configは変更・停止・再起動していない。Watchdog用Scheduled Taskの登録スクリプトは作成したが、初回監査時点ではタスク自体は未登録。

2026-09-03の実運用policy更新では、ユーザーが明示依頼した検証として `discord.post` をGatewayのdry-run → confirmToken → executeで1回実送信し、既存Outbox Pump経由で `processed/outbox` 到達まで確認した。Discord Botの停止・再起動、権限変更、任意network操作は行っていない。

legacy global安全フラグはすべて `false` のまま維持している。

- `writeActionsEnabled=false`
- `externalActionsEnabled=false`
- `destructiveActionsEnabled=false`
- `longRunningActionsEnabled=false`

2026-09-03以降、これらのglobal booleanは実行許可の根拠にせず、`config/safety.json` の `actionPolicy` を正本とする。policy欠落・無効時はlegacy booleanへフォールバックせずfail-closedする。

現在の個別許可:

- write: `git.commit`
- external: `discord.post`, `git.push`
- long-running: `task.run`
- 上記4 actionは `userExplicitlyRequested=true` と同一payloadへ結び付いた `confirmToken` が必要
- `discord.post` のcontent file / attachmentは既存allowed-path検証も必須
- `task.run` は `blender`, `blender-mcp`, `local-ai-start`, `local-ai-generate`, `unity`, `remotion`, `hyperframes` の登録済みadapterに限定し、既存`taskCommandPolicy`で実行ファイル・引数・pathを再検証する
- `allowedNetworkTaskAdapters=[]` のため `requiresNetwork=true` のlong-running taskは拒否する

引き続きallowlist空:

- destructive

また `discord.restart`, 任意external/network action, 任意write action, 任意commandはallowlist外として拒否する。Gitのcommit/pushは個別actionのみを提供し、一括commit+push actionは廃止した。

## DevSpace read-only実環境確認

現在のDevSpaceをGatewayから読み取り確認した結果:

- package: `@waishnav/devspace` 1.0.4
- reference upstream commit: `1caf5004386dda23e0860c4d0663911c3954f61f`（診断用）
- PID: `47852`
- endpoint: `127.0.0.1:7676`
- `/healthz`: HTTP 200 / DevSpace応答確認
- `/mcp`: HTTP 401 / 認証層までroute応答確認
- workspace DB: read-only取得可能
- overall: `healthy`

DevSpace checkoutには今回以前からローカル変更が存在する。HEAD/versionはpinと一致しているため、Gatewayはこれを破損扱いせず `worktree warning` として報告する。Gatewayはこれらの変更を修復・reset・checkoutしない。

## 今回の主要追加・修正

### 1. PID存在だけに依存しないhealth

`devspace.status/health` は以下を組み合わせる。

- trusted process検出
- parent PID/command line
- configured TCP port ownership
- `/healthz`
- `/mcp` route responsiveness
- package version
- Git commit状態（診断用。起動条件ではない）
- executable/module存在
- config readability
- workspace SQLite read-only状態

`healthy / degraded / stopped / unresponsive / unknown` を区別する。

### 2. process queryのPowerShell injection排除

旧process検索のように検索文字列をPowerShell sourceへ連結せず、固定script + JSON環境変数で値を渡す。

shell-looking text、引用符、`&`, `|`, `$()`, 日本語、`/`, `\` をliteral queryとして保持する試験を追加した。

### 3. Gateway起動DevSpace専用supervisor

Windowsのgraceful stopを実機検証したところ、以下は採用不可だった。

- `taskkill /PID <pid>` without `/F`: Node processでは「`/F`のみで終了可能」となり、graceful stopではない。
- Windows Console Control Event / AttachConsoleによるCtrl+C送信: この環境では `AttachConsole` が Win32 error 6 となり成立しなかった。

未検証の方式を残さず撤回し、DevSpaceが公開している以下を利用する方式へ変更した。

- `createServer(config)`
- `shutdownHttpServer(httpServer, close)`

Gatewayから起動するDevSpaceは固定 `src/devspace/supervisor.mjs` を経由する。supervisorは固定DevSpace rootの `dist/config.js`, `dist/server.js`, `dist/server-shutdown.js` をimportし、DevSpace本来のserver lifecycleを起動する。

停止時はGit-ignored stateに保存したrandom control tokenでshutdown requestを認証し、supervisor自身が `shutdownHttpServer(httpServer, close)` を呼ぶ。

fake DevSpace modules + 一時HTTP serverを使うintegration testで、

```text
supervisor起動
-> control request
-> HTTP server close
-> application close()
-> supervisor exit code 0
```

まで確認済み。

### 4. 既存launcher起動DevSpaceを勝手にgraceful扱いしない

現在稼働中のDevSpaceはGateway supervisorより前から既存launcherで起動されている。

このprocessにはGateway supervisor controlがないため、非force `devspace.stop/restart` は拒否する。`taskkill` をgraceful stopとして代用しない。

明示的にforceが許可された場合だけdestructive操作として強制終了へ進む設計。

### 5. force killのPID再利用対策

force kill直前にPIDのcreation timeを再取得し、診断時に確認したprocessと一致することを再検証する。

テスト用Node processで、誤ったcreation timeではkillを拒否し、正しいcreation timeでのみforce killできることを実Windowsで確認した。

### 6. 二重起動防止

start前に以下を確認する。

- trusted processが既に存在しないこと
- configured portが占有されていないこと
- `/healthz` / `/mcp` が別processから応答していないこと
- expected package version、必須runtime module、node_modulesが揃っていること

process認識に失敗していてもportが占有されていればduplicate startを拒否する。

### 7. 自動再install/update禁止

以下ではstart/recoverを中断し、manual repairを推奨する。

- expected version mismatch
- `node_modules` missing
- `package.json` missing/unreadable
- `dist/cli.js` missing
- `dist/config.js` / `dist/server.js` / `dist/server-shutdown.js` missing
- Gateway supervisor missing

Gatewayからnpm install、git pull/reset、DevSpace update、config rewriteは行わない。

### 8. filesystem boundary

`fs.exists/stat/list/readText/delete/deleteRecursive` を追加した。

- allowed root必須
- canonical path / realpath
- `..` root escape拒否
- junction/symlink escape拒否
- allowed rootそのものの削除禁止
- non-empty directoryとrecursive deleteを分離
- destructive confirmation
- confirmation後にcanonical path + lstat fingerprint再検証
- recursive previewでsymlinkを横断しない

さらにGateway自身の `state/` はgeneric `fs.readText` と全削除操作から除外した。supervisor control tokenやconfirmation tokenは専用tool以外から読取・削除できない。

### 9. process boundary

read-only:

- `process.list`
- `process.find`
- `process.info`
- `process.status`

mutationは `config/processes.json` のregistered IDだけ。任意 `exec(command)` は提供しない。

### 10. Git read-only diagnostics

DevSpace停止時にも以下を利用できる。

- `git.status`
- `git.log`
- `git.diff`
- `git.diffSummary`

trusted Git executable + args arrayで起動する。`git clean`, `git reset --hard` 等の汎用破壊操作は追加していない。

### 11. confirmation token再利用防止

安全flag OFFでpolicy blockされた実行試行でも、`consume=true` のconfirmation tokenは消費するよう変更した。

これにより、flag OFF中に確認済みの古いtokenをTTL内に保持し、後からflag ONへ切り替えた直後に再利用する経路を防止する。

### 12. Windows path / shell境界

自動監査対象:

- `/` / `\`
- space
- 日本語
- `()`
- `&`
- `'`
- `"`
- `$()` 等shell-looking text
- drive root
- UNC path
- `..`
- junction/symlink
- nonexistent destination
- case-insensitive Windows path

privileged recovery sourceには `exec/execSync`, `shell:true`, `cmd /c`, `powershell -Command` のescape hatchがないことを検査する。

PowerShellを使うprocess/CIM queryは固定script + env data transportとし、ユーザー値をsourceへ連結しない。

### 13. Git Bash -> cmd.exe slash変換

DevSpaceのGit Bash shellから `cmd.exe /d /c ...` を呼ぶとMSYS path変換が発生することを実機確認した。

Git Bashからの手動検証時は:

```text
cmd.exe //d //c Status-AgentToolsGateway.bat
```

を使用する。通常のWindows cmd/Terminalやbatchダブルクリックでは不要。

## 自動テスト結果

最終チェックは `npm run check` を正本とする。

直近PASS構成:

- `scripts/static-audit.js`: 22項目 PASS
- `scripts/devspace-manager-test.js`: 23項目 PASS
- `scripts/smoke-test.js`: 6項目 PASS
- `gateway.health`: healthy
- production DevSpace: read-onlyでhealthy確認

DevSpace manager testは `productionDevSpaceTouched=false` を明示し、start/stop/restart/recoverはfake runtime/process/serverで試験する。

## Windows launcher

追加済み:

- `Start-AgentToolsGateway.bat`
- `Status-AgentToolsGateway.bat`
- `Doctor-AgentToolsGateway.bat`

PowerShell ExecutionPolicyへ依存せず、固定Node.jsを直接使用する。

Gateway transportはstdioのため、Gateway自身のprocess lifecycleはMCP host側の責務。曖昧なNode process検索でkillする `Stop/Restart-AgentToolsGateway.bat` は安全上作成していない。

## 残る意図的な制限

コード上の復旧経路とライブ運用解禁は分離している。legacy global booleanは全てfalseを維持し、個別allowlistだけを利用する。

個別許可済み:

- `discord.post`: ユーザー明示依頼assertion + matching confirmToken + allowed path
- `git.commit`: ユーザー明示依頼assertion + matching confirmToken
- `git.push`: ユーザー明示依頼assertion + matching confirmToken
- `task.run`: ユーザー明示依頼assertion + matching confirmToken + trusted adapter + `taskCommandPolicy`再検証。network-requiring taskは未許可

未解禁:

- `discord.restart`
- 本番DevSpaceの実stop/restart/recover
- 実filesystem delete
- 実registered process control
- destructive action全般
- arbitrary external/network action
- arbitrary write action
- arbitrary long-running command / unsupported task adapter
- `requiresNetwork=true` のlong-running task

DevSpaceのSPOF対策は独立Watchdogへ移行したため、自己復旧のためだけにAgentTools MCP GatewayをChatGPTへ別登録する必要はない。

Watchdogについては以下を検証済み:

- healthy時はno-op
- 連続失敗thresholdまで復旧しない
- force escalationは高いfailure thresholdまで遅延
- cooldownでrestart loopを抑制
- 1時間当たりのrecovery rate limit + circuit breaker
- privileged Watchdog sourceに `exec`, `shell:true`, `cmd /c`, `powershell -Command` なし
- Scheduled Task登録/解除PowerShellの構文解析
- `New-ScheduledTaskAction/Trigger/Principal/SettingsSet` object生成

残るライブ作業は `AgentTools-DevSpaceWatchdog` の実登録と、必要なら別途明示的に行う本番DevSpace停止試験。
