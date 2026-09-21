# Licensing boundary

AgentToolsを第三者へ配布する前に、repository rootのライセンスを明示する必要があります。

## Current state

- AgentTools独自コードのroot licenseはMIT License。
- repository rootの `LICENSE` を正本とする。
- `agenttools-mcp-gateway/package.json` の `license` も `MIT` とする。
- `discord-bot/codex-discord-connector/` は上流MIT Licenseを保持する。
- `unity-official/` はUnity Agent Plugin由来の選択済みGuideで、同ディレクトリの `LICENSE.md` / `SOURCE.md` を保持する。
- npm等の依存パッケージは各パッケージ自身のライセンスに従う。root licenseで上書きしない。

## Before the first public export

1. repository rootの `LICENSE` が存在し、MIT License本文であることを確認する。
2. AgentTools独自packageの `license` fieldがroot licenseと一致していることを確認する。
3. 第三者コードの既存LICENSE/SOURCEを削除しない。
4. `Export-AgentToolsPublic.ps1` で新規Public repository用treeを生成する。

既存Private repositoryそのものをPublic化せず、sanitized exportから別repositoryを作る方針とする。
