# ChatGPT / Codex 作業オーケストレーション

AgentToolsにおける **ChatGPT + DevSpace + Codex subagent + Work Task + Control Center + Discord Bot** の設計・運用境界を定めます。

具体的なTask CLIの操作手順・例は`agenttools-mcp-gateway/skill/SKILL.md`（global skill名: `work-task`）を正本とし、この文書へ重複させません。

## 1. 基本原則

1. ChatGPTをhost / orchestratorとして扱う。
2. 明確で閉じた作業だけをCodexへ委譲する。
3. ユーザー向け作業状態の正本は`type=work` Taskとする。
4. Control CenterはTaskを表示・操作するUIであり、状態の正本ではない。
5. terminal Work Taskだけから定型Discord完了通知を生成する。
6. Unity / Blender / Local AI / 動画render等の内部実行JobをユーザーTaskへ混在させない。
7. `activity.*`は互換入口、`state/activity/`は互換・内部delivery用途に限定する。

### DevSpace継続の優先順位

進行中の開発Taskに対する継続・再開要求は、添付ファイルのモダリティより優先します。`@devspace 続けて`、`作業再開`、`reopen workspace`等があり、同一Projectの作業文脈が残っている場合は、まず既存DevSpace Workspaceを継続します。

優先順位:

```text
既存開発Taskの継続
  > DevSpace Workspace復旧
  > 添付画像・文書等のモダリティ固有ルーティング
```

Unity/game/renderのスクリーンショットは、画像そのものの編集・加工・生成が明示されない限り診断資料です。`スクリーンショット + モデル/コード/材質修正`を画像編集タスクへ変換しません。また、実作業依頼を引き継ぎ文や作業指示書だけで代替しません。

同一会話・同一canonical Project pathのcheckoutについてはDevSpace自身がpersisted Workspaceを再利用します。hostが`workspaceId`を保持していればそのIDを使い続け、IDを失った場合は同じProject path/modeを`open_workspace`して復旧します。AgentTools Gatewayの`devspace.workspaceLookup`はProject pathからactive/recent Workspaceを確認するread-only診断であり、Workspaceの第二正本ではありません。

## 2. 役割分担

### ChatGPT / host

原則としてhostに残す作業:

- 要件整理、仕様判断、設計
- 複数Subsystemにまたがる変更
- 難しい不具合調査
- Unity実機・GUI・視覚判断を伴う検証
- Codex成果物のレビュー、統合、最終修正
- 外部影響・破壊的操作・高リスク操作の判断

### Codex worker

範囲と完了条件が明確なbounded taskに利用する。モデル名を呼び出し側へ散在させず、`config/codex-models.json`の用途別roleを正本にする。

- `complex`: `gpt-6.1-sol` (high)。Codexへ切り出せる範囲が明確な難しめの実装。広域な設計・統合・長時間判断はChatGPTホストのSolへ戻す
- `continuation`: `gpt-6.1-sol` (medium)。安全なローカル作業の自動継続。Astraは自動選択しない
- `implementation`: `gpt-6.1-sol` (medium)。単純〜中程度の実装、機械的リファクタ、テスト追加、明確なバグ修正
- `review`: `gpt-6.1-sol` (medium)。独立diffレビュー。通常レビューにAstraを常用せず利用枠を抑える
- `lightweight`: `gpt-5.6-luna` (low)。read-only探索、軽量監査など高頻度・低コスト作業

各roleは`model`に加えて内部設定の`thinking`も定義し、DevSpace 1.0.8 CLIへは`--effort`として渡す。作業が曖昧化・広域化・反復失敗した場合はCodexで粘らずhostへ戻す。

### 会話上の担当表示・作業状態

通常のhost作業では毎回`担当: ChatGPT`と表示しない。次の場合だけ担当を明示する。

- Codexへ委譲した
- ChatGPTとCodexが並行している
- CodexからChatGPTへhandoffした
- 最終報告でCodexが実作業へ参加した

DevSpaceを使った開発作業のユーザー向け報告では、担当表示とは別に **作業状態 / 次の作業 / 実際に使ったDevSpace Workspace ID** を必須とします。実行時間上限で中断した場合は`paused_timeout`等のTask状態だけに依存せず、次に会話応答できる最初の報告でその事実と再開可否を明示します。

## 3. Work Task

ユーザー向け作業状態の正本は`agenttools-mcp-gateway/state/tasks.json`の`type=work` Taskです。

Taskを作る代表例:

- 複数ファイルに触る開発作業
- テスト、ビルド、実機確認を含む修正
- Codexへ委譲する作業
- ChatGPT/Codex間でhandoffが起こり得る作業
- AgentTools自体の保守・配備

原則Taskを作らない例:

- 単純な質問
- Git status等の軽い読み取り確認
- 履歴価値が低い短時間のread-only確認

1つのユーザー依頼に対してWork Taskは原則1件とし、並行workerは同じTaskの`workers`で表現します。

### State

互換用`status`とは別に、ユーザーが停止理由を判断できる`state`を持ちます。

- `working`
- `waiting_user`
- `waiting_dependency`
- `paused_timeout`
- `paused`
- `blocked`

`stateReason`は「ユーザー確認待ち」「同じcheckoutを別Taskが変更中」「実行時間上限に到達。再開可能」など、停止理由を短く記述します。

### Goal Contract

完了条件が重要な長時間Taskは`work.goal`へ`agenttools-goal-contract/v1`を保存できます。Goal Contractは少なくとも「達成したい結果」「完了条件」「検証手順」「制約」を構造化し、`goalEnforce=true`の場合は`task.judge --goalResult satisfied`で検証済みになるまで`task.complete`による成功完了を拒否します。

Goal判定は`continue / satisfied / blocked`の3値です。検証手順が定義されているGoalを`satisfied`にする場合はevidenceを必須とし、単にagentが「終わった」と判断しただけでは成功扱いにしません。Goalを変更すると判定状態は`active`へ戻ります。

### Worker run / heartbeat / stall recovery

`work.workers[]`は現在担当だけでなく、workerごとのrun履歴を保持します。各runにはattempt番号、run ID、開始時刻、heartbeat、意味のある進捗時刻、終了理由を保存します。`task.update`は通常の進捗更新と同時にheartbeatとなり、`progressMade=true`または新しい`progressSignature`を付けた更新は「意味のある進捗」として扱います。進捗ログを増やさずheartbeatだけ更新したい場合は`task heartbeat`を使用します。

常駐の短周期全件pollingは追加しません。通常のlifecycle再評価は`task reconcile`または次回host executionの`task resumable`時にboundedなactive Taskだけを対象とします。加えてCodex自動継続を有効にした場合だけ、既存DevSpace watchdog上で既定60秒間隔・最大100件のactive Task確認と1 sweep最大8件の継続処理を行います。10秒のwatchdog本体周期ごとにTask全件を走査しません。既定で10分間進捗がなければ`stalled`、30分間heartbeatがなければrunを`crashed`として回収します。crashが3回連続すると15分間worker circuit breakerを開き、自動的な再試行ループを止めます。通常の復旧は`task recover`、breakerを明示解除する必要がある場合だけ`task recover --force true`を使います。

内部execution Taskは別レコードのままです。Gatewayが起動した子processについてはstdout/stderrの発生を進捗イベントとしてstall timerをリセットし、既定15分無出力でstall終了を要求します。Gateway再起動後に`running`のまま残った内部Taskは`task reconcile`でPIDを確認し、processが消失していればcrash、processが残っているが現Gatewayへ再attachできない場合は安全側に`blocked`として分類します。消費済みconfirmation tokenを使って勝手に再実行はしません。

### Resume Context / execution checkpoint

長時間作業はチャット本文だけへ進捗を保持せず、Work Taskの`work.resumeContext`へ構造化checkpointを保存します。最低限、最後に完了した作業、次作業、workspace/worktree、branch、未コミット有無、実行中だった操作、外部アプリ状態、安全確認、ユーザー確認要否、次操作のimpact、timeout種別、再開回数を保持します。

`task checkpoint`で意味のあるphase境界を保存し、execution timeout時は`task timeout`で`paused_timeout`履歴と自動継続判定を記録します。継続方法は`workflow continuation`設定で切り替えます。`codex`ではtimeout時点では`Codex引き継ぎ待ち`として保持し、watchdogの次回継続sweepでDevSpace Codex workerを起動した時点で`resumeContext.autoResumeStatus=resuming`へ移行します。`chatgpt`では従来通り次のhost executionでcheckpointから再開し、`off`では`paused_timeout`のまま自動継続しません。

自動継続対象は`read / local_write / local_test / local_validation / local_generation`だけです。ユーザー確認、外部送信、push/PR、SNS、production、削除、課金・アカウント操作、同一checkout競合は自動継続しません。既存の明示許可は外部操作そのものの通常policyを省略する根拠にはしません。

無限継続防止として`config/safety.json`の`workTaskAutoResumePolicy`を正本とし、既定で連続timeout 3回、auto-resume 3回、記録上の累積execution 4時間、同一progress checkpoint反復2回を上限にします。意味のある進捗を`progressMade=true`でcheckpointした場合は連続timeout/loopカウンタをリセットできます。

`timeoutKind`は少なくとも`gateway_task / command / chatgpt_execution / dependency / user`を区別します。DevSpace shellの1コマンドtimeout、Gateway内部execution Taskのtimeout、ChatGPT側のturn/execution終了を同じ原因として表示しません。

次のhost executionは開始時に`task resumable`を確認し、同じ依頼/project/workspaceのcheckpointがあれば新規Taskを重複作成せず`resumeContext.nextStep`から継続します。`task resumable`はtimeout履歴が付く前のcheckpoint-only Taskも返すため、checkpoint保存直後にChatGPT/host executionが突然終了した場合も復旧候補を失いません。

`workflow continuation --mode codex`では、このcheckpoint-only断絶も自動継続対象です。ChatGPT heartbeatが既定10分以上途絶れ、安全なlocal impactであり、同一checkout競合もなく、設定をCodexへ切り替えた後に作成されたcheckpointである場合に限り、DevSpaceのpersistent Codex workerへ引き継ぎます。明示的な`chatgpt_execution` timeoutはheartbeat猶予を待たず次回sweepで引き継ぎます。設定有効化前の古いcheckpointを一斉起動しないため、モード変更時刻より古いcheckpointは自動委譲しません。

Codex自動継続はprovider CLIを直接呼ばずDevSpace agent daemon/CLIを使用し、元checkoutの未コミット差分を引き継ぎます。そのためChatGPT生存中には起動せず、外部送信・commit/push・PR・production・削除・課金/アカウント操作は禁止した安全なローカル作業だけを委譲します。Codex終了後はTask ownerをChatGPTへ戻し、変更・テスト結果の最終確認待ちにします。

自動継続roleは既定で`gpt-6.1-sol`を使用する。`gpt-6-astra`は明示指定専用であり、role mappingや自動継続からは選択しない。同じWork Taskで前回のCodex継続が正常完了し、同じモデルを引き続き使える場合は、次checkpointで新しいagentを作らず保存済みDevSpace Agent IDへ`agents continue`し、同一Codex session/contextを継続利用する。失敗・停止session、モデル変更、または`reuseCodexSession=false`の場合は新規sessionへfallbackする。Work Task checkpointは引き続き障害復旧の正本であり、session再利用に依存して安全情報を省略しない。

OpenAI側でChatGPTのturnそのものが終了した場合、ローカルGateway単体で新しいChatGPT turnを生成することはできません。`chatgpt`モードの責務は状態を失わず次host executionで復元すること、`codex`モードの責務はその空白期間の安全なローカル作業をDevSpace workerへ移譲することです。OpenAI側の実行上限を回避した扱いにはしません。

Control CenterはCodex引き継ぎ状態、実際に選択されたモデル、DevSpace Agent ID、引き継ぎ回数、session再利用状態、開始/終了、結果、およびDevSpaceが取得できるCodex利用枠スナップショットを表示します。自動継続設定のtooltip/footerにも現在のモデルとthinkingを表示します。現状DevSpaceが取得できるusageは`usedPercent / remainingPercent / resetsAt / source`であり、input/output/cache token数やturn単位の正確なtoken消費量ではありません。

Control Centerの通常の続行操作は、Task ID・現在進捗・保存済み次作業を含むChatGPT再開プロンプトを生成してclipboardへ渡すだけとし、workerを自動起動しません。ユーザーが別の「Codexで続行」を明示した場合だけDevSpace continuationを起動し、その手動経路は`codex-models.json`の`implementation` roleを使用します。自動timeout継続の`continuation` roleもGPT-6.1 Solを使用し、Astraはユーザーが明示指定した場合だけ利用します。

### 更新粒度

Taskは低レベル操作ログではありません。意味のあるphase変更だけを記録します。

- 調査 → 設計 → 実装 → テスト → 統合
- Codex委譲 / 完了 / handoff
- blocked / waiting / resume
- 全体完了

ファイルを読むたび、shell commandを実行するたびには更新しません。

### Internal execution jobs

`state/tasks.json`にはWork Task以外に、Unity / Blender / Local AI / video render等の内部実行Jobも存在します。これらはPID、stdout、timeout等のprocess管理用であり、Control CenterのユーザーTask一覧には表示しません。

`task.run`は`type=work`を実行してはいけません。Work Taskと内部execution Taskは必ず別レコードとし、Work Taskへcommand metadataを付けて直接process実行する経路は拒否します。内部execution timeoutでは`executionAttempt / executionGeneration / gatewayInstanceId / timeoutKind / terminationState / exitConfirmedAt`等を保存し、「timeout要求」と「child process終了確認」を区別します。timeout後に消費済みconfirmation tokenを再利用して同じexecutionを無条件再実行しません。

## 4. Activity compatibility

`activity.start/update/complete/fail/cancel`は旧クライアント互換入口としてのみ残します。新規作業では使用せず、互換入口から呼ばれた場合もWork Taskへ同期し、Task側を正本とします。

`state/activity/activities.json`は旧履歴・内部ログ、`state/activity/notifications/`はterminal Work Taskから生成されたDiscord delivery eventの内部spoolとして利用できます。

名称や内部保存パスに`activity`が残っていても、ユーザー向け作業モデルを「Work Activity」と呼びません。

## 5. Codex delegation / worktree

DevSpace subagentの具体的な操作は`subagent-delegation` Skillを正本とします。

### Write task

Codex write taskは原則managed worktreeへ隔離します。

owner checkoutがdirtyで未コミット差分を安全に新worktreeへ再現できない場合、`WORKTREE_SOURCE_DIRTY`を無理に回避しません。host側で続行するか、明示的にclean baseを用意します。

### Read-only task

調査やReviewerはread-only / checkout isolationを基本とし、不要なworktreeを増やしません。

### Review

Codex write task後の独立レビュー方針はGatewayのworkflow review settingに従います。

- `codex`: 別sessionのread-only Codex Reviewerを優先
- `chatgpt`: 追加Codexを使わずhostがレビュー

quota guardやprovider failureでReviewerを開始できない場合はhost reviewへfallbackし、繰り返し再試行しません。

## 6. Handoff

次の場合はCodexからhostへhandoffします。

- usage/quota limit
- provider failure
- worktree/source conflict
- 作業範囲が当初より広がった
- 反復失敗している

Task上ではCodex workerを`done`または`blocked`にし、host workerへownershipを移します。同じ変更を両者が同一checkoutで同時編集しません。

## 7. Control Center

Control CenterはユーザーTaskの進捗・履歴・担当・現在作業・停止理由を表示します。

- Work Task Storeを書き換える別正本を持たない
- 内部実行JobをユーザーTaskへ混ぜない
- `working`と確認待ち・依存待ち・timeout停止を区別して表示する
- 「サービス確認」等の再読込操作では最新Task状態も取得する
- 選択Taskには「状況確認」「続行」「タスク終了」を提供する。
  - `状況確認`: Task Storeを変更せず、Work Taskへ記録された最新ChatGPT進捗、現在状態、DevSpace Workspace、Git branch/変更件数をread-onlyで確認する。ChatGPT製品の完全な会話履歴を取得したとは表示しない。
  - `続行`: 停止Taskに明示的なcontinue requestを記録する。安全な`resumeContext`がある場合だけ既存DevSpace continuation経路を起動する。checkpointがない場合は次回ChatGPT host executionで拾える要求として保持し、作業開始済みとは表示しない。外部・破壊的・確認必須actionは「続行」クリックだけで許可された扱いにしない。
  - `タスク終了`: 閉じ忘れTaskを成功完了にする手動operator操作。明示確認とstale Task検知を行い、reconcile後もactive workerが残るTaskは拒否し、`completeWorkTask`のGoal Contract enforcementを迂回しない。
- Web Control Centerのremote writeは上記Task操作だけに限定し、Cloudflare Accessに加えてsame-origin CSRF防御を必須とする。任意Gateway/DevSpace command実行endpointは公開しない。

Control Center停止中でもGateway Task Storeが正本であるため、作業自体は継続できます。

## 8. Discord terminal notification

Discordへ自動送信できるstanding authorizationは、Work Taskから生成される**定型システム通知**だけです。

対象:

- terminal Task: `succeeded` / `failed` / `cancelled`
- Codex自動継続: `continuation_started` / `continuation_completed` / `continuation_failed`

Codex自動継続通知は、ChatGPT executionが途切れた後もユーザーが状態を把握できるようにするための運用通知です。開始時は「Codexへ引き継いだ」、完了時は「Codexのローカル作業完了・ChatGPT最終確認待ち」、失敗時は「Codex継続失敗・ChatGPT再開待ち」を定型フォーマットで通知します。利用可能な場合はCodex model、引き継ぎ回数、quota使用率スナップショットも含めます。

それ以外の中間進捗は自動送信しません。任意Discord投稿、成果物添付、自由文送信にはこの承認を流用せず、通常の明示依頼ルールに従います。Codex worker自身にもDiscord送信権限は与えず、通知はAgentToolsの内部spoolからDiscord Botへ渡します。

通知delivery内部実装が`state/activity/notifications/`を利用していても、通知の意味上の正本はWork Taskとその自動継続状態です。

Discord Bot停止時はdelivery eventを保持し、Taskを未完了へ戻しません。

## 9. Completion rule

ユーザーが明示したterminal pointを満たした時にWork Taskを完了します。

特にGit操作が依頼に含まれる場合:

- `commit`まで依頼: commit成功を標準完了条件とする
- `commit/push`またはpushまで依頼: push成功を標準完了条件とする
- commit/push成功後にユーザーから別途「完了」「クローズ」と言われるのを待たない
- WIP checkpointとして継続するとユーザーが明示した場合だけTaskを継続する

具体的な`task complete`等のコマンドは`work-task` Skillに従います。

## 10. Failure / stale handling

Task記録障害だけで本来の開発作業を失敗扱いにしません。作業を継続し、追跡障害を報告します。

前回セッション異常終了などで`running`が残った場合は、実作業状態を確認してからTaskを再開・失敗・中止・完了のいずれかへ明示的に整理します。時刻だけを見て自動削除しません。

## 11. Performance

Task更新、通知pump、watchdog、queue等の常駐処理は[`background-performance-policy.md`](background-performance-policy.md)に従います。

特に:

- 短周期で全Task/全ログを読み直さない
- 変更検出・offset・ID限定取得を優先
- idle CPU / I/O budgetを設ける
- CPU/I/O超過だけを理由に自動killしない

## 12. Validation

Task / Activity互換層 / Control Center / Discord / subagent連携を変更した場合は、少なくとも次を確認します。

- Gateway関連test
- Work Task create/update/terminal lifecycle
- Activity互換入口がWork Taskへ同期されること
- Control Centerでstate / reason / workerが正しく表示されること
- terminal TaskだけがDiscord delivery対象になること
- 中間進捗が自動Discord送信されないこと
- commit/push completion rule
- `devspace.workspaceLookup`が同一Project pathのactive checkoutをinactive履歴より優先して返すこと
- DevSpace本体の`workspace-conversation.test.ts`で、同一会話・同一Projectの`open_workspace`が同じ`workspaceId`を再利用すること

モダリティ誤ルーティングはGateway単体では画像入力を伴うChatGPT host routingまで再現できないため、次の会話レベル受け入れケースも確認します。

```text
前提: Unity/コーディング作業が同一ProjectのDevSpace Workspaceで進行中
入力: 「@devspace 続けて」 + Unity画面スクリーンショット + モデル/材質/コード修正指示
期待:
  1. 既知のworkspaceIdを再利用する。IDが無効な場合だけ同じProject pathをopen_workspaceする。
  2. 添付画像は診断資料として扱い、画像生成/画像編集へ切り替えない。
  3. 実際のProject修正を行い、引き継ぎ文章だけで代替しない。
  4. 会話報告に作業状態、次作業、workspaceIdを明記する。
```

Gateway全体の総合確認は原則`npm run check`を使用します。
