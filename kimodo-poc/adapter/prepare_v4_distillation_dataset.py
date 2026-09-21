import argparse
import json
import random
import sys
from pathlib import Path


def load_jsonl(path: Path):
    rows = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            if line.strip():
                rows.append(json.loads(line))
    return rows


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--base", type=Path, default=Path("adapter/data/distill_pairs_v2.jsonl"))
    p.add_argument("--catalog-dir", type=Path, default=Path("motion_prompt_db/prompt_collections_v1"))
    p.add_argument("--output", type=Path, default=Path("adapter/data/distill_pairs_v4.jsonl"))
    p.add_argument("--catalog-val-per-genre", type=int, default=20)
    p.add_argument("--seed", type=int, default=20260825)
    args = p.parse_args()

    sys.path.insert(0, str(args.catalog_dir.resolve()))
    from catalog import BY_GENRE

    rows = []
    seen = set()
    counts = {"train": 0, "val": 0, "test": 0}

    for row in load_jsonl(args.base):
        key = (row["ja"], row["en"])
        if key in seen:
            continue
        seen.add(key)
        out = dict(row)
        out["source_dataset"] = "base_v2"
        rows.append(out)
        counts[out["split"]] += 1

    rng = random.Random(args.seed)
    catalog_counts = {}
    for genre, genre_rows in BY_GENRE.items():
        genre_rows = list(genre_rows)
        indices = list(range(len(genre_rows)))
        rng.shuffle(indices)
        val_indices = set(indices[: args.catalog_val_per_genre])
        gcounts = {"train": 0, "val": 0}
        for idx, row in enumerate(genre_rows):
            key = (row["ja_prompt"], row["canonical_en"])
            if key in seen:
                continue
            seen.add(key)
            split = "val" if idx in val_indices else "train"
            out = {
                "id": f"catalog_{row['id']}",
                "split": split,
                "kind": row["genre"],
                "ja": row["ja_prompt"],
                "en": row["canonical_en"],
                "source_dataset": "prompt_catalog_v1",
                "catalog_id": row["id"],
                "genre": row["genre"],
                "intensity": row["intensity"],
                "route_hint": row["route_hint"],
            }
            rows.append(out)
            counts[split] += 1
            gcounts[split] += 1
        catalog_counts[genre] = gcounts

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    print(json.dumps({
        "output": str(args.output),
        "total": len(rows),
        "splits": counts,
        "catalog": catalog_counts,
        "unique_pairs": len(seen),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
