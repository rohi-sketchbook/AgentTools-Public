# AgentTools Control Center Web

既存のWindows/WPF Control Centerはそのまま残し、同じCollectorからWeb Dashboardを提供します。通常表示はread-onlyで、変更操作はWork Task専用の限定操作と、Control Center自身の更新反映・再起動だけを公開します。詳細状況確認と通常の作業続行はHost Request Queueへ固定形式の依頼を登録し、Scheduled ChatGPTが生成したMarkdownレポートを「通信」欄から閲覧します。

## セキュリティ方針

- Kestrelは常に `127.0.0.1` のみにbindする。
- ルーターのポート開放や `0.0.0.0` bindは行わない。
- Web APIの変更操作はWork Task専用の固定操作（状況確認 / 詳細状況確認のQueue登録 / 続行要求 / 閉じ忘れ完了）と、Control Center自身の更新反映・再起動だけに限定する。DevSpaceサービス起動/停止/再起動、Scheduled Task操作、任意コマンド実行、ログを開く等は公開しない。
- `LogPath`、`WorkspaceRoot`、Collectorの生DetailsはWeb APIへ返さない。
- Taskの依頼全文・担当別メッセージ・作業ログやDevSpace Agent IDはWeb APIへ返さない。外部版はタイトル・状態・フェーズ・プロジェクト・参加者に加え、Codex自動継続の状態・回数・model・利用枠割合だけを返す。利用枠はquotaスナップショットであり正確なtoken数ではない。
- Skill改善候補はstatus/reason/summaryとsanitized diffだけを表示し、保存済みbase/proposed contentやtarget絶対パスは返さない。
- PID、localhost endpoint、Windows絶対パスは公開用文字列からredactする。
- Taskは最大2秒キャッシュ、サービス診断は最大20秒キャッシュし、失敗結果も同じTTLで保持して同時HTTPアクセスをsingle-flight化する。
- ブラウザはTaskとPCリソースを3秒周期、通信欄とSkill改善候補を15秒周期、サービス状態とCodex利用枠表示を60秒周期で更新する。主要表示の「タスク / 常駐アプリ / 通信」は同一領域のタブ切替とし、初期表示はタスクにする。Task一覧はデフォルトでactive Task（`running` / `blocked`）だけを表示し、「履歴を表示」で終了済みを含む取得済みTask全件へ切り替える。通信欄は全体で最新20件、Task詳細では対象Taskの最新10件だけを表示してUIが無制限に伸びないようにする。通信欄の一覧/レポート取得はローカルJSON/Markdownを直接読むだけで、15秒pollからGateway子processを起動しない。Codex app-serverへの実問い合わせは5分キャッシュし、高頻度pollへ子processを混ぜない。
- Codex利用枠APIは`planType`、短期/長期windowの使用率・残量・リセット時刻、利用可能なFull reset件数だけを返す。account IDやcredit ID等の識別情報はWebへ返さない。
- CPU/RAMはWindows APIからO(1)で取得し、GPU使用率/VRAM/GPU温度はNVIDIA環境では`nvidia-smi`を最大5秒キャッシュして取得する。
- HTTPレスポンスにCSP、`no-store`、`nosniff`、`no-referrer`等の防御ヘッダーを付与する。
- インターネット公開は Cloudflare Tunnel + Cloudflare Access を前提とする。
- Tunnel側でも `originRequest.access.required: true` を設定し、Access JWTをcloudflaredで検証する。Task変更APIとControl Center更新APIはさらにAccess identity headerの存在をアプリ側でも要求する（localhost直アクセスは除く）。
- Task変更APIとControl Center更新APIはJSON + `X-Control-Center-CSRF`を必須とし、CSRF tokenは同一originの`GET /api/task-actions/session`から取得する。`Sec-Fetch-Site`が送られるブラウザでは`same-origin`以外を拒否する。
- Control Center更新は、現在のWebを稼働させたままstagingへDesktop/WebをRelease publishし、両方のbuild成功後だけ短時間停止して`dist`を入れ替える。切替後のWeb healthが失敗した場合は旧`dist`へロールバックする。複数端末からの同時実行は`state/`配下の一時lockで拒否する。
- 「タスク終了」はブラウザ/desktop側で明示確認し、表示時の`updatedAt`と現在値が一致しない場合は完了を拒否する。Goal Contractの完了制約も通常の`completeWorkTask`で維持する。

## ローカル起動

開発実行:

```powershell
dotnet run --project .\AgentToolsControlCenter.Web.csproj -c Release
```

URL:

```text
http://127.0.0.1:47832
```

ポートだけ変更する場合:

```powershell
$env:CONTROL_CENTER_WEB_PORT = '47833'
dotnet run --project .\AgentToolsControlCenter.Web.csproj -c Release
```

bind先は変更できず、常にloopbackのみです。

## Releaseビルド

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Build-Web-Release.ps1
```

出力:

```text
dist\AgentToolsControlCenter.Web.exe
```

Web版はこのPCに導入済みの .NET 10 ASP.NET Core Runtime を利用するframework-dependent構成です。

起動:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-Web.ps1
```

未起動の場合だけ起動し、healthとloopback bindまで検証する場合:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Ensure-Web-Running.ps1
```

Windowsログオン時にWeb Dashboardを起動する場合:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-Web-Startup.ps1
```

解除:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Uninstall-Web-Startup.ps1
```

## Cloudflare Tunnel + Access

外部公開にはCloudflareアカウントとCloudflare上で有効なドメインが必要です。

1. Cloudflare Zero TrustでTunnelを作成する。
2. Self-hosted Access applicationを作成し、本人だけを許可するAccess policyを設定する。
3. Public hostnameをControl Center用サブドメイン（例 `control.example.com`）にする。
4. Origin serviceを `http://127.0.0.1:47832` にする。
5. Access applicationのTeam nameとAUD tagを確認する。
6. `cloudflare\config.example.yml` を `%USERPROFILE%\.cloudflared\agenttools-control-center.yml` 等へコピーし、Tunnel ID / credentials-file / hostname / Team name / AUD tagを設定する。
7. 実際のcredentials JSON、`cert.pem`、token等はリポジトリへ保存しない。
8. Web Dashboardを起動した後、Tunnelを起動する。

Tunnel起動:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-Cloudflare-Tunnel.ps1
```

別のconfigを使う場合:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-Cloudflare-Tunnel.ps1 -ConfigPath C:\Users\<USER>\.cloudflared\control-center.yml
```

`Start-Cloudflare-Tunnel.ps1` は起動前に `cloudflared tunnel ingress validate` を実行します。

Tunnel設定完了後、Windowsログオン時にもTunnelを起動する場合:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-Tunnel-Startup.ps1
```

解除:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Uninstall-Tunnel-Startup.ps1
```

Cloudflare公式資料:

- Tunnel setup: https://developers.cloudflare.com/tunnel/setup/
- Tunnel configuration: https://developers.cloudflare.com/tunnel/advanced/local-management/configuration-file/
- Self-hosted Access: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/
- Protect with Access origin parameter: https://developers.cloudflare.com/tunnel/advanced/origin-parameters/#access-settings

## API

```text
GET /healthz
GET /api/services
GET /api/tasks
GET /api/activities  # 旧クライアント互換
GET /api/resources
GET /api/communications  # 最新20件
GET /api/tasks/{id}/communications  # 対象Taskの最新10件
GET /api/communications/{id}
GET /api/skill-improvements
GET /api/task-actions/session
GET /api/control-center/update-status
POST /api/control-center/apply-update
POST /api/devspace/restart
POST /api/tasks/{id}/inspect
POST /api/tasks/{id}/inspect-detailed
POST /api/tasks/{id}/continue-chatgpt
POST /api/tasks/{id}/resume-prompt  # 旧UI/互換用途。通常UIでは未使用
POST /api/tasks/{id}/continue-codex
POST /api/tasks/{id}/continue  # 旧クライアント互換。Codexは起動しない
POST /api/tasks/{id}/complete
```

変更系endpointはTaskの限定操作、Control Center自身の更新反映、および固定されたDevSpace安全再起動だけです。任意Gateway CLI、任意のDevSpace service control、Git、Discord等へ転送できる汎用POST endpointは提供しません。

- `update-status`: Control Centerの関連source更新時刻とDesktop/Webのpublished executable時刻を比較し、Release反映待ちかだけを返す。絶対パスは返さない。
- `apply-update`: `confirm=true`、Cloudflare Access identity、same-origin、CSRFを通過した場合だけ固定スクリプト`Apply-Update-And-Restart.ps1`を起動する。sourceをstaging buildしてからDesktop/Webを入れ替えるため、build失敗時は現行Webを停止しない。
- `devspace/restart`: `confirm=true`、same-origin、CSRFを通過した場合だけ既存の`devspace-manual-control.js restart`固定経路を直接実行する。maintenance markerと安全なgraceful restartは正本スクリプト側で管理し、Watchdog更新処理はDevSpace再起動の前提条件にしない。任意actionや任意コマンドは受け付けない。

- `inspect`: Work Taskへ記録された最新ChatGPT進捗、現在のTask状態、DevSpace Workspace有無、Git branch/変更件数をread-onlyで即時確認する。ChatGPT製品の完全な会話履歴を取得する機能ではない。
- `inspect-detailed`: 同一Taskのpending/processing依頼がなければ、固定type `task_detailed_inspection` をHost Request Queueへ登録する。対象Projectの任意コマンドをWebから渡すAPIではない。Scheduled ChatGPT側がDevSpaceでread-only調査し、原則1500文字以上・Markdown見出し5個以上のレポートを生成した後にcompletedへ遷移する。
- `continue-chatgpt`: 固定type `task_continue` をHost Request Queueへ登録する。Scheduled ChatGPT Hostが既存Work TaskとDevSpace workspaceを再利用し、Requestで許可された安全なローカル作業の範囲で未完了作業を実際に続行する。通常の続行経路ではCodex worker/Astraを自動起動せず、結果はMarkdown実施レポートとして「通信」に返す。
- `communications`: Host Requestの状態（pending / processing / completed / failed）とsanitized結果概要を表示する。全体一覧は最新20件、`/api/tasks/{id}/communications` は対象Taskだけを最新10件まで返す。個別取得ではcompletedレポート全文をsanitizer経由で返す。絶対レポートパスやRequest内部instructionはWebへ返さない。
- `resume-prompt`: 旧UI/互換用。停止TaskからChatGPT (Sol)へ貼り付ける再開プロンプトを生成するが、通常Web UIの「作業続行」では使用しない。
- `continue-codex`: ユーザーが別ボタンで明示した場合だけDevSpace Codex continuationを開始する。Control Center経由の手動続行は`implementation` role（GPT-5.6 Terra）を使用する。自動継続も`continuation` role（GPT-5.6 Terra）を使用し、Astraはユーザー明示指定時だけ利用する。
- `continue`: 旧Webクライアント互換。現在は`resume-prompt`相当で、Codexを自動起動しない。
- `complete`: 閉じ忘れTaskを手動成功完了にする。明示確認、stale更新検知、worker reconcile後のactive worker不存在、Goal Contract enforcementを通過した場合だけ実行する。

## 負荷設計

サービス状態取得はGateway CLI、PowerShell等を利用するため、リクエストごとには実行しません。サーバー側で20秒TTL + `SemaphoreSlim` single-flightを適用し、ブラウザ側も60秒周期です。

Taskは `state/tasks.json` の `type=work` レコード読み取りだけで、2秒TTLを設けています。内部実行JobはWeb APIへ出しません。Host Request通信欄は`state/host-requests/`のboundedなJSON/Markdown readのみで、ブラウザ側15秒周期です。Queue登録時だけ固定Gateway CLIを起動します。Skill改善候補は`state/skill-improvements.json`のbounded state readだけで、ブラウザ側15秒周期です。PCリソースは2秒TTLでsingle-flight化し、CPU/RAMは固定量のWindows API呼び出し、NVIDIA GPU情報は`nvidia-smi`を最大5秒キャッシュします。サーバー側の常駐timerはなく、閲覧されていない間は診断処理・Task・通信・Skill候補・PCリソースのpollingを発生させません。
