# Idle UI QA

## Purpose

VR Avatar Studioの通常開発中に別の自動修正系workerを競合させず、開発が止まったタイミングだけrecent UI screenshotを画像として確認し、客観性の高いUI/UX不具合候補を残す。

Idle UI QAは開発エージェントではない。source変更、worktree作成、commit、main統合、push、Discord送信を行わない。

## Trigger

Scheduled Task `AgentTools-IdleUiQA` が既定10分間隔でone-shot実行する。

実際の画像QAは次をすべて満たす場合だけ起動する。

1. `config/idle-ui-qa.json`でenabled。
2. VR Avatar Studioと同じworkspaceRootを持つactive Work Taskにrunning workerがいない。
3. project fingerprintが前回観測から変化した後、既定30分間変化していない。
4. 現project fingerprintがまだQA済みではない。
5. 設定されたscreenshot directoryに画像が存在する。

project fingerprintはGit HEADとworking treeの変更path、size、mtimeから作る。fingerprintが変化するたびidle graceを最初から数える。

## Visual review

recent screenshotを新しい順に最大12枚だけ選び、DevSpaceのCodex providerへ`localImage`として添付する。

workerは必ず:

- `read_only`
- owner checkoutを使用
- source変更禁止
- 添付画像はexecution workspace内だけ
- 最大16画像（Idle UI QA既定は12画像）

とする。

対象は文字切れ・はみ出し、UI重なり、明確に不自然な位置/サイズ、余白/整列の明確な不統一、同種Toast/警告/メッセージ表示の位置や見た目の不統一、戻る/閉じる等の明確な導線欠落、同一画面内の状態表示矛盾。好みだけに依存する微妙な美観差はfindingにしない。

## Duplicate suppression

findingは「画面 + 問題カテゴリ + 要素」を表すstable keyを持つ。

`state/idle-ui-qa/issues.json`で`status=open`のkeyが再度観測されても、新規findingとして追加しない。`lastSeenAt`と`duplicateObservations`だけ更新する。

つまり未修正の同一問題はQAのたびにユーザーへ繰り返し提示しない。修正確認後は`uiqa.resolve --key <key>`でresolvedにする。resolved後に同じ問題が再発した場合は新規findingとして再度開く。

## State

- `state/idle-ui-qa/state.json`: idle gate、最後にQAしたfingerprint、最終結果
- `state/idle-ui-qa/issues.json`: open / resolved finding ledger
- `state/idle-ui-qa/reports/`: 各画像QAの構造化report

Control Centerは`uiqa status`を読み、開発中、idle待ち、画像待ち、問題なし、指摘あり、errorを表示する。

## Performance

常駐Node processを持たない。10分ごとのone-shotで、通常はWork Task状態とGit fingerprintだけを確認して終了する。画像読込とCodex起動はidle gate通過時かつ未QA fingerprintの場合だけ行う。
