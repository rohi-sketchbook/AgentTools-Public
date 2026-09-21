import argparse
import json
from pathlib import Path

import numpy as np


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--pairs", type=Path, required=True)
    p.add_argument("--qwen", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    args = p.parse_args()

    rows = [json.loads(line) for line in args.pairs.read_text(encoding="utf-8").splitlines() if line.strip()]
    q = np.load(args.qwen)
    ids = q["ids"].astype(str)
    splits = q["splits"].astype(str)
    if len(rows) != len(ids):
        raise SystemExit("row count mismatch")

    x = q["embeddings"].astype(np.float32)
    x /= np.maximum(np.linalg.norm(x, axis=1, keepdims=True), 1e-8)
    labels = np.asarray([row.get("genre", "") or "generic" for row in rows])
    train_idx = np.where(splits == "train")[0]

    args.output.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        args.output,
        embeddings=x[train_idx].astype(np.float16),
        labels=labels[train_idx],
        ids=ids[train_idx],
        k=np.asarray([7], dtype=np.int32),
    )
    print(json.dumps({
        "output": str(args.output),
        "rows": int(len(train_idx)),
        "embedding_dim": int(x.shape[1]),
        "labels": {label: int(np.sum(labels[train_idx] == label)) for label in sorted(set(labels[train_idx]))},
        "k": 7,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
