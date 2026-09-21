# -*- coding: shift_jis -*-
from __future__ import annotations

import argparse
import contextlib
import gc
import json
import os
import sys
import time
import traceback
import uuid
from pathlib import Path
from typing import Any

import numpy as np
import torch
import torch.nn.functional as F
from transformers import AutoModel, AutoTokenizer


CATEGORY_HINTS = {
    "locomotion",
    "gesture",
    "dance",
    "posture_transition",
    "everyday_activity",
    "object_interaction",
    "stunt_athletic",
}


class DummyTextEncoder:
    def __call__(self, texts):
        raise RuntimeError("text encoder should not be called when text_feat is supplied")


def _load_runtime_modules(assets_root: Path):
    scripts_dir = (assets_root / "scripts").resolve()
    adapter_dir = (assets_root / "adapter").resolve()
    for path in (str(scripts_dir), str(adapter_dir)):
        if path not in sys.path:
            sys.path.insert(0, path)

    from kimodo import load_model
    from kimodo.exports.motion_io import save_kimodo_npz
    from kimodo.skeleton import SOMASkeleton30
    from train_qwen_instruction_bridge import QwenInstructionBridge
    from train_specialist_residual import MotionAdapter, SpecialistResidual
    from train_domain_router import DomainRouter, CLASSES
    from train_promoted_anchor_gate import PromotedAnchorGate
    from export_vac_bridge import export_bridge

    return {
        "load_model": load_model,
        "save_kimodo_npz": save_kimodo_npz,
        "SOMASkeleton30": SOMASkeleton30,
        "QwenInstructionBridge": QwenInstructionBridge,
        "MotionAdapter": MotionAdapter,
        "SpecialistResidual": SpecialistResidual,
        "DomainRouter": DomainRouter,
        "PromotedAnchorGate": PromotedAnchorGate,
        "CLASSES": CLASSES,
        "export_bridge": export_bridge,
    }


class KimodoRuntime:
    def __init__(self, assets_root: Path, manifest_path: Path) -> None:
        self.assets_root = assets_root.resolve()
        self.manifest_path = manifest_path.resolve()
        self.modules = _load_runtime_modules(self.assets_root)
        self.device = torch.device("cuda")
        self.loaded = False
        self.manifest: dict[str, Any] | None = None
        self.tokenizer = None
        self.qwen = None
        self.router = None
        self.bridge = None
        self.base = None
        self.teacher_mean = None
        self.teacher_std = None
        self.experts: dict[str, Any] = {}
        self.anchor_gate = None
        self.anchor_residual = None
        self.anchor_gate_threshold = 0.8
        self.category_concepts: dict[str, list[dict[str, Any]]] = {}
        self.category_embeddings: dict[str, torch.Tensor] = {}
        self.category_similarity_threshold = 0.82
        self.category_blend_weight = 0.20
        self.kimodo = None

    def _asset(self, relative: str) -> Path:
        path = (self.assets_root / relative).resolve()
        try:
            path.relative_to(self.assets_root)
        except ValueError as exc:
            raise ValueError(f"Manifest path escapes assets root: {relative}") from exc
        return path

    def load(self) -> dict[str, Any]:
        if self.loaded:
            return self.status()
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA is unavailable. AI animation requires an NVIDIA CUDA GPU.")
        if not self.manifest_path.is_file():
            raise FileNotFoundError(self.manifest_path)

        t0 = time.perf_counter()
        self.manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        if self.manifest.get("schema") != "kimodo-routed-pipeline/v1":
            raise RuntimeError("Unsupported routed pipeline manifest schema")

        os.environ["CHECKPOINT_DIR"] = str((self.assets_root / "models").resolve())
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()

        QwenInstructionBridge = self.modules["QwenInstructionBridge"]
        MotionAdapter = self.modules["MotionAdapter"]
        SpecialistResidual = self.modules["SpecialistResidual"]
        DomainRouter = self.modules["DomainRouter"]
        PromotedAnchorGate = self.modules["PromotedAnchorGate"]

        qwen_dir = self._asset(self.manifest["qwen_model"])
        self.tokenizer = AutoTokenizer.from_pretrained(
            str(qwen_dir),
            local_files_only=True,
            trust_remote_code=False,
            padding_side="left",
        )
        self.qwen = AutoModel.from_pretrained(
            str(qwen_dir),
            local_files_only=True,
            trust_remote_code=False,
            use_safetensors=True,
        ).to(self.device).eval()

        router_ck = torch.load(self._asset(self.manifest["router"]), map_location="cpu", weights_only=False)
        self.router = DomainRouter(
            int(router_ck["hidden"]),
            float(router_ck.get("dropout", 0.0)),
        ).to(self.device).eval()
        self.router.load_state_dict(router_ck["state_dict"])

        bridge_ck = torch.load(self._asset(self.manifest["bridge"]), map_location="cpu", weights_only=False)
        self.bridge = QwenInstructionBridge(
            int(bridge_ck["hidden"]),
            float(bridge_ck.get("dropout", 0.0)),
        ).to(self.device).eval()
        self.bridge.load_state_dict(bridge_ck["state_dict"])

        base_ck = torch.load(self._asset(self.manifest["base_adapter"]), map_location="cpu", weights_only=False)
        self.base = MotionAdapter(
            int(base_ck["hidden"]),
            float(base_ck.get("dropout", 0.0)),
        ).to(self.device).eval()
        self.base.load_state_dict(base_ck["state_dict"])
        self.teacher_mean = torch.as_tensor(base_ck["teacher_mean"], dtype=torch.float32, device=self.device)
        self.teacher_std = torch.as_tensor(base_ck["teacher_std"], dtype=torch.float32, device=self.device)

        self.anchor_gate = None
        self.anchor_residual = None
        anchor_gate_path = self.manifest.get("promoted_anchor_gate")
        anchor_residual_path = self.manifest.get("promoted_anchor_residual")
        if anchor_gate_path and anchor_residual_path:
            gate_ck = torch.load(self._asset(anchor_gate_path), map_location="cpu", weights_only=False)
            self.anchor_gate = PromotedAnchorGate(
                int(gate_ck["hidden"]),
                float(gate_ck.get("dropout", 0.0)),
            ).to(self.device).eval()
            self.anchor_gate.load_state_dict(gate_ck["state_dict"])
            self.anchor_gate_threshold = float(self.manifest.get("promoted_anchor_gate_threshold", 0.8))

            residual_ck = torch.load(self._asset(anchor_residual_path), map_location="cpu", weights_only=False)
            self.anchor_residual = SpecialistResidual(
                int(residual_ck["hidden"]),
                float(residual_ck.get("dropout", 0.0)),
            ).to(self.device).eval()
            self.anchor_residual.load_state_dict(residual_ck["state_dict"])

        self._load_category_index()

        self.experts = {}
        for domain, relative in self.manifest.get("experts", {}).items():
            expert_ck = torch.load(self._asset(relative), map_location="cpu", weights_only=False)
            expert = SpecialistResidual(
                int(expert_ck["hidden"]),
                float(expert_ck.get("dropout", 0.0)),
            ).to(self.device).eval()
            expert.load_state_dict(expert_ck["state_dict"])
            self.experts[domain] = expert

        load_model = self.modules["load_model"]
        with contextlib.redirect_stdout(sys.stderr):
            self.kimodo = load_model(
                "Kimodo-SOMA-RP-v1.1",
                device="cuda",
                text_encoder=DummyTextEncoder(),
            )
        torch.cuda.synchronize()
        self.loaded = True
        return {
            **self.status(),
            "loadSeconds": round(time.perf_counter() - t0, 4),
            "vramMiB": round(torch.cuda.memory_allocated() / 1024 / 1024, 1),
            "categoryConcepts": sum(len(rows) for rows in self.category_concepts.values()),
        }

    def _encode_source_batch(self, texts: list[str]) -> torch.Tensor:
        instruction = str(self.manifest.get("qwen_instruction") or "")
        wrapped = [f"Instruct: {instruction}\\nQuery:{text}" if instruction else text for text in texts]
        tokenizer_input = wrapped[0] if len(wrapped) == 1 else wrapped
        tokens = self.tokenizer(
            tokenizer_input,
            return_tensors="pt",
            padding=len(wrapped) > 1,
            truncation=True,
            max_length=256,
        ).to(self.device)
        with torch.inference_mode():
            hidden = self.qwen(**tokens).last_hidden_state
            return F.normalize(hidden[:, -1], p=2, dim=1).float()

    def _load_category_index(self) -> None:
        self.category_concepts = {}
        self.category_embeddings = {}
        relative = self.manifest.get("motion_category_index")
        if not relative:
            return
        path = self._asset(relative)
        document = json.loads(path.read_text(encoding="utf-8"))
        if document.get("schema") != "kimodo-motion-category-index/v1":
            raise RuntimeError("Unsupported motion category index schema")
        blend = document.get("concept_blend") or {}
        self.category_similarity_threshold = float(blend.get("similarity_threshold", 0.82))
        self.category_blend_weight = float(blend.get("weight", 0.20))
        concepts = list(document.get("concepts") or [])
        if not concepts:
            return

        all_embeddings: list[torch.Tensor] = []
        batch_size = 64
        for start in range(0, len(concepts), batch_size):
            batch = concepts[start:start + batch_size]
            source = self._encode_source_batch([str(row.get("ja") or "") for row in batch])
            with torch.inference_mode():
                all_embeddings.append(self.bridge(source))
        encoded = torch.cat(all_embeddings, dim=0)
        by_category: dict[str, list[int]] = {}
        for index, row in enumerate(concepts):
            category = str(row.get("category") or "")
            if category:
                by_category.setdefault(category, []).append(index)
        for category, indices in by_category.items():
            self.category_concepts[category] = [concepts[index] for index in indices]
            idx = torch.as_tensor(indices, device=self.device, dtype=torch.long)
            self.category_embeddings[category] = encoded[idx].detach()

    def unload(self) -> dict[str, Any]:
        if self.kimodo is not None:
            del self.kimodo
        self.kimodo = None
        self.experts.clear()
        self.category_concepts.clear()
        self.category_embeddings.clear()
        for name in (
            "qwen", "tokenizer", "router", "bridge", "base", "teacher_mean", "teacher_std",
            "anchor_gate", "anchor_residual",
        ):
            value = getattr(self, name, None)
            if value is not None:
                del value
            setattr(self, name, None)
        self.manifest = None
        self.loaded = False
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
        return self.status()

    def status(self) -> dict[str, Any]:
        return {
            "loaded": self.loaded,
            "device": str(self.device),
            "model": "Kimodo-SOMA-RP-v1.1",
            "pipeline": "kimodo-routed-pipeline/v1",
        }

    def _encode_prompt(self, prompt: str, category_hint: str = "") -> tuple[torch.Tensor, dict[str, Any]]:
        if not self.loaded:
            raise RuntimeError("Models are not loaded")

        t0 = time.perf_counter()
        source_x = self._encode_source_batch([prompt])
        torch.cuda.synchronize()
        qwen_seconds = time.perf_counter() - t0

        t0 = time.perf_counter()
        with torch.inference_mode():
            route_probs = torch.softmax(self.router(source_x), dim=1)[0]
        torch.cuda.synchronize()
        router_seconds = time.perf_counter() - t0

        classes = self.modules["CLASSES"]
        top_id = int(route_probs.argmax().item())
        top_prob = float(route_probs[top_id].item())
        predicted = classes[top_id]
        threshold = float(self.manifest.get("router_threshold", 0.8))
        selected = predicted if predicted != "generic" and top_prob >= threshold else "generic"

        t0 = time.perf_counter()
        matched_concept_id = ""
        concept_similarity = 0.0
        concept_blend_applied = False
        anchor_gate_probability = 0.0
        anchor_residual_applied = False
        with torch.inference_mode():
            v3_x = self.bridge(source_x)
            conditioning_x = v3_x

            if category_hint and category_hint in self.category_embeddings:
                prototypes = self.category_embeddings[category_hint]
                if len(prototypes):
                    similarities = F.cosine_similarity(v3_x, prototypes, dim=1)
                    best_index = int(similarities.argmax().item())
                    concept_similarity = float(similarities[best_index].item())
                    concepts = self.category_concepts.get(category_hint) or []
                    if best_index < len(concepts):
                        matched_concept_id = str(concepts[best_index].get("id") or "")
                    if concept_similarity >= self.category_similarity_threshold:
                        weight = self.category_blend_weight
                        conditioning_x = F.normalize(
                            (1.0 - weight) * v3_x + weight * prototypes[best_index:best_index + 1],
                            p=2,
                            dim=1,
                        )
                        concept_blend_applied = True

            if self.anchor_gate is not None and self.anchor_residual is not None:
                anchor_gate_probability = float(torch.sigmoid(self.anchor_gate(v3_x))[0].item())
                if anchor_gate_probability >= self.anchor_gate_threshold:
                    selected = "generic"
                    anchor_residual_applied = True

            final_z = self.base(conditioning_x)
            if anchor_residual_applied:
                final_z = final_z + self.anchor_residual(conditioning_x)
            elif selected in self.experts:
                final_z = final_z + self.experts[selected](conditioning_x)
            embedding = final_z * self.teacher_std + self.teacher_mean
        torch.cuda.synchronize()
        adapter_seconds = time.perf_counter() - t0

        meta = {
            "predictedDomain": predicted,
            "selectedDomain": selected,
            "routeConfidence": round(top_prob, 6),
            "routeThreshold": threshold,
            "categoryHint": category_hint,
            "matchedConceptId": matched_concept_id,
            "conceptSimilarity": round(concept_similarity, 6),
            "conceptBlendApplied": concept_blend_applied,
            "anchorGateProbability": round(anchor_gate_probability, 6),
            "anchorResidualApplied": anchor_residual_applied,
            "qwenSeconds": round(qwen_seconds, 4),
            "routerSeconds": round(router_seconds, 6),
            "adapterSeconds": round(adapter_seconds, 6),
        }
        return embedding, meta

    def generate(self, request: dict[str, Any]) -> dict[str, Any]:
        if not self.loaded:
            raise RuntimeError("Models are not loaded")

        prompt = str(request.get("prompt") or "").strip()
        if not prompt:
            raise ValueError("prompt is empty")
        if len(prompt) > 2000:
            raise ValueError("prompt is too long")

        category_hint = str(request.get("categoryHint") or "").strip()
        if category_hint == "auto":
            category_hint = ""
        if category_hint and category_hint not in CATEGORY_HINTS:
            raise ValueError(f"unknown categoryHint: {category_hint}")

        frames = int(request.get("frames", 120))
        steps = int(request.get("steps", 100))
        seed = int(request.get("seed", 20260825))
        if frames < 30 or frames > 900:
            raise ValueError("frames must be between 30 and 900")
        if steps < 10 or steps > 200:
            raise ValueError("steps must be between 10 and 200")

        output_bridge = Path(str(request.get("outputBridge") or "")).resolve()
        if not output_bridge.name:
            raise ValueError("outputBridge is empty")
        output_bridge.parent.mkdir(parents=True, exist_ok=True)
        temp_npz = output_bridge.with_name(output_bridge.stem + ".motion.npz")

        name = str(request.get("name") or "AI\u30a2\u30cb\u30e1\u30fc\u30b7\u30e7\u30f3").strip() or "AI\u30a2\u30cb\u30e1\u30fc\u30b7\u30e7\u30f3"
        clip_id = str(request.get("clipId") or f"kimodo_{uuid.uuid4().hex[:12]}")
        loop = bool(request.get("loop", False))
        root_motion_threshold = float(request.get("rootMotionThresholdMeters", 0.20))
        root_yaw_threshold = float(request.get("rootYawThresholdDegrees", 30.0))

        torch.manual_seed(seed)
        torch.cuda.manual_seed_all(seed)
        torch.cuda.reset_peak_memory_stats()
        total_start = time.perf_counter()

        embedding, route_meta = self._encode_prompt(prompt, category_hint)
        text_pad = torch.ones((1, 1), dtype=torch.bool, device=self.device)
        pad_mask = torch.ones((1, frames), dtype=torch.bool, device=self.device)
        heading = torch.zeros((1,), dtype=torch.float32, device=self.device)

        t0 = time.perf_counter()
        with torch.inference_mode(), contextlib.redirect_stdout(sys.stderr):
            torch.manual_seed(seed)
            torch.cuda.manual_seed_all(seed)
            motion = self.kimodo._generate(
                texts=[prompt],
                max_frames=frames,
                num_denoising_steps=steps,
                pad_mask=pad_mask,
                first_heading_angle=heading,
                motion_mask=None,
                observed_motion=None,
                cfg_weight=[2.0, 2.0],
                text_feat=embedding[:, None, :],
                text_pad_mask=text_pad,
                progress_bar=lambda x: x,
            )
            torch.cuda.synchronize()
            generation_seconds = time.perf_counter() - t0
            decoded = self.kimodo.motion_rep.inverse(motion[0], is_normalized=True, return_numpy=False)
            articulated_fingers = not isinstance(self.kimodo.skeleton, self.modules["SOMASkeleton30"])
            if not articulated_fingers:
                # SOMASkeleton30 has no articulated finger chains. Expansion to SOMA77
                # fills fingers with a fixed relaxed-hand rest pose, so those rotations
                # must not be advertised as generated finger motion.
                decoded = self.kimodo.skeleton.output_to_SOMASkeleton77(decoded)

        save_kimodo_npz = self.modules["save_kimodo_npz"]
        save_kimodo_npz(
            temp_npz,
            {
                key: value.detach().cpu().numpy() if torch.is_tensor(value) else value
                for key, value in decoded.items()
            },
        )

        fps = float(self.kimodo.fps)
        export_bridge = self.modules["export_bridge"]
        bridge_doc = export_bridge(
            temp_npz,
            output_bridge,
            fps=fps,
            clip_id=clip_id,
            name=name,
            prompt=prompt,
            selected_specialist=route_meta["selectedDomain"],
            loop=loop,
            root_motion_threshold_m=root_motion_threshold,
            root_yaw_threshold_deg=root_yaw_threshold,
            articulated_fingers=articulated_fingers,
        )
        try:
            temp_npz.unlink(missing_ok=True)
        except Exception:
            pass

        total_seconds = time.perf_counter() - total_start
        return {
            "bridgePath": str(output_bridge),
            "name": bridge_doc["name"],
            "clipId": bridge_doc["clipId"],
            "frames": bridge_doc["frameCount"],
            "fps": bridge_doc["fps"],
            "duration": bridge_doc["duration"],
            "rootMotion": bridge_doc["rootMotion"],
            "generationSeconds": round(generation_seconds, 4),
            "totalSeconds": round(total_seconds, 4),
            "peakVramMiB": round(torch.cuda.max_memory_allocated() / 1024 / 1024, 1),
            **route_meta,
        }


def _emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _handle(runtime: KimodoRuntime, request: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    request_id = str(request.get("id") or "")
    command = str(request.get("command") or "").lower()
    should_exit = False
    if command == "load":
        result = runtime.load()
    elif command == "status":
        result = runtime.status()
    elif command == "generate":
        result = runtime.generate(request)
    elif command == "unload":
        result = runtime.unload()
    elif command == "shutdown":
        result = runtime.unload()
        should_exit = True
    else:
        raise ValueError(f"Unknown command: {command}")
    return {"id": request_id, "ok": True, "command": command, "result": result}, should_exit


def main() -> int:
    parser = argparse.ArgumentParser(description="VR Avatar Studio Kimodo AI animation runtime worker")
    parser.add_argument("--assets-root", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, default=None)
    args = parser.parse_args()

    assets_root = args.assets_root.resolve()
    manifest = (args.manifest or assets_root / "adapter" / "routed_pipeline_v1.json").resolve()
    runtime = KimodoRuntime(assets_root, manifest)

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        request_id = ""
        try:
            request = json.loads(line)
            request_id = str(request.get("id") or "")
            response, should_exit = _handle(runtime, request)
            _emit(response)
            if should_exit:
                return 0
        except Exception as exc:
            traceback.print_exc(file=sys.stderr)
            _emit({
                "id": request_id,
                "ok": False,
                "error": str(exc),
                "errorType": type(exc).__name__,
            })
    runtime.unload()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
