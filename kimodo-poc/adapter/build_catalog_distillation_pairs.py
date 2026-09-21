import argparse
import importlib.util
import json
from collections import Counter
from pathlib import Path


def load_catalog(path: Path):
    spec = importlib.util.spec_from_file_location("prompt_catalog", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load catalog: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return list(module.PROMPTS)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--catalog", type=Path, default=Path("motion_prompt_db/prompt_collections_v1/catalog.py"))
    p.add_argument("--output", type=Path, required=True)
    args = p.parse_args()

    rows = load_catalog(args.catalog)
    by_genre = {}
    for row in rows:
        by_genre.setdefault(row["genre"], []).append(row)

    out_rows = []
    for genre in sorted(by_genre):
        group = sorted(by_genre[genre], key=lambda r: r["id"])
        if len(group) != 200:
            raise SystemExit(f"Expected 200 rows for {genre}, got {len(group)}")
        # Exactly 20 validation rows per genre, spread uniformly through the 200 IDs.
        val_ids = {group[i]["id"] for i in range(9, 200, 10)}
        for row in group:
            out_rows.append({
                "id": f"catalog_{row['id']}",
                "split": "val" if row["id"] in val_ids else "train",
                "ja": row["ja_prompt"],
                "en": row["canonical_en"],
                "genre": row["genre"],
                "route_hint": row["route_hint"],
                "intensity": row["intensity"],
                "adult_glamour": row["adult_glamour"],
            })

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as f:
        for row in out_rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    print(json.dumps({
        "count": len(out_rows),
        "splits": dict(Counter(r["split"] for r in out_rows)),
        "genres": dict(Counter(r["genre"] for r in out_rows)),
        "val_by_genre": dict(Counter(r["genre"] for r in out_rows if r["split"] == "val")),
        "output": str(args.output),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
