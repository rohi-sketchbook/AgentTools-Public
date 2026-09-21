import argparse
import json
import time
from pathlib import Path

import numpy as np
import torch
import transformers.modeling_utils as modeling_utils
from kimodo.model.llm2vec import LLM2Vec


def load_rows(path: Path):
    rows = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            if line.strip():
                rows.append(json.loads(line))
    return rows


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--pairs", type=Path, required=True)
    p.add_argument("--model-dir", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--start", type=int, required=True)
    p.add_argument("--end", type=int, required=True)
    args = p.parse_args()

    if not torch.cuda.is_available():
        raise SystemExit("CUDA unavailable")
    all_rows = load_rows(args.pairs)
    if args.start < 0 or args.end > len(all_rows) or args.start >= args.end:
        raise SystemExit(f"Invalid range {args.start}:{args.end} for {len(all_rows)} rows")
    rows = all_rows[args.start:args.end]

    base = args.model_dir.resolve()
    adapter = (args.model_dir / "supervised_adapter").resolve()
    modeling_utils.caching_allocator_warmup = lambda *a, **kw: None

    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()
    load_start = time.perf_counter()
    model = LLM2Vec.from_pretrained(
        base_model_name_or_path=str(base),
        peft_model_name_or_path=str(adapter),
        torch_dtype=torch.bfloat16,
        device_map="cuda",
    )
    torch.cuda.synchronize()
    load_s = time.perf_counter() - load_start

    embeddings = np.empty((len(rows), 4096), dtype=np.float32)
    started = time.perf_counter()
    for i, row in enumerate(rows):
        # Deliberately keep the teacher at batch_size=1. Kimodo's own wrapper
        # does this because LLM2Vec embeddings vary with internal batch size.
        with torch.inference_mode():
            emb = model.encode(
                [row["en"]], batch_size=1, show_progress_bar=False,
                convert_to_tensor=True, device="cuda",
            )
        embeddings[i] = emb[0].float().cpu().numpy()
        if (i + 1) % 50 == 0 or i + 1 == len(rows):
            print(f"teacher {args.start + i + 1}/{args.end}", flush=True)

    torch.cuda.synchronize()
    encode_s = time.perf_counter() - started
    args.output.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        args.output,
        embeddings=embeddings,
        ids=np.asarray([r["id"] for r in rows]),
        splits=np.asarray([r["split"] for r in rows]),
        start=np.asarray(args.start),
        end=np.asarray(args.end),
    )
    print(json.dumps({
        "start": args.start,
        "end": args.end,
        "rows": len(rows),
        "load_seconds": round(load_s, 3),
        "encode_seconds": round(encode_s, 3),
        "mean_ms": round(encode_s * 1000 / len(rows), 3),
        "peak_vram_mib": round(torch.cuda.max_memory_allocated() / 1024 / 1024, 1),
        "output": str(args.output),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
