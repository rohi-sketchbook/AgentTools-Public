# AgentTools Control Center

DevSpaceとAgentTools周辺サービスの稼働状況をまとめて確認するWindows常駐アプリです。

## 監視対象

- AgentTools MCP Gateway
- DevSpace
- DevSpace Watchdog
- Idle UI QA（開発アイドル時のUI/UX画像監査）
- Local AI（Stability Matrix / ComfyUI）
- Discord Bot
- UnitySkills
- 開発日記Runner

単純なPID存在確認だけでなく、既存Gatewayのhealth JSON、HTTP/MCP疎通、Watchdogの連続失敗、Idle UI QA、Local AIの`localAi status`、Windows Scheduled Task、UnitySkills設定、開発日記`status.json`を組み合わせて判定します。Local AIはStability MatrixとComfyUI packageが導入済みでComfyUI APIが停止中の場合、オンデマンド運用の正常な「待機」として表示します。

## 主な機能

- サービス状態は起動時と「再確認」ボタン押下時のオンデマンド更新
- ChatGPT / CodexのユーザーTaskは`state/tasks.json`の`type=work`だけを3秒周期で読み取り、担当者・モデル・現在作業を自動更新
- Taskカードをクリックすると、下部詳細欄に依頼内容・担当別状況・Workspace・開始/更新時刻・作業ログを表示
- ヘッダーの「自動継続」で `Codexへ引継ぎ / ChatGPT待ち / OFF` を切替
- Codex自動継続時はTaskカード/詳細に引き継ぎ状態・回数・DevSpace Agent ID・Codex利用枠スナップショットを表示
- `Skill改善候補 (N)`から候補diffをレビューし、承認/却下と承認済み候補の明示適用を実行
- Task一覧はデフォルトでアクティブ（`running` / `blocked`）のみ表示し、「履歴を表示」ボタンで完了・失敗・中止の直近履歴を含む全件へ切替
- 常駐中のTask更新では子プロセスを起動しない低負荷設計
- 正常／警告／停止／処理中／不明の区別
- PID、Endpoint、最終確認、キュー件数などの詳細表示
- 並行作業時は同一タスク内に `ChatGPT (GPT-5.6 Sol)` / `Codex (Terra)` 等のactive workerを併記
- ログフォルダをExplorerで開く
- 診断情報をJSONとしてクリップボードへコピー
- DevSpaceの起動・停止・再起動・診断（Gateway supervisor経由、強制終了なし）
- Watchdog、Idle UI QA、Discord Botの確認付き再実行/再起動
- Local AIは初期版では状態表示のみ（起動・生成などの実操作はGatewayの確認付きToolへ分離）
- 最小化・閉じる操作でタスクトレイ常駐

DevSpace操作は `agenttools-mcp-gateway\scripts\devspace-manual-control.js` を正本とし、process ownershipの再検証とGateway supervisorのgraceful shutdown/startを使用します。Watchdog・Idle UI QA・Discordは固定された既存Windows Scheduled Taskだけを使用し、任意コマンドは受け付けません。

## 作業Task表示

ChatGPT / Codex作業の運用正本は `..\agenttools-mcp-gateway\docs\agent-work-orchestration.md`。

Control Centerは`type=work` Taskのconsumerであり、状態の正本ではありません。通常は`running` / `blocked`だけを表示し、「履歴を表示」を押した場合だけ`succeeded` / `failed` / `cancelled`を含む直近履歴へ展開します。active Taskはさらに`working / waiting_user / waiting_dependency / paused_timeout / paused / blocked`を表示用状態として使い分け、カード右上で「作業中」「確認待ち」「依存待ち」「時間切れ」「一時停止」「待機中」を判別できます。`resumeContext.continuation`がある場合は「Codex引継ぎ中」「Codex継続中」「最終確認待ち」「引継ぎ失敗」を優先表示し、詳細欄にはDevSpace Agent ID、引き継ぎ回数、開始/終了、結果、使用枠を表示します。usageはDevSpaceが取得したCodex quotaの`usedPercent / remainingPercent`であり、正確なinput/output token数ではありません。Unity/Blender/Local AI/動画render等の内部実行Jobは表示しません。並行作業では同一Task内のactive workerを併記します。

ヘッダーの「自動継続」はGatewayの`workflow continuation`設定を変更します。`Codexへ引継ぎ`は安全なlocal checkpointをChatGPT切断後にDevSpace Codexへ委譲、`ChatGPT待ち`は次のChatGPT executionまでcheckpointを保持、`OFF`はtimeout後に自動継続しません。モード変更前の古いcheckpointを後から一斉にCodex起動しない安全策を持ちます。

Task更新はGatewayの`state\tasks.json`を3秒周期で直接読むだけで、更新のたびにNode/PowerShell/DevSpace CLI等の子processを起動しません。

## Codex利用枠

Desktop / Web Control Centerは、ChatGPTプランに紐づくCodexの`account/rateLimits/read`を読み取り、短期枠（通常5時間）と長期枠（通常週次）の使用率・残量・リセット時刻を表示します。`planType`と利用可能なFull reset回数も表示しますが、account IDやreset credit ID等の識別情報は保持・公開しません。これはCodex quotaであり、ChatGPT全体のメッセージ上限やTask単体のtoken消費量ではありません。

UIは1分ごとに再読込しますが、Codex app-serverへの実問い合わせは各Control Centerプロセス内で5分キャッシュし、取得失敗時も同じ間隔で再試行します。Desktopの「再確認」だけは明示操作としてキャッシュを無視して再取得します。

## Skill改善候補

Skill改善候補の設計正本は `..\agenttools-mcp-gateway\docs\skill-improvement-workflow.md` です。Desktop Control Centerは`state\skill-improvements.json`を最大15秒間隔で読み、候補一覧・理由・diffを表示します。承認は状態更新だけで実ファイルを変更せず、適用は承認済み候補に限ってGatewayの`skill.apply` dry-run/confirmTokenとbase hash再確認を通します。

Skill改善候補についてはWeb Control Centerでも引き続きremote read-onlyで、候補とsanitized diffの表示だけを行います。Web全体ではWork Task専用の限定操作（状況確認 / 詳細状況確認Host Request / ChatGPT作業続行Host Request / 明示的なCodex続行 / 閉じ忘れ完了）、Control Center自身の更新反映・再起動、および既存の安全経路に固定したDevSpace再起動だけをCSRF保護endpointとして提供し、Skill改善の承認・却下・適用endpointや任意プロセス操作endpointは提供しません。通常の「作業続行」はHost Request Queueへ登録し、Scheduled ChatGPT Hostが既存Task/Workspaceを再利用して安全なローカル作業を再開します。Codex続行は別ボタンからGPT-5.6系のimplementation roleで明示実行します。Control Center更新はstaging build成功後だけDesktop/Webを短時間停止して`dist`を切り替え、Web health失敗時は旧版へロールバックします。

## 起動

ビルド済みEXEがある場合:

```text
Start-ControlCenter.bat
```

開発実行:

```powershell
dotnet run --project .\AgentToolsControlCenter.csproj
```

## Releaseビルド

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Build-Release.ps1
```

出力:

```text
dist\AgentToolsControlCenter.exe
```

.NET 8 Desktop Runtimeを利用するframework-dependent single-file構成です。

## Windows起動時に常駐

Releaseビルド後に実行します。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-Startup.ps1
```

解除:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Uninstall-Startup.ps1
```

## スモークテスト

```powershell
dotnet run --project .\tests\AgentToolsControlCenter.Smoke\AgentToolsControlCenter.Smoke.csproj -c Release
```

実際のローカル環境へ読み取り専用の状態取得を行い、8件の状態レコードを検証します。再起動処理はテストでは実行しません。

## AgentTools Rootの解決順

1. `AGENTTOOLS_ROOT`環境変数
2. 実行ファイルの親ディレクトリを遡って自動検出
3. `<AgentToolsRoot>`
