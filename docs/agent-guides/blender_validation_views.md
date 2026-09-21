# Blender Validation Views

Blenderシーンの自己検証用render契約。Beauty renderだけでは完了判定しない。

## Required review loop

1. 低解像度・低sampleのpreviewを生成する。
2. Agent自身が生成画像を実際に確認する。
3. 問題を `Critical / Major / Minor` に分ける。
4. Critical / Majorは可能な限りその場で修正する。
5. 修正した観点を再renderして確認する。
6. 残ったMinorと未確認事項を `validation_report.md` に残す。
7. 最終提出時だけ必要な品質へsample / resolutionを上げる。

画像を読めるDevSpace環境では、render後に `read_image` 等で確認する。ファイル生成だけで自己レビュー済みと見なさない。

## Review set

### Beauty

目的: 参考画像との雰囲気、照明、質感、構図、空間密度を見る。

推奨:

- `beauty_main.png`
- `beauty_front.png`
- `beauty_back.png`
- 必要なら主要close-up

見る点:

- 参考画像の主役形状と空間構成が維持されているか。
- 視線誘導と画角が不自然でないか。
- 白飛び、黒潰れ、過度な均一照明がないか。
- 壁、床、家具、装飾が平板に見えないか。
- 素材差が読み取れるか。
- 家具、植物、小物、ライトのスケールが自然か。

### Solid

目的: materialやlightingに騙されず、純粋な形状品質を見る。

推奨:

- `solid_front.png`
- `solid_back.png`
- 必要なら `solid_main.png`

見る点:

- 壁やアーチの厚み、凹凸、断面。
- 家具のシルエット、面取り、脚、クッション厚み。
- 階段、床、天井、壁の接合。
- テクスチャ依存でGeometry不足になっていないか。
- 不自然な箱形、板ポリ、過度な丸みがないか。

### Wireframe overlay

目的: topology、重複、coplanar、過密mesh、Z-fighting候補を見る。

推奨:

- `wire_main.png`
- `wire_top.png`

見る点:

- 同一位置の重複面やほぼ同一平面。
- 発光ライン、反射面、装飾板が母材と競合していないか。
- 不要に細分化されたmeshがないか。
- 極端に細長いpolygonや乱れたtriangulationが目立たないか。
- 接合部に隙間またはめり込みがないか。

### Normal / Face Orientation

目的: 面反転、法線破綻、意図しない片面meshを検出する。

推奨:

- `normal_check.png`

BlenderのFace Orientation相当のfalse-color表示、またはcustom normal diagnostic materialを使ってよい。重要なのは、法線方向を画像として判断できること。

重点対象:

- Arch / Shelf / Wall / Ceiling / Floor
- Glass / Curtain / Thin Panel
- Imported FBX
- Booleanやmirror後のmesh

意図的な両面表現を除き、裏面描画で問題を隠さない。

### Orthographic

目的: 寸法、配置、左右対称、奥行き、干渉をperspectiveの錯覚なしで見る。

推奨:

- `orthographic_front.png`
- `orthographic_side.png`
- `orthographic_top.png`
- 必要ならBack / Left / Right

見る点:

- 実寸とスケール感。
- 通路幅、階段幅、床高さ。
- 壁・天井・家具・照明の干渉。
- 左右対称の崩れ。
- 接合部の段差や隙間。
- 参考三面図がある場合の輪郭差。

### Collision / Bounds

目的: Unity / VBGで歩行・当たり判定・配置が成立するかを見る。

推奨:

- `collision_check.png`

Render meshとcollision meshを色や表示モードで区別して確認する。

見る点:

- 歩行床を十分に覆っているか。
- 階段、床、壁のcolliderが穴や過剰な段差を作らないか。
- 装飾や小物まで高密度collisionになっていないか。
- Scene boundsが異常に大きくないか。
- 原点から遠すぎるobjectや飛び地がないか。

## Close-up review

重要素材または販売品質では、必要に応じて接写を追加する。

候補:

- 白大理石
- ガラス / クリスタル
- 金属
- 布 / レザー
- 木材
- BAR壁
- 床反射
- 発光ライン
- アーチ断面
- 家具の縁やクッション

接写では、単に綺麗かではなく「素材カテゴリが互いに区別できるか」「Geometryが近距離で耐えるか」を見る。

## Cheap programmatic checks

画像確認に加えて、Blender Pythonで安価に確認できる項目は自動化してよい。

- unit scale / scene unit
- object dimensions / bounds
- negative or near-zero scale
- duplicate object names
- loose geometry / zero-area face候補
- non-manifold候補
- material slot異常
- UV layer有無
- collision candidateのpolycount
- export対象外のhelper object混入

数値検査だけでvisual reviewを置き換えない。

## Severity

### Critical

- 面反転でUnity上消失する可能性が高い。
- 明白なZ-fightingや重複面。
- 大きな交差・穴・浮遊object。
- 参考画像の主要構造が異なる。
- Scene scale / axis / boundsが破綻。

原則として提出前に修正する。

### Major

- 板ポリ感、厚み不足、家具シルエット不一致。
- 主要素材が均一で質感差がない。
- 主要照明の交差や不自然な白飛び。
- 主要導線のcollision問題。

販売品質では原則として修正する。

### Minor

- 遠景小物の密度差。
- 接写しない箇所の軽微な粗さ。
- 参考画像との差が小さく、全体品質へ影響しないもの。

残す場合は理由をreportへ記録する。

## Omission rule

タスクによって不要なviewは省略できる。ただし `validation_report.md` へ次を記載する。

- 省略したview
- 省略理由
- 代替確認方法

「時間短縮のため」だけを理由に、面反転・Z-fighting・主要構造の検証を省略しない。
