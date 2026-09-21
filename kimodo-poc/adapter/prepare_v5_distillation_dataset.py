from __future__ import annotations

import argparse
import json
from pathlib import Path


def load_jsonl(path: Path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--base", type=Path, default=Path("adapter/data/distill_pairs_v2.jsonl"))
    p.add_argument("--paraphrases", type=Path, default=Path("adapter/data/catalog_paraphrases_v5.jsonl"))
    p.add_argument("--output", type=Path, default=Path("adapter/data/distill_pairs_v5.jsonl"))
    args = p.parse_args()

    base_rows = load_jsonl(args.base)
    para_rows = load_jsonl(args.paraphrases)
    rows = []
    seen_ids = set()
    seen_pairs = set()

    for row in base_rows:
        out = dict(row)
        out["source_dataset"] = "base_v2"
        rows.append(out)
        seen_ids.add(out["id"])
        seen_pairs.add((out["ja"], out["en"]))

    skipped_pair_duplicates = 0
    for row in para_rows:
        if row["id"] in seen_ids:
            raise SystemExit(f"Duplicate id: {row['id']}")
        pair = (row["ja"], row["en"])
        if pair in seen_pairs:
            skipped_pair_duplicates += 1
            continue
        seen_ids.add(row["id"])
        seen_pairs.add(pair)
        rows.append(row)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    stats = {
        "output": str(args.output),
        "total": len(rows),
        "base": len(base_rows),
        "paraphrases_input": len(para_rows),
        "paraphrases_kept": len(rows) - len(base_rows),
        "skipped_pair_duplicates": skipped_pair_duplicates,
        "splits": {s: sum(r["split"] == s for r in rows) for s in ("train", "val", "test")},
        "genres": {},
    }
    genres = sorted({r.get("genre") for r in para_rows if r.get("genre")})
    for genre in genres:
        stats["genres"][genre] = {
            s: sum(r.get("genre") == genre and r["split"] == s for r in rows)
            for s in ("train", "val")
        }
    print(json.dumps(stats, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
