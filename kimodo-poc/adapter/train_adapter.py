import argparse
import json
import re
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F


class MotionAdapter(torch.nn.Module):
    def __init__(self, hidden: int, dropout: float) -> None:
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


def metrics(pred: torch.Tensor, target: torch.Tensor) -> dict:
    cos = F.cosine_similarity(pred, target, dim=1)
    rmse = torch.sqrt(F.mse_loss(pred, target))
    rel = torch.linalg.vector_norm(pred - target, dim=1) / torch.linalg.vector_norm(target, dim=1)
    return {
        "cos_mean": float(cos.mean().item()),
        "cos_min": float(cos.min().item()),
        "rmse": float(rmse.item()),
        "rel_l2_mean": float(rel.mean().item()),
    }


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--qwen", type=Path, required=True)
    p.add_argument("--teacher", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--hidden", type=int, default=256)
    p.add_argument("--dropout", type=float, default=0.05)
    p.add_argument("--epochs", type=int, default=1200)
    p.add_argument("--batch-size", type=int, default=64)
    p.add_argument("--lr", type=float, default=1e-3)
    p.add_argument("--weight-decay", type=float, default=1e-3)
    p.add_argument("--patience", type=int, default=150)
    p.add_argument("--seed", type=int, default=20260825)
    p.add_argument("--base-repeat", type=int, default=1, help="Repeat non-catalog training rows to preserve broad-language generalization")
    p.add_argument("--dedupe-teacher-stats", action="store_true", help="Count repeated paraphrases of the same catalog meaning once when computing teacher mean/std")
    args = p.parse_args()

    if not torch.cuda.is_available():
        raise SystemExit("CUDA unavailable")

    q = np.load(args.qwen)
    t = np.load(args.teacher)
    if not np.array_equal(q["ids"], t["ids"]) or not np.array_equal(q["splits"], t["splits"]):
        raise SystemExit("Qwen/teacher row alignment mismatch")

    x_np = q["embeddings"].astype(np.float32)
    y_np = t["embeddings"].astype(np.float32)
    splits = q["splits"].astype(str)
    ids = q["ids"].astype(str)

    train_idx = np.where(splits == "train")[0]
    val_idx = np.where(splits == "val")[0]
    test_idx = np.where(splits == "test")[0]

    # Standardize each teacher dimension from train statistics. Repeated natural-language
    # paraphrases may intentionally share one teacher target; when requested, count that
    # semantic target only once so the coordinate statistics are not biased by paraphrase count.
    stats_idx = train_idx
    if args.dedupe_teacher_stats:
        seen_stats_keys = set()
        unique_stats_idx = []
        for i in train_idx:
            row_id = ids[i]
            m = re.fullmatch(r"((?:GE|IC|RF|DC|BS)\d{3})_p\d{2}", row_id)
            key = f"catalog:{m.group(1)}" if m else f"row:{row_id}"
            if key not in seen_stats_keys:
                seen_stats_keys.add(key)
                unique_stats_idx.append(i)
        stats_idx = np.asarray(unique_stats_idx, dtype=np.int64)
    y_mean = y_np[stats_idx].mean(axis=0)
    y_std = y_np[stats_idx].std(axis=0)
    y_std = np.maximum(y_std, 0.05)
    yz_np = (y_np - y_mean) / y_std

    device = torch.device("cuda")
    x = torch.from_numpy(x_np).to(device)
    yz = torch.from_numpy(yz_np).to(device)
    y = torch.from_numpy(y_np).to(device)
    mean = torch.from_numpy(y_mean).to(device)
    std = torch.from_numpy(y_std).to(device)

    torch.manual_seed(args.seed)
    torch.cuda.manual_seed_all(args.seed)
    model = MotionAdapter(args.hidden, args.dropout).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=args.weight_decay)

    train_t = torch.as_tensor(train_idx, device=device, dtype=torch.long)
    if args.base_repeat < 1:
        raise SystemExit("--base-repeat must be >= 1")
    def is_catalog_row(row_id: str) -> bool:
        return row_id.startswith("catalog_") or re.fullmatch(r"(?:GE|IC|RF|DC|BS)\d{3}_p\d{2}", row_id) is not None

    catalog_mask = np.array([is_catalog_row(ids[i]) for i in train_idx])
    base_train_idx = train_idx[~catalog_mask]
    catalog_train_idx = train_idx[catalog_mask]
    fit_idx = np.concatenate([catalog_train_idx, *([base_train_idx] * args.base_repeat)])
    fit_t = torch.as_tensor(fit_idx, device=device, dtype=torch.long)
    val_t = torch.as_tensor(val_idx, device=device, dtype=torch.long)
    test_t = torch.as_tensor(test_idx, device=device, dtype=torch.long)

    best_state = None
    best_val = -1.0
    best_epoch = 0
    stale = 0
    started = time.perf_counter()
    torch.cuda.reset_peak_memory_stats()

    for epoch in range(1, args.epochs + 1):
        model.train()
        perm = fit_t[torch.randperm(len(fit_t), device=device)]
        for start in range(0, len(perm), args.batch_size):
            idx = perm[start : start + args.batch_size]
            pred_z = model(x[idx])
            pred_y = pred_z * std + mean
            loss_mse = F.mse_loss(pred_z, yz[idx])
            loss_cos = 1.0 - F.cosine_similarity(pred_y, y[idx], dim=1).mean()
            loss = loss_mse + 0.25 * loss_cos
            opt.zero_grad(set_to_none=True)
            loss.backward()
            opt.step()

        model.eval()
        with torch.inference_mode():
            val_pred = model(x[val_t]) * std + mean
            val_cos = float(F.cosine_similarity(val_pred, y[val_t], dim=1).mean().item())
        if val_cos > best_val + 1e-5:
            best_val = val_cos
            best_epoch = epoch
            best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
            stale = 0
        else:
            stale += 1
        if epoch % 100 == 0:
            print(f"epoch={epoch} val_cos={val_cos:.5f} best={best_val:.5f}@{best_epoch}", flush=True)
        if stale >= args.patience:
            break

    if best_state is None:
        raise SystemExit("No checkpoint produced")
    model.load_state_dict(best_state)
    model.eval()
    torch.cuda.synchronize()
    elapsed = time.perf_counter() - started

    with torch.inference_mode():
        train_pred = model(x[train_t]) * std + mean
        val_pred = model(x[val_t]) * std + mean
        test_pred = model(x[test_t]) * std + mean if len(test_t) else None

    args.output.parent.mkdir(parents=True, exist_ok=True)
    torch.save(
        {
            "state_dict": best_state,
            "hidden": args.hidden,
            "dropout": args.dropout,
            "teacher_mean": y_mean,
            "teacher_std": y_std,
            "qwen_dim": 1024,
            "teacher_dim": 4096,
            "seed": args.seed,
        },
        args.output,
    )

    result = {
        "parameters": sum(p.numel() for p in model.parameters()),
        "base_repeat": args.base_repeat,
        "dedupe_teacher_stats": bool(args.dedupe_teacher_stats),
        "teacher_stats_samples": int(len(stats_idx)),
        "fit_samples_per_epoch": int(len(fit_idx)),
        "unique_train_samples": int(len(train_idx)),
        "hidden": args.hidden,
        "epochs_ran": epoch,
        "best_epoch": best_epoch,
        "elapsed_seconds": round(elapsed, 3),
        "peak_vram_mib": round(torch.cuda.max_memory_allocated() / 1024 / 1024, 1),
        "train": metrics(train_pred, y[train_t]),
        "val": metrics(val_pred, y[val_t]),
        "test": metrics(test_pred, y[test_t]) if test_pred is not None else None,
        "test_ids": ids[test_idx].tolist(),
        "output": str(args.output),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
