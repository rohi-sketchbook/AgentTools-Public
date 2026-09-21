# Skill改善候補ワークフロー

AgentToolsでは、作業中に見つかった再利用価値のあるSkill改善を即時反映せず、**候補として保存 → diff確認 → 承認/却下 → 明示適用**の順で扱います。

## 目的

- Task完了のたびに追加LLM判定を回してトークンを消費しない。
- Agentが勝手に`SKILL.md`を書き換えない。
- 改善理由とdiffをユーザーが後からまとめて確認できる。
- 提案後にSkillが更新されていた場合、古い提案で上書きしない。
- Skill改善機能はWeb Control Centerでもremote read-only境界を維持する。Work Task専用の限定操作endpointとは権限境界を混在させない。

## 状態の正本

Gateway stateの`state/skill-improvements.json`を正本とします。

Proposalは最低限、以下を保持します。

- proposal id
- target `SKILL.md`
- Skill名
- status
- reason / summary / source / proposedBy
- related Work Task id（任意）
- base SHA-256
- proposed content / proposed SHA-256
- compact diff
- review情報
- stale理由 / appliedAt

保存件数はboundedとし、active proposalを優先して最大50件保持します。提案本文は64KiB、表示diffは16KiBを上限とします。

## 状態遷移

```text
pending -> approved -> applied
   |          |
   +-> rejected
   +-> stale
```

`stale`は、提案作成後に対象SkillのSHA-256が変わったため、そのproposalをそのまま適用できない状態です。新しい現在内容を基準にproposalを作り直します。

## 候補を作るタイミング

通常作業で既に具体的な根拠が得られた場合だけ候補を記録します。active Work Task中に見つかった改善は、その場で`task.skillCandidate`へbufferし、Task終端時に追加LLM判定なしで`skill.propose`へflushします。

例:

- 文書化済み手順が誤っていた。
- 同じ復旧/検証手順を再発見した。
- 繰り返し起きるミスを明確なルールで防げる。
- 重複・矛盾したSkillの統合方法が明確になった。
- ユーザーがSkill棚卸しを依頼した。

**Task完了後に「Skill改善があるか」を調べるためだけの追加LLM turnは起動しません。** 現在の作業コンテキストで自然に改善点が判明した時だけ記録します。

### Work Task buffer

`task.skillCandidate`は対象Skillの現在hashと完全な提案本文を`state/skill-improvement-buffer.json`へbounded保存します。Task側には本文を持たず、candidate id / Skill名 / reason / summary / statusだけを保持します。

```text
task.skillCandidate
  -> buffered
  -> task.complete / task.fail / cancelled completion
  -> skill.propose(source=task_completion)
  -> pending proposal
```

1 Taskあたりbufferは最大8件、buffer全体は最大100件です。Task完了前に対象Skillのhashが変化したcandidateは`stale`として止め、別内容へ古い提案本文を重ねません。proposal化に失敗しても本来のTask完了は妨げず、Task work logへ失敗理由を残します。

manual棚卸しなどactive Work Taskに紐づかない改善は従来通り`skill.propose`を直接使用します。

## Gateway actions

Task中の候補buffer:

```text
task.skillCandidate
```

読み取り・直接proposal登録・レビュー状態更新:

```text
skill.list
skill.get
skill.propose
skill.approve
skill.reject
```

実ファイル変更:

```text
skill.apply
```

`skill.apply`はaction-scoped safety policy上のwrite actionです。以下すべてが必要です。

1. proposalが`approved`。
2. 現在のSkill hashがproposalのbase hashと一致。
3. `userExplicitlyRequested=true`。
4. dry-runで発行されたmatching `confirmToken`。
5. 書込み後のhashがproposal hashと一致。

書込み直前にhash一致を確認した現在内容をメモリ上へ保持し、書込み後検証に失敗した場合はその内容へ復元します。元Skill全文はproposal stateへ重複保存しません。

## Control Center

### Desktop

メイン画面の`Skill改善候補 (N)`からレビュー画面を開きます。

レビュー画面:

- 候補一覧
- 理由 / source / target
- diff
- 承認
- 却下
- 適用（approvedのみ）

承認ではファイルを書き換えません。適用操作ではGatewayのdry-run/confirmTokenを取得した後、さらにユーザー確認ダイアログを表示します。

### Web

Skill改善画面は従来通り**remote read-only**です。Web Control Center全体には別途Work Task専用の限定操作がありますが、Skill改善へwrite権限を流用しません。

- proposal一覧表示
- status / reason表示
- sanitized diff表示

のみを提供し、approve/reject/applyのPOST endpointは持ちません。Work Task操作で導入したCloudflare Access identity確認・CSRF・action confirmationも、Skill改善のwrite許可には流用しません。Skill改善へremote writeを追加する場合は別の設計・確認として扱います。

## 更新頻度と性能

Desktopの候補件数表示は最大15秒間隔、Webのproposal再取得も15秒間隔です。Control Centerが読むのは従来通りboundedな`skill-improvements.json`だけです。`skill-improvement-buffer.json`はTask実行時だけGatewayが読み書きし、常駐poll・子process起動・LLM呼び出しは追加しません。
