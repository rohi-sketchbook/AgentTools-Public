# AgentTools Agent Rules

このファイルには、AgentTools配下で常時適用する共通契約だけを置く。ツール固有の手順はSkill、詳細な運用ルールは必要なときだけ`docs/agent-guides/`を読む。指示をここへ重複させない。

## Core

- ユーザーが実作業を依頼した場合は、説明文や引き継ぎ文だけで代替せず、利用可能なツールで実作業を進める。
- 既存の未コミット変更やユーザー変更を自分の変更と混同・破棄しない。
- token、API key、cookie等の認証情報をsource / log / commitへ含めない。
- 課金、アカウント変更、外部公開、push、送信、削除など外部影響・破壊性のある操作は、グローバル指示と該当Skillの確認ルールに従う。
- 検証は変更範囲に比例させ、必要な確認が通った後に無関係な広域テストを繰り返さない。

## DevSpace continuation

- `@devspace`、`続けて`、`継続`、`作業再開`、`continue`、`resume`等は継続要求として扱う。既知の同一Project `workspaceId`を再利用し、拒否・不明時だけ同じProject/path/modeを開き直す。
- 開発継続中のUnity画面、ゲーム画面、レンダー、スクリーンショットは、画像そのものの編集・生成が明示されない限り診断・参照入力として扱う。
- 詳細な復旧・報告ルールは`docs/agent-guides/devspace-continuity.md`を、DevSpaceを使う継続作業で必要になったときだけ読む。

## Task / Git

- ユーザー向け作業管理は`work-task` Skillを正本とする。
- commit/pushは`git-helper` Skillとユーザーの明示指示に従う。Git commit messageは日本語とする。

## Read only when relevant

- 常駐処理、timer、watchdog、polling、queue、file watcher: `docs/agent-guides/background-performance.md`
- DevSpace継続・Workspace復旧・作業報告: `docs/agent-guides/devspace-continuity.md`
- Sol/Astra/Codexの役割と指示分離: `docs/agent-guides/model-routing.md`

詳細仕様はREADME、各サブプロジェクトのdocs、該当する`SKILL.md`を参照する。