import argparse
import json
import os
import statistics
import time
from pathlib import Path

import torch
from kimodo import load_model


class DummyTextEncoder:
    def __call__(self, texts):
        raise RuntimeError("DummyTextEncoder should not be called; benchmark passes text_feat directly")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--checkpoint-root", type=Path, required=True)
    p.add_argument("--model", default="Kimodo-SOMA-RP-v1.1")
    p.add_argument("--frames", type=int, default=30)
    p.add_argument("--steps", type=int, default=1)
    p.add_argument("--repeats", type=int, default=1)
    p.add_argument("--text-tokens", type=int, default=1)
    p.add_argument("--seed", type=int, default=42)
    args = p.parse_args()

    if not torch.cuda.is_available():
        raise SystemExit("CUDA is not available")
    os.environ["CHECKPOINT_DIR"] = str(args.checkpoint_root.resolve())

    torch.manual_seed(args.seed)
    torch.cuda.manual_seed_all(args.seed)
    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()

    t0 = time.perf_counter()
    model = load_model(args.model, device="cuda", text_encoder=DummyTextEncoder())
    torch.cuda.synchronize()
    load_s = time.perf_counter() - t0

    # Kimodo accepts a variable-length sequence of 4096-d text features and
    # internally pads it to the model's configured token count (50 for v1.1).
    text_feat = torch.zeros((1, args.text_tokens, 4096), dtype=torch.float32, device="cuda")
    text_pad_mask = torch.ones((1, args.text_tokens), dtype=torch.bool, device="cuda")
    motion_pad_mask = torch.ones((1, args.frames), dtype=torch.bool, device="cuda")
    first_heading = torch.zeros((1,), dtype=torch.float32, device="cuda")

    durations = []
    with torch.inference_mode():
        for _ in range(args.repeats):
            torch.cuda.synchronize()
            started = time.perf_counter()
            motion = model._generate(
                texts=[""],
                max_frames=args.frames,
                num_denoising_steps=args.steps,
                pad_mask=motion_pad_mask,
                first_heading_angle=first_heading,
                motion_mask=None,
                observed_motion=None,
                cfg_weight=[2.0, 2.0],
                text_feat=text_feat,
                text_pad_mask=text_pad_mask,
                progress_bar=lambda x: x,
            )
            torch.cuda.synchronize()
            durations.append(time.perf_counter() - started)

    result = {
        "gpu": torch.cuda.get_device_name(0),
        "model": args.model,
        "frames": args.frames,
        "steps": args.steps,
        "repeats": args.repeats,
        "text_tokens": args.text_tokens,
        "load_seconds": round(load_s, 4),
        "mean_generate_seconds": round(statistics.mean(durations), 4),
        "min_generate_seconds": round(min(durations), 4),
        "max_generate_seconds": round(max(durations), 4),
        "peak_vram_mib": round(torch.cuda.max_memory_allocated() / 1024 / 1024, 1),
        "output_shape": list(motion.shape),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
