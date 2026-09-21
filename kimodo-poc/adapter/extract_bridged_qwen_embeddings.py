# -*- coding: shift_jis -*-
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from transformers import AutoModel, AutoTokenizer

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str((ROOT / "adapter").resolve()))
from train_qwen_instruction_bridge import QwenInstructionBridge


DEFAULT_INSTRUCTION = "Map Japanese human motion descriptions into a semantic space for full-body motion generation."


def load_rows(path: Path) -> list[dict]:
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pairs", type=Path, required=True)
    parser.add_argument("--model-dir", type=Path, default=Path("models/qwen3-embedding-0.6b"))
    parser.add_argument("--bridge", type=Path, default=Path("adapter/checkpoints/qwen_bridge_h256.pt"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--instruction", default=DEFAULT_INSTRUCTION)
    parser.add_argument("--batch-size", type=int, default=32)
    args = parser.parse_args()

    if not torch.cuda.is_available():
        raise SystemExit("CUDA unavailable")
    if args.batch_size < 1:
        raise SystemExit("--batch-size must be >= 1")

    rows = load_rows(args.pairs)
    if not rows:
        raise SystemExit("No rows found")

    device = torch.device("cuda")
    started = time.perf_counter()
    tokenizer = AutoTokenizer.from_pretrained(
        str(args.model_dir.resolve()),
        local_files_only=True,
        trust_remote_code=False,
        padding_side="left",
    )
    qwen = AutoModel.from_pretrained(
        str(args.model_dir.resolve()),
        local_files_only=True,
        trust_remote_code=False,
        use_safetensors=True,
    ).to(device).eval()

    checkpoint = torch.load(args.bridge.resolve(), map_location="cpu", weights_only=False)
    bridge = QwenInstructionBridge(
        int(checkpoint["hidden"]),
        float(checkpoint.get("dropout", 0.0)),
    ).to(device).eval()
    bridge.load_state_dict(checkpoint["state_dict"])

    for module in (qwen, bridge):
        for parameter in module.parameters():
            parameter.requires_grad_(False)

    torch.cuda.synchronize()
    load_seconds = time.perf_counter() - started
    torch.cuda.reset_peak_memory_stats()
    embeddings = np.empty((len(rows), 1024), dtype=np.float32)
    encode_started = time.perf_counter()

    with torch.inference_mode():
        for start in range(0, len(rows), args.batch_size):
            end = min(start + args.batch_size, len(rows))
            texts = [row["ja"] for row in rows[start:end]]
            if args.instruction:
                texts = [f"Instruct: {args.instruction}\nQuery:{text}" for text in texts]
            tokens = tokenizer(
                texts,
                return_tensors="pt",
                padding=True,
                truncation=True,
                max_length=256,
            ).to(device)
            hidden = qwen(**tokens).last_hidden_state
            source = F.normalize(hidden[:, -1], p=2, dim=1).float()
            bridged = bridge(source)
            embeddings[start:end] = bridged.cpu().numpy()

    torch.cuda.synchronize()
    encode_seconds = time.perf_counter() - encode_started
    args.output.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        args.output,
        embeddings=embeddings,
        ids=np.asarray([row["id"] for row in rows]),
        splits=np.asarray([row["split"] for row in rows]),
    )
    print(
        json.dumps(
            {
                "rows": len(rows),
                "shape": list(embeddings.shape),
                "load_seconds": round(load_seconds, 3),
                "encode_seconds": round(encode_seconds, 3),
                "mean_ms": round(encode_seconds * 1000.0 / len(rows), 3),
                "peak_vram_mib": round(torch.cuda.max_memory_allocated() / 1024 / 1024, 1),
                "output": str(args.output),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
