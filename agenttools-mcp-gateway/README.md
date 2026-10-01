# AgentTools MCP Gateway

`<AgentToolsRoot>` の共有Runtimeを統合管理するローカルGatewayです。

担当範囲は、DevSpace lifecycle、ユーザーTask Store、安全Policy、Watchdog、共有Adapter、診断・監査です。人間向け通常操作はAgentTools Control Centerを入口にします。

## Architecture

```text
ChatGPT / DevSpace / Control Center
               ↓
      AgentTools MCP Gateway
       ├─ Work Task Store
       ├─ Safety / confirmation policy
       ├─ DevSpace manager / watchdog
       ├─ Local adapters
       └─ diagnostics / audits
               ↓
Unity / Blender / Local AI / Discord / Git / XR / Video
```

ユーザー向け作業状態の正本は`state/tasks.json`の`type=work` Taskです。Unity / Blender / Local AI / 動画render等のprocess実行記録は内部Jobであり、ユーザーTaskとは分離します。`activity.*`と`state/activity/`は互換・内部delivery用途に限定します。

作業オーケストレーションの設計は[`docs/agent-work-orchestration.md`](docs/agent-work-orchestration.md)、AgentがTaskを操作する具体的手順は`skill/SKILL.md`を正本とします。

## Quick Start

Gateway自身:

```text
node src/cli.js status
node src/cli.js doctor
```

DevSpace:

```text
node src/cli.js devspace status
node src/cli.js devspace doctor
```

ユーザーTask:

```text
node src/cli.js task list --work true --mode active
node src/cli.js task list --work true --mode recent --limit 20
```

各コマンドの実行手順やconfirmTokenの扱いは、対応SkillまたはCLI helpを参照してください。READMEへ長い操作例を複製しません。

## Safety model

実行許可の正本は`config/safety.json`の`actionPolicy`です。legacy global booleanは互換フィールドとして`false`を維持し、実行許可には使用しません。`actionPolicy`が欠落・無効な場合はfail-closedします。

現在の実行可能カテゴリ:

| Category | Allowlist |
|---|---|
| write | `git.commit` |
| external | `discord.post`, `git.push` |
| destructive | なし |
| long-running | `task.run` |

`discord.post`、`git.commit`、`git.push`、`task.run`は、現在のユーザー依頼をtrusted callerが確認した`userExplicitlyRequested=true`と、同じpayloadへ結び付いた`confirmToken`の両方が必要です。

`task.run`はさらに登録済みAdapterへ限定されます。現行allowlistはBlender、BlenderMCP、Local AI start/generate、Unity、Remotion、HyperFramesです。networkを必要とするtask adapterは現在許可していません。

任意process実行、任意command、filesystem delete、無許可の外部送信、任意network task等は引き続き拒否します。

Watchdogの固定内部復旧処理はMCP mutation policyとは別系統です。任意コマンド実行、再install、update、config rewriteは行いません。

## Major subsystems

### Work Task

- `type=work`がユーザー依頼の正本
- Control Centerは表示・操作UI
- terminal Taskから定型Discord完了通知を生成
- `activity.*`は旧クライアント互換のみ
- 詳細: [`docs/agent-work-orchestration.md`](docs/agent-work-orchestration.md)

### DevSpace manager

- health / status / diagnose / recovery
- 手動Start / Stop / Restart / Status / Doctorの実装正本は`scripts/devspace-manual-control.js`
- Control Centerと`<WorkspaceRoot>`直下の互換BATはこの実装を利用
- force killへ自動fallbackしない
- 詳細: [`docs/devspace-recovery.md`](docs/devspace-recovery.md)

### DevSpace Watchdog

- MCP接続から独立してhealthを観測
- 固定された内部復旧経路のみ使用
- 常駐処理変更時は[`docs/background-performance-policy.md`](docs/background-performance-policy.md)に従う

### Unity Worktree Validation

- Unity Worktree Validatorは特定製品固有ではなく、local設定で指定したUnity ProjectをDevSpace管理Worktreeで安全に検証する共通基盤
- ローカル依存を管理cacheへsnapshotし、Worktreeへ一時Junction接続してUnityを起動し、終了時にJunctionと所有Unity processをcleanup
- `unity-worktree-session.js` は対話的Editor検証の標準経路、`unity-worktree-session-cleanup.js` はguardian異常終了時のruntime安全装置
- 設定は`config/unity-worktree-validator.json`、詳細は[`docs/unity-worktree-validation.md`](docs/unity-worktree-validation.md)

### Local adapters

Filesystem、Git、Unity、Blender、Local AI、動画render等の共有AdapterをGateway policy配下で提供します。ツール固有の操作方法は各共有Skillを正本とします。

## Validation

Gateway変更後の総合確認は原則:

```text
npm run check
```

常駐・短周期処理を変更した場合は加えて:

```text
npm run audit:background-performance
```

影響範囲に応じて関連testを追加で実行します。本番DevSpaceを意図的にhang/killする試験は通常行わず、異常系はfake testを優先します。

## Documentation

詳細資料の入口は[`docs/README.md`](docs/README.md)です。

READMEは概要と入口だけを保持します。仕様・設計・障害記録・操作手順をここへ再集約しないでください。
