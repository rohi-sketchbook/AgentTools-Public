# 常駐・バックグラウンド処理 性能ポリシー

## 目的

常駐ツール、監視ループ、同期処理、Watchdog、Queue Pump等が、データ量の増加によって徐々にCPU・I/Oを占有する事故を防ぐ。

2026-08-21のDiscord Bot / Codex transcript sync高負荷インシデントを基準事例とする。

## 設計原則

1. 周期処理は原則として `O(1)` または `O(変更量)` とする。
2. 全件列挙・全文読込・全DB走査を高頻度timerへ載せない。
3. ファイル更新は `fs.watch` 等のイベント駆動を第一選択とし、pollingは取りこぼし対策の低頻度fallbackに限定する。
4. append-only logは `size / mtime / byte offset` を保持し、追記分だけ読む。
5. 対象IDが既知なら、そのIDだけを読むAPIを用意する。`includeXxx` と `onlyXxx` の意味を混同しない。
6. 「現在のデータ量なら軽い」を受入理由にしない。常駐処理はデータ量が100倍になったときの計算量を確認する。
7. timer callbackの重複実行を禁止し、`running` / lock / cancellationで多重実行を防ぐ。
8. 重い処理を短周期timerに追加する場合は、コードレビューで周期・最大対象数・最大読込量・fallback理由を明記する。

### Work Taskの既知の例外

AgentTools Control CenterのTask表示は、ユーザーがGUIを開いている間に`state/tasks.json`の`type=work`レコードだけを3秒周期で読む。これは子process/CLI/DB scanを起動せず、Task Store自体もboundedな単一JSON状態ファイルとして扱うため許容する。Task件数や状態ファイルサイズが増えてこの前提を満たさなくなった場合は、`fs.watch`または差分取得へ移行する。

Discord側のterminal Task通知とCodex自動継続の定型ライフサイクル通知は`fs.watch`を主経路とし、30秒以上のtimerは取りこぼし対策fallbackだけとする。通知delivery spoolは移行互換のため`state/activity/notifications`を当面使用する。Codex workerのquota確認はworker開始時のone-shotとする。Control Centerの利用枠表示だけは別経路としてUIを1分更新しつつ、`account/rateLimits/read`の実問い合わせを各Control Centerプロセス内で5分キャッシュする。取得失敗時も5分以内に再spawnせず、3秒Task pollへ子processを混ぜない。

ChatGPT切断後のCodex自動継続は既存DevSpace watchdogへ相乗りするが、10秒のwatchdog周期ごとにTaskを走査しない。継続sweepは既定60秒間隔、active Task最大100件、1 sweepの起動・監視処理最大8件へboundedとし、Codex agent監視は保存済みagent IDへの`get/handoff`だけを行う。将来Task件数が増え、このbounded JSON scan自体がidle budgetを圧迫する場合は、resume candidate indexまたはevent-driven queueへ移行する。詳細は `agent-work-orchestration.md`。

## Idle Performance Budget

通常のアイドル状態の常駐AgentToolsプロセスでは、以下を既定の警戒値とする。

- CPU: 1コア換算 5%以上
- Read: 5 MB/s以上
- Write: 1 MB/s以上
- Working Set: 1 GB以上
- 継続判定: 1分サンプルで5回連続

ビルド、動画処理、明示的な一括変換等のforeground jobは例外だが、常駐idle状態へ戻った後も超過が続く場合は異常とする。

`devspace-watchdog` はAgentTools配下プロセスの累積CPU/I/Oを監視し、継続超過を `resource-budget-exceeded` としてWatchdog履歴へ記録する。自動killは行わない。

## 静的監査

`npm run audit:background-performance` は、少なくとも以下を高信頼度の危険パターンとして検出する。

- 1秒未満の `setInterval`
- 5秒以下の `setInterval` callbackでのファイルI/O
- PowerShellの短周期loopとファイル全走査の組合せ

安全上必要なO(1) fallback pollingは、対象が固定サイズであることを確認した上で `performance-audit: allow-bounded-poll` を明示する。

## テスト要件

常駐・同期機能の変更では、可能な範囲で以下を追加する。

- 未変更時に本文を再読込しないテスト
- append時に追記分だけ処理するテスト
- partial line / rotation / truncateのテスト
- 対象数増加時のscale test
- timer重複実行防止テスト

データ量100倍でidle時処理量も100倍になる設計は、原則として再設計対象とする。

## Unityへの適用

Unity Playerへ常時監視コードを追加しない。開発・デバッグ時はEditor専用診断で確認する。

特に以下をレビュー対象とする。

- `Update` / `LateUpdate` / `FixedUpdate`
- `EditorApplication.update`
- 無限Coroutine
- `FindObjects*`, `GetComponentsInChildren`, `AssetDatabase.FindAssets`
- `Directory.GetFiles`, `File.ReadAllText`, JSON全解析
- 毎フレームのLINQ・大規模allocation

VR Avatar Studioでは `ChatGPT検証用/診断` 配下の性能診断を使い、Editor idle時のCPU・I/O・メモリ増加を実測する。

## Idle UI QA

Idle UI QAは常駐Node loopを持たず、Windows Scheduled Taskから既定10分間隔のone-shotで起動する。

- 通常checkはWork Task状態とGit fingerprintだけを確認して終了する。
- project fingerprintが変化したら30分のidle graceを最初から数え直す。
- 同fingerprintを複数回画像QAしない。
- screenshot列挙は設定済みdirectoryの直下だけ、Codexへ渡す画像は最大12枚とする。
- Codex画像QAはidle gate通過時だけ起動し、通常のdevelopment workerと並行起動しない。
- 未解決findingの再観測は既存ledger更新だけにし、新規Taskや再通知を増殖させない。
