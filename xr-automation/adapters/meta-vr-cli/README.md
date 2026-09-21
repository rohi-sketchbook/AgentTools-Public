# Meta VR CLI Adapter

Meta Quest実機の管理・観測を担当するAdapterです。

正本コマンド:

```text
npx -y metavr
```

MCP stdio server:

```text
npx -y metavr mcp server
```

`xr-automation`ではグローバルinstallやvendor checkoutを正本にしません。公式の推奨に合わせ、必要時にnpx経由で起動します。

主な責務:

- Quest device列挙・接続状態確認
- APK install / launch / stop
- screenshot / screen recording
- device log
- Perfetto capture / analysis
- Meta Quest developer documentation search

Metaアカウントへのログイン、Developer Mode変更、USB debugging承認など人間の認証・端末設定が必要な操作は自動化の前提にしません。
