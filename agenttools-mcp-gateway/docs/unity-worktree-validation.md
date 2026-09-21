# Unity Worktree Validation

Unity Worktree Validatorは、AutoDevやIdle UI QAの専用機能ではなく、DevSpace管理WorktreeでVR Avatar Studioを安全に検証するための共通基盤です。

## 目的

通常のGit Worktreeには、VR Avatar Studioがローカル配置で参照するUnity依存がそのまま存在しない場合があります。Validatorは必要な依存を管理キャッシュへスナップショットし、対象Worktreeへ一時的にJunctionとして接続してからUnityを起動します。検証後はJunction、Unity子プロセス、生成差分を安全に後始末し、元のWorktree状態を保ちます。

この基盤はAutoDev撤去後も維持します。今後のDevSpace/Codex/ChatGPTによるUnity Worktree検証で共通利用し、`Unity.exe -projectPath <worktree>` の直接起動へ戻さないことを原則とします。

## 構成

- `src/core/unityWorktreeValidator.js`
  - Worktree検査、依存スナップショット/Junction管理、Unity batchmode検証、busy判定、所有プロセスのcleanupを担う本体。
- `config/unity-worktree-validator.json`
  - 対象project、管理Worktree root、ローカル依存、cache/log、timeout等の独立設定。AutoDev設定には依存しない。
- `scripts/unity-worktree-validator-test.js`
  - Junction復旧、依存cache、Unity所有プロセス判定、孤児`.meta`保護等の回帰テスト。`npm run check`の一部として常時維持する。
- `scripts/unity-worktree-session.js`
  - 対話的なUnity Editor検証用ランチャー。依存を安全に接続し、Editor終了時にcleanupする。現時点で常駐コードから直接呼ばれないが、Worktree上でEditorを安全に開く標準経路として維持する。
- `scripts/unity-worktree-session-cleanup.js`
  - Unity検証のowner/guardian異常終了時も、所有Unityプロセスと管理Junctionをcleanupする安全装置。`unityWorktreeValidator.js`のguardianから直接起動されるためruntime依存である。

## AutoDevとの境界

旧AutoDevは課題キュー、claim、worktree統合、検証フローを所有していました。その上でUnity検証手段としてValidatorを利用していました。

AutoDev撤去時に削除するのはAutoDev固有のqueue/policy/integration/processing/worktree orchestrationです。Unity Worktree Validator本体と上記の共通検証・cleanup資産はAutoDev固有ではないため削除対象に含めません。

## 検証

Gateway全体の変更では次を実行します。

```text
npm run check
```

Validator単体では次を実行できます。

```text
npm run test:unity-worktree-validator
```

実Unity EditorをWorktreeで開く場合は、直接`Unity.exe`を起動せず`unity-worktree-session.js`経由を使用します。
