# Model routing and instruction layering

この文書は、Sol/Astra/Codexの役割やagent profileを変更するときだけ読む。

## Current roles

- **ChatGPTホスト側のSol**: DevSpace subagent profileではない。グローバル`AGENTS.md`とProjectの`AGENTS.md`を共通契約として使い、必要なrunbookだけ追加で読む。
- **Codex自動ルーティング**: 標準の実装・レビュー・継続・複雑作業は`gpt-6.1-sol`、高頻度の軽量探索とIdle QAは`gpt-5.6-luna`を使う。
- **Codex Astra (`gpt-6-astra`)**: 自動選択禁止。ユーザーがAstraを明示指定した場合だけ`.devspace/agents/astra.md` profileを使う。
- Codex role mappingの正本は`agenttools-mcp-gateway/config/codex-models.json`。モデル名やthinkingを別文書へ重複固定しない。

## Instruction layering

1. グローバル`AGENTS.md`: 全Project共通の安全境界だけ。
2. Project `AGENTS.md`: 全モデル・全タスク共通の短い契約だけ。
3. `docs/agent-guides/` / Skill: 現在の作業に関係するものだけ読む。
4. `.devspace/agents/<profile>.md`: subagent固有の最小補正。
5. User task: 今回の具体的要求。

同じルールを複数層へコピーしない。特にAstra profileへProject全体の設計説明やSkill手順を複製しない。

## Astra profile policy

Astra profileは明示指定時だけ使用する。Astraには、行動開始、確認質問の抑制、必要文書だけの読込、変更範囲に比例した検証、既存変更の保護といった挙動補正だけを与える。Project固有の詳細はルート`AGENTS.md`や関連runbookから必要時に取得する。

Blender制作でSolが監督する場合も、Sol側の画像比較・品質判定・repair ticket生成は `blender_sol_supervision.md` に隔離し、Astra profileや通常runbookへ複製しない。Astraへ渡すのは圧縮した具体的な作業ticketだけとする。

通常のSol作業はrole mappingから`gpt-6.1-sol`を直接指定し、専用profileは作らない。Astraだけは明示指定専用profileとして分離する。
