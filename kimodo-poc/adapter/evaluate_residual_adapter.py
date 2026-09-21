"""Compare a base MotionAdapter with a teacher-space residual adapter.

The residual adapter is intentionally interpreted in the teacher embedding space:
``base(qwen) * teacher_std + teacher_mean + residual(qwen)``.
It is not normalized or de-normalized with the base checkpoint statistics.
"""

import argparse
import json
from collections import defaultdict
from pathlib import Path
from typing import Any

import numpy as np
import torch
import torch.nn.functional as F


class MotionAdapter(torch.nn.Module):
    """The same architecture used by train_adapter.py."""

    def __init__(self, hidden: int, dropout: float = 0.0) -> None:
        super().__init__()
        if hidden <= 0:
            self.net = torch.nn.Linear(1024, 4096)
        else:
            self.net = torch.nn.Sequential(
                torch.nn.Linear(1024, hidden),
                torch.nn.GELU(),
                torch.nn.Dropout(dropout),
                torch.nn.Linear(hidden, 4096),
            )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)


def load_checkpoint(path: Path) -> dict[str, Any]:
    try:
        checkpoint = torch.load(path, map_location="cpu", weights_only=False)
    except TypeError:  # PyTorch before the weights_only parameter.
        checkpoint = torch.load(path, map_location="cpu")
    if not isinstance(checkpoint, dict) or "state_dict" not in checkpoint:
        raise SystemExit(f"Invalid adapter checkpoint (missing state_dict): {path}")
    return checkpoint


def load_adapter(checkpoint: dict[str, Any], label: str) -> MotionAdapter:
    if "hidden" not in checkpoint:
        raise SystemExit(f"{label} checkpoint is missing hidden")
    model = MotionAdapter(int(checkpoint["hidden"]), float(checkpoint.get("dropout", 0.0)))
    try:
        model.load_state_dict(checkpoint["state_dict"])
    except RuntimeError as exc:
        raise SystemExit(f"Could not load {label} checkpoint as MotionAdapter: {exc}") from exc
    return model.eval()


def summary(values: np.ndarray) -> dict[str, float | int | None]:
    if len(values) == 0:
        return {"count": 0, "cos_mean": None, "cos_median": None, "cos_min": None, "cos_max": None}
    return {
        "count": int(len(values)),
        "cos_mean": float(values.mean()),
        "cos_median": float(np.median(values)),
        "cos_min": float(values.min()),
        "cos_max": float(values.max()),
    }


def comparison(base: np.ndarray, combined: np.ndarray, applied: np.ndarray) -> dict[str, Any]:
    base_result = summary(base)
    combined_result = summary(combined)
    delta = combined - base
    return {
        "base": base_result,
        "base_plus_residual": combined_result,
        "delta_cos_mean": float(delta.mean()) if len(delta) else None,
        "residual_applied_count": int(applied.sum()),
        "residual_skipped_count": int((~applied).sum()),
        "residual_applied": bool(applied.all()) if len(applied) else False,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-adapter", type=Path, required=True)
    parser.add_argument("--residual-adapter", type=Path, required=True)
    parser.add_argument("--qwen", type=Path, required=True, help="Aligned Qwen embedding .npz")
    parser.add_argument("--teacher", type=Path, required=True, help="Aligned teacher embedding .npz")
    parser.add_argument("--pairs", type=Path, required=True, help="Aligned pairs .jsonl")
    parser.add_argument("--output", type=Path, help="Optional JSON result path; JSON is always printed")
    parser.add_argument("--device", default="cpu", help="Torch device, e.g. cpu or cuda")
    parser.add_argument(
        "--skip-residual-splits",
        nargs="*",
        default=[],
        metavar="SPLIT",
        help="Do not apply residual to these splits (e.g. --skip-residual-splits test).",
    )
    parser.add_argument(
        "--skip-residual-genres",
        nargs="*",
        default=[],
        metavar="GENRE",
        help="Do not apply residual to these genres.",
    )
    args = parser.parse_args()

    rows = [json.loads(line) for line in args.pairs.read_text(encoding="utf-8").splitlines() if line.strip()]
    qwen = np.load(args.qwen)
    teacher = np.load(args.teacher)
    required = {"ids", "splits", "embeddings"}
    if not required.issubset(qwen.files) or not required.issubset(teacher.files):
        raise SystemExit("Both embedding NPZ files must contain ids, splits, and embeddings")
    if not np.array_equal(qwen["ids"], teacher["ids"]) or not np.array_equal(qwen["splits"], teacher["splits"]):
        raise SystemExit("Qwen/teacher row alignment mismatch")

    ids = qwen["ids"].astype(str)
    splits = qwen["splits"].astype(str)
    if len(rows) != len(ids):
        raise SystemExit(f"pairs/embedding row count mismatch: pairs={len(rows)}, embeddings={len(ids)}")
    for index, row in enumerate(rows):
        if str(row.get("id")) != ids[index]:
            raise SystemExit(f"pairs/embedding ID mismatch at row {index}: {row.get('id')!r} != {ids[index]!r}")

    x_np = qwen["embeddings"].astype(np.float32)
    y_np = teacher["embeddings"].astype(np.float32)
    if x_np.ndim != 2 or x_np.shape[1] != 1024 or y_np.ndim != 2 or y_np.shape[1] != 4096:
        raise SystemExit(f"Expected Qwen [N,1024] and teacher [N,4096], got {x_np.shape} and {y_np.shape}")

    base_checkpoint = load_checkpoint(args.base_adapter)
    residual_checkpoint = load_checkpoint(args.residual_adapter)
    if "teacher_mean" not in base_checkpoint or "teacher_std" not in base_checkpoint:
        raise SystemExit("Base checkpoint must contain teacher_mean and teacher_std")
    device = torch.device(args.device)
    base_model = load_adapter(base_checkpoint, "base").to(device)
    residual_model = load_adapter(residual_checkpoint, "residual").to(device)
    mean = torch.as_tensor(base_checkpoint["teacher_mean"], dtype=torch.float32, device=device)
    std = torch.as_tensor(base_checkpoint["teacher_std"], dtype=torch.float32, device=device)
    if tuple(mean.shape) != (4096,) or tuple(std.shape) != (4096,):
        raise SystemExit("Base teacher_mean and teacher_std must each have 4096 values")

    x = torch.from_numpy(x_np).to(device)
    y = torch.from_numpy(y_np).to(device)
    with torch.inference_mode():
        base_prediction = base_model(x) * std + mean
        residual = residual_model(x)
        if tuple(residual.shape) != tuple(base_prediction.shape):
            raise SystemExit(f"Residual output must be [N,4096], got {tuple(residual.shape)}")
        combined_prediction = base_prediction + residual
        base_cos = F.cosine_similarity(base_prediction, y, dim=1).cpu().numpy()
        combined_cos = F.cosine_similarity(combined_prediction, y, dim=1).cpu().numpy()

    genres = np.asarray([str(row.get("genre") or row.get("kind") or "unknown") for row in rows])
    skipped_splits = set(args.skip_residual_splits)
    skipped_genres = set(args.skip_residual_genres)
    residual_applied = np.asarray(
        [(split not in skipped_splits and genre not in skipped_genres) for split, genre in zip(splits, genres)], dtype=bool
    )
    effective_cos = np.where(residual_applied, combined_cos, base_cos)

    by_split: dict[str, Any] = {}
    by_split_genre: dict[str, dict[str, Any]] = defaultdict(dict)
    for split in sorted(set(splits.tolist())):
        split_mask = splits == split
        by_split[split] = comparison(base_cos[split_mask], effective_cos[split_mask], residual_applied[split_mask])
        for genre in sorted(set(genres[split_mask].tolist())):
            mask = split_mask & (genres == genre)
            by_split_genre[split][genre] = comparison(base_cos[mask], effective_cos[mask], residual_applied[mask])

    skipped_mask = ~residual_applied
    unchanged = bool(np.array_equal(effective_cos[skipped_mask], base_cos[skipped_mask]))
    result = {
        "formula": "base(qwen) * base.teacher_std + base.teacher_mean + residual(qwen)",
        "rows": int(len(ids)),
        "residual_policy": {
            "skip_splits": sorted(skipped_splits),
            "skip_genres": sorted(skipped_genres),
            "applied_count": int(residual_applied.sum()),
            "skipped_count": int(skipped_mask.sum()),
        },
        "non_degradation_when_residual_skipped": {
            "checked_count": int(skipped_mask.sum()),
            "unchanged": unchanged,
            "max_absolute_cosine_difference": float(np.abs(effective_cos[skipped_mask] - base_cos[skipped_mask]).max()) if skipped_mask.any() else None,
        },
        "overall": comparison(base_cos, effective_cos, residual_applied),
        "by_split": by_split,
        "by_split_and_genre": dict(by_split_genre),
    }
    rendered = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)


if __name__ == "__main__":
    main()
