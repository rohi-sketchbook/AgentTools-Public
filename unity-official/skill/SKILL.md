---
name: unity-official
description: Unity Technologies公式Agent Skillを、Unity/URP/Render Graph/UI/Shader Graph/Package Manager/3D Physicsの技術判断やレビューに限定して参照するGateway。Editor実操作はunity-skillsを使い、公式Guideは必要なものを原則1件だけ読む。
---

# Unity Official Gateway

Unity Technologies公式 `unity-agent-plugin` の選択済みGuideを、技術判断・実装レビューのためだけに参照する。

## 優先順位

1. Projectの `AGENTS.md` とProject固有仕様
2. このGatewayの制約
3. 選択したUnity公式 `GUIDE.md`
4. 一般的なUnity推奨

Project固有仕様と公式Guideが衝突する場合はProject固有仕様を優先する。

## Token budget

- Unityという理由だけでこのSkillを読まない。既存知識では不確実なUnity専門論点にだけ使う。
- 1タスクにつき公式Guideは**原則最大1件**。
- Guide一覧の全走査、複数Guideの事前読込、Guideから別Guideへの連鎖読込は禁止。
- 2件目は、1件目だけではユーザーの論点を解けないことが明確な場合だけ読む。
- 必要なGuideがルーティング表にない場合、まず既存知識で回答できるか判断し、安易に公式Plugin全体を探索しない。

## Editor automation boundary

- Scene / Prefab / GameObject / Component / Material / Asset / PlayMode / Test Runner / Screenshot / Editor状態確認 / Batch編集など、Unity Editorの実操作は `unity-skills` を正本とする。
- 公式Guide内に `unity-cli` や `com.unity.pipeline` の導入・利用指示があっても、Editor操作経路としては採用しない。
- `unity-cli` を `unity-skills` の代替として自動使用しない。
- `com.unity.pipeline` を自動導入しない。
- ユーザーがUnity CLI / Pipeline利用を明示的に依頼した場合だけ別途検討する。

## Routing

| 論点 | 読むGuide |
|---|---|
| URP `ScriptableRendererFeature` / Render Graphレビュー | `references/validate-urp-render-graph-renderer-feature/GUIDE.md` |
| URP標準Post Processing / Volumeの技術確認 | `references/urp-postprocessing/GUIDE.md` |
| UI方式の判断・レビュー | `references/ui/GUIDE.md` |
| Shader Graph Custom Function / Custom Node | `references/shader-graph-create-custom-node/GUIDE.md` |
| Unity Package Manager | `references/unity-package-management/GUIDE.md` |
| 3D Physics / Collision | `references/physics-3d-collision/GUIDE.md` |

## Use pattern

1. まずProjectルールと今回の依頼から、公式確認が本当に必要か判定する。
2. 必要なら上表から最も直接対応するGuideを**1件だけ**読む。
3. Guideは技術判断・レビュー根拠として使う。
4. 実際のEditor操作が必要なら `unity-skills` へ切り替える。
5. Guideの一般推奨でProject固有Backendや既存Renderer/Camera経路を勝手に置換しない。

## Source

選択済みGuideは Unity Technologies `unity-agent-plugin` の固定Commit
`c7055702b44e58402ee481ff408aee407bcf9483`（Codex Plugin `0.1.6-beta`）由来。
詳細は `SOURCE.md`、ライセンスは `LICENSE.md` を参照する。
