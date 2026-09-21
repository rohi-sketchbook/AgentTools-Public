# -*- coding: shift_jis -*-
import argparse
import json
import os
import shutil
import sys
import time
from pathlib import Path

import numpy as np
import torch
from kimodo import load_model
from kimodo.exports.bvh import save_motion_bvh
from kimodo.exports.motion_io import save_kimodo_npz
from kimodo.skeleton import SOMASkeleton30, global_rots_to_local_rots

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str((ROOT / "adapter").resolve()))
sys.path.insert(0, str((ROOT / "scripts").resolve()))
from routed_text_encoder import RoutedQwenTextEncoder
from plan_motion_sequence import plan
from generate_teacher_motion import render_preview


def squeeze_batch(output: dict) -> dict:
    squeezed = {}
    for key, value in output.items():
        if torch.is_tensor(value) and value.ndim >= 1 and value.shape[0] == 1:
            squeezed[key] = value[0]
        else:
            squeezed[key] = value
    return squeezed


def continuity_metrics(posed_joints: np.ndarray, frame_counts: list[int], root_idx: int) -> dict:
    if len(posed_joints) < 2:
        return {"median_frame_pose_delta_m": 0.0, "boundaries": []}
    rel = posed_joints - posed_joints[:, root_idx:root_idx + 1, :]
    deltas = np.sqrt(np.mean((rel[1:] - rel[:-1]) ** 2, axis=(1, 2)))
    root_deltas = np.linalg.norm(posed_joints[1:, root_idx] - posed_joints[:-1, root_idx], axis=1)
    median_pose = float(np.median(deltas))
    median_root = float(np.median(root_deltas))
    boundaries = []
    cursor = 0
    for i, count in enumerate(frame_counts[:-1]):
        cursor += count
        idx = min(max(cursor - 1, 0), len(deltas) - 1)
        boundaries.append({
            "between_clip": [i, i + 1],
            "frame": cursor,
            "pose_delta_m": float(deltas[idx]),
            "pose_delta_vs_median": float(deltas[idx] / max(median_pose, 1e-8)),
            "root_delta_m": float(root_deltas[idx]),
            "root_delta_vs_median": float(root_deltas[idx] / max(median_root, 1e-8)),
        })
    return {
        "median_frame_pose_delta_m": median_pose,
        "median_frame_root_delta_m": median_root,
        "max_frame_pose_delta_m": float(deltas.max()),
        "boundaries": boundaries,
    }


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--prompt", required=True)
    p.add_argument("--checkpoint-root", type=Path, required=True)
    p.add_argument("--qwen-dir", type=Path, required=True)
    p.add_argument("--bridge", type=Path, required=True)
    p.add_argument("--base-adapter", type=Path, required=True)
    p.add_argument("--router", type=Path, required=True)
    p.add_argument("--expert-dir", type=Path, required=True)
    p.add_argument("--anchor-residual", type=Path, default=Path("adapter/checkpoints/promoted_anchor_residual_h128.pt"))
    p.add_argument("--anchor-gate", type=Path, default=Path("adapter/checkpoints/promoted_anchor_gate_h64.pt"))
    p.add_argument("--anchor-gate-threshold", type=float, default=0.80)
    p.add_argument("--output-dir", type=Path, required=True)
    p.add_argument("--steps", type=int, default=100)
    p.add_argument("--threshold", type=float, default=0.80)
    p.add_argument("--transition-frames", type=int, default=5)
    p.add_argument("--seed", type=int, default=20260825)
    p.add_argument("--ffmpeg", default="")
    args = p.parse_args()

    if not torch.cuda.is_available():
        raise SystemExit("CUDA unavailable")
    ffmpeg = args.ffmpeg or shutil.which("ffmpeg")
    if not ffmpeg:
        raise SystemExit("ffmpeg not found")
    if args.transition_frames < 1:
        raise SystemExit("transition frames must be >= 1")

    out_dir = args.output_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    os.environ["CHECKPOINT_DIR"] = str(args.checkpoint_root.resolve())
    motion_plan = plan(args.prompt)
    clip_prompts = [clip["prompt"] for clip in motion_plan["clips"]]
    if motion_plan.get("mode") != "single_vac" or len(clip_prompts) != 1:
        raise RuntimeError("AI motion generation must produce exactly one VAC per request")
    frame_counts = [max(30, int(round(float(clip["duration_seconds"]) * 30.0))) for clip in motion_plan["clips"]]

    torch.manual_seed(args.seed)
    torch.cuda.manual_seed_all(args.seed)
    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()

    t0 = time.perf_counter()
    encoder = RoutedQwenTextEncoder(
        qwen_dir=args.qwen_dir,
        bridge_path=args.bridge,
        base_adapter_path=args.base_adapter,
        router_path=args.router,
        expert_dir=args.expert_dir,
        anchor_residual_path=args.anchor_residual,
        anchor_gate_path=args.anchor_gate,
        anchor_gate_threshold=args.anchor_gate_threshold,
        device="cuda",
        threshold=args.threshold,
    )
    encoder_load_s = time.perf_counter() - t0

    t0 = time.perf_counter()
    model = load_model("Kimodo-SOMA-RP-v1.1", device="cuda", text_encoder=encoder)
    torch.cuda.synchronize()
    kimodo_load_s = time.perf_counter() - t0

    encoder.clear_route_history()
    torch.manual_seed(args.seed)
    torch.cuda.manual_seed_all(args.seed)
    torch.cuda.synchronize()
    t0 = time.perf_counter()
    output = model(
        prompts=clip_prompts,
        num_frames=frame_counts,
        num_denoising_steps=args.steps,
        multi_prompt=True,
        num_samples=1,
        num_transition_frames=args.transition_frames,
        cfg_weight=[2.0, 2.0],
        post_processing=False,
        return_numpy=False,
        progress_bar=lambda x: x,
    )
    torch.cuda.synchronize()
    generation_s = time.perf_counter() - t0
    output = squeeze_batch(output)

    if isinstance(model.skeleton, SOMASkeleton30):
        skeleton = model.skeleton.somaskel77.to("cuda")
    else:
        skeleton = model.skeleton

    npz_path = out_dir / "motion.npz"
    save_kimodo_npz(npz_path, {k: v.detach().cpu().numpy() if torch.is_tensor(v) else v for k, v in output.items()})

    joints_pos = output["posed_joints"]
    joints_rot = output["global_rot_mats"]
    local_rot = global_rots_to_local_rots(joints_rot, skeleton)
    root_positions = joints_pos[:, skeleton.root_idx, :]
    bvh_path = out_dir / "motion.bvh"
    save_motion_bvh(bvh_path, local_rot, root_positions, skeleton=skeleton, fps=model.fps, standard_tpose=True)
    preview = render_preview(joints_pos.detach().cpu().numpy(), skeleton, out_dir, ffmpeg, fps=int(model.fps))

    posed_np = joints_pos.detach().cpu().numpy()
    continuity = continuity_metrics(posed_np, frame_counts, int(skeleton.root_idx))
    for i, clip in enumerate(motion_plan["clips"]):
        clip["frames"] = frame_counts[i]
        if i < len(encoder.route_history):
            clip["route"] = encoder.route_history[i]

    motion_plan["transition_frames"] = args.transition_frames
    motion_plan["total_frames"] = int(len(posed_np))
    motion_plan["fps"] = float(model.fps)
    motion_plan["total_seconds"] = float(len(posed_np) / float(model.fps))
    (out_dir / "motion_plan.json").write_text(json.dumps(motion_plan, ensure_ascii=False, indent=2), encoding="utf-8")

    meta = {
        "source_prompt": args.prompt,
        "plan_mode": motion_plan["mode"],
        "clip_count": len(clip_prompts),
        "clip_prompts": clip_prompts,
        "frame_counts": frame_counts,
        "transition_frames": args.transition_frames,
        "routes": encoder.route_history,
        "encoder_load_seconds": round(encoder_load_s, 3),
        "kimodo_load_seconds": round(kimodo_load_s, 3),
        "generation_seconds": round(generation_s, 3),
        "peak_vram_mib": round(torch.cuda.max_memory_allocated() / 1024 / 1024, 1),
        "continuity": continuity,
        "files": {"npz": str(npz_path), "bvh": str(bvh_path), "preview": str(preview), "plan": str(out_dir / "motion_plan.json")},
    }
    (out_dir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(meta, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
