# Public distribution model

AgentToolsの公開リポジトリには、他の利用者のPCでも意味を持つコード・既定値・サンプルだけを保存する。

## Path notation

追跡対象のREADME / Skillでは個人PCの絶対パスを書かず、次の文書用placeholderを使用する。

- `<AgentToolsRoot>`: cloneしたAgentTools repository root
- `<WorkspaceRoot>`: AgentToolsや製品Projectを置く利用者側workspace root
- `<UserProfile>`: 利用者home/profile
- `<StabilityMatrixRoot>`: 利用者が選んだStability Matrix root

`install-agenttools-skills.ps1` はSkillをglobal discovery directoryへ配置するとき、これらを現在のlocal値へ展開する。通常のREADMEでは利用者が自分の環境へ読み替えるための表記である。

JSON設定内の `${AGENTTOOLS_ROOT}` / `${USERPROFILE}` 等は別物で、Gatewayのconfig loaderが実行時に展開する。

## Configuration layers

1. **Portable defaults**
   - Gitで追跡する。
   - リポジトリ自身の場所は `${AGENTTOOLS_ROOT}` で表す。
   - ユーザーホームは `${USERPROFILE}` で表す。
   - 特定のUnity Project、Stability Matrix配置、DevSpace checkout、Discord channel等を前提にしない。

2. **Local overrides**
   - Runtimeが読み込むlocal overrideは `*.local.json` を使用する。`.local.yml` / `.local.yaml` は秘密・ローカル設定の誤追跡防止のためignoreするが、現在の設定loaderでは読み込まない。
   - Gitでは常にignoreする。
   - PC固有の絶対パス、利用者固有Project、ローカルRuntimeの配置をここへ置く。
   - 配布時は `*.example.json` のみを公開する。

3. **Secrets**
   - password、token、API key、cookie、private keyは設定JSONへ保存しない。
   - 環境変数または各サービスのSecret管理機能を使用する。
   - `.env`、`.connect`、runtime stateはGitでignoreする。

## Safe public defaults

次の値はセキュリティ上の既定値として公開設定に置いてよい。

- loopback host: `127.0.0.1`
- health endpoint名
- 一般的なtimeout / retry値
- Windows標準探索先
- AgentTools内部の相対パス

ポート番号は秘密ではないため既定値を公開してよいが、利用者が上書き可能であること。

## Project-specific features

VRAS、開発日記、特定GitHub Pages、特定Discord serverなど、ひとつの利用者・製品専用の機能はoptional profileとして扱う。

- 汎用CoreがそのProjectの存在を前提にしない。
- 未設定時は無効または明確な設定不足エラーにする。
- 個人の絶対パスやURLは`*.local.json`へ置く。
- 公開リポジトリにはgeneric exampleだけを置く。

## Public repository strategy

既存のPrivate開発repoには過去コミット由来のローカルパス等が残り得るため、そのrepo自体をPublicへ切り替えない。

初回公開時はPrivate開発repoのcleanな最新コミットから `Export-AgentToolsPublic.ps1` でtracked treeだけを空ディレクトリへ書き出し、新しいPublic repositoryの初期ソースとする。このexportはGit履歴、`*.local.*`、`.env`、state、temp、ignored runtime dataをコピーしない。

2回目以降は、公開Git checkoutをcleanな状態にしたうえで `-UpdateGitRepository` を指定し、同じ公開Git作業ツリーを直接更新する。更新モードは `.git` を保持し、sanitized treeに存在しなくなったPublic側tracked fileを削除してから最新treeを上書きする。公開Git作業ツリーに未コミット・未追跡変更がある場合は拒否する。

```powershell
.\Export-AgentToolsPublic.ps1 `
  -Destination <PublicRepositoryCheckout> `
  -UpdateGitRepository
```

通常更新のために `public-preview-YYYYMMDD-NNNN` のような一時ディレクトリを作る必要はない。差分確認は更新後のPublic repositoryで `git status` / `git diff` を使う。

Private repo内で維持したい製品固有サンプルや再配布対象外素材は `.agenttools-publicignore` にrepository-relative pathまたは末尾`/`のdirectory prefixとして登録する。`public-release-audit.js`とexport scriptは同じmanifestを使用する。

これによりPrivate側の開発履歴をrewriteせず、配布用historyを独立して管理できる。

## Release gate

公開前には最低限、以下を確認する。ライセンス境界は[licensing.md](licensing.md)を参照する。

- repository rootに配布条件を示す`LICENSE`または`LICENSE.md`がある。
- tracked fileに`*.local.*`、`.env`、`.connect`、state、DB、private keyが含まれていない。
- user homeや開発ドライブの絶対パスがruntime codeへ直書きされていない。
- Secret形式の文字列がtracked fileとGit履歴に存在しない。
- fresh cloneで個人設定なしでもCoreのhealth/checkが安全に失敗または動作する。
- optional profileを設定すると既存のローカル環境が従来どおり動作する。
