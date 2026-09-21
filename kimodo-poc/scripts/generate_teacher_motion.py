import argparse
import json
import os
import subprocess
import time
from pathlib import Path

import numpy as np
import torch
import transformers.modeling_utils as modeling_utils
from PIL import Image, ImageDraw
from kimodo import load_model
from kimodo.exports.bvh import save_motion_bvh
from kimodo.exports.motion_io import save_kimodo_npz
from kimodo.model.llm2vec import LLM2Vec
from kimodo.skeleton import SOMASkeleton30, global_rots_to_local_rots


class DummyTextEncoder:
    def __call__(self, texts):
        raise RuntimeError("text encoder should not be called when text_feat is supplied")


def project(points, center, scale, yaw=np.deg2rad(-28.0), pitch=np.deg2rad(8.0)):
    p = points - center[None, :]
    cy, sy = np.cos(yaw), np.sin(yaw)
    cp, sp = np.cos(pitch), np.sin(pitch)
    ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]], dtype=np.float32)
    rx = np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]], dtype=np.float32)
    q = p @ ry.T @ rx.T
    x = q[:, 0] * scale
    y = -q[:, 1] * scale
    return np.stack([x, y], axis=-1)


def render_preview(posed_joints, skeleton, out_dir: Path, ffmpeg: str, fps: int = 30):
    out_dir.mkdir(parents=True, exist_ok=True)
    frames_dir = out_dir / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    parents = skeleton.joint_parents.detach().cpu().numpy().astype(int)
    pts = posed_joints
    root = pts[:, skeleton.root_idx]
    world_center = np.array([
        float((root[:, 0].min() + root[:, 0].max()) * 0.5),
        float(np.percentile(pts[:, :, 1], 45)),
        float((root[:, 2].min() + root[:, 2].max()) * 0.5),
    ], dtype=np.float32)
    span_xz = max(
        float(pts[:, :, 0].max() - pts[:, :, 0].min()),
        float(pts[:, :, 2].max() - pts[:, :, 2].min()),
        2.0,
    )
    height = max(float(pts[:, :, 1].max() - pts[:, :, 1].min()), 1.6)
    scale = min(560.0 / span_xz, 540.0 / height)
    W, H = 960, 720

    for fi, joints in enumerate(pts):
        img = Image.new("RGB", (W, H), (245, 245, 245))
        d = ImageDraw.Draw(img)
        p2 = project(joints, world_center, scale)
        p2[:, 0] += W * 0.5
        p2[:, 1] += H * 0.68

        # ground reference
        d.line((40, int(H * 0.86), W - 40, int(H * 0.86)), fill=(190, 190, 190), width=2)
        for j, parent in enumerate(parents):
            if parent >= 0:
                a = tuple(map(float, p2[parent]))
                b = tuple(map(float, p2[j]))
                d.line((a[0], a[1], b[0], b[1]), fill=(35, 35, 35), width=3)
        for x, y in p2:
            r = 3
            d.ellipse((x-r, y-r, x+r, y+r), fill=(25, 25, 25))
        d.text((20, 18), f"frame {fi:03d}/{len(pts)-1:03d}", fill=(20, 20, 20))
        img.save(frames_dir / f"{fi:04d}.png")

    mp4 = out_dir / "preview.mp4"
    subprocess.run([
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
        "-framerate", str(fps), "-i", str(frames_dir / "%04d.png"),
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", str(mp4)
    ], check=True)
    return mp4


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--checkpoint-root", type=Path, required=True)
    p.add_argument("--teacher-dir", type=Path, required=True)
    p.add_argument("--prompt", required=True)
    p.add_argument("--output-dir", type=Path, required=True)
    p.add_argument("--frames", type=int, default=300)
    p.add_argument("--steps", type=int, default=100)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--ffmpeg", required=True)
    args = p.parse_args()

    if not torch.cuda.is_available():
        raise SystemExit("CUDA unavailable")
    out = args.output_dir.resolve()
    out.mkdir(parents=True, exist_ok=True)
    os.environ["CHECKPOINT_DIR"] = str(args.checkpoint_root.resolve())

    modeling_utils.caching_allocator_warmup = lambda *a, **k: None
    torch.manual_seed(args.seed)
    torch.cuda.manual_seed_all(args.seed)
    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()

    teacher_dir = args.teacher_dir.resolve()
    t0 = time.perf_counter()
    teacher = LLM2Vec.from_pretrained(
        base_model_name_or_path=str(teacher_dir),
        peft_model_name_or_path=str(teacher_dir / "supervised_adapter"),
        torch_dtype=torch.bfloat16,
        device_map="cuda",
    )
    torch.cuda.synchronize()
    teacher_load_s = time.perf_counter() - t0

    t0 = time.perf_counter()
    emb = teacher.encode(
        [args.prompt], batch_size=1, show_progress_bar=False,
        convert_to_tensor=True, device="cuda"
    ).to(dtype=torch.float32, device="cuda")
    torch.cuda.synchronize()
    embed_s = time.perf_counter() - t0

    t0 = time.perf_counter()
    model = load_model("Kimodo-SOMA-RP-v1.1", device="cuda", text_encoder=DummyTextEncoder())
    torch.cuda.synchronize()
    model_load_s = time.perf_counter() - t0

    text_feat = emb[:, None, :]
    text_pad_mask = torch.ones((1, 1), dtype=torch.bool, device="cuda")
    motion_pad_mask = torch.ones((1, args.frames), dtype=torch.bool, device="cuda")
    first_heading = torch.zeros((1,), dtype=torch.float32, device="cuda")

    with torch.inference_mode():
        torch.cuda.synchronize()
        t0 = time.perf_counter()
        motion = model._generate(
            texts=[args.prompt], max_frames=args.frames,
            num_denoising_steps=args.steps, pad_mask=motion_pad_mask,
            first_heading_angle=first_heading, motion_mask=None,
            observed_motion=None, cfg_weight=[2.0, 2.0],
            text_feat=text_feat, text_pad_mask=text_pad_mask,
            progress_bar=lambda x: x,
        )
        torch.cuda.synchronize()
        generation_s = time.perf_counter() - t0

        decoded = model.motion_rep.inverse(motion[0], is_normalized=True, return_numpy=False)
        if isinstance(model.skeleton, SOMASkeleton30):
            decoded = model.skeleton.output_to_SOMASkeleton77(decoded)
            export_skeleton = model.skeleton.somaskel77.to("cuda")
        else:
            export_skeleton = model.skeleton

    npz_path = out / "motion.npz"
    save_kimodo_npz(npz_path, {k: v.detach().cpu().numpy() if torch.is_tensor(v) else v for k, v in decoded.items()})

    joints_pos = decoded["posed_joints"]
    joints_rot = decoded["global_rot_mats"]
    local_rot_mats = global_rots_to_local_rots(joints_rot, export_skeleton)
    root_positions = joints_pos[:, export_skeleton.root_idx, :]
    bvh_path = out / "motion.bvh"
    save_motion_bvh(
        bvh_path, local_rot_mats, root_positions,
        skeleton=export_skeleton, fps=model.fps, standard_tpose=True,
    )

    posed_np = joints_pos.detach().cpu().numpy()
    mp4_path = render_preview(posed_np, export_skeleton, out, args.ffmpeg, fps=int(model.fps))

    meta = {
        "prompt": args.prompt,
        "seed": args.seed,
        "frames": args.frames,
        "fps": float(model.fps),
        "seconds": args.frames / float(model.fps),
        "denoising_steps": args.steps,
        "teacher_load_seconds": round(teacher_load_s, 3),
        "embedding_seconds": round(embed_s, 3),
        "kimodo_load_seconds": round(model_load_s, 3),
        "generation_seconds": round(generation_s, 3),
        "peak_vram_mib": round(torch.cuda.max_memory_allocated() / 1024 / 1024, 1),
        "embedding_norm": float(torch.linalg.vector_norm(emb[0]).item()),
        "files": {"npz": str(npz_path), "bvh": str(bvh_path), "preview": str(mp4_path)},
    }
    (out / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(meta, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
