import argparse
import json
import os
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from transformers import AutoModel, AutoTokenizer

from generate_teacher_motion import DummyTextEncoder, render_preview
from kimodo import load_model
from kimodo.exports.bvh import save_motion_bvh
from kimodo.exports.motion_io import save_kimodo_npz
from kimodo.skeleton import SOMASkeleton30, global_rots_to_local_rots


class QwenInstructionBridge(torch.nn.Module):
    def __init__(self, hidden: int, dropout: float = 0.0) -> None:
        super().__init__()
        self.net = torch.nn.Sequential(
            torch.nn.Linear(1024, hidden),
            torch.nn.GELU(),
            torch.nn.Dropout(dropout),
            torch.nn.Linear(hidden, 1024),
        )
        self.scale = torch.nn.Parameter(torch.tensor(0.1, dtype=torch.float32))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return F.normalize(x + self.scale * self.net(x), p=2, dim=1)


class MotionAdapter(torch.nn.Module):
    def __init__(self, hidden: int, dropout: float = 0.0) -> None:
        super().__init__()
        if hidden <= 0:
            self.net = torch.nn.Linear(1024, 4096)
        else:
            self.net = torch.nn.Sequential(
                torch.nn.Linear(1024, hidden),
                torch.nn.GELU(),
                torch.nn.Dropout(dropout),
                torch.nn.Linear(hidden, 4096),
            )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)


class SpecialistResidual(torch.nn.Module):
    def __init__(self, hidden: int, dropout: float = 0.0) -> None:
        super().__init__()
        self.fc1 = torch.nn.Linear(1024, hidden)
        self.fc2 = torch.nn.Linear(hidden, 4096)
        self.dropout = torch.nn.Dropout(dropout)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.fc2(self.dropout(F.gelu(self.fc1(x))))


def load_reference(path: Path, row_id: str):
    data = np.load(path)
    ids = data["ids"].astype(str)
    matches = np.where(ids == row_id)[0]
    if len(matches) != 1:
        return None
    return torch.from_numpy(data["embeddings"][int(matches[0])].astype(np.float32))


def route_specialist(router_path: Path, qwen_emb: torch.Tensor):
    data = np.load(router_path)
    bank = data["embeddings"].astype(np.float32)
    bank /= np.maximum(np.linalg.norm(bank, axis=1, keepdims=True), 1e-8)
    labels = data["labels"].astype(str)
    k = int(data["k"][0]) if "k" in data else 7
    query = qwen_emb.detach().float().cpu().numpy()[0]
    query /= max(float(np.linalg.norm(query)), 1e-8)
    sims = bank @ query
    top = np.argpartition(sims, -k)[-k:]
    votes, counts = np.unique(labels[top], return_counts=True)
    best_i = int(np.argmax(counts))
    label = str(votes[best_i])
    count = int(counts[best_i])
    # A strict majority is required. Ambiguous routes fall back to generic.
    if count <= k // 2:
        label = "generic"
    return label, count, k


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--checkpoint-root", type=Path, required=True)
    p.add_argument("--qwen-dir", type=Path, required=True)
    p.add_argument("--adapter", type=Path, required=True)
    p.add_argument("--prompt", required=True)
    p.add_argument("--output-dir", type=Path, required=True)
    p.add_argument("--frames", type=int, default=300)
    p.add_argument("--steps", type=int, default=100)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--ffmpeg", required=True)
    p.add_argument("--teacher-reference", type=Path)
    p.add_argument("--reference-id", default="target_ja_walk_wave")
    p.add_argument("--instruction", default="")
    p.add_argument("--bridge", type=Path)
    p.add_argument("--residual", type=Path)
    p.add_argument("--router", type=Path)
    p.add_argument("--specialist-dir", type=Path)
    args = p.parse_args()

    if not torch.cuda.is_available():
        raise SystemExit("CUDA unavailable")

    out = args.output_dir.resolve()
    out.mkdir(parents=True, exist_ok=True)
    os.environ["CHECKPOINT_DIR"] = str(args.checkpoint_root.resolve())

    torch.manual_seed(args.seed)
    torch.cuda.manual_seed_all(args.seed)
    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()

    # Qwen3-Embedding: local Safetensors only, remote code disabled.
    qwen_dir = args.qwen_dir.resolve()
    t0 = time.perf_counter()
    tokenizer = AutoTokenizer.from_pretrained(
        str(qwen_dir), local_files_only=True, trust_remote_code=False, padding_side="left"
    )
    qwen = AutoModel.from_pretrained(
        str(qwen_dir), local_files_only=True, trust_remote_code=False, use_safetensors=True
    ).to("cuda").eval()
    torch.cuda.synchronize()
    qwen_load_s = time.perf_counter() - t0

    t0 = time.perf_counter()
    qwen_text = args.prompt
    if args.instruction:
        qwen_text = f"Instruct: {args.instruction}\nQuery:{qwen_text}"
    tokens = tokenizer(qwen_text, return_tensors="pt", truncation=True, max_length=256).to("cuda")
    with torch.inference_mode():
        hidden = qwen(**tokens).last_hidden_state
        qwen_emb = F.normalize(hidden[:, -1], p=2, dim=1).float()
    torch.cuda.synchronize()
    qwen_embed_s = time.perf_counter() - t0

    selected_specialist = None
    route_votes = None
    if args.router and not args.residual:
        routed, vote_count, vote_k = route_specialist(args.router.resolve(), qwen_emb)
        route_votes = f"{vote_count}/{vote_k}"
        if routed != "generic":
            if not args.specialist_dir:
                raise SystemExit("--specialist-dir is required when --router selects a specialist")
            candidate = args.specialist_dir.resolve() / f"residual_{routed}_h256.pt"
            if not candidate.exists():
                raise SystemExit(f"Specialist checkpoint not found: {candidate}")
            args.residual = candidate
            selected_specialist = routed
        else:
            selected_specialist = "generic"
    elif args.residual:
        selected_specialist = args.residual.stem

    bridge = None
    if args.bridge:
        bck = torch.load(args.bridge.resolve(), map_location="cpu", weights_only=False)
        bridge = QwenInstructionBridge(int(bck["hidden"]), float(bck.get("dropout", 0.0))).to("cuda").eval()
        bridge.load_state_dict(bck["state_dict"])

    checkpoint = torch.load(args.adapter.resolve(), map_location="cpu", weights_only=False)
    adapter = MotionAdapter(int(checkpoint["hidden"]), float(checkpoint.get("dropout", 0.0))).to("cuda").eval()
    adapter.load_state_dict(checkpoint["state_dict"])
    teacher_mean = torch.as_tensor(checkpoint["teacher_mean"], dtype=torch.float32, device="cuda")
    teacher_std = torch.as_tensor(checkpoint["teacher_std"], dtype=torch.float32, device="cuda")

    residual = None
    if args.residual:
        rck = torch.load(args.residual.resolve(), map_location="cpu", weights_only=False)
        residual = SpecialistResidual(int(rck["hidden"]), float(rck.get("dropout", 0.0))).to("cuda").eval()
        residual.load_state_dict(rck["state_dict"])

    t0 = time.perf_counter()
    with torch.inference_mode():
        adapter_input = bridge(qwen_emb) if bridge is not None else qwen_emb
        pred_z = adapter(adapter_input)
        if residual is not None:
            pred_z = pred_z + residual(adapter_input)
        emb = pred_z * teacher_std + teacher_mean
    torch.cuda.synchronize()
    adapter_s = time.perf_counter() - t0

    cosine_to_teacher = None
    if args.teacher_reference:
        ref = load_reference(args.teacher_reference.resolve(), args.reference_id)
        if ref is not None:
            cosine_to_teacher = float(F.cosine_similarity(emb.cpu(), ref[None, :], dim=1).item())

    embedding_norm = float(torch.linalg.vector_norm(emb[0]).item())
    peak_after_embedding = torch.cuda.max_memory_allocated() / 1024 / 1024

    # Qwen and adapter are only needed for conditioning. Release them before
    # loading Kimodo so the two models do not need to coexist on VRAM.
    emb = emb.detach().cpu()
    del hidden, tokens, qwen_emb, adapter_input, qwen, tokenizer, adapter, teacher_mean, teacher_std, checkpoint
    if bridge is not None:
        del bridge
    if residual is not None:
        del residual
    torch.cuda.empty_cache()

    t0 = time.perf_counter()
    model = load_model("Kimodo-SOMA-RP-v1.1", device="cuda", text_encoder=DummyTextEncoder())
    torch.cuda.synchronize()
    kimodo_load_s = time.perf_counter() - t0

    emb = emb.to("cuda")
    text_feat = emb[:, None, :]
    text_pad_mask = torch.ones((1, 1), dtype=torch.bool, device="cuda")
    motion_pad_mask = torch.ones((1, args.frames), dtype=torch.bool, device="cuda")
    first_heading = torch.zeros((1,), dtype=torch.float32, device="cuda")

    with torch.inference_mode():
        torch.manual_seed(args.seed)
        torch.cuda.manual_seed_all(args.seed)
        torch.cuda.synchronize()
        t0 = time.perf_counter()
        motion = model._generate(
            texts=[args.prompt],
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
        generation_s = time.perf_counter() - t0

        decoded = model.motion_rep.inverse(motion[0], is_normalized=True, return_numpy=False)
        if isinstance(model.skeleton, SOMASkeleton30):
            decoded = model.skeleton.output_to_SOMASkeleton77(decoded)
            export_skeleton = model.skeleton.somaskel77.to("cuda")
        else:
            export_skeleton = model.skeleton

    npz_path = out / "motion.npz"
    save_kimodo_npz(
        npz_path,
        {k: v.detach().cpu().numpy() if torch.is_tensor(v) else v for k, v in decoded.items()},
    )

    joints_pos = decoded["posed_joints"]
    joints_rot = decoded["global_rot_mats"]
    local_rot_mats = global_rots_to_local_rots(joints_rot, export_skeleton)
    root_positions = joints_pos[:, export_skeleton.root_idx, :]
    bvh_path = out / "motion.bvh"
    save_motion_bvh(
        bvh_path,
        local_rot_mats,
        root_positions,
        skeleton=export_skeleton,
        fps=model.fps,
        standard_tpose=True,
    )

    posed_np = joints_pos.detach().cpu().numpy()
    mp4_path = render_preview(posed_np, export_skeleton, out, args.ffmpeg, fps=int(model.fps))

    root = posed_np[:, export_skeleton.root_idx]
    root_displacement = float(np.linalg.norm(root[-1] - root[0]))
    root_path = float(np.linalg.norm(np.diff(root, axis=0), axis=1).sum())

    meta = {
        "pipeline": "Qwen3-Embedding-0.6B -> distilled adapter -> Kimodo-SOMA-RP-v1.1",
        "prompt": args.prompt,
        "seed": args.seed,
        "frames": args.frames,
        "fps": float(model.fps),
        "seconds": args.frames / float(model.fps),
        "denoising_steps": args.steps,
        "qwen_load_seconds": round(qwen_load_s, 3),
        "qwen_embedding_seconds": round(qwen_embed_s, 4),
        "adapter_seconds": round(adapter_s, 5),
        "kimodo_load_seconds": round(kimodo_load_s, 3),
        "generation_seconds": round(generation_s, 3),
        "peak_embedding_stage_vram_mib": round(peak_after_embedding, 1),
        "peak_process_vram_mib": round(torch.cuda.max_memory_allocated() / 1024 / 1024, 1),
        "embedding_norm": embedding_norm,
        "cosine_to_english_teacher_reference": cosine_to_teacher,
        "selected_specialist": selected_specialist,
        "route_votes": route_votes,
        "root_displacement_m": round(root_displacement, 4),
        "root_path_m": round(root_path, 4),
        "files": {"npz": str(npz_path), "bvh": str(bvh_path), "preview": str(mp4_path)},
    }
    (out / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(meta, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
