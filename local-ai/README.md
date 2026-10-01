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

画像入力を受け取るregistered workflowは、manifestの`inputFiles`でファイルbindingを宣言できます。入力画像は`local-ai/input/`配下だけを許可し、生成時にComfyUIの`input/AgentTools/`へ一時コピーして、終了後に削除します。省略可能な参照画像は`omitWhenMissing`で不要なLoadImageノードとAutogrow入力を落とせます。

Qwen-Image-2.1高速版の登録ID:

```text
qwen-image-turbo-ja
qwen-image-turbo-ja-edit
```

Editでは主画像を`local-ai/input/`へ置き、`paramsJson`で`inputImage`を指定します。`referenceImage2` / `referenceImage3`も同じ方法で追加できます。

```text
node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js localAi generate --workflow qwen-image-turbo-ja-edit --prompt "服を白いジャケットに変えて" --paramsJson '{"inputImage":"source.png"}'
```

LTX-2.3 Distilled GGUF高速動画版の登録ID:

```text
ltx-2-3-distilled-ja
ltx-2-3-distilled-ja-i2v
```

RTX 3080 10GB向けの既定値は640x384、97 frames、24fps、CFG 1.0、Distilled 8-step sigma scheduleです。T2Vはテキストだけ、I2Vは`local-ai/input/`配下の1枚を`inputImage`で渡します。ChatGPTから日本語で依頼する場合は、生成意図を保ったLTX向けプロンプトへ整形してから`prompt`へ渡せます。

```text
node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js localAi generate --workflow ltx-2-3-distilled-ja --prompt "A woman walks through a neon-lit rainy street, cinematic camera tracking, natural motion"

node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js localAi generate --workflow ltx-2-3-distilled-ja-i2v --prompt "Animate the subject with a gentle turn and natural hair movement" --paramsJson '{"inputImage":"source.png"}'
```

Wan2.2 TI2V 5B Turbo GGUF高速動画版の登録ID:

```text
wan2-2-ti2v-5b-turbo-ja
wan2-2-ti2v-5b-turbo-ja-i2v
```

モデル本体は `hum-ma/Wan2.2-TI2V-5B-Turbo-GGUF` の `Wan2_2-TI2V-5B-Turbo-Q5_K_M.gguf` を使用します。RTX 3080 10GB向けの高速既定値は832x480、81 frames、24fps、4 steps、CFG 1.0、Euler + simple、SD3 shift 8、latent multiplier 0.8です。モデル本来の推奨解像度1280x704より軽くし、VRAM offloadと生成時間を抑える構成です。

T2Vはテキストだけ、I2Vは `local-ai/input/` 配下の1枚を `inputImage` で渡します。I2Vの入力画像はComfyUI標準 `Wan22ImageToVideoLatent` の処理により、指定された `width` / `height` へbilinear + center cropで合わせます。入力画像は既存runnerが `ComfyUI/input/AgentTools/...` へ一時stagingし、終了後にcleanupします。

日本語で依頼された場合は、そのまま直訳だけを渡すのではなく、意図を保った簡潔な英語Wan向け動画Promptへ整形する運用を正本とします。特に `subject`、`action`、`camera motion`、`scene`、`lighting`、`chronological motion` の順序が分かるようにまとめます。

`length`、`fps`、Turbo固有の `shift`、`latentMultiplier` などは `paramsJson` から上書きできます。

```text
node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js localAi generate --workflow wan2-2-ti2v-5b-turbo-ja --prompt "A woman walks through a neon-lit rainy street; the camera tracks beside her; reflections move naturally across the wet pavement."

node <AgentToolsRoot>/agenttools-mcp-gateway/src/cli.js localAi generate --workflow wan2-2-ti2v-5b-turbo-ja-i2v --prompt "The subject slowly turns toward the camera; hair and clothing move naturally; the camera makes a gentle push-in." --paramsJson '{"inputImage":"source.png","length":81,"fps":24,"shift":8,"latentMultiplier":0.8}'
```

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
