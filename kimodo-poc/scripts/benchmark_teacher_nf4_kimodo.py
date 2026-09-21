import argparse
import json
import statistics
import time
from pathlib import Path

import torch
import transformers.modeling_utils as modeling_utils
from kimodo.model.llm2vec import LLM2Vec


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--model-dir", type=Path, required=True)
    p.add_argument("--prompts", type=Path, required=True)
    p.add_argument("--limit", type=int, default=0)
    args = p.parse_args()

    prompts = []
    with args.prompts.open(encoding="utf-8") as f:
        for line in f:
            if line.strip():
                prompts.append(json.loads(line))
    if args.limit:
        prompts = prompts[: args.limit]

    if not torch.cuda.is_available():
        raise SystemExit("CUDA unavailable")

    base = args.model_dir.resolve()
    adapter = (args.model_dir / "supervised_adapter").resolve()

    # transformers 5.x tries to walk bitsandbytes-internal buffers during this
    # warmup and crashes for pre-quantized NF4 models. The model publisher calls
    # out this exact issue. Disabling only the allocator pre-warm does not alter
    # weights or inference math.
    modeling_utils.caching_allocator_warmup = lambda *args, **kwargs: None

    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()
    t0 = time.perf_counter()
    model = LLM2Vec.from_pretrained(
        base_model_name_or_path=str(base),
        peft_model_name_or_path=str(adapter),
        torch_dtype=torch.bfloat16,
        device_map="cuda",
    )
    torch.cuda.synchronize()
    load_s = time.perf_counter() - t0

    durations = []
    records = []
    for item in prompts:
        torch.cuda.synchronize()
        started = time.perf_counter()
        emb = model.encode(
            [item["text"]],
            batch_size=1,
            show_progress_bar=False,
            convert_to_tensor=True,
            device="cuda",
        )
        torch.cuda.synchronize()
        elapsed = time.perf_counter() - started
        durations.append(elapsed)
        records.append(
            {
                "id": item["id"],
                "shape": list(emb.shape),
                "norm": float(torch.linalg.vector_norm(emb[0]).item()),
                "elapsed_ms": round(elapsed * 1000, 3),
            }
        )

    print(
        json.dumps(
            {
                "gpu": torch.cuda.get_device_name(0),
                "load_seconds": round(load_s, 3),
                "samples": len(records),
                "mean_ms": round(statistics.mean(durations) * 1000, 3) if durations else None,
                "peak_vram_mib": round(torch.cuda.max_memory_allocated() / 1024 / 1024, 1),
                "records": records,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
