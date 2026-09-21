import argparse
import gc
import importlib.util
import json
import os
import random
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import torch
import transformers.modeling_utils as modeling_utils
from kimodo import load_model
from kimodo.model.llm2vec import LLM2Vec
from kimodo.skeleton import SOMASkeleton30


class DummyTextEncoder:
    def __call__(self, texts):
        raise RuntimeError("text encoder should not be called when text_feat is supplied")


def load_catalog(path: Path):
    spec = importlib.util.spec_from_file_location("prompt_catalog", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load catalog: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return list(module.PROMPTS)


def stratified_sample(rows, per_genre: int, seed: int):
    rng = random.Random(seed)
    by_genre = defaultdict(list)
    for row in rows:
        by_genre[row["genre"]].append(row)

    selected = []
    for genre in sorted(by_genre):
        pool = list(by_genre[genre])
        rng.shuffle(pool)
        # Round-robin strata so route/intensity combinations stay represented.
        strata = defaultdict(list)
        for row in pool:
            strata[(row["route_hint"], int(row["intensity"]))].append(row)
        keys = sorted(strata)
        genre_selected = []
        while len(genre_selected) < per_genre and keys:
            next_keys = []
            for key in keys:
                if strata[key] and len(genre_selected) < per_genre:
                    genre_selected.append(strata[key].pop())
                if strata[key]:
                    next_keys.append(key)
            keys = next_keys
        selected.extend(genre_selected)
    return selected


def path_length(points: np.ndarray) -> float:
    if len(points) < 2:
        return 0.0
    return float(np.linalg.norm(np.diff(points, axis=0), axis=-1).sum())


def mean_root_relative_frame_motion(joints: np.ndarray, root_idx: int) -> float:
    root = joints[:, root_idx : root_idx + 1]
    rel = joints - root
    if len(rel) < 2:
        return 0.0
    return float(np.linalg.norm(np.diff(rel, axis=0), axis=-1).mean())


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--catalog", type=Path, default=Path("motion_prompt_db/prompt_collections_v1/catalog.py"))
    p.add_argument("--checkpoint-root", type=Path, default=Path("models"))
    p.add_argument("--teacher-dir", type=Path, default=Path("models/kimodo-llm2vec-nf4"))
    p.add_argument("--output-dir", type=Path, default=Path("results/prompt-catalog-sweep-200"))
    p.add_argument("--per-genre", type=int, default=40)
    p.add_argument("--frames", type=int, default=120)
    p.add_argument("--steps", type=int, default=25)
    p.add_argument("--seed", type=int, default=20260825)
    p.add_argument("--ids", nargs="*", default=None)
    args = p.parse_args()

    if not torch.cuda.is_available():
        raise SystemExit("CUDA unavailable")

    all_rows = load_catalog(args.catalog)
    if args.ids:
        wanted = set(args.ids)
        rows = [r for r in all_rows if r["id"] in wanted]
        missing = sorted(wanted - {r["id"] for r in rows})
        if missing:
            raise SystemExit(f"Unknown IDs: {missing}")
    else:
        rows = stratified_sample(all_rows, args.per_genre, args.seed)

    out = args.output_dir.resolve()
    motions_dir = out / "motions"
    motions_dir.mkdir(parents=True, exist_ok=True)
    os.environ["CHECKPOINT_DIR"] = str(args.checkpoint_root.resolve())

    selection = {
        "count": len(rows),
        "by_genre": dict(Counter(r["genre"] for r in rows)),
        "by_route": dict(Counter(r["route_hint"] for r in rows)),
        "by_intensity": dict(Counter(str(r["intensity"]) for r in rows)),
        "ids": [r["id"] for r in rows],
    }
    (out / "selection.json").write_text(json.dumps(selection, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(selection, ensure_ascii=False, indent=2), flush=True)

    modeling_utils.caching_allocator_warmup = lambda *a, **k: None
    teacher_dir = args.teacher_dir.resolve()
    torch.cuda.empty_cache()
    teacher = LLM2Vec.from_pretrained(
        base_model_name_or_path=str(teacher_dir),
        peft_model_name_or_path=str(teacher_dir / "supervised_adapter"),
        torch_dtype=torch.bfloat16,
        device_map="cuda",
    )
    embeddings = np.empty((len(rows), 4096), dtype=np.float32)
    encode_times = []
    for idx, row in enumerate(rows):
        t0 = time.perf_counter()
        with torch.inference_mode():
            emb = teacher.encode(
                [row["canonical_en"]], batch_size=1, show_progress_bar=False,
                convert_to_tensor=True, device="cuda",
            )
        torch.cuda.synchronize()
        encode_times.append(time.perf_counter() - t0)
        embeddings[idx] = emb[0].float().cpu().numpy()
        if (idx + 1) % 25 == 0 or idx + 1 == len(rows):
            print(f"teacher {idx + 1}/{len(rows)}", flush=True)
    del teacher
    gc.collect()
    torch.cuda.empty_cache()

    model = load_model("Kimodo-SOMA-RP-v1.1", device="cuda", text_encoder=DummyTextEncoder())
    export_skeleton = model.skeleton.somaskel77.to("cuda") if isinstance(model.skeleton, SOMASkeleton30) else model.skeleton
    names = export_skeleton.bone_order_names
    root_idx = int(export_skeleton.root_idx)
    left_hand_idx = names.index("LeftHand")
    right_hand_idx = names.index("RightHand")
    head_idx = names.index("Head")

    records = []
    total_start = time.perf_counter()
    for idx, row in enumerate(rows):
        torch.manual_seed(args.seed)
        torch.cuda.manual_seed_all(args.seed)
        text_feat = torch.from_numpy(embeddings[idx]).to(device="cuda", dtype=torch.float32)[None, None, :]
        text_pad_mask = torch.ones((1, 1), dtype=torch.bool, device="cuda")
        motion_pad_mask = torch.ones((1, args.frames), dtype=torch.bool, device="cuda")
        first_heading = torch.zeros((1,), dtype=torch.float32, device="cuda")

        torch.cuda.synchronize()
        t0 = time.perf_counter()
        with torch.inference_mode():
            motion = model._generate(
                texts=[row["canonical_en"]], max_frames=args.frames,
                num_denoising_steps=args.steps, pad_mask=motion_pad_mask,
                first_heading_angle=first_heading, motion_mask=None, observed_motion=None,
                cfg_weight=[2.0, 2.0], text_feat=text_feat,
                text_pad_mask=text_pad_mask, progress_bar=lambda x: x,
            )
            decoded = model.motion_rep.inverse(motion[0], is_normalized=True, return_numpy=False)
            if isinstance(model.skeleton, SOMASkeleton30):
                decoded = model.skeleton.output_to_SOMASkeleton77(decoded)
        torch.cuda.synchronize()
        generation_s = time.perf_counter() - t0

        joints = decoded["posed_joints"].detach().float().cpu().numpy()
        root = decoded["root_positions"].detach().float().cpu().numpy()
        local_rot = decoded["local_rot_mats"].detach().float().cpu().numpy()
        finite = bool(np.isfinite(joints).all() and np.isfinite(root).all() and np.isfinite(local_rot).all())
        root_displacement = float(np.linalg.norm(root[-1] - root[0]))
        rec = {
            **row,
            "frames": args.frames,
            "steps": args.steps,
            "seed": args.seed,
            "teacher_encode_ms": round(encode_times[idx] * 1000, 3),
            "generation_seconds": round(generation_s, 4),
            "finite": finite,
            "root_displacement_m": round(root_displacement, 4),
            "root_path_m": round(path_length(root), 4),
            "left_hand_root_relative_path_m": round(path_length(joints[:, left_hand_idx] - root), 4),
            "right_hand_root_relative_path_m": round(path_length(joints[:, right_hand_idx] - root), 4),
            "head_root_relative_path_m": round(path_length(joints[:, head_idx] - root), 4),
            "mean_root_relative_joint_motion_m_per_frame": round(mean_root_relative_frame_motion(joints, root_idx), 6),
        }
        records.append(rec)
        np.savez_compressed(
            motions_dir / f"{row['id']}.npz",
            posed_joints=joints, root_positions=root, local_rot_mats=local_rot,
        )
        print(
            f"{row['id']} {idx + 1:03d}/{len(rows):03d} {row['genre']} "
            f"route={row['route_hint']} i={row['intensity']} gen={generation_s:.2f}s root={root_displacement:.2f}m",
            flush=True,
        )

    elapsed = time.perf_counter() - total_start
    with (out / "summary.jsonl").open("w", encoding="utf-8") as f:
        for rec in records:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    summary = {
        "count": len(records),
        "frames": args.frames,
        "steps": args.steps,
        "seed": args.seed,
        "total_generation_seconds": round(elapsed, 3),
        "mean_generation_seconds": round(float(np.mean([r["generation_seconds"] for r in records])), 4),
        "all_finite": all(r["finite"] for r in records),
        "by_genre": dict(Counter(r["genre"] for r in records)),
        "output_dir": str(out),
    }
    (out / "run_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
