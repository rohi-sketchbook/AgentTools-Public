# Blender Agent General Rules

Blenderで3D背景・小物・シーンを作成または修正するときの共通契約。目的は「ファイルを作る」ことではなく、**作る → 見る → 自己指摘する → 直す → 証拠を残す**までを完了させること。

## Goal

完了は `.blend` / FBX等を書き出した時点ではない。原則として次を満たして初めて完了とする。

- 最終Blenderファイルを保存した。
- タスクで必要なFBX / GLB / OBJ等をexportした。
- review画像を生成し、Agent自身が画像を確認した。
- 重大な形状破綻、交差、面反転、Z-fighting候補を確認・修正した。
- `validation_report.md` を残した。
- Unity / VBG / FBXが対象なら移行上の注意を記録した。
- 未解決事項を隠さず明記した。

出力名やディレクトリはProject指定を優先する。指定がなければ `output/` を使用する。既存正本を破壊しないため、必要ならversion付きファイル名を使う。

## Standard cycle

1. **Input**
   - 仕様、参考画像、既存blend/fbx、出力先、最終用途を確認する。
   - 販売品質か検証用かを判断する。
2. **Interpret**
   - 参考画像から空間構成、主役形状、視線誘導、色、光、素材、密度、スケール感を言語化する。
   - 再現優先度を A / B / C に分ける。Aは空間構成や主役形状など、最も結果へ効く要素にする。
   - 不明点は安全で可逆な仮定で進め、reportへ残す。
3. **Inspect existing scene**
   - Collection、主要object、unit、scale、camera、material、light、export対象を把握する。
   - ユーザー手動調整箇所、変更禁止箇所、既存未コミット変更を保護対象として記録する。
4. **Backup**
   - 既存正本を直接破壊しない。破壊的変更前にcopy/version保存する。
5. **Build / Modify**
   - 近距離で見える主要形状は実Geometryを優先する。
   - 板ポリ、重複面、coplanar面、negative scale、法線、交差に注意する。
6. **Review render**
   - `blender_validation_views.md` に従ってBeautyだけでなく複数パスを作る。
7. **Self review**
   - Agent自身が生成画像を読む。ローカル画像を確認できる場合は `read_image` 等で実画像を検査する。
   - 問題を列挙し、重大なものはreportへ書くだけでなく修正する。
8. **Re-render**
   - 修正した観点を再度renderして、修正が別の破綻を生んでいないことを確認する。
9. **Export**
   - 対象がUnity / VBG / FBXなら `blender_unity_vbg_export.md` に従う。
10. **Report**
   - `validation_report.md` と必要なら `scene_sidecar.json` を生成する。

## Blender Python / DevSpace execution

- Blender Pythonは可能な限りProject内の再実行可能な `.py` として残し、何を変更するscriptか分かる名前を付ける。
- scriptは対象Collection/objectを明示し、無関係なscene要素を一括削除・初期化しない。
- 既存object名だけを根拠に危険な全置換を行わず、対象範囲を確認する。
- 長い処理は、modeling / material / review setup / exportのように意味のあるphaseへ分ける。
- `blender_run_script` 等で実行する場合、期待する `.blend` / FBX / render / reportをoutputとして検証する。ただし「存在する」ことと「品質確認済み」を混同しない。
- renderは低品質previewで反復し、最終のみ必要品質へ上げる。

## Long-task observability

実質的な長時間作業では `work-task` のTaskをユーザー向け進行状況の正本として使う。少なくとも次の境界でcheckpointを残す。

- 現状把握と保護対象の確定後
- 大きなmodeling/material修正後
- review画像の自己確認後
- export/report直前または実行時間切れ前

checkpointには、最後に完了した工程、現在の `.blend` / WIP、最後に確認したreview画像、残問題、次の具体的作業を記録する。validation未完了の状態を「完成」としてTask終了しない。

## Geometry rules

### Real geometry first

近距離またはシルエットへ効く次の要素は、原則としてテクスチャだけで済ませない。

- アーチ断面、壁の凹凸、棚、ボトル、ライト器具、シャンデリア
- 家具の縁・脚・クッション厚み、手すり、階段、床段差
- 大理石パネル等の目立つ目地、バーのカウンター、主要装飾ライン

テクスチャ / normal / bumpへ寄せてよいのは、微細な粗さ、小傷、石・布・金属の微細ノイズ、遠景の細部。

### Avoid flat-card construction

販売品質では以下を満たす。

- 壁・床・天井に必要な厚みや接合構造がある。
- アーチに断面形状がある。
- 家具に面取り、丸み、脚、縁、必要なら縫い目等がある。
- ライトは発光面だけでなく器具として成立している。
- 階段、床、壁、天井の接続が別角度から見ても破綻しない。

### Z-fighting and intersections

特に次を確認する。

- 床と反射面
- 階段とランウェイ
- 壁と装飾パネル
- 発光ラインと壁
- バーカウンターと棚
- 拡張モデル同士の接合部
- 天井照明とアーチ / ランウェイ / BAR照明

単純に0.001だけ浮かせる対応を常用しない。可能なら不要面削除、厚み付け、Boolean/merge、構造整理で解決する。

### Normals

裏面描画で誤魔化さない。Arch、Shelf、Wall、Ceiling、Floor、Glass、Curtain、Thin Panel、Imported FBXはface orientation / normal diagnosticで確認する。Unityの光漏れ、Lightmap異常、片面消失につながるため、意図的な両面材質を除き法線を正す。

## Material and lighting rules

- 白大理石、白塗装、布、樹脂、ガラス、金属を単なる同じ白色にしない。
- Base Color、Roughness、Metallic、Normal/Bump、微細variation、Specular/Reflection、Emission、Alphaを素材カテゴリに応じて調整する。
- 重要素材は必要に応じてclose-up reviewを作る。
- Blenderだけで成立する見た目にしない。Unity移行対象ではprocedural shader、複雑なglass、volumetric、Cycles専用node、shader displacement等をreportへ明記する。

## Default outputs

```text
output/
  final.blend
  export.fbx                 # 必要な場合
  scene_sidecar.json         # Unity/VBG/semantic情報が有用な場合
  validation_report.md
  review/
    beauty_main.png
    beauty_front.png
    beauty_back.png
    solid_front.png
    solid_back.png
    wire_main.png
    wire_top.png
    normal_check.png
    orthographic_front.png
    orthographic_side.png
    orthographic_top.png
    collision_check.png
```

タスク上不要な成果物は省略してよい。**省略した理由を `validation_report.md` に書く。**

## Validation report contract

`validation_report.md` には最低限、次の見出しと実内容を含める。

```text
# Validation Report
## Summary
## Input Interpretation
## Created / Modified Assets
## Self Review
## Fixed Issues
## Remaining Issues
## Unity / VBG / FBX Notes
## License / External Assets
```

各節では次を明示する。

- Summary: 作業概要、最終出力物、完了判定。
- Input Interpretation: 重要要素、再現優先度、仮定。
- Created / Modified Assets: 主要object、material、light、camera、外部asset。
- Self Review: Beauty / Solid / Wire / Normal / Orthographic / Collisionで何を確認したか。
- Fixed Issues: Agentが自己検出して直した問題。
- Remaining Issues: 残問題、軽微と判断した理由、人間確認が必要な箇所。
- Unity / VBG / FBX Notes: scale/axis/material/emission/alpha/normal/lightmap/probe/collider注意。
- License / External Assets: 出典、license、販売可否、attribution要否。不明なら「不明」と書き、販売用成果物へ混ぜない。

## Prohibited

- backupなしで既存正本を上書きする。
- ユーザー手動調整を無断で戻す。
- Beauty renderだけで完了扱いする。
- 面反転・Z-fighting・交差の確認を省略する。
- 近距離の主要ディテールをテクスチャだけで誤魔化す。
- license不明assetを販売用成果物へ混ぜる。
- Unityで再現困難な表現を注意書きなしで使う。
- 未確認なのに「問題なし」と断言する。
- 参考画像にない要素を過剰追加し、本質を崩す。
- 出力場所や残問題を曖昧にする。

## Sales-quality gate

BOOTH等で単体販売可能な品質を目指す場合は追加で確認する。

- 近距離で見る主要要素が実Geometryとして成立している。
- 素材カテゴリの差がclose-upでも分かる。
- 参考画像との差分と、残した差分の理由を説明できる。
- 外部asset licenseと販売可否を確認済み。
- collision / LOD / polycount / texture解像度の方針を記録済み。
- 少なくとも主要導線・カメラ近傍で明確な交差、法線異常、Z-fightingがない。
