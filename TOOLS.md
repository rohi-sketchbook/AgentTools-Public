# AgentTools Tool Registry

`<AgentToolsRoot>` 配下の共有ツールについて、用途・Lifecycle・正本入口を管理する台帳です。

詳細な操作手順は各`SKILL.md`、人間向け説明は各README、設計仕様は各`docs/`を参照します。このファイルへ手順を複製しません。

## Lifecycle

- **CORE**: AgentTools運用の中核
- **ACTIVE**: 現役の用途別ツール
- **SECONDARY**: 現役だが第一選択ではない
- **COMPAT**: 互換入口。新規処理では正本入口を優先
- **FALLBACK**: 通常経路が使えない場合の代替
- **REFERENCE**: rollback・比較・検証用。通常運用の正本ではない
- **UPSTREAM**: 外部checkout/vendor領域

## Tool registry

| Tool | Lifecycle | Purpose | Canonical entry / source |
|---|---|---|---|
| `agenttools-control-center` | CORE | AgentTools関連サービスとユーザーTaskのGUI監視・操作 | `Start-ControlCenter.bat` |
| `agenttools-mcp-gateway` | CORE | DevSpace lifecycle、Task Store、安全Policy、Watchdog、自動開発、診断・監査 | `src/cli.js`, `Start-AgentToolsGateway.bat` |
| `discord-bot` | CORE | Discord Remote Control / ChatGPT Bridge | `discord-codex-bridge/run-localized-bot-supervisor.ps1` |
| `image-bridge` | CORE | 画面キャプチャとChatGPT↔ローカル画像転送 | DevSpace native `read_image` / `download_artifact` |
| `blender-mcp` | CORE | BlenderMCP lifecycleとテクスチャ取込 | `Start-BlenderMCP.bat` |
| `windows-ui` | CORE | Windows UI Automationによる安全なUI操作 | `WindowsUi.bat` |
| `git-helper` | CORE | guarded commit / explicit push | `Git-CommitPush.bat`, `skill/SKILL.md` |
| `common` | CORE | 共通安全処理 | `PathSafety.ps1` |
| `local-ai` | ACTIVE | Stability Matrix / ComfyUIのローカル画像・動画生成基盤 | Gateway `localAi ...`, `skill/SKILL.md` |
| `xr-automation` | ACTIVE | Meta Quest / OpenXR自動QA | `XRAutomation.bat`, `MetaVR.bat` |
| `codex-mode` | ACTIVE | Codex AppのChatGPT / LM Studio切替 | `Switch-To-ChatGPT.bat`, `Switch-To-LMStudio.bat` |
| `img2blender` | ACTIVE | 参照画像からBlenderシーンを再構成 | `tools/img2blender/pipeline.py` |
| `devlog-codex-runner` | ACTIVE | 開発日記生成・検証・公開パイプライン | `start-devlog-pipeline.mjs` |
| `devlog-image-guard` | ACTIVE | 開発日記画像の保存先固定・重複転送防止 | `Devlog-ImageTransferGuard.bat` |
| `hyperframes` | ACTIVE | 新規プログラマティック動画制作の第一選択 | `hf-local.cmd`, `skill/SKILL.md` |
| `remotion` | SECONDARY | 既存Remotion資産・明示指定案件 | `skill/SKILL.md` |

## Shared root utilities

| File | Lifecycle | Purpose |
|---|---|---|
| `install-agenttools-skills.ps1` | CORE | 共有SkillをグローバルSkill領域へ登録・更新 |
| `remove-nul-files.ps1` | ACTIVE | Windows予約名`NUL`ファイルの検出・除去 |
| `Remove-Nul-Files-DELETE.bat` | ACTIVE | `remove-nul-files.ps1 -Delete`の対話入口 |

## Canonical boundaries

- ユーザー向け作業状態はGatewayの`type=work` Taskが正本。Control Centerは表示・操作UIでありTask Storeの正本ではない。
- Unity / Blender / Local AI / 動画render等の実行記録は内部Jobで、ユーザー向けTaskと混同しない。
- `activity.*`と`state/activity/`は互換・内部delivery用途に限定し、新規ユーザー作業の正本にはしない。
- DevSpaceの人間向け通常操作はControl Center、実装正本はGateway。`<WorkspaceRoot>`直下のDevSpace BATはCOMPAT入口。
- 新規動画は原則HyperFrames。Remotionは既存資産または明示指定時に利用する。
- Local AIはStability Matrixを環境管理、ComfyUIを推論Runtimeとして扱う。Modelsをgeneric filesystem allowed rootへ公開しない。
- Image BridgeはDevSpace native転送を第一選択とし、Base64/BAT経路はFALLBACK。
- Git push、Discord任意投稿、外部公開等は各SkillとGateway Policyの明示許可ルールに従う。

## Non-canonical / external areas

- `devspace-pr103`: **REFERENCE**。通常稼働DevSpaceの正本ではない。
- `img2blender/tools/img2threejs`: **UPSTREAM**。ローカル固有実装と混同しない。
- `agent`: GENERATED / external Skill copy。
- `node_modules`, `bin`, `obj`, `dist`, `logs`, `state`, `inbox`, `outbox`, `processed`, `attachments`, `out`, `output`, `renders`, `snapshots`: runtime/generated領域。

## Registry maintenance rule

ツールを追加・廃止・正本変更する場合は、ここでは**台帳情報だけ**を更新する。

1. 再利用する実装は個別製品ではなくAgentToolsへ置く。
2. 人間/Agentが直接使う正本入口を1つ決める。
3. 互換入口はCOMPAT、代替経路はFALLBACK、外部checkoutはUPSTREAMと明示する。
4. 操作手順は`SKILL.md`、人間向け説明はREADME、設計詳細はdocsへ置く。
5. 常駐・timer・watchdog変更は`agenttools-mcp-gateway/docs/background-performance-policy.md`に従う。
