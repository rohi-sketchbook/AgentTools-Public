# Discord ChatGPT Queue

ユーザーから「Discord確認して」等の依頼を受けたら、`inbox/*.json` の `status: pending` を確認する。

requestの `cwd` / `workspaceRoot` をDevSpaceで開き、必要な調査・編集を行う。処理開始時はInboxを `processing`、完了時は `completed` に更新し、`outbox/<requestId>.json` を作る。

Outboxは `requestId / channelId / replyToMessageId / content / attachments` を持つ。`channelId` と `replyToMessageId` はInboxの値をそのまま使用する。

OpenAI APIやブラウザ自動操作でChatGPTを起動しない。Codex CLIはユーザーが明示指定した場合のみ使用する。

削除、git push/reset/clean、外部公開、サービス停止、Credential/API Key操作はDiscord側確認済みであることが明確でない限り実行しない。
