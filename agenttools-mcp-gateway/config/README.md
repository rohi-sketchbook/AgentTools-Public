# Gateway configuration

`*.json` は公開可能なportable defaultsです。同名の `*.local.json` が存在する場合、Gatewayはlocal側を再帰マージしてから利用します。配列はlocal側で置換されます。

利用できる展開変数:

- `${AGENTTOOLS_ROOT}`: AgentTools repository root
- `${AGENTTOOLS_GATEWAY_ROOT}`: `agenttools-mcp-gateway`
- `${USERPROFILE}` / `${HOME}`: current user home
- その他の環境変数

PC固有の絶対パス、製品Project、DevSpace checkout等は `*.local.json` にのみ記述してください。local設定はGit ignore対象です。Secretはlocal JSONにも保存せず環境変数を使用してください。

CIやfresh-clone検証では `AGENTTOOLS_DISABLE_LOCAL_CONFIG=1` を設定すると、存在するlocal overrideを無視してportable defaultsだけを読み込めます。
