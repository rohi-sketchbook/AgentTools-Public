# -*- coding: shift_jis -*-
"""Benchmark the proposed 1024->2048->4096 adapter on synthetic embeddings.

This measures compute/memory cost only. Synthetic targets do not measure motion quality.
"""
import argparse
import json
import time

import torch
import torch.nn.functional as F


class MotionAdapter(torch.nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.net = torch.nn.Sequential(
            torch.nn.Linear(1024, 2048),
            torch.nn.GELU(),
            torch.nn.Linear(2048, 4096),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--samples", type=int, default=10000)
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--epochs", type=int, default=5)
    parser.add_argument("--dtype", choices=("fp32", "fp16", "bf16"), default="fp16")
    args = parser.parse_args()

    if not torch.cuda.is_available():
        raise SystemExit("CUDA is required for this benchmark.")
    if args.samples < 1 or args.batch_size < 1 or args.epochs < 1:
        raise SystemExit("samples, batch-size and epochs must be >= 1")

    device = torch.device("cuda")
    dtype = {"fp32": torch.float32, "fp16": torch.float16, "bf16": torch.bfloat16}[args.dtype]
    model = MotionAdapter().to(device=device, dtype=dtype)
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3)

    parameter_count = sum(p.numel() for p in model.parameters())
    torch.cuda.synchronize()
    torch.cuda.reset_peak_memory_stats()

    total_seen = 0
    started = time.perf_counter()
    steps_per_epoch = (args.samples + args.batch_size - 1) // args.batch_size

    for _epoch in range(args.epochs):
        remaining = args.samples
        for _step in range(steps_per_epoch):
            batch = min(args.batch_size, remaining)
            remaining -= batch
            student = torch.randn(batch, 1024, device=device, dtype=dtype)
            teacher = torch.randn(batch, 4096, device=device, dtype=dtype)
            prediction = model(student)
            mse = F.mse_loss(prediction.float(), teacher.float())
            cosine = 1.0 - F.cosine_similarity(prediction.float(), teacher.float(), dim=1).mean()
            loss = mse + cosine
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            optimizer.step()
            total_seen += batch

    torch.cuda.synchronize()
    elapsed = time.perf_counter() - started
    result = {
        "gpu": torch.cuda.get_device_name(0),
        "dtype": args.dtype,
        "parameters": parameter_count,
        "samples_per_epoch": args.samples,
        "epochs": args.epochs,
        "total_samples": total_seen,
        "batch_size": args.batch_size,
        "elapsed_seconds": round(elapsed, 3),
        "samples_per_second": round(total_seen / elapsed, 1),
        "seconds_per_epoch": round(elapsed / args.epochs, 3),
        "peak_vram_mib": round(torch.cuda.max_memory_allocated() / 1024 / 1024, 1),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
