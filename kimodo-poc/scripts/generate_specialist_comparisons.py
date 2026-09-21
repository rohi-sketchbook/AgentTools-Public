import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from kimodo import load_model
from kimodo.exports.motion_io import save_kimodo_npz
from kimodo.skeleton import SOMASkeleton30

sys.path.insert(0, str((Path(__file__).resolve().parents[1] / "adapter").resolve()))
from train_qwen_instruction_bridge import QwenInstructionBridge
from train_specialist_residual import MotionAdapter, SpecialistResidual
from generate_teacher_motion import DummyTextEncoder, render_preview

GENRES = ["glamour_editorial", "idol_cute", "runway_fashion", "dynamic_cute_dance", "bold_sensual"]


def choose_rows(rows):
    chosen = []
    for genre in GENRES:
        matches = [r for r in rows if r.get("genre") == genre and r.get("split") == "val" and r.get("paraphrase_variant") == 0]
        if not matches:
            raise RuntimeError(f"No held-out p00 row for {genre}")
        chosen.append(matches[0])
    return chosen


def generate(model, emb, prompt, frames, steps, seed):
    device = emb.device
    mask = torch.ones((1, frames), dtype=torch.bool, device=device)
    text_pad = torch.ones((1, 1), dtype=torch.bool, device=device)
    heading = torch.zeros((1,), dtype=torch.float32, device=device)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    with torch.inference_mode():
        motion = model._generate(
            texts=[prompt], max_frames=frames, num_denoising_steps=steps,
            pad_mask=mask, first_heading_angle=heading, motion_mask=None,
            observed_motion=None, cfg_weight=[2.0, 2.0],
            text_feat=emb[:, None, :], text_pad_mask=text_pad, progress_bar=lambda x: x,
        )
        decoded = model.motion_rep.inverse(motion[0], is_normalized=True, return_numpy=False)
        if isinstance(model.skeleton, SOMASkeleton30):
            decoded = model.skeleton.output_to_SOMASkeleton77(decoded)
            skeleton = model.skeleton.somaskel77.to(device)
        else:
            skeleton = model.skeleton
    return decoded, skeleton


def montage_triplet(ffmpeg, base, expert, teacher, out):
    subprocess.run([
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(base), "-i", str(expert), "-i", str(teacher),
        "-filter_complex", "[0:v]scale=480:360[v0];[1:v]scale=480:360[v1];[2:v]scale=480:360[v2];[v0][v1][v2]hstack=inputs=3[outv]",
        "-map", "[outv]", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "22", str(out),
    ], check=True)


def montage_all(ffmpeg, videos, out):
    cmd = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error"]
    for v in videos:
        cmd += ["-i", str(v)]
    ins = "".join(f"[{i}:v]" for i in range(len(videos)))
    cmd += ["-filter_complex", f"{ins}vstack=inputs={len(videos)}[outv]", "-map", "[outv]", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", str(out)]
    subprocess.run(cmd, check=True)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--pairs", type=Path, required=True)
    p.add_argument("--qwen", type=Path, required=True)
    p.add_argument("--teacher", type=Path, required=True)
    p.add_argument("--bridge", type=Path, required=True)
    p.add_argument("--base-adapter", type=Path, required=True)
    p.add_argument("--checkpoint-dir", type=Path, required=True)
    p.add_argument("--checkpoint-root", type=Path, required=True)
    p.add_argument("--output-dir", type=Path, required=True)
    p.add_argument("--frames", type=int, default=120)
    p.add_argument("--steps", type=int, default=100)
    p.add_argument("--seed", type=int, default=20260825)
    args = p.parse_args()

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise SystemExit("ffmpeg not found")
    os.environ["CHECKPOINT_DIR"] = str(args.checkpoint_root.resolve())
    out = args.output_dir.resolve()
    out.mkdir(parents=True, exist_ok=True)

    rows = [json.loads(x) for x in args.pairs.read_text(encoding="utf-8").splitlines() if x.strip()]
    chosen = choose_rows(rows)
    q = np.load(args.qwen)
    t = np.load(args.teacher)
    ids = q["ids"].astype(str)
    id_to_idx = {rid: i for i, rid in enumerate(ids)}

    device = torch.device("cuda")
    bck = torch.load(args.bridge, map_location="cpu", weights_only=False)
    bridge = QwenInstructionBridge(int(bck["hidden"]), float(bck.get("dropout", 0.0))).to(device).eval()
    bridge.load_state_dict(bck["state_dict"])
    ack = torch.load(args.base_adapter, map_location="cpu", weights_only=False)
    base = MotionAdapter(int(ack["hidden"]), float(ack.get("dropout", 0.0))).to(device).eval()
    base.load_state_dict(ack["state_dict"])
    mean = torch.as_tensor(ack["teacher_mean"], dtype=torch.float32, device=device)
    std = torch.as_tensor(ack["teacher_std"], dtype=torch.float32, device=device)

    experts = {}
    for genre in GENRES:
        ck = torch.load(args.checkpoint_dir / f"residual_{genre}_h128.pt", map_location="cpu", weights_only=False)
        expert = SpecialistResidual(int(ck["hidden"]), float(ck.get("dropout", 0.0))).to(device).eval()
        expert.load_state_dict(ck["state_dict"])
        experts[genre] = expert

    model = load_model("Kimodo-SOMA-RP-v1.1", device="cuda", text_encoder=DummyTextEncoder())
    results = []
    triplet_videos = []

    for row in chosen:
        genre = row["genre"]
        idx = id_to_idx[row["id"]]
        x0 = F.normalize(torch.from_numpy(q["embeddings"][idx:idx+1].astype(np.float32)).to(device), p=2, dim=1)
        teacher_emb = torch.from_numpy(t["embeddings"][idx:idx+1].astype(np.float32)).to(device)
        with torch.inference_mode():
            x = bridge(x0)
            base_z = base(x)
            base_emb = base_z * std + mean
            residual_z = experts[genre](x)
            expert_emb = (base_z + residual_z) * std + mean
        base_cos = float(F.cosine_similarity(base_emb, teacher_emb, dim=1).item())
        expert_cos = float(F.cosine_similarity(expert_emb, teacher_emb, dim=1).item())

        row_dir = out / row["id"]
        row_dir.mkdir(parents=True, exist_ok=True)
        previews = {}
        decoded_map = {}
        for label, emb in [("base", base_emb), ("expert", expert_emb), ("teacher", teacher_emb)]:
            decoded, skeleton = generate(model, emb, row["ja"], args.frames, args.steps, args.seed)
            label_dir = row_dir / label
            label_dir.mkdir(parents=True, exist_ok=True)
            save_kimodo_npz(label_dir / "motion.npz", {k: v.detach().cpu().numpy() if torch.is_tensor(v) else v for k, v in decoded.items()})
            preview = render_preview(decoded["posed_joints"].detach().cpu().numpy(), skeleton, label_dir, ffmpeg, fps=int(model.fps))
            previews[label] = preview
            decoded_map[label] = decoded["posed_joints"].detach().cpu().numpy()

        triplet = row_dir / "base_expert_teacher.mp4"
        montage_triplet(ffmpeg, previews["base"], previews["expert"], previews["teacher"], triplet)
        triplet_videos.append(triplet)
        root_idx = int(skeleton.root_idx)
        teacher_j = decoded_map["teacher"]
        def motion_diff(a):
            n = min(len(a), len(teacher_j))
            aa = a[:n] - a[:n, root_idx:root_idx+1]
            tt = teacher_j[:n] - teacher_j[:n, root_idx:root_idx+1]
            return float(np.sqrt(np.mean((aa - tt) ** 2)))
        results.append({
            "id": row["id"], "base_id": row["base_id"], "genre": genre,
            "ja": row["ja"], "canonical_en": row["en"],
            "embedding_cos_base": base_cos, "embedding_cos_expert": expert_cos,
            "pose_rms_to_teacher_base_m": motion_diff(decoded_map["base"]),
            "pose_rms_to_teacher_expert_m": motion_diff(decoded_map["expert"]),
            "triplet_video": str(triplet),
        })

    all_video = out / "all_genres_base_expert_teacher.mp4"
    montage_all(ffmpeg, triplet_videos, all_video)
    report = {"frames": args.frames, "steps": args.steps, "seed": args.seed, "rows": results, "montage": str(all_video)}
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
