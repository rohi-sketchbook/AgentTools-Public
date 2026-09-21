# XR Automation Agent Tool

Canonical root: `<AgentToolsRoot>\xr-automation`

XRアプリのホスト側自動化・診断をプロジェクト横断で扱う共有基盤です。現在の現役経路は **Meta VR CLI** と **Unity MCPBridge** です。VR Avatar Studio固有のUnity packageやvendor SDKはここから導入しません。

## 現在の構成

- `MetaVR.bat` — Meta VR CLI (`metavr`) のオンデマンド入口
- `Start-MetaVR-MCP.bat` — Meta VR CLI MCP serverをstdio / telemetry無効で起動
- `Status-XRAutomation.bat` — ローカル前提条件をネットワークアクセスなしで確認
- `XRAutomation.bat` — 共通ランチャー
- `scripts\Invoke-XRAutomation.ps1` — 共通診断 / Unity MCPBridge helper
- `config\providers.json` — DevSpace等から利用する現役Provider定義
- `adapters\meta-vr-cli` — Quest実機管理Adapter
- `skill\SKILL.md` — ChatGPT / DevSpace向け共有Skill

## 現行方針

VR Avatar StudioのPCVR正本は次の構成です。

- Unity OpenXR
- XR Interaction Toolkit

Meta XR Core SDKは使用しません。`com.meta.xr.sdk.core`をVR Avatar Studioへ自動導入・要求・推奨しないでください。

Meta XR Operatorは2026-09-04に不採用・廃止しました。過去のPoC成功を理由に再導入しないでください。Meta XR Core SDK 205.0.0 / `OVRPlugin.dll`でUnity Editor本体とAssetImportWorkerのWindows Process handleが継続増加する重大なリークを実測したためです。

再評価する場合は別タスクで、上流修正の有無、60秒以上のProcess handle監視、Editor idle CPU、AssetImportWorker、RAMを再検証してから判断します。

Meta XR Simulator 2は過去のOperator PoCで使用しましたが、現在のVR Avatar Studioの自動化経路では利用しません。既存のSimulator helper scriptは履歴・独立検証用であり、VR Avatar StudioへMeta SDKを戻す根拠にしないでください。

## Meta VR CLI

Quest実機の管理、アプリ操作、capture、log、performance tooling等にはMeta VR CLIを利用できます。Operatorとは独立した経路です。

```text
npx -y metavr --version
npx -y metavr mcp server --no-telemetry
```

例:

```bat
MetaVR.bat --version
MetaVR.bat device list
MetaVR.bat capture screenshot -o latest.png
Start-MetaVR-MCP.bat
```

`metavr`初回実行時はnpm cacheへの取得が発生する可能性があります。認証・Metaアカウント設定・Developer Mode変更は自動では行いません。

## Unity MCPBridge

`scripts\Invoke-XRAutomation.ps1`の`mcpbridge-*` actionはOperatorとは別のUnity Editor RPC helperとして維持します。

利用可能なaction:

- `mcpbridge-status`
- `mcpbridge-tools`
- `mcpbridge-menu`
- `mcpbridge-call`

これらは一時discovery情報から対象Unity Editorへ接続し、Bearer token自体は表示しません。

## DevSpace統合

現在の責務分離:

```text
ChatGPT
  -> DevSpace
      -> UnitySkills / Unity MCPBridge
      -> xr-automation
          -> Meta VR CLI / Meta VR CLI MCP
```

## 常駐処理

このツール自身はwatchdog、timer、polling daemonを追加しません。Meta VR CLI MCP接続は必要なセッション中だけオンデマンド起動します。

## 履歴文書

- `docs\implementation-status.md` — 現行状態とOperator廃止理由
- `docs\next-steps.md` — 旧Operator PoC計画の廃止記録。現行の作業チェックリストではありません
