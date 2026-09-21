# XR Automation 実装状態

更新: 2026-09-04

## 現行状態

| 機能 | 状態 | 備考 |
| --- | --- | --- |
| Meta VR CLI wrapper | 現役 | Quest実機管理、capture、log、performance tooling等 |
| Meta VR CLI MCP | 現役 | 必要時のみオンデマンド起動 |
| Unity MCPBridge helper | 現役 | `Invoke-XRAutomation.ps1`の限定actionとして維持 |
| Meta XR Operator | 廃止 | 2026-09-04不採用決定 |
| Meta XR Core SDK | VR Avatar Studioでは非採用 | 自動導入・要求・推奨しない |
| Meta XR Simulator 2 | VR Avatar Studioの現行経路では非採用 | 旧PoC履歴のみ |

## VR Avatar Studioの正本構成

PCVRは以下を正本とします。

- Unity OpenXR
- XR Interaction Toolkit

Quest系controller対応はUnity OpenXR標準Featureで維持します。Meta XR Core SDKを外したことはQuest controller対応の廃止を意味しません。

## Operator廃止理由

過去にはUnity 6000.5.9f1 / Meta XR Core SDK 205.0.0 / Meta XR Simulator 2でMeta XR Operator PoCに成功していましたが、2026-09-04に重大なEditorリソースリークを実測したため不採用へ変更しました。

`OVRPlugin.dll`ロード時、Unity Editor本体とAssetImportWorkerの双方で約30秒ごとにPC上の全Process相当のWindows Process handleを開いたまま保持し、長時間起動後には各processで約90万handle規模まで増加しました。Unity系だけで実RAM約19GBまで増加したケースも確認しています。

A/B試験:

- `OVRPlugin.dll`をEditorからロードしない場合、70秒以上Process handle増加なし
- Meta XR Core撤去後、75秒監視で従来の「30秒ごと +約190」が消失
- Main / AssetImportWorkerとも`OVRPlugin.dll`未ロード

VR Avatar Studio側撤去commitは`664c7f9`です。

## 現役ホスト側経路

```text
ChatGPT
  -> DevSpace
      -> UnitySkills / Unity MCPBridge
      -> xr-automation
          -> Meta VR CLI / Meta VR CLI MCP
```

`mcpbridge-*`はOperator専用ではないUnity Editor RPC helperとして維持します。Bearer tokenをchat/log/sourceへ露出しません。

## 再発防止

過去のPoC成功を理由にMeta XR Core / Meta XR Operatorを復活させません。将来再評価する場合は別タスクで上流修正を確認し、60秒以上のProcess handle監視、Editor idle CPU、AssetImportWorker、RAMを必須検証にします。

Meta VR CLIはOperatorとは別物なので、Quest実機管理等で必要なら引き続き利用します。
