# -*- coding: shift_jis -*-
from __future__ import annotations

import argparse
import csv
import json
from collections import Counter
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--input",
        type=Path,
        default=Path("motion_prompt_db/promoted_anchor_paraphrases.tsv"),
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("adapter/data/promoted_anchor_pairs.jsonl"),
    )
    args = parser.parse_args()

    with args.input.open("r", encoding="utf-8", newline="") as stream:
        source_rows = list(csv.DictReader(stream, delimiter="\t"))

    required = {"id", "anchor_id", "split", "ja", "canonical_en"}
    if not source_rows:
        raise SystemExit("No promoted anchor rows found")
    if not required.issubset(source_rows[0]):
        missing = sorted(required - set(source_rows[0]))
        raise SystemExit(f"Missing columns: {missing}")

    ids = [row["id"] for row in source_rows]
    if len(ids) != len(set(ids)):
        raise SystemExit("Duplicate promoted anchor pair IDs")

    anchors = Counter(row["anchor_id"] for row in source_rows)
    bad_counts = {key: value for key, value in anchors.items() if value != 5}
    if bad_counts:
        raise SystemExit(f"Each promoted anchor must have exactly five variants: {bad_counts}")

    rows = []
    for row in source_rows:
        split = row["split"]
        if split not in {"train", "val"}:
            raise SystemExit(f"Unsupported split for {row['id']}: {split}")
        rows.append(
            {
                "id": row["id"],
                "split": split,
                "kind": "promoted_anchor_paraphrase",
                "anchor_id": row["anchor_id"],
                "ja": row["ja"],
                "en": row["canonical_en"],
                "source_dataset": "promoted_anchor_v1",
            }
        )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as stream:
        for row in rows:
            stream.write(json.dumps(row, ensure_ascii=False) + "\n")

    print(
        json.dumps(
            {
                "output": str(args.output),
                "rows": len(rows),
                "anchors": len(anchors),
                "splits": dict(Counter(row["split"] for row in rows)),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
