from __future__ import annotations

import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "motion_prompt_db"
OUTPUT = ROOT / "adapter" / "motion_category_index.json"


def rows(name: str) -> list[dict[str, str]]:
    with (DB / name).open("r", encoding="utf-8", newline="") as stream:
        return list(csv.DictReader(stream, delimiter="\t"))


def add(out: list[dict], row: dict[str, str], category: str) -> None:
    out.append({
        "id": row["id"],
        "category": category,
        "ja": row["ja"],
        "canonical_en": row["canonical_en"],
    })


def runway_category(row: dict[str, str]) -> str:
    motion_id = row["id"]
    if any(token in motion_id for token in ("walk", "stride", "cross_step")):
        return "locomotion"
    if motion_id in {"runway_balletic_turn", "runway_pirouette"}:
        return "dance"
    if motion_id in {"runway_coat_reveal", "runway_skirt_flow", "runway_pause_gaze"}:
        return "gesture"
    return "posture_transition"


def main() -> None:
    concepts: list[dict] = []
    for row in rows("poses_general.tsv"):
        add(concepts, row, "posture_transition")
    for row in rows("idol_gestures.tsv"):
        add(concepts, row, "gesture")
    for row in rows("glamour_editorial.tsv"):
        add(concepts, row, "posture_transition")
    for row in rows("runway_fashion.tsv"):
        add(concepts, row, runway_category(row))
    for row in rows("idol_motion.tsv"):
        add(concepts, row, "dance")
    for row in rows("head_locomotion_style.tsv"):
        category = row.get("category", "")
        if category == "locomotion":
            add(concepts, row, "locomotion")
        elif category == "head":
            add(concepts, row, "gesture")
    for row in rows("body_primitives.tsv"):
        add(concepts, row, "posture_transition" if row.get("category") == "transition" else "gesture")

    ids = [row["id"] for row in concepts]
    if len(ids) != len(set(ids)):
        raise SystemExit("duplicate concept ids")

    document = {
        "schema": "kimodo-motion-category-index/v1",
        "categories": [
            {"id": "locomotion", "label_ja": "移動"},
            {"id": "gesture", "label_ja": "ジェスチャー"},
            {"id": "dance", "label_ja": "ダンス"},
            {"id": "posture_transition", "label_ja": "姿勢・遷移"},
            {"id": "everyday_activity", "label_ja": "日常動作"},
            {"id": "object_interaction", "label_ja": "物体操作"},
            {"id": "stunt_athletic", "label_ja": "アクロバット"},
        ],
        "concept_blend": {"similarity_threshold": 0.82, "weight": 0.20},
        "concepts": concepts,
        "note": "Only reviewed/current vocabulary concepts are used as semantic prototypes. Categories without reviewed prototypes leave the prompt embedding unchanged.",
    }
    OUTPUT.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    counts = {category["id"]: sum(row["category"] == category["id"] for row in concepts) for category in document["categories"]}
    print(json.dumps({"output": str(OUTPUT), "concepts": len(concepts), "counts": counts}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
