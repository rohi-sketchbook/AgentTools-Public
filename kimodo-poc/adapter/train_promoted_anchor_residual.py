# -*- coding: shift_jis -*-
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

from train_specialist_residual import MotionAdapter, SpecialistResidual


def cos_stats(pred: torch.Tensor, target: torch.Tensor) -> dict:
    cosine = F.cosine_similarity(pred, target, dim=1)
    return {
        "mean": float(cosine.mean().item()),
        "median": float(cosine.median().item()),
        "min": float(cosine.min().item()),
        "max": float(cosine.max().item()),
    }


def aligned_npz(path: Path, teacher_path: Path) -> tuple[np.lib.npyio.NpzFile, np.lib.npyio.NpzFile]:
    qwen = np.load(path)
    teacher = np.load(teacher_path)
    if not np.array_equal(qwen["ids"].astype(str), teacher["ids"].astype(str)):
        raise SystemExit(f"ID mismatch: {path} vs {teacher_path}")
    if not np.array_equal(qwen["splits"].astype(str), teacher["splits"].astype(str)):
        raise SystemExit(f"Split mismatch: {path} vs {teacher_path}")
    return qwen, teacher


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--anchor-qwen", type=Path, required=True)
    parser.add_argument("--anchor-teacher", type=Path, required=True)
    parser.add_argument("--base-qwen", type=Path, default=Path("adapter/data/qwen_embeddings_v3_instruct.npz"))
    parser.add_argument("--base-teacher", type=Path, default=Path("adapter/data/teacher_embeddings_v2.npz"))
    parser.add_argument("--base-adapter", type=Path, default=Path("adapter/checkpoints/adapter_v3_instruct_h512.pt"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--hidden", type=int, default=128)
    parser.add_argument("--dropout", type=float, default=0.03)
    parser.add_argument("--epochs", type=int, default=1600)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--weight-decay", type=float, default=1e-4)
    parser.add_argument("--patience", type=int, default=220)
    parser.add_argument("--base-anchor-weight", type=float, default=1.0)
    parser.add_argument("--drift-penalty", type=float, default=3.0)
    parser.add_argument("--seed", type=int, default=20260826)
    args = parser.parse_args()

    if not torch.cuda.is_available():
        raise SystemExit("CUDA unavailable")
    if args.base_anchor_weight < 0:
        raise SystemExit("--base-anchor-weight must be >= 0")

    anchor_q, anchor_t = aligned_npz(args.anchor_qwen, args.anchor_teacher)
    base_q, base_t = aligned_npz(args.base_qwen, args.base_teacher)

    anchor_splits = anchor_q["splits"].astype(str)
    base_splits = base_q["splits"].astype(str)
    anchor_train_np = np.where(anchor_splits == "train")[0]
    anchor_val_np = np.where(anchor_splits == "val")[0]
    base_train_np = np.where(base_splits == "train")[0]
    base_val_np = np.where(base_splits == "val")[0]
    base_test_np = np.where(base_splits == "test")[0]
    if len(anchor_train_np) == 0 or len(anchor_val_np) == 0:
        raise SystemExit("Anchor train/val rows are required")

    device = torch.device("cuda")
    anchor_x = torch.from_numpy(anchor_q["embeddings"].astype(np.float32)).to(device)
    anchor_y = torch.from_numpy(anchor_t["embeddings"].astype(np.float32)).to(device)
    base_x = torch.from_numpy(base_q["embeddings"].astype(np.float32)).to(device)
    base_y = torch.from_numpy(base_t["embeddings"].astype(np.float32)).to(device)

    checkpoint = torch.load(args.base_adapter, map_location="cpu", weights_only=False)
    base = MotionAdapter(int(checkpoint["hidden"]), float(checkpoint.get("dropout", 0.0))).to(device).eval()
    base.load_state_dict(checkpoint["state_dict"])
    for parameter in base.parameters():
        parameter.requires_grad_(False)
    mean = torch.as_tensor(checkpoint["teacher_mean"], dtype=torch.float32, device=device)
    std = torch.as_tensor(checkpoint["teacher_std"], dtype=torch.float32, device=device)

    with torch.inference_mode():
        anchor_base_z = base(anchor_x)
        anchor_base_y = anchor_base_z * std + mean
        anchor_target_z = (anchor_y - mean) / std
        anchor_target_residual = anchor_target_z - anchor_base_z
        base_base_z = base(base_x)
        base_base_y = base_base_z * std + mean

    torch.manual_seed(args.seed)
    torch.cuda.manual_seed_all(args.seed)
    residual = SpecialistResidual(args.hidden, args.dropout).to(device)
    optimizer = torch.optim.AdamW(residual.parameters(), lr=args.lr, weight_decay=args.weight_decay)

    anchor_train = torch.as_tensor(anchor_train_np, dtype=torch.long, device=device)
    anchor_val = torch.as_tensor(anchor_val_np, dtype=torch.long, device=device)
    base_train = torch.as_tensor(base_train_np, dtype=torch.long, device=device)
    base_val = torch.as_tensor(base_val_np, dtype=torch.long, device=device)
    base_test = torch.as_tensor(base_test_np, dtype=torch.long, device=device)

    with torch.inference_mode():
        anchor_val_base_cos = float(
            F.cosine_similarity(anchor_base_y[anchor_val], anchor_y[anchor_val], dim=1).mean().item()
        )
        base_val_base_cos = float(
            F.cosine_similarity(base_base_y[base_val], base_y[base_val], dim=1).mean().item()
        )

    best_state = None
    best_score = -1e9
    best_epoch = 0
    best_anchor_val = -1.0
    best_base_val = -1.0
    stale = 0
    started = time.perf_counter()
    torch.cuda.reset_peak_memory_stats()

    for epoch in range(1, args.epochs + 1):
        residual.train()
        permutation = anchor_train[torch.randperm(len(anchor_train), device=device)]
        for start in range(0, len(permutation), args.batch_size):
            idx = permutation[start : start + args.batch_size]
            correction = residual(anchor_x[idx])
            pred_z = anchor_base_z[idx] + correction
            pred_y = pred_z * std + mean
            loss_fit = F.mse_loss(correction, anchor_target_residual[idx])
            loss_cos = 1.0 - F.cosine_similarity(pred_y, anchor_y[idx], dim=1).mean()
            loss = loss_fit + 0.25 * loss_cos

            if args.base_anchor_weight > 0 and len(base_train):
                take = min(len(idx) * 2, len(base_train))
                base_idx = base_train[torch.randint(0, len(base_train), (take,), device=device)]
                base_correction = residual(base_x[base_idx])
                loss = loss + args.base_anchor_weight * torch.mean(base_correction.square())

            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            optimizer.step()

        residual.eval()
        with torch.inference_mode():
            anchor_val_correction = residual(anchor_x[anchor_val])
            anchor_val_pred = (anchor_base_z[anchor_val] + anchor_val_correction) * std + mean
            anchor_val_cos = float(
                F.cosine_similarity(anchor_val_pred, anchor_y[anchor_val], dim=1).mean().item()
            )
            base_val_correction = residual(base_x[base_val])
            base_val_pred = (base_base_z[base_val] + base_val_correction) * std + mean
            base_val_cos = float(
                F.cosine_similarity(base_val_pred, base_y[base_val], dim=1).mean().item()
            )
            drift = max(0.0, base_val_base_cos - base_val_cos)
            score = anchor_val_cos - args.drift_penalty * drift

        if score > best_score + 1e-6:
            best_score = score
            best_epoch = epoch
            best_anchor_val = anchor_val_cos
            best_base_val = base_val_cos
            best_state = {key: value.detach().cpu().clone() for key, value in residual.state_dict().items()}
            stale = 0
        else:
            stale += 1

        if epoch % 100 == 0:
            print(
                f"epoch={epoch} anchor_val={anchor_val_cos:.6f} base_val={base_val_cos:.6f} "
                f"score={score:.6f} best={best_score:.6f}@{best_epoch}",
                flush=True,
            )
        if stale >= args.patience:
            break

    if best_state is None:
        raise SystemExit("No checkpoint produced")

    residual.load_state_dict(best_state)
    residual.eval()
    torch.cuda.synchronize()
    elapsed = time.perf_counter() - started

    with torch.inference_mode():
        anchor_all_pred = (anchor_base_z + residual(anchor_x)) * std + mean
        anchor_val_pred = anchor_all_pred[anchor_val]
        base_val_pred = (base_base_z[base_val] + residual(base_x[base_val])) * std + mean
        base_test_pred = (
            (base_base_z[base_test] + residual(base_x[base_test])) * std + mean
            if len(base_test)
            else None
        )
        base_train_correction = residual(base_x[base_train])
        base_val_correction = residual(base_x[base_val])

    args.output.parent.mkdir(parents=True, exist_ok=True)
    torch.save(
        {
            "state_dict": best_state,
            "hidden": args.hidden,
            "dropout": args.dropout,
            "kind": "promoted_anchor_residual",
            "base_adapter_checkpoint": str(args.base_adapter),
            "teacher_mean": checkpoint["teacher_mean"],
            "teacher_std": checkpoint["teacher_std"],
            "base_anchor_weight": args.base_anchor_weight,
            "drift_penalty": args.drift_penalty,
            "seed": args.seed,
        },
        args.output,
    )

    result = {
        "parameters": sum(parameter.numel() for parameter in residual.parameters()),
        "hidden": args.hidden,
        "base_anchor_weight": args.base_anchor_weight,
        "drift_penalty": args.drift_penalty,
        "epochs_ran": epoch,
        "best_epoch": best_epoch,
        "elapsed_seconds": round(elapsed, 3),
        "peak_vram_mib": round(torch.cuda.max_memory_allocated() / 1024 / 1024, 1),
        "counts": {
            "anchor_train": len(anchor_train_np),
            "anchor_val": len(anchor_val_np),
            "base_train": len(base_train_np),
            "base_val": len(base_val_np),
            "base_test": len(base_test_np),
        },
        "anchor_val_base": cos_stats(anchor_base_y[anchor_val], anchor_y[anchor_val]),
        "anchor_val_with_residual": cos_stats(anchor_val_pred, anchor_y[anchor_val]),
        "base_val_base": cos_stats(base_base_y[base_val], base_y[base_val]),
        "base_val_with_residual": cos_stats(base_val_pred, base_y[base_val]),
        "base_test_base": cos_stats(base_base_y[base_test], base_y[base_test]) if len(base_test) else None,
        "base_test_with_residual": cos_stats(base_test_pred, base_y[base_test]) if base_test_pred is not None else None,
        "base_correction_rms": {
            "train": float(torch.sqrt(torch.mean(base_train_correction.square())).item()),
            "val": float(torch.sqrt(torch.mean(base_val_correction.square())).item()),
        },
        "best_selection": {
            "score": best_score,
            "anchor_val_cos": best_anchor_val,
            "base_val_cos": best_base_val,
            "anchor_val_base_cos": anchor_val_base_cos,
            "base_val_base_cos": base_val_base_cos,
        },
        "output": str(args.output),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
