# Local AI Agent Tool

Stability Matrixを環境・Package管理層、ComfyUIを推論API層として扱うAgentTools共通Local AI基盤です。

Canonical root: `<AgentToolsRoot>\local-ai`

External runtime: `<StabilityMatrixRoot>`

ComfyUI endpoint: `http://127.0.0.1:8188`

## 設計方針

- Stability Matrix本体、Packages、ModelsはAgentTools配下へ移動しません。
- `<StabilityMatrixRoot>`をGatewayの一般`fs.*` allowed rootへ追加しません。
- Stability Matrix側の情報は専用Adapterが必要な範囲だけ読み取ります。
- 生成はStability Matrix GUI AutomationではなくComfyUI Server APIを使用します。
- 常駐polling daemonは追加しません。状態確認はオンデマンド、生成中のpollingはforeground task内だけです。
- ComfyUIが停止していても、Stability MatrixとComfyUI packageが導入済みなら「待機可能」な正常状態です。
- AgentToolsが開始した生成だけを所有ジョブとして記録し、`interrupt`は現在実行中ジョブがAgentTools所有の場合だけ許可します。

## Gateway commands

```text
node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js localAi status
node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js localAi workflows
node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js localAi models --folder checkpoints
node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js localAi start
node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js localAi generate --workflow <id> --prompt "..."
node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js localAi interrupt
node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js localAi free
```

`start`と`generate`は既存AgentTools Taskとして計画されます。実行は`task.run`のconfirmationとGateway safety policyに従います。

## Stability Matrix Adapter

`adapters/stability-matrix.js`は次だけを扱います。

- `StabilityMatrix.exe`の存在
- `Data/settings.json`のInstalledPackages
- ComfyUI packageの導入状態、commit、launch設定

モデルフォルダの再帰走査は行いません。

## ComfyUI Adapter

`adapters/comfyui.js`はローカルServer APIを使用します。

- `/system_stats`
- `/queue`
- `/models/{folder}`
- `/prompt`
- `/history/{prompt_id}`
- `/view`
- `/interrupt`
- `/free`

`/object_info`全件取得は通常経路では使用しません。

## Workflows

AgentToolsから実行するworkflowは`workflows/<id>/`へ登録します。

```text
workflows/
  image-basic/
    manifest.json
    workflow-api.json
```

`workflow-api.json`はComfyUIのAPI format（node idをkeyにし、各nodeが`class_type`と`inputs`を持つ形式）である必要があります。

`manifest.json`例:

```json
{
  "name": "Z Image basic",
  "type": "image",
  "workflowFile": "workflow-api.json",
  "bindings": {
    "prompt": { "node": "6", "input": "text" },
    "seed": { "node": "3", "input": "seed" },
    "steps": { "node": "3", "input": "steps" },
    "width": { "node": "5", "input": "width" },
    "height": { "node": "5", "input": "height" }
  }
}
```

ComfyUI GUIが通常保存する`nodes`/`links`形式はUI formatとして検出・一覧化しますが、そのまま`/prompt`へは送信しません。API formatを登録してから実行します。

現在の実機ではComfyUI user workflowsを次から専用Adapterで検出します。

```text
<StabilityMatrixRoot>\Data\Packages\ComfyUI\user\default\workflows
```

## Output / State

生成物:

```text
local-ai\output\<workflow>-<timestamp>\
```

所有ジョブ情報:

```text
local-ai\state\jobs\<promptId>.json
```

これらはGit管理しません。

## Control Center

AgentTools Control Centerは`localAi status`を読み、`Local AI`カードとして表示します。

- 待機: Stability Matrix + ComfyUI package導入済み、ComfyUI APIはoffline
- 利用可能: ComfyUI API online
- 生成中: queue running/pendingあり
- 警告: runtime/APIの一部が縮退
- 未構成: Stability MatrixまたはComfyUI package未検出

Control Centerからの起動・停止ボタンは初期実装では提供しません。状態表示と実操作の責務を分離し、生成・起動はGatewayの確認付きTool経由に限定します。
