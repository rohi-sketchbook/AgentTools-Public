# Blender Sol Supervision

GPT-5.6 Sol が ChatGPT ホスト側から Blender 制作を監督するときだけ読む。Astra の standing instruction / agent profile /通常の Blender runbook へこの内容をコピーしない。

目的は、Astra の入力トークンを増やさずに、Sol の画像理解・比較・設計・品質判定を使って Blender 制作の完成度を上げること。

## Responsibility split

### Sol

Sol は Art Director / Technical Director / Inspector を担当する。

- 参考画像と要求から、再現優先度と主要形状を整理する。
- 実作業前に、何を一致させるべきかを短く決める。
- Blender の preview render / Solid / Wire / Normal / Orthographic を実画像として確認する。
- 参考画像と render の差を `Critical / Major / Minor` で判定する。
- 次に直すべき項目を少数の具体的 ticket に圧縮する。
- 完了判定、販売品質判定、Unity/VBG移行上のリスク判定を行う。

### Astra

Astra は長時間の Blender Operator / Builder として使う。

- Astra profile は既存の短いまま維持する。
- Sol の分析全文や長い評価表を Astra に渡さない。
- 1回の handoff は「対象」「変更内容」「壊してはいけないもの」「完了条件」に絞る。
- Astra に同じ参考画像の長文再分析や、既に Sol が行った比較を重複させない。

Astra が自力で十分に進行できている場合、Sol は途中で細かく介入しない。重大差分、破綻、方向性のズレ、完了判定時だけ監督する。

## Sol production loop

1. **Reference interpretation**
   - 空間構成、silhouette、比率、negative space、主要断面、素材、照明、カメラを把握する。
   - 優先度を `Must match / Should match / Can approximate` に分ける。
2. **Build ticket**
   - Astra または Blender 操作へ渡す変更要求を最大5～8項目程度に圧縮する。
   - 一般論ではなく object / area / visual defect 単位で書く。
3. **Preview**
   - 低解像度・低sampleを優先して反復する。
4. **Visual inspection**
   - `blender_validation_views.md` の出力を Sol 自身が読む。
   - Beauty だけで完了判定しない。
5. **Diff**
   - 参考画像と現在の render を比較し、影響の大きい差だけを抽出する。
6. **Repair ticket**
   - `Critical -> Major -> Minor` の順で、次の修正 ticket を作る。
7. **Re-render**
   - 修正対象に対応する view を再確認する。
8. **Gate**
   - 主要差分と技術的破綻が解消したら export / report へ進む。

`blend を保存した`、`FBX が存在する`、`script が正常終了した`だけでは完成扱いしない。

## Reference diff rubric

Sol が参考画像と render を比較するときは、次の順に見る。

1. **Composition / camera**
   - camera height, FOV, vanishing point, framing
2. **Primary geometry**
   - 大きな輪郭、壁・床・天井、ランウェイ、BAR、アーチ等の比率
3. **Secondary geometry**
   - 断面、凹凸、棚、器具、家具厚み、trim
4. **Material separation**
   - marble / paint / cloth / resin / glass / metal が区別できるか
5. **Lighting**
   - 明暗の立体感、reflection、specular、emission、白飛び、黒潰れ
6. **Detail density**
   - 小物、植物、クリスタル等の密度と controlled irregularity
7. **Technical defects**
   - intersection, floating geometry, flipped normal, Z-fighting, coplanar face

差分レポートを Astra へ丸ごと渡さず、修正に必要な情報だけ ticket 化する。

## Repair ticket format

Astra へ渡すときは原則この程度の密度に抑える。

```text
Target: BAR wall
Problem: 参考画像より平板で、中央の膨らみと縦方向の掘り込みが弱い。
Change: 主要壁を単なる積層板ではなく連続面として再構成し、実Geometryで緩い凸面＋縦溝を作る。近距離で板の重なりに見えないよう断面を整える。
Protect: 既存BAR寸法、床接合、ユーザー手動配置済み小物。
Done when: Solid viewでも曲面と溝が明確、Beautyで陰影が出て、壁/trimの交差がない。
```

複数項目を渡す場合も、各ticketを短く保つ。

## Geometry quality direction

Sol は「primitive を置いた数」ではなく、最終silhouetteと断面品質で評価する。

近距離の主要構造で flat-card / box-stack 感が出る場合は、必要に応じて次を要求する。

- custom profile extrusion
- Curve / bevel profile
- Boolean後のclean topology
- Subdivision / support edge
- controlled bevel
- Displace / sculpt相当の連続面変形
- Geometry Nodes（繰返し構造に適する場合）

単純Primitiveの集合でも見た目と構造が十分なら作り直しを強制しない。手法ではなく結果で判定する。

## Controlled irregularity

植物、瓶、クリスタル、装飾、小物などで規則性がCG感につながる場合だけ variation を入れる。

- scale
- rotation
- spacing
- height
- roughness / tint の微差

完全randomにはせず、構図とデザイン意図を維持する。

## Cheap validation strategy

数値・構造で安価に確認できる項目は visual reasoning の前に機械検査へ寄せてよい。

- non-manifold / loose geometry
- zero-area face候補
- negative / near-zero scale
- duplicate names
- missing material / texture
- UV layer有無
- object bounds / outlier
- helper object の export 混入

ただし機械検査の成功で visual inspection を省略しない。

## State files

長期作業で再開性が必要な場合だけ、Project側に次を使う。

- `REFERENCE_ANALYSIS.md`: 参考画像の重要要素と優先度
- `LOCKED_ELEMENTS.md`: ユーザー手動変更、変更禁止、既に確定した寸法・位置
- `VISUAL_DIFF.md`: Sol が現在残っている主要差分だけを保持
- `validation_report.md`: 最終検証
- `scene_sidecar.json`: Unity/VBG等への移行情報

常に全部作る必要はない。Astraへこれらを全文投入しない。必要な行だけ作業ticketへ圧縮する。

## Token policy

Astra の token 消費を増やさないことを優先する。

- `.devspace/agents/astra.md` を Blender 用に肥大化させない。
- Sol専用runbookを Astra に読ませない。
- Sol の chain-of-work、比較表、長い critique を Astra へ転送しない。
- 同じ画像分析を Sol と Astra の両方に重複実行させない。
- Astra の途中報告は必要最小限とし、進捗の正本は Task / 成果物 / review画像を使う。
- 修正要求は一度に多すぎる項目を渡さず、主要差分をまとめて渡す。

Astra を使わず Sol 自身が BlenderMCP を操作する場合は、この文書の full loop を Sol 自身で実行する。

## Completion gate

販売品質または高品質背景では、Sol は最低限次を満たすまで完成判定しない。

- 参考画像の主要 silhouette / proportions / composition が大きく外れていない。
- Solidでも主要Geometryが成立している。
- 主要素材カテゴリがBeauty/close-upで区別できる。
- Face Orientation / normal に重大異常がない。
- 明白な intersection / floating / Z-fighting候補が残っていない。
- 修正後の再renderを確認している。
- Unity/VBG/FBX対象なら移行上の既知リスクがreportされている。

Minor差分は、品質への影響が小さく理由を説明できる場合だけ残してよい。
