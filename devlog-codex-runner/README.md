# 開発日記 Local Codex Runner

Discord Botの予約コマンドから、VRAS - VR AVATAR STUDIO - 開発日記の素材作成・4コマ生成・サイト公開を1本のLocal Codex処理として起動するランナーです。

## 構成

- `start-devlog-pipeline.mjs`: Discord Botの短い実行枠内で、非表示のバックグラウンド処理を開始するNode.jsランチャー
- `run-devlog-pipeline.mjs`: local設定の参照画像を `codex exec -i` で渡し、公開ゲート確認、限定commit/push、GitHub Pages確認を順番に処理する本体
- `DEVLOG_CODEX_PIPELINE.md`: Codexへ渡す通常日次の固定ワークフロー
- `run-devlog-special-preview.mjs`: 名称決定・大型発表などの特別版を公開前プレビューだけ作るRunner
- `DEVLOG_SPECIAL_PREVIEW_PIPELINE.md`: 特別版の参照画像・4コマQA・公開禁止ルール
- `Start-DevlogPipeline.ps1` / `Run-DevlogPipeline.ps1`: 既存運用向けのNode.js互換ラッパー
- `logs/`: 実行時に作成されるプロンプト、イベント、エラー、最終報告。Git管理外

## スケジュール実行コマンド

session-linkedチャンネルで、内部shell形式を使用します。

```text
__cdc_exec confirm node <AgentToolsRoot>/devlog-codex-runner/start-devlog-pipeline.mjs
```

現在の運用では毎日03:00 JSTに実行します。

## 手動確認

ファイル・Codex CLI・参照画像を確認するだけで、Codex実行や公開は行いません。

```powershell
node <AgentToolsRoot>\devlog-codex-runner\run-devlog-pipeline.mjs --dry-run
```

当日分を手動起動する場合:

```powershell
node <AgentToolsRoot>\devlog-codex-runner\start-devlog-pipeline.mjs
```

## 特別版の公開前プレビュー

名称決定や大型発表など、通常の日次記事と同じ日付に追加記事を作りたい場合は特別版Runnerを使います。このモードは `.devlog-work/<slug>/` だけへ出力し、公開用 `docs/`、一覧、トップページ、Gitを変更しません。

ろひの正式画像はRunnerが固定で添付し、特別版で使用するロゴ等のブランド素材は `--logo` で別途添付します。画像QAでは「2x2の4パネルだけ」「ろひ参照一致」「ロゴ参照一致」「未知の主役キャラなし」「ポスター化なし」「日本語可読」を必須にします。

```powershell
node <AgentToolsRoot>\devlog-codex-runner\run-devlog-special-preview.mjs `
  --slug 2026-09-02-vras-special `
  --date 2026-09-02 `
  --brief <WorkspaceRoot>\vr-avatar-viewer-site\.devlog-work\2026-09-02-vras-special\special-brief.md `
  --logo <WorkspaceRoot>\vr-avatar-viewer-site\docs\assets\images\vras-logo-draft-2026-09-02.png `
  --report
```

`--report` はQA通過後の4コマを設定済みDiscordチャンネルへ確認用として送ります。公開・commit・pushの許可にはなりません。中断後もQA済み画像と `special-status.json` が残っていれば、再実行時に画像生成をやり直さず確認HTMLの生成から安全に再開します。

## 処理境界

1. Codexは記事、画像、サイト統合、Validator実行までを`workspace-write`で行う。
2. Codex終了後、外側のNode.jsランナーが`status.json`の全公開ゲートを確認する。
3. 合格時だけGit Helperへ当日記事、当日画像、日記一覧、トップページの4パスを渡す。
4. commit/push後、ローカルHEADと`origin/main`の一致を確認する。
5. GitHub Pagesの記事URLと画像URLを直接HTTP確認し、成功時だけ`published=true`にする。

Codexサンドボックス内では`.git/index.lock`を作成できないため、Git操作は必ず外側ランナーが担当します。

## 安全条件

- Viewerリポジトリは読取専用
- サイトのcommit/pushは全公開ゲート成功時のみ
- 当日公開に必要な4ファイルだけを明示的にstage
- `.devlog-work/`や既存の無関係な差分はcommitしない
- `reset --hard`、`git clean`、force pushは禁止
- ロックファイルで同時実行を防止
- 当日分が公開済みなら重複commitを作らず冪等終了
- 失敗時は`published=false`のまま具体的な停止理由を記録
