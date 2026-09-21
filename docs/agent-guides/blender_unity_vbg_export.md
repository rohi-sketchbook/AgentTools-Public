# Blender → Unity / VR Avatar Studio / VBG / FBX Rules

Blender成果物をUnity、VR Avatar Studio、VBG、FBXへ持ち込む場合の変換契約。

## Coordinate / scale

- Blender sceneは原則 `meters / Z-up` として扱う。
- Unityは `meters / Y-up`。FBX export時のaxis変換設定を `validation_report.md` に記録する。
- object scale、scene unit、boundsを確認し、現実的な寸法になっているかorthographic viewで確認する。
- 既存sceneのtransformを一律Applyしない。ユーザー調整、親子関係、animation、modifierへ影響する場合はexport用copyで処理する。
- 原点から極端に離れたobject、異常に大きいbounds、不要helperのexport混入を確認する。

## Scene organization

可能ならCollectionまたは命名で次を分離する。

- Render geometry
- Collision geometry
- Lights / Emission helpers
- Review cameras
- Blender-only helpers
- Export targets

Review camera、guide、measurement helper、diagnostic mesh等はexport対象へ混ぜない。

## Collision

販売用・VBG用の静的背景では、Render meshとCollision meshを分けることを推奨する。

- Render: 見た目重視、高品質。
- Collision: 軽量、単純、歩行面と壁面重視。

命名規則はProject指定を優先する。指定がなければ `_COL` 等の明確なsuffixを使用してよい。

確認すること:

- 床・階段・通路をcollisionが適切に覆う。
- 小物や装飾へ過剰なcollisionを付けない。
- 見た目meshの複雑さをそのままMeshColliderへ持ち込まない。
- collider候補を `scene_sidecar.json` へ記録する。

## Materials

UnityでBlenderの見た目が完全再現されるとは仮定しない。

特に注意するもの:

- Blender procedural shader
- Cycles専用node
- 複雑なglass / refraction
- volumetric
- shader-driven displacement
- procedural noise
- transmission / anisotropy等の高度表現

`validation_report.md` ではmaterialごとに必要に応じて次を記録する。

- category: stone / paint / cloth / metal / glass / wood等
- Unity shader hint: 例 `URP/Lit`
- BaseColor / Normal / Metallic / Roughness相当textureの有無
- Emissionの有無
- Alpha / transparency mode
- 両面描画が必要か
- Unity側でbake / texture化が必要なprocedural表現

法線異常をTwo Sidedで隠さない。

## Lighting

Blender上のArea LightやCycles/Eeveeの結果をそのままUnityへ移せるとは考えない。

reportへ記録する候補:

- Blender light type
- UnityでのLight変換候補
- emissive materialで表現する箇所
- baked / mixed / realtimeの想定
- Reflection Probeが必要な場所
- Light Probeが必要な場所
- Lightmap UVが必要なmesh
- glass / crystal / emissionがbakeへ与える注意

VBG用途では、背景側に固定可能な光はbaked候補、時間変化や演出依存はrealtime候補として区別する。

## FBX / GLB export

export前に最低限確認する。

- 必要objectだけがexport対象。
- unit / scale / axis設定を記録した。
- 法線とtangentの方針が明確。
- UV layerが必要meshに存在する。
- material slotが壊れていない。
- helper / review camera / diagnostic meshが混入していない。
- animation不要の静的背景へ不要なarmature/animationを混ぜていない。

販売品質または変換リスクが高い場合は、可能ならexport後ファイルをclean sceneへ再importし、少なくとも以下を比較する。

- bounds / scale
- object countまたは主要hierarchy
- normal orientation
- material slot
- obvious missing geometry

再importを省略した場合はreportへ理由を書く。

## scene_sidecar.json

FBX等で失われる制作意図を補うため、Unity/VBG連携で有用ならsidecarを生成する。

最低限の推奨schema:

```json
{
  "sceneName": "Example Scene",
  "unit": "meters",
  "coordinateSystem": "Blender_ZUp",
  "intendedTarget": ["Unity", "VR Avatar Studio", "VBG", "FBX"],
  "objects": [
    {
      "name": "Runway_Base",
      "type": "architecture",
      "role": "walkable_floor",
      "export": true,
      "collision": true,
      "editable": true,
      "protected": false,
      "notes": "Main walkable deck"
    }
  ],
  "materials": [
    {
      "name": "White_Marble",
      "category": "stone",
      "unityShaderHint": "URP/Lit",
      "usesNormalMap": true,
      "usesEmission": false,
      "notes": "Preserve roughness variation"
    }
  ],
  "lights": [
    {
      "name": "Arch_Accent_Light",
      "type": "area_or_emission",
      "role": "architectural_accent",
      "notes": "Convert to Unity light or emissive material"
    }
  ],
  "cameras": [
    {
      "name": "Review_Front",
      "role": "beauty_review",
      "focalLength": 35
    }
  ],
  "validation": {
    "requiresBeautyRender": true,
    "requiresSolidRender": true,
    "requiresWireframe": true,
    "requiresNormalCheck": true,
    "requiresOrthographic": true
  }
}
```

Projectが独自schemaを持つ場合はそちらを優先する。

## Unity / VBG report checklist

`validation_report.md` の `Unity / VBG / FBX Notes` には、該当するものを記録する。

- Blender unitと実寸
- FBX axis設定
- scale適用の有無
- Unity shader変換注意
- emission / alpha / glass / normal map注意
- lightmap UV注意
- Reflection Probe / Light Probe候補
- collider方針
- render/collision分離方針
- LOD / polycount / texture解像度方針
- Unity側で追加作業が必要なもの

## External assets / license

外部assetを使用したら次を記録する。

- asset名
- 入手元
- license
- 商用利用可否
- 再配布 / 組み込み販売可否
- attribution要否

licenseや再配布条件が確認できないassetは、販売用成果物へ含めない。検証sceneだけに使う場合もreportへその状態を明記する。
