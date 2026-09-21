# Background performance guidance

この文書は、常駐プロセス、timer、watchdog、queue pump、同期処理、file watcher、polling、定期実行を追加・変更するときだけ読む。

2026-08-21のDiscord Bot / Codex同期高負荷インシデントを重大インシデントとして扱う。正本ポリシーは`agenttools-mcp-gateway/docs/background-performance-policy.md`。

- 周期処理は原則`O(1)`または`O(変更量)`とし、短周期timerで全件走査・全文読込を行わない。
- file watcherはevent-drivenを第一選択とし、pollingは低頻度かつ固定量のfallbackに限定する。
- append-only fileはoffset / size / mtime等で増分処理する。
- 対象IDが既知なら対象限定APIを使い、常駐loopで全件取得後filterを繰り返さない。
- idle performance budgetとデータ量増加時のscale testを設ける。
- Gateway変更時は可能な限り`npm run audit:background-performance`と関連testを実行する。
- CPU/I/O超過だけを理由にプロセスを自動killしない。