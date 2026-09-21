# ChatGPT Scheduled Task: AgentTools Host Request Queue

この文書は、ChatGPTのScheduled Taskを1時間ごとに起動し、AgentToolsのHost Request Queueを処理するための運用プロンプト正本です。

## Schedule

- Frequency: every 1 hour
- Purpose: AgentTools Host Request Queueのpending依頼を処理する
- Local project: `<AgentToolsRoot>`

## Scheduled Task prompt

次の処理を実行してください。

1. DevSpaceで `<AgentToolsRoot>` を開く。既存workspaceが再利用可能なら再利用する。
2. DevSpaceの固定目的Tool `host_request_list` を使い、AgentTools workspaceIdを渡してpending Host Requestを最大20件確認する。Queue確認のために`bash`やGateway CLIを直接実行しない。
3. pendingが0件なら何も変更せず終了する。
4. pendingがある場合は古いものから1件ずつ、最大8件まで処理する。各Requestを処理する直前に固定目的Tool `host_request_claim` を使い、そのRequest IDをclaimする。

5. claim結果の `instruction` を正本として実行する。`task_detailed_inspection` は対象ProjectをDevSpaceで開いてread-onlyで詳細調査する。`task_continue` は既存Work TaskとDevSpace workspaceを再利用し、状況確認だけで終わらず、instructionで許可された安全なローカル作業の範囲で実装・修正・テスト・検証を実際に続行する。この通常続行ではCodex worker/Astraを自動起動しない。
6. 各Requestの実施レポートは `report.path` に日本語Markdownで保存する。短い回答ではなく、Requestに指定された章立て・最低文字数・最低見出し数を満たす実務レポートを作成する。推測は推測と明記し、secret/token/cookie等を記載しない。
7. レポート保存後は固定目的Tool `host_request_complete` を使う。`complete` がレポート品質不足を返した場合は、追加調査または説明を加えてレポートを改善し、再度completeする。
8. Requestを完遂できない場合のみ、理由を短く整理して固定目的Tool `host_request_fail` を使う。

9. Host Requestごとの `instruction` とAgentToolsの安全境界を厳守し、Requestで許可されていない操作へ範囲を拡大しない。`task_continue` で許可されるのは対象Taskを前進させる安全なローカル作業までとする。
10. Queue処理結果はローカルのHost Request状態とMarkdownレポートを正本とする。Control Centerがそこを読み取るため、ChatGPT側で数行の要約だけ返して完了扱いにしない。

## Queue

```text
agenttools-mcp-gateway/state/host-requests/
  pending/
  processing/
  completed/
  failed/
  reports/
```

`state/`はGit管理対象外です。

## Host-side fixed tools

Scheduled ChatGPTからQueueを操作する場合は、DevSpaceの固定目的Toolを使用します。

```text
host_request_list
host_request_claim
host_request_get
host_request_complete
host_request_fail
```

これらは既存Gateway CLIの`hostRequest` actionだけを固定引数で呼ぶbridgeで、任意コマンド実行機能を持ちません。CLIはControl Centerやローカル診断用の互換入口として引き続き利用できます。

`task_detailed_inspection` と `task_continue` は、それぞれ同一Task・同一typeのpending/processing依頼がある間は重複登録しません。詳細調査レポートは既定で1500文字以上、作業続行レポートは既定で800文字以上、どちらもMarkdown見出し5個以上が必要で、条件未達では`completed`へ遷移しません。
