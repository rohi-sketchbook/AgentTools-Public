# AgentTools

AgentToolsは、ChatGPT / DevSpaceから利用する共有ローカルツール群です。任意のローカルディレクトリへcloneして利用できます。

## Quick Start

Coreは個人PC固有設定なしで起動できるようにし、Unity Project、DevSpace checkout、Local AI、Discord、開発日記などは必要な機能だけlocal overrideを追加します。

```powershell
cd <AgentToolsRoot>\agenttools-mcp-gateway
node src/cli.js gateway health
node scripts/public-release-audit.js
```

必要な機能の `config/*.local.example.json` を同名の `*.local.json` としてコピーして編集してください。`*.local.*`、`.env`、`.connect`、state、logsはGit対象外です。設定レイヤーは[docs/public-distribution.md](docs/public-distribution.md)を参照してください。

Public配布用treeは既存Private repoをそのまま公開せず、root license選択後に `Export-AgentToolsPublic.ps1` で生成します。初回は空ディレクトリへexportし、以後は `-UpdateGitRepository` で既存の公開Git checkoutを直接更新するため、更新ごとの一時previewディレクトリは不要です。製品固有サンプルは `.agenttools-publicignore` でPublic exportから分離し、ライセンス境界は[docs/licensing.md](docs/licensing.md)を参照してください。

## まず読むもの

| 目的 | 正本 |
|---|---|
| 全ツールの一覧・状態・入口 | [TOOLS.md](TOOLS.md) |
| Agentが常時守るルール | [AGENTS.md](AGENTS.md) |
| ChatGPT / Codex / Task運用 | [agenttools-mcp-gateway/docs/agent-work-orchestration.md](agenttools-mcp-gateway/docs/agent-work-orchestration.md) |
| Gatewayの概要とCLI入口 | [agenttools-mcp-gateway/README.md](agenttools-mcp-gateway/README.md) |
| Gateway詳細資料の索引 | [agenttools-mcp-gateway/docs/README.md](agenttools-mcp-gateway/docs/README.md) |

## 文書の責務

AgentToolsでは同じ手順を複数箇所へ複製しない。

- `AGENTS.md`: 常時適用する短い強制ルール
- `skill/SKILL.md`: Agentがそのツールを実際に操作するときの手順
- `README.md`: 人間向けの概要、入口、Quick Start
- `docs/`: 設計、仕様、障害対応、履歴などの詳細資料
- `TOOLS.md`: ツール台帳。用途・Lifecycle・正本入口だけを管理

仕様変更時は、変更内容の正本だけを更新し、他文書は原則リンクと短い要約に留める。

## 基本構成

中核は次の3層です。

```text
AgentTools Control Center   人間向け監視・操作UI
          ↓
AgentTools MCP Gateway      Task / DevSpace / Policy / Adapter / 診断
          ↓
各共有ツール・外部Runtime   Discord / Unity / Blender / Local AI / XR / Git 等
```

ChatGPTは通常オーケストレータとして動作し、必要に応じてDevSpace subagentへ閉じた作業を委譲します。ユーザー向け進捗の正本はGatewayの`type=work` Taskです。

## Workspace

DevSpaceのアクセス可能ルートや製品Projectの場所は利用者ごとのlocal設定で指定します。AgentTools本体は特定ドライブや特定Projectの配置を前提にしません。

`agent`、`node_modules`、`dist`、`logs`、`state`などの生成・外部領域は自作ツール台帳から除外します。公開版とローカル設定の境界は[docs/public-distribution.md](docs/public-distribution.md)を参照してください。

## Shared Skills

共有Skillのソースは各ツールの`skill\SKILL.md`です。AgentToolsリポジトリで共有`git-helper`を使ってcommitすると、そのcommitに含まれるSkillだけを`C:\Users\<user>\.agents\skills`へ自動同期します。通常のSkill更新では手動インストールは不要です。

初回セットアップ、全Skillの再同期、または自動同期失敗時だけ次を実行します。

AgentTools rootで次を実行します。

```powershell
.\install-agenttools-skills.ps1
```

単一Skillだけを同期する場合は`-OnlySkill <name>`を指定できます。グローバル`AGENTS.md`には共有Skillの発見情報だけを置き、ツール固有の操作手順は複製しません。
