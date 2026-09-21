import argparse
import json
from pathlib import Path

import numpy as np


def load_rows(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def normalize(x: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(x, axis=1, keepdims=True)
    return x / np.maximum(n, 1e-8)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--pairs", type=Path, required=True)
    p.add_argument("--qwen", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    args = p.parse_args()

    rows = load_rows(args.pairs)
    q = np.load(args.qwen)
    ids = q["ids"].astype(str)
    splits = q["splits"].astype(str)
    if len(rows) != len(ids):
        raise SystemExit("row count mismatch")

    x = normalize(q["embeddings"].astype(np.float32))
    genres = np.asarray([row.get("genre", "") or "" for row in rows], dtype=str)
    names = sorted(g for g in set(genres.tolist()) if g)

    centroids = []
    counts = {}
    for genre in names:
        idx = np.where((genres == genre) & (splits == "train"))[0]
        if len(idx) == 0:
            raise SystemExit(f"no train rows for {genre}")
        c = x[idx].mean(axis=0, keepdims=True)
        c = normalize(c)[0]
        centroids.append(c)
        counts[genre] = int(len(idx))
    centroids = np.stack(centroids).astype(np.float32)

    val_idx = np.where((splits == "val") & (genres != ""))[0]
    sims = x[val_idx] @ centroids.T
    pred = np.asarray(names)[np.argmax(sims, axis=1)]
    truth = genres[val_idx]
    best = np.max(sims, axis=1)
    sorted_sims = np.sort(sims, axis=1)
    margin = sorted_sims[:, -1] - sorted_sims[:, -2]
    acc = float(np.mean(pred == truth)) if len(val_idx) else 0.0

    generic_idx = np.where((splits != "test") & (genres == ""))[0]
    generic_best = np.max(x[generic_idx] @ centroids.T, axis=1) if len(generic_idx) else np.empty(0)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        args.output,
        genres=np.asarray(names),
        centroids=centroids,
    )
    report = {
        "output": str(args.output),
        "genres": names,
        "train_counts": counts,
        "val_count": int(len(val_idx)),
        "val_accuracy": round(acc, 6),
        "val_best_similarity": {
            "min": round(float(best.min()), 6) if len(best) else None,
            "median": round(float(np.median(best)), 6) if len(best) else None,
            "max": round(float(best.max()), 6) if len(best) else None,
        },
        "val_margin": {
            "min": round(float(margin.min()), 6) if len(margin) else None,
            "median": round(float(np.median(margin)), 6) if len(margin) else None,
        },
        "generic_best_similarity": {
            "count": int(len(generic_best)),
            "max": round(float(generic_best.max()), 6) if len(generic_best) else None,
            "p95": round(float(np.percentile(generic_best, 95)), 6) if len(generic_best) else None,
            "median": round(float(np.median(generic_best)), 6) if len(generic_best) else None,
        },
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
