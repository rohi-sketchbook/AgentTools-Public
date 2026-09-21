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
import torch.nn.functional as F
from transformers import AutoModel, AutoTokenizer
from kimodo import load_model
from kimodo.exports.bvh import save_motion_bvh
from kimodo.exports.motion_io import save_kimodo_npz
from kimodo.skeleton import SOMASkeleton30, global_rots_to_local_rots

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str((ROOT / "adapter").resolve()))
from train_qwen_instruction_bridge import QwenInstructionBridge
from train_specialist_residual import MotionAdapter, SpecialistResidual
from train_domain_router import DomainRouter, CLASSES
from routed_text_encoder import PromotedAnchorGate
from generate_teacher_motion import DummyTextEncoder, render_preview

DEFAULT_INSTRUCTION = "Map Japanese human motion descriptions into a semantic space for full-body motion generation."
SPECIALIST_GENRES = {"glamour_editorial", "idol_cute", "runway_fashion", "dynamic_cute_dance", "bold_sensual"}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--checkpoint-root", type=Path, required=True)
    p.add_argument("--qwen-dir", type=Path, required=True)
    p.add_argument("--bridge", type=Path, required=True)
    p.add_argument("--base-adapter", type=Path, required=True)
    p.add_argument("--router", type=Path, required=True)
    p.add_argument("--expert-dir", type=Path, required=True)
    p.add_argument("--anchor-residual", type=Path, default=Path("adapter/checkpoints/promoted_anchor_residual_h128.pt"))
    p.add_argument("--anchor-gate", type=Path, default=Path("adapter/checkpoints/promoted_anchor_gate_h64.pt"))
    p.add_argument("--anchor-gate-threshold", type=float, default=0.80)
    p.add_argument("--prompt", required=True)
    p.add_argument("--output-dir", type=Path, required=True)
    p.add_argument("--frames", type=int, default=120)
    p.add_argument("--steps", type=int, default=100)
    p.add_argument("--seed", type=int, default=20260825)
    p.add_argument("--threshold", type=float, default=0.80)
    p.add_argument("--instruction", default=DEFAULT_INSTRUCTION)
    p.add_argument("--force-domain", choices=CLASSES)
    p.add_argument("--embedding-only", action="store_true")
    p.add_argument("--ffmpeg", default="")
    args = p.parse_args()

    if not torch.cuda.is_available():
        raise SystemExit("CUDA unavailable")
    ffmpeg = args.ffmpeg or shutil.which("ffmpeg")
    if not args.embedding_only and not ffmpeg:
        raise SystemExit("ffmpeg not found")

    out = args.output_dir.resolve()
    out.mkdir(parents=True, exist_ok=True)
    os.environ["CHECKPOINT_DIR"] = str(args.checkpoint_root.resolve())
    device = torch.device("cuda")
    torch.manual_seed(args.seed)
    torch.cuda.manual_seed_all(args.seed)
    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()

    # Reproducible current Qwen query space.
    t0 = time.perf_counter()
    tokenizer = AutoTokenizer.from_pretrained(
        str(args.qwen_dir.resolve()), local_files_only=True, trust_remote_code=False, padding_side="left"
    )
    qwen = AutoModel.from_pretrained(
        str(args.qwen_dir.resolve()), local_files_only=True, trust_remote_code=False, use_safetensors=True
    ).to(device).eval()
    qwen_load_s = time.perf_counter() - t0
    text = f"Instruct: {args.instruction}\nQuery:{args.prompt}" if args.instruction else args.prompt
    tokens = tokenizer(text, return_tensors="pt", truncation=True, max_length=256).to(device)
    t0 = time.perf_counter()
    with torch.inference_mode():
        hidden = qwen(**tokens).last_hidden_state
        source_x = F.normalize(hidden[:, -1], p=2, dim=1).float()
    torch.cuda.synchronize()
    qwen_embed_s = time.perf_counter() - t0

    # Route in the reproducible source-Qwen space.
    rck = torch.load(args.router.resolve(), map_location="cpu", weights_only=False)
    router = DomainRouter(int(rck["hidden"]), float(rck.get("dropout", 0.0))).to(device).eval()
    router.load_state_dict(rck["state_dict"])
    t0 = time.perf_counter()
    with torch.inference_mode():
        route_probs = torch.softmax(router(source_x), dim=1)[0]
    torch.cuda.synchronize()
    router_s = time.perf_counter() - t0
    top_id = int(route_probs.argmax().item())
    top_prob = float(route_probs[top_id].item())
    predicted_domain = CLASSES[top_id]
    if args.force_domain:
        selected_domain = args.force_domain
        route_reason = "forced"
    elif predicted_domain != "generic" and top_prob >= args.threshold:
        selected_domain = predicted_domain
        route_reason = "specialist_confident"
    else:
        selected_domain = "generic"
        route_reason = "generic_or_below_threshold"

    # Bridge current Qwen space into the preserved v3 Qwen space.
    bck = torch.load(args.bridge.resolve(), map_location="cpu", weights_only=False)
    bridge = QwenInstructionBridge(int(bck["hidden"]), float(bck.get("dropout", 0.0))).to(device).eval()
    bridge.load_state_dict(bck["state_dict"])
    ack = torch.load(args.base_adapter.resolve(), map_location="cpu", weights_only=False)
    base = MotionAdapter(int(ack["hidden"]), float(ack.get("dropout", 0.0))).to(device).eval()
    base.load_state_dict(ack["state_dict"])
    mean = torch.as_tensor(ack["teacher_mean"], dtype=torch.float32, device=device)
    std = torch.as_tensor(ack["teacher_std"], dtype=torch.float32, device=device)

    t0 = time.perf_counter()
    with torch.inference_mode():
        v3_x = bridge(source_x)
        base_z = base(v3_x)
        final_z = base_z
        residual_norm = 0.0
        anchor_gate_probability = 0.0
        anchor_applied = False
        if not args.force_domain:
            agck = torch.load(args.anchor_gate.resolve(), map_location="cpu", weights_only=False)
            anchor_gate = PromotedAnchorGate(
                int(agck["hidden"]), float(agck.get("dropout", 0.0))
            ).to(device).eval()
            anchor_gate.load_state_dict(agck["state_dict"])
            anchor_gate_probability = float(torch.sigmoid(anchor_gate(v3_x))[0].item())
            if anchor_gate_probability >= args.anchor_gate_threshold:
                arck = torch.load(args.anchor_residual.resolve(), map_location="cpu", weights_only=False)
                anchor_residual = SpecialistResidual(
                    int(arck["hidden"]), float(arck.get("dropout", 0.0))
                ).to(device).eval()
                anchor_residual.load_state_dict(arck["state_dict"])
                residual_z = anchor_residual(v3_x)
                final_z = base_z + residual_z
                residual_norm = float(torch.linalg.vector_norm(residual_z * std, dim=1).item())
                selected_domain = "generic"
                route_reason = "promoted_anchor_gate"
                anchor_applied = True
        if not anchor_applied and selected_domain in SPECIALIST_GENRES:
            epath = args.expert_dir / f"residual_{selected_domain}_h128.pt"
            eck = torch.load(epath, map_location="cpu", weights_only=False)
            expert = SpecialistResidual(int(eck["hidden"]), float(eck.get("dropout", 0.0))).to(device).eval()
            expert.load_state_dict(eck["state_dict"])
            residual_z = expert(v3_x)
            final_z = base_z + residual_z
            residual_norm = float(torch.linalg.vector_norm(residual_z * std, dim=1).item())
        emb = final_z * std + mean
    torch.cuda.synchronize()
    conditioning_s = time.perf_counter() - t0
    emb_norm = float(torch.linalg.vector_norm(emb[0]).item())
    peak_conditioning = float(torch.cuda.max_memory_allocated() / 1024 / 1024)

    routing = {
        "predicted_domain": predicted_domain,
        "predicted_probability": top_prob,
        "selected_domain": selected_domain,
        "threshold": args.threshold,
        "anchor_gate_probability": anchor_gate_probability,
        "anchor_gate_threshold": args.anchor_gate_threshold,
        "anchor_residual_applied": anchor_applied,
        "route_reason": route_reason,
        "probabilities": {CLASSES[i]: float(route_probs[i].item()) for i in range(len(CLASSES))},
    }
    meta = {
        "prompt": args.prompt,
        "instruction": args.instruction,
        "routing": routing,
        "qwen_load_seconds": round(qwen_load_s, 4),
        "qwen_embedding_seconds": round(qwen_embed_s, 4),
        "router_seconds": round(router_s, 6),
        "bridge_base_residual_seconds": round(conditioning_s, 6),
        "embedding_norm": emb_norm,
        "residual_teacher_space_norm": residual_norm,
        "peak_conditioning_vram_mib": round(peak_conditioning, 1),
    }

    if args.embedding_only:
        (out / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(meta, ensure_ascii=False, indent=2))
        return

    # Conditioning models are no longer needed on GPU.
    emb = emb.detach().cpu()
    del hidden, tokens, source_x, qwen, tokenizer, router, bridge, base, mean, std, ack, bck, rck
    if "expert" in locals():
        del expert
    if "anchor_gate" in locals():
        del anchor_gate
    if "anchor_residual" in locals():
        del anchor_residual
    torch.cuda.empty_cache()

    t0 = time.perf_counter()
    model = load_model("Kimodo-SOMA-RP-v1.1", device="cuda", text_encoder=DummyTextEncoder())
    torch.cuda.synchronize()
    kimodo_load_s = time.perf_counter() - t0
    emb = emb.to(device)
    mask = torch.ones((1, args.frames), dtype=torch.bool, device=device)
    text_pad = torch.ones((1, 1), dtype=torch.bool, device=device)
    heading = torch.zeros((1,), dtype=torch.float32, device=device)
    with torch.inference_mode():
        torch.manual_seed(args.seed)
        torch.cuda.manual_seed_all(args.seed)
        torch.cuda.synchronize()
        t0 = time.perf_counter()
        motion = model._generate(
            texts=[args.prompt], max_frames=args.frames, num_denoising_steps=args.steps,
            pad_mask=mask, first_heading_angle=heading, motion_mask=None, observed_motion=None,
            cfg_weight=[2.0, 2.0], text_feat=emb[:, None, :], text_pad_mask=text_pad,
            progress_bar=lambda x: x,
        )
        torch.cuda.synchronize()
        generation_s = time.perf_counter() - t0
        decoded = model.motion_rep.inverse(motion[0], is_normalized=True, return_numpy=False)
        if isinstance(model.skeleton, SOMASkeleton30):
            decoded = model.skeleton.output_to_SOMASkeleton77(decoded)
            skeleton = model.skeleton.somaskel77.to(device)
        else:
            skeleton = model.skeleton

    npz_path = out / "motion.npz"
    save_kimodo_npz(npz_path, {k: v.detach().cpu().numpy() if torch.is_tensor(v) else v for k, v in decoded.items()})
    joints_pos = decoded["posed_joints"]
    joints_rot = decoded["global_rot_mats"]
    local_rot = global_rots_to_local_rots(joints_rot, skeleton)
    root_positions = joints_pos[:, skeleton.root_idx, :]
    bvh_path = out / "motion.bvh"
    save_motion_bvh(bvh_path, local_rot, root_positions, skeleton=skeleton, fps=model.fps, standard_tpose=True)
    preview = render_preview(joints_pos.detach().cpu().numpy(), skeleton, out, ffmpeg, fps=int(model.fps))

    meta.update({
        "frames": args.frames,
        "fps": float(model.fps),
        "seconds": args.frames / float(model.fps),
        "denoising_steps": args.steps,
        "kimodo_load_seconds": round(kimodo_load_s, 4),
        "generation_seconds": round(generation_s, 4),
        "peak_total_vram_mib": round(torch.cuda.max_memory_allocated() / 1024 / 1024, 1),
        "files": {"npz": str(npz_path), "bvh": str(bvh_path), "preview": str(preview)},
    })
    (out / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(meta, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
