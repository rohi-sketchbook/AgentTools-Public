from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np


def load_jsonl(path: Path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--pairs", type=Path, default=Path("adapter/data/distill_pairs_v5.jsonl"))
    p.add_argument("--base-teacher", type=Path, default=Path("adapter/data/teacher_embeddings_v2.npz"))
    p.add_argument("--catalog-teacher", type=Path, default=Path("adapter/data/teacher_embeddings_v4.npz"))
    p.add_argument("--output", type=Path, default=Path("adapter/data/teacher_embeddings_v5.npz"))
    args = p.parse_args()

    rows = load_jsonl(args.pairs)
    base = np.load(args.base_teacher)
    cat = np.load(args.catalog_teacher)

    base_map = {
        str(row_id): emb
        for row_id, emb in zip(base["ids"].astype(str), base["embeddings"].astype(np.float32))
    }
    catalog_map = {}
    for row_id, emb in zip(cat["ids"].astype(str), cat["embeddings"].astype(np.float32)):
        if row_id.startswith("catalog_"):
            catalog_map[row_id[len("catalog_"):]] = emb

    if len(base_map) != 743:
        raise SystemExit(f"Expected 743 base teacher rows, got {len(base_map)}")
    if len(catalog_map) != 1000:
        raise SystemExit(f"Expected 1000 catalog teacher rows, got {len(catalog_map)}")

    out = np.empty((len(rows), 4096), dtype=np.float32)
    source_counts = {"base": 0, "catalog_reused": 0}
    for i, row in enumerate(rows):
        if row.get("source_dataset") == "base_v2":
            out[i] = base_map[row["id"]]
            source_counts["base"] += 1
        elif row.get("source_dataset") == "prompt_catalog_v1_paraphrase":
            out[i] = catalog_map[row["base_id"]]
            source_counts["catalog_reused"] += 1
        else:
            raise SystemExit(f"Unknown teacher source for row {row['id']}: {row.get('source_dataset')}")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        args.output,
        embeddings=out,
        ids=np.asarray([r["id"] for r in rows]),
        splits=np.asarray([r["split"] for r in rows]),
    )
    print(json.dumps({
        "output": str(args.output),
        "shape": list(out.shape),
        "source_counts": source_counts,
        "ids_unique": len({r["id"] for r in rows}) == len(rows),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
