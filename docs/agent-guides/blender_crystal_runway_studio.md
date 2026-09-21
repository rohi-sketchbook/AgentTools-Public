# Crystal Runway Studio Blender Rules

Crystal Runway Studio系のBlender制作・修正でのみ読むProject固有ルール。汎用ルールは `blender_agent_general.md`、検証は `blender_validation_views.md`、Unity/VBG移行は `blender_unity_vbg_export.md` を正本とする。

## Protected state

次は保護対象として扱う。

- `Runway_Light` の現在の長さ・位置・高さ。適切と判断済みなので、明確な理由なしに変更しない。
- ユーザーが手作業で移動・調整したobject / material / transform。
- 既存正本 `.blend` / `.fbx`。backup/version copyなしに破壊しない。
- ユーザーが明示した「今の位置が正しい」「戻さないで」といった局所調整。

作業開始時にsceneを確認し、保護対象を `validation_report.md` の Input Interpretation または Created / Modified Assets に記録する。

## Reference priority

参考画像がある場合、次の順で再現する。

### Priority A

- ランウェイとBARの空間構成・位置関係
- アーチの主要形状と断面
- ランウェイ / 建築発光ライン
- 白・青を基調とした上質で写実的な空間印象
- 主要導線とスケール感

### Priority B

- BAR壁の起伏
- シャンデリアの密度と輝き
- 家具シルエット
- 大理石 / 布 / 塗装 / 金属 / ガラスの質感差
- 植物と外景の自然な密度

### Priority C

- 遠景の細かな建築ディテール
- 小物の微細配置
- 画面外または通常視点から目立たない装飾

参考画像にない装飾を追加してPriority Aを崩さない。

## High-risk review areas

### BAR wall

- 凹凸が弱く、平たい板を重ねただけに見えないか。
- 起伏がGeometryとして成立しているか。
- 近接時にsurfaceが単調でないか。
- panel / light / wallのcoplanar重複がないか。

### Furniture

- クッションが丸く厚すぎないか。
- 参考画像の薄く引き締まったシルエットへ近いか。
- 脚、縁、面取り、座面厚みが近距離で成立しているか。
- 家具同士・壁・床へ不自然にめり込んでいないか。

### White materials / lighting

- 白い面が均一な白になっていないか。
- 大理石、布、塗装、金属、ガラスのRoughness / Specular / Normal差が見えるか。
- 白飛びで形状が消えていないか。
- BAR側の暗さと間接照明を潰していないか。
- 発光ラインが器具や周辺構造と整合しているか。

### Arches / chandelier

- アーチが単なる薄い板ではなく、断面・厚み・接合を持つか。
- `Arch_Light` / `Arch_1` ～ `Arch_3` の面反転を重点確認する。
- シャンデリアのクリスタル密度、長短variation、反射・輝きが十分か。
- クリスタルや支持部材が規則的すぎないか。

### Exterior / plants

- 植物の高さ、回転、葉量、配置間隔が規則的すぎないか。
- 反復感が強い場合はseeded variationを入れる。
- 外景の建物密度や明暗が均一すぎないか。
- 遠景が主役より目立たないか。

### Ceiling / light curves

- ランウェイ上の天井照明curveとBAR上部照明curveが衝突していないか。
- アーチ、天井、ランウェイ照明との干渉をTop / Side orthographicで確認する。
- 衝突回避のために `Runway_Light` の確定済みtransformを不用意に動かさない。可能なら他側のcurveまたは構造で解決する。

### Known geometry risks

重点確認:

- `Central_Empty_Shelves` の面反転
- `Arch_Light` / `Arch_1` ～ `Arch_3` の面反転
- `Runway_Deck` 周辺のZ-fighting
- `Entry_Steps` とRunway幅・接合
- Reflection Coat周辺のcoplanar面 / Z-fighting
- BAR拡張部との接合
- 天井照明 / BAR照明 / アーチ照明の交差

## Review minimum

Crystal Runway Studioの販売品質修正では最低限、次を出す。

- BAR側Beauty
- Runway側Beauty
- BARまたは主要壁のSolid
- Runway / BAR接合を含むWire
- Face Orientation / Normal diagnostic
- Top orthographic
- FrontまたはSide orthographic
- collision/bounds（Unity/VBGへ持ち込む場合）
- 主要素材close-up（質感を変更した場合）

重大修正を行った箇所は修正前後の差をreportに文章で残し、可能なら対応するreview画像名を記録する。

## Completion gate

次を満たさない状態で「販売品質」「問題なし」と断言しない。

- Priority Aの構成が参考画像と大きく乖離していない。
- BAR壁が板ポリに見えない。
- 家具シルエットが過度に厚く丸くない。
- 白系素材の差が視認できる。
- アーチ断面とシャンデリア密度が成立している。
- 植物・外景の反復感が目立たない。
- 主要面反転、Z-fighting、照明curve干渉を検証済み。
- `Runway_Light` とユーザー手動調整を保持している。
- Unity/VBG移行対象ならexport注意とcollision方針を記録している。
