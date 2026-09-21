import argparse
import json
from pathlib import Path

import numpy as np


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--pairs", type=Path, required=True)
    p.add_argument("--parts", type=Path, nargs="+", required=True)
    p.add_argument("--output", type=Path, required=True)
    args = p.parse_args()

    rows = [json.loads(line) for line in args.pairs.read_text(encoding="utf-8").splitlines() if line.strip()]
    embeddings = []
    ids = []
    splits = []
    for part in args.parts:
        data = np.load(part)
        embeddings.append(data["embeddings"].astype(np.float32))
        ids.extend(data["ids"].astype(str).tolist())
        splits.extend(data["splits"].astype(str).tolist())

    merged = np.concatenate(embeddings, axis=0)
    expected_ids = [row["id"] for row in rows]
    expected_splits = [row["split"] for row in rows]
    if ids != expected_ids:
        for i, (a, b) in enumerate(zip(ids, expected_ids)):
            if a != b:
                raise SystemExit(f"ID mismatch at {i}: embedding={a} pairs={b}")
        raise SystemExit(f"ID count mismatch: embeddings={len(ids)} pairs={len(expected_ids)}")
    if splits != expected_splits:
        raise SystemExit("Split order mismatch")
    if merged.shape[0] != len(rows):
        raise SystemExit("Embedding row count mismatch")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        args.output,
        embeddings=merged,
        ids=np.asarray(ids),
        splits=np.asarray(splits),
    )
    print(json.dumps({
        "output": str(args.output),
        "shape": list(merged.shape),
        "parts": [str(x) for x in args.parts],
        "ids_verified": True,
        "splits_verified": True,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
