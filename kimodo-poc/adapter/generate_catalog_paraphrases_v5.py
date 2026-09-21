from __future__ import annotations

import argparse
import json
import sys
from hashlib import sha256
from pathlib import Path


def load_jsonl(path: Path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def pick(options, base_id: str, slot: str, variant: int):
    digest = sha256(f"{base_id}|{slot}|{variant}".encode("utf-8")).digest()
    return options[int.from_bytes(digest[:4], "big") % len(options)]


def find_component(canonical: str, candidates):
    matches = [(ja, en) for ja, en, *rest in candidates if en in canonical]
    if len(matches) != 1:
        raise ValueError(f"Expected exactly one component match, got {len(matches)} for: {canonical}")
    return matches[0][1]


def find_component_triplet(canonical: str, candidates):
    matches = [item for item in candidates if item[1] in canonical]
    if len(matches) != 1:
        raise ValueError(f"Expected exactly one component match, got {len(matches)} for: {canonical}")
    return matches[0][1]


def normalize(text: str) -> str:
    text = text.replace("。。", "。").replace("、、", "、")
    text = text.replace("。 。", "。").replace("、。", "。")
    return text.strip()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--catalog-dir", type=Path, default=Path("motion_prompt_db/prompt_collections_v1"))
    p.add_argument("--v4-pairs", type=Path, default=Path("adapter/data/distill_pairs_v4.jsonl"))
    p.add_argument("--output", type=Path, default=Path("adapter/data/catalog_paraphrases_v5.jsonl"))
    p.add_argument("--variants", type=int, default=6)
    args = p.parse_args()

    root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(args.catalog_dir.resolve()))
    sys.path.insert(0, str((root / "adapter").resolve()))

    import catalog
    from codex_idol_paraphrase_lexicon import IDOL_CUTE_PARAPHRASE_LEXICON
    from codex_runway_dynamic_paraphrase_lexicon import RUNWAY_FASHION_LEXICON, DYNAMIC_CUTE_DANCE_LEXICON
    from codex_glamour_bold_paraphrase_lexicon import (
        GE_STANCES_PARAPHRASES,
        GE_TORSO_PARAPHRASES,
        GE_HANDS_PARAPHRASES,
        GE_GAZE_PARAPHRASES,
        BS_LEVEL_PARAPHRASES,
        BS_BODY_PARAPHRASES,
        BS_HANDS_PARAPHRASES,
        BS_GAZE_PARAPHRASES,
    )

    v4_rows = load_jsonl(args.v4_pairs)
    split_by_catalog_id = {
        row["catalog_id"]: row["split"]
        for row in v4_rows
        if row.get("source_dataset") == "prompt_catalog_v1"
    }
    if len(split_by_catalog_id) != 1000:
        raise SystemExit(f"Expected 1000 catalog split entries, got {len(split_by_catalog_id)}")

    idol_base_keys = [
        "feet_together_toes_slightly_inward",
        "one_foot_slightly_forward",
        "weight_lightly_on_one_leg",
        "one_heel_lifted",
        "tiny_knee_bend_crouch",
    ]
    idol_gesture_keys = [
        "right_peace_sign_beside_face",
        "double_peace_signs_beside_face",
        "one_hand_finger_heart",
        "both_hands_heart_near_chest",
        "both_hands_under_cheeks",
        "both_hands_cat_paw_pose",
        "one_hand_on_cheek",
        "small_wave_toward_camera",
    ]
    idol_expression_keys = [
        "head_tilt_slightly_right",
        "head_tilt_slightly_left",
        "chin_slightly_lowered",
        "face_forward",
        "shoulders_slightly_raised",
    ]
    idol_base_map = {item[1]: key for item, key in zip(catalog.IC_BASE, idol_base_keys)}
    idol_gesture_map = {item[1]: key for item, key in zip(catalog.IC_GESTURE, idol_gesture_keys)}
    idol_expression_map = {item[1]: key for item, key in zip(catalog.IC_EXPRESSION, idol_expression_keys)}

    rows = []
    seen_ja = set()
    per_genre = {}

    for base in catalog.PROMPTS:
        canonical = base["canonical_en"]
        split = split_by_catalog_id[base["id"]]
        generated_for_base = set()

        for variant in range(args.variants):
            if base["genre"] == "glamour_editorial":
                stance = find_component(canonical, catalog.GE_STANCES)
                torso = find_component(canonical, catalog.GE_TORSO)
                hands = find_component(canonical, catalog.GE_HANDS)
                gaze = find_component(canonical, catalog.GE_GAZE)
                ja = "。".join([
                    pick(GE_STANCES_PARAPHRASES[stance], base["id"], "stance", variant),
                    pick(GE_TORSO_PARAPHRASES[torso], base["id"], "torso", variant),
                    pick(GE_HANDS_PARAPHRASES[hands], base["id"], "hands", variant),
                    pick(GE_GAZE_PARAPHRASES[gaze], base["id"], "gaze", variant),
                ]) + "。"

            elif base["genre"] == "bold_sensual":
                level = find_component(canonical, catalog.BS_LEVEL)
                body = find_component(canonical, catalog.BS_BODY)
                hands = find_component(canonical, catalog.BS_HANDS)
                gaze = find_component(canonical, catalog.BS_GAZE)
                ja = "。".join([
                    pick(BS_LEVEL_PARAPHRASES[level], base["id"], "level", variant),
                    pick(BS_BODY_PARAPHRASES[body], base["id"], "body", variant),
                    pick(BS_HANDS_PARAPHRASES[hands], base["id"], "hands", variant),
                    pick(BS_GAZE_PARAPHRASES[gaze], base["id"], "gaze", variant),
                ]) + "。"

            elif base["genre"] == "idol_cute":
                base_en = find_component(canonical, catalog.IC_BASE)
                gesture_en = find_component_triplet(canonical, catalog.IC_GESTURE)
                expr_en = find_component(canonical, catalog.IC_EXPRESSION)
                ja = "。".join([
                    pick(IDOL_CUTE_PARAPHRASE_LEXICON["base"][idol_base_map[base_en]], base["id"], "base", variant),
                    pick(IDOL_CUTE_PARAPHRASE_LEXICON["gesture"][idol_gesture_map[gesture_en]], base["id"], "gesture", variant),
                    pick(IDOL_CUTE_PARAPHRASE_LEXICON["expression"][idol_expression_map[expr_en]], base["id"], "expression", variant),
                ]) + "。"

            elif base["genre"] == "runway_fashion":
                style = find_component(canonical, catalog.RF_STYLE)
                walk = find_component(canonical, catalog.RF_WALK)
                arms = find_component(canonical, catalog.RF_ARMS)
                finish = find_component_triplet(canonical, catalog.RF_FINISH)
                ja = (
                    pick(RUNWAY_FASHION_LEXICON["style"][style], base["id"], "style", variant)
                    + pick(RUNWAY_FASHION_LEXICON["walk"][walk], base["id"], "walk", variant)
                    + "。"
                    + pick(RUNWAY_FASHION_LEXICON["arms"][arms], base["id"], "arms", variant)
                    + "。"
                    + pick(RUNWAY_FASHION_LEXICON["finish"][finish], base["id"], "finish", variant)
                    + "。"
                )

            elif base["genre"] == "dynamic_cute_dance":
                style = find_component(canonical, catalog.DC_STYLE)
                step = find_component(canonical, catalog.DC_STEP)
                upper = find_component(canonical, catalog.DC_UPPER)
                finish = find_component_triplet(canonical, catalog.DC_FINISH)
                ja = (
                    pick(DYNAMIC_CUTE_DANCE_LEXICON["style"][style], base["id"], "style", variant)
                    + pick(DYNAMIC_CUTE_DANCE_LEXICON["step"][step], base["id"], "step", variant)
                    + "。"
                    + pick(DYNAMIC_CUTE_DANCE_LEXICON["upper"][upper], base["id"], "upper", variant)
                    + "。"
                    + pick(DYNAMIC_CUTE_DANCE_LEXICON["finish"][finish], base["id"], "finish", variant)
                    + "。"
                )
            else:
                raise ValueError(base["genre"])

            ja = normalize(ja)
            if ja in generated_for_base:
                # Rare hash collision: change one lexical realization only, preserving semantics.
                for retry_no in range(1, 33):
                    retry_variant = variant + retry_no * 97
                    if base["genre"] == "glamour_editorial":
                        retry_first = pick(GE_STANCES_PARAPHRASES[stance], base["id"], "stance-retry", retry_variant)
                        retry_ja = "。".join([retry_first,
                            pick(GE_TORSO_PARAPHRASES[torso], base["id"], "torso", variant),
                            pick(GE_HANDS_PARAPHRASES[hands], base["id"], "hands", variant),
                            pick(GE_GAZE_PARAPHRASES[gaze], base["id"], "gaze", variant)]) + "。"
                    elif base["genre"] == "bold_sensual":
                        retry_first = pick(BS_LEVEL_PARAPHRASES[level], base["id"], "level-retry", retry_variant)
                        retry_ja = "。".join([retry_first,
                            pick(BS_BODY_PARAPHRASES[body], base["id"], "body", variant),
                            pick(BS_HANDS_PARAPHRASES[hands], base["id"], "hands", variant),
                            pick(BS_GAZE_PARAPHRASES[gaze], base["id"], "gaze", variant)]) + "。"
                    elif base["genre"] == "idol_cute":
                        retry_first = pick(IDOL_CUTE_PARAPHRASE_LEXICON["base"][idol_base_map[base_en]], base["id"], "base-retry", retry_variant)
                        retry_ja = "。".join([retry_first,
                            pick(IDOL_CUTE_PARAPHRASE_LEXICON["gesture"][idol_gesture_map[gesture_en]], base["id"], "gesture", variant),
                            pick(IDOL_CUTE_PARAPHRASE_LEXICON["expression"][idol_expression_map[expr_en]], base["id"], "expression", variant)]) + "。"
                    elif base["genre"] == "runway_fashion":
                        retry_first = pick(RUNWAY_FASHION_LEXICON["style"][style], base["id"], "style-retry", retry_variant)
                        retry_ja = (retry_first
                            + pick(RUNWAY_FASHION_LEXICON["walk"][walk], base["id"], "walk", variant) + "。"
                            + pick(RUNWAY_FASHION_LEXICON["arms"][arms], base["id"], "arms", variant) + "。"
                            + pick(RUNWAY_FASHION_LEXICON["finish"][finish], base["id"], "finish", variant) + "。")
                    elif base["genre"] == "dynamic_cute_dance":
                        retry_first = pick(DYNAMIC_CUTE_DANCE_LEXICON["style"][style], base["id"], "style-retry", retry_variant)
                        retry_ja = (retry_first
                            + pick(DYNAMIC_CUTE_DANCE_LEXICON["step"][step], base["id"], "step", variant) + "。"
                            + pick(DYNAMIC_CUTE_DANCE_LEXICON["upper"][upper], base["id"], "upper", variant) + "。"
                            + pick(DYNAMIC_CUTE_DANCE_LEXICON["finish"][finish], base["id"], "finish", variant) + "。")
                    retry_ja = normalize(retry_ja)
                    if retry_ja not in generated_for_base:
                        ja = retry_ja
                        break
                else:
                    raise SystemExit(f"Could not find unique paraphrase for {base['id']} variant {variant}")
            generated_for_base.add(ja)
            if ja in seen_ja:
                raise SystemExit(f"Cross-row Japanese duplicate: {base['id']} / {ja}")
            seen_ja.add(ja)

            rows.append({
                "id": f"{base['id']}_p{variant:02d}",
                "base_id": base["id"],
                "split": split,
                "kind": "catalog_natural_paraphrase",
                "genre": base["genre"],
                "ja": ja,
                "en": canonical,
                "intensity": base["intensity"],
                "route_hint": base["route_hint"],
                "source_dataset": "prompt_catalog_v1_paraphrase",
                "paraphrase_variant": variant,
            })
            per_genre[base["genre"]] = per_genre.get(base["genre"], 0) + 1

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    print(json.dumps({
        "output": str(args.output),
        "rows": len(rows),
        "unique_ja": len(seen_ja),
        "per_genre": per_genre,
        "splits": {s: sum(r["split"] == s for r in rows) for s in ("train", "val")},
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
