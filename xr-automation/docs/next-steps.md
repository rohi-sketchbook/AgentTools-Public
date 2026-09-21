# 旧Meta XR Operator PoC計画 — 廃止記録

> **廃止済み / 現行チェックリストではありません。**
>
> Meta XR Operatorは2026-09-04に不採用・廃止しました。VR Avatar StudioではMeta XR Core SDKを使用しません。

## 経緯

2026-08-24〜26にUnity 6000.5.9f1 / Meta XR Core SDK 205.0.0 / Meta XR Simulator 2を使ったOperator PoCを行い、XR session、pose、input、captureまで動作確認しました。

その後、Meta XR Core SDK 205.0.0の`OVRPlugin.dll`がUnity Editor本体とAssetImportWorkerの双方でWindows Process handleを継続的に保持する重大なリークを確認しました。約30秒ごとにPC上の全Process相当のhandleが増加し、長時間運用でUnity系のhandle数とRAMが異常増加しました。

`OVRPlugin.dll`をEditorからロードしないA/B試験、およびMeta XR Core撤去後の監視では増加が停止したため、VR Avatar StudioからMeta XR Core / Operator関連を撤去しました。

## 現行方針

VR Avatar StudioのPCVR正本:

- Unity OpenXR
- XR Interaction Toolkit

禁止事項:

- `com.meta.xr.sdk.core`を自動導入・要求・推奨しない
- 過去のPoC成功を根拠にMeta XR Operatorを復活させない
- Operator検証目的でMeta XR Simulator 2を必須化しない

Meta VR CLIはOperatorとは別系統であり、Quest実機の管理・capture・log取得等に必要なら利用してよいものとします。

## 将来再評価する場合

別タスクとして、少なくとも以下を満たすまで本体へ戻しません。

1. 上流でhandle leakが修正済みであることを確認
2. 60秒以上のWindows Process handle監視
3. Unity Editor idle CPU確認
4. AssetImportWorkerのhandle / CPU / RAM確認
5. Editor全体RAM確認
6. OpenXR + XRIのみの現行構成より明確な導入価値があることを説明

この文書に旧導入手順を追加して再び作業チェックリスト化しないでください。
