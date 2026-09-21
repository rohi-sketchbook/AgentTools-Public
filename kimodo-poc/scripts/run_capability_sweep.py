# -*- coding: shift_jis -*-
import argparse
import csv
import gc
import json
import os
import time
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


def load_capability_rows(db_dir: Path, input_tsv: Path | None = None):
    if input_tsv is not None:
        with input_tsv.open(encoding="utf-8", newline="") as f:
            rows = list(csv.DictReader(f, delimiter="\t"))
        for row in rows:
            if not row.get("en") and row.get("canonical_en"):
                row["en"] = row["canonical_en"]
        return rows

    files = [
        "capability_glamour_25.tsv",
        "capability_idol_25.tsv",
        "capability_runway_25.tsv",
        "capability_dynamic_25.tsv",
    ]
    rows = []
    for name in files:
        with (db_dir / name).open(encoding="utf-8", newline="") as f:
            rows.extend(csv.DictReader(f, delimiter="\t"))
    return rows


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


def horizontal_path_length(points: np.ndarray) -> float:
    if len(points) < 2:
        return 0.0
    horizontal = points[:, [0, 2]]
    return float(np.linalg.norm(np.diff(horizontal, axis=0), axis=-1).sum())


def horizontal_speed_stats(points: np.ndarray, fps: float) -> tuple[float, float, float]:
    if len(points) < 2:
        return 0.0, 0.0, 0.0
    horizontal = points[:, [0, 2]]
    speed = np.linalg.norm(np.diff(horizontal, axis=0), axis=-1) * fps
    window = max(1, min(10, len(speed)))
    return float(speed[:window].mean()), float(speed[-window:].mean()), float(speed.max())


def heading_change_deg(joints: np.ndarray, left_shoulder_idx: int, right_shoulder_idx: int) -> float:
    if len(joints) < 2:
        return 0.0

    def heading(frame: np.ndarray) -> float:
        shoulder_axis = frame[right_shoulder_idx] - frame[left_shoulder_idx]
        horizontal = shoulder_axis[[0, 2]]
        norm = float(np.linalg.norm(horizontal))
        if norm < 1e-8:
            return 0.0
        # Shoulder axis points across the body; rotate 90 degrees in XZ to obtain forward.
        forward_x = -horizontal[1] / norm
        forward_z = horizontal[0] / norm
        return float(np.degrees(np.arctan2(forward_x, forward_z)))

    start = heading(joints[0])
    end = heading(joints[-1])
    delta = (end - start + 180.0) % 360.0 - 180.0
    return abs(float(delta))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--db-dir", type=Path, default=Path("motion_prompt_db"))
    p.add_argument("--checkpoint-root", type=Path, default=Path("models"))
    p.add_argument("--teacher-dir", type=Path, default=Path("models/kimodo-llm2vec-nf4"))
    p.add_argument("--output-dir", type=Path, default=Path("results/capability-sweep-100"))
    p.add_argument("--input-tsv", type=Path, help="Optional TSV with id and en/canonical_en columns")
    p.add_argument("--priority", choices=("high", "medium", "low"), help="Filter custom TSV by priority")
    p.add_argument("--route-hint", help="Filter custom TSV by route_hint")
    p.add_argument("--frames", type=int, default=120)
    p.add_argument("--steps", type=int, default=25)
    p.add_argument("--seed", type=int, default=20260825)
    p.add_argument("--ids", nargs="*", default=None, help="Optional capability IDs to run; default is all 100")
    args = p.parse_args()

    if not torch.cuda.is_available():
        raise SystemExit("CUDA unavailable")

    input_tsv = args.input_tsv.resolve() if args.input_tsv else None
    rows = load_capability_rows(args.db_dir, input_tsv)
    if input_tsv is None and len(rows) != 100:
        raise SystemExit(f"Expected 100 capability rows in DB, got {len(rows)}")
    if args.priority:
        rows = [row for row in rows if row.get("priority") == args.priority]
    if args.route_hint:
        rows = [row for row in rows if row.get("route_hint") == args.route_hint]
    if not rows:
        raise SystemExit("No capability rows matched the requested filters")
    missing_prompt = [row.get("id", "<missing-id>") for row in rows if not row.get("en")]
    if missing_prompt:
        raise SystemExit(f"Rows missing en/canonical_en prompt: {missing_prompt}")
    if args.ids:
        wanted = set(args.ids)
        rows = [row for row in rows if row["id"] in wanted]
        missing = sorted(wanted - {row["id"] for row in rows})
        if missing:
            raise SystemExit(f"Unknown capability IDs: {missing}")

    out = args.output_dir.resolve()
    motions_dir = out / "motions"
    motions_dir.mkdir(parents=True, exist_ok=True)
    os.environ["CHECKPOINT_DIR"] = str(args.checkpoint_root.resolve())

    # Known transformers 5.x / pre-quantized NF4 allocator-warmup incompatibility.
    modeling_utils.caching_allocator_warmup = lambda *a, **k: None

    # Phase 1: encode all canonical English prompts with the teacher once, then unload it.
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
                [row["en"]],
                batch_size=1,
                show_progress_bar=False,
                convert_to_tensor=True,
                device="cuda",
            )
        torch.cuda.synchronize()
        encode_times.append(time.perf_counter() - t0)
        embeddings[idx] = emb[0].float().cpu().numpy()
        if (idx + 1) % 20 == 0:
            print(f"teacher {idx + 1}/{len(rows)}", flush=True)
    del teacher
    gc.collect()
    torch.cuda.empty_cache()

    # Phase 2: motion-only Kimodo on CUDA. Reset the same diffusion seed per row so
    # semantic differences are not obscured by different initial noise.
    model = load_model("Kimodo-SOMA-RP-v1.1", device="cuda", text_encoder=DummyTextEncoder())
    if isinstance(model.skeleton, SOMASkeleton30):
        export_skeleton = model.skeleton.somaskel77.to("cuda")
    else:
        export_skeleton = model.skeleton
    names = export_skeleton.bone_order_names
    root_idx = int(export_skeleton.root_idx)
    left_hand_idx = names.index("LeftHand")
    right_hand_idx = names.index("RightHand")
    head_idx = names.index("Head")
    left_shoulder_idx = names.index("LeftShoulder")
    right_shoulder_idx = names.index("RightShoulder")

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
                texts=[row["en"]],
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
        root_path = path_length(root)
        root_horizontal_displacement = float(np.linalg.norm((root[-1] - root[0])[[0, 2]]))
        root_horizontal_path = horizontal_path_length(root)
        root_vertical_range = float(np.ptp(root[:, 1]))
        root_start_speed, root_end_speed, root_peak_speed = horizontal_speed_stats(root, fps=30.0)
        body_heading_change = heading_change_deg(joints, left_shoulder_idx, right_shoulder_idx)
        left_hand_path = path_length(joints[:, left_hand_idx] - root)
        right_hand_path = path_length(joints[:, right_hand_idx] - root)
        head_path = path_length(joints[:, head_idx] - root)
        joint_frame_motion = mean_root_relative_frame_motion(joints, root_idx)

        np.savez_compressed(
            motions_dir / f"{row['id']}.npz",
            posed_joints=joints,
            root_positions=root,
            local_rot_mats=local_rot,
        )
        rec = {
            **row,
            "frames": args.frames,
            "steps": args.steps,
            "seed": args.seed,
            "teacher_encode_ms": round(encode_times[idx] * 1000, 3),
            "generation_seconds": round(generation_s, 4),
            "finite": finite,
            "root_displacement_m": round(root_displacement, 4),
            "root_path_m": round(root_path, 4),
            "root_horizontal_displacement_m": round(root_horizontal_displacement, 4),
            "root_horizontal_path_m": round(root_horizontal_path, 4),
            "root_vertical_range_m": round(root_vertical_range, 4),
            "root_start_horizontal_speed_mps": round(root_start_speed, 4),
            "root_end_horizontal_speed_mps": round(root_end_speed, 4),
            "root_peak_horizontal_speed_mps": round(root_peak_speed, 4),
            "body_heading_change_deg": round(body_heading_change, 2),
            "left_hand_root_relative_path_m": round(left_hand_path, 4),
            "right_hand_root_relative_path_m": round(right_hand_path, 4),
            "head_root_relative_path_m": round(head_path, 4),
            "mean_root_relative_joint_motion_m_per_frame": round(joint_frame_motion, 6),
        }
        records.append(rec)
        print(
            f"{row['id']} {idx + 1:03d}/{len(rows):03d} gen={generation_s:.2f}s "
            f"root={root_displacement:.2f}m hands=({left_hand_path:.2f},{right_hand_path:.2f})",
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
        "output_dir": str(out),
    }
    (out / "run_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
