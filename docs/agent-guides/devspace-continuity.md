# DevSpace continuation and workspace recovery

この文書は、DevSpaceで進行中の開発作業を継続・復旧するときだけ読む。通常の作業では読み込まない。

## Continuation intent

DevSpaceで進行中の開発作業がある場合、継続・再開の意図を添付ファイル種別や画像処理ルーティングより優先する。`@devspace`、`続けて`、`継続`、`作業再開`、`ワークスペースを開きなおして`、`前の作業を続けて`、`実装を続行`、`continue`、`resume`、`reopen workspace`等は継続要求として扱う。

- 同一Projectに対する既知の`workspaceId`が会話コンテキストにある場合、まずそのIDを再利用する。拒否・無効化された場合だけ`open_workspace`する。
- `workspaceId`を拾えない場合もProject absolute pathが分かるなら作業を止めず、同じcheckout/worktreeモードで`open_workspace`して復旧する。同一会話のpersisted Workspaceが残っていればDevSpace側で同じIDが再利用される。
- AgentTools Gatewayの診断経路を使える場合は`devspace.workspaceLookup`でProject pathからactive/recent Workspaceを確認できる。ただしWorkspaceの正本はDevSpaceであり、lookup結果を固定値として文書へ保存しない。
- `DevSpaceを使えない`と回答する前に、利用可能なDevSpace toolの再発見または`open_workspace`による復旧を試す。
- Workspace復旧だけで解決できる場合はユーザーへ再確認しない。対象Projectを特定できない、または別Projectを開くことで外部影響が変わる場合だけ確認する。
- `workspaceId`はセッション依存のopaque handleとして扱い、`AGENTS.md`やSkill等へ固定値を保存しない。

## Attachments during development

- 開発継続中に添付されたUnity画面、ゲーム画面、レンダー、スクリーンショット等は原則として診断・目視確認用の参考資料として扱う。
- ユーザーが画像そのものの編集・加工・生成を明示した場合だけ画像処理タスクへ切り替える。
- `Unity画面 + モデル修正指示`、`ゲーム画面 + バグ修正指示`、`レンダー + 材質調整指示`は元Projectを修正する開発タスクであり、画像編集タスクではない。
- 実作業依頼を単なる引き継ぎ文章、作業指示書、1コピ用文章だけで代替しない。ユーザーが文章作成自体を依頼した場合だけ文章を成果物とする。

## User-facing work reports

DevSpaceを使った実作業について進捗・中断・完了を報告する際は、次を明確にする。

- **作業状態**: `完了`、`継続作業あり`、`ユーザー確認待ち`、`依存待ち`、`実行時間切れで中断`等。
- **次の作業**: 残作業がある場合は次の具体的作業。完了なら`次の作業なし`等、terminalであること。
- **Workspace ID**: 実作業に使ったDevSpace `workspaceId`。複数Project/worktreeを使った場合はProject pathと対応付ける。
- ChatGPT/host側の実行時間上限で中断した場合は、その事実、再開可否、保存済みcheckpoint、次作業を明示する。強制終了で同一turn内に報告できなかった場合は、次に応答可能になった最初の報告で開示する。

作業Taskの作成・checkpoint・timeout・completionの詳細は`work-task` Skillを正本とする。