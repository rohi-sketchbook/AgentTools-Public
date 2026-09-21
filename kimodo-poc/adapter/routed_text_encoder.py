# -*- coding: shift_jis -*-
from __future__ import annotations

from pathlib import Path

import torch
import torch.nn.functional as F
from transformers import AutoModel, AutoTokenizer

from train_qwen_instruction_bridge import QwenInstructionBridge
from train_specialist_residual import MotionAdapter, SpecialistResidual
from train_domain_router import DomainRouter, CLASSES

DEFAULT_INSTRUCTION = "Map Japanese human motion descriptions into a semantic space for full-body motion generation."
SPECIALIST_GENRES = {"glamour_editorial", "idol_cute", "runway_fashion", "dynamic_cute_dance", "bold_sensual"}


class PromotedAnchorGate(torch.nn.Module):
    def __init__(self, hidden: int = 64, dropout: float = 0.05) -> None:
        super().__init__()
        self.net = torch.nn.Sequential(
            torch.nn.Linear(1024, hidden),
            torch.nn.GELU(),
            torch.nn.Dropout(dropout),
            torch.nn.Linear(hidden, 1),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x).squeeze(-1)


class RoutedQwenTextEncoder:
    """Drop-in Kimodo text encoder using Qwen + router + v3 bridge/base + residual experts."""

    def __init__(
        self,
        qwen_dir: Path,
        bridge_path: Path,
        base_adapter_path: Path,
        router_path: Path,
        expert_dir: Path,
        anchor_residual_path: Path | None = None,
        anchor_gate_path: Path | None = None,
        anchor_gate_threshold: float = 0.80,
        device: str = "cuda",
        threshold: float = 0.80,
        instruction: str = DEFAULT_INSTRUCTION,
    ) -> None:
        self.device = torch.device(device)
        self.threshold = float(threshold)
        self.anchor_gate_threshold = float(anchor_gate_threshold)
        self.instruction = instruction
        self.route_history: list[dict] = []
        if (anchor_residual_path is None) != (anchor_gate_path is None):
            raise ValueError("anchor_residual_path and anchor_gate_path must be provided together")

        self.tokenizer = AutoTokenizer.from_pretrained(
            str(Path(qwen_dir).resolve()), local_files_only=True, trust_remote_code=False, padding_side="left"
        )
        self.qwen = AutoModel.from_pretrained(
            str(Path(qwen_dir).resolve()), local_files_only=True, trust_remote_code=False, use_safetensors=True
        ).to(self.device).eval()

        bck = torch.load(Path(bridge_path).resolve(), map_location="cpu", weights_only=False)
        self.bridge = QwenInstructionBridge(int(bck["hidden"]), float(bck.get("dropout", 0.0))).to(self.device).eval()
        self.bridge.load_state_dict(bck["state_dict"])

        ack = torch.load(Path(base_adapter_path).resolve(), map_location="cpu", weights_only=False)
        self.base = MotionAdapter(int(ack["hidden"]), float(ack.get("dropout", 0.0))).to(self.device).eval()
        self.base.load_state_dict(ack["state_dict"])
        self.teacher_mean = torch.as_tensor(ack["teacher_mean"], dtype=torch.float32, device=self.device)
        self.teacher_std = torch.as_tensor(ack["teacher_std"], dtype=torch.float32, device=self.device)

        rck = torch.load(Path(router_path).resolve(), map_location="cpu", weights_only=False)
        self.router = DomainRouter(int(rck["hidden"]), float(rck.get("dropout", 0.0))).to(self.device).eval()
        self.router.load_state_dict(rck["state_dict"])

        self.anchor_residual = None
        self.anchor_gate = None
        if anchor_residual_path is not None and anchor_gate_path is not None:
            arck = torch.load(Path(anchor_residual_path).resolve(), map_location="cpu", weights_only=False)
            self.anchor_residual = SpecialistResidual(
                int(arck["hidden"]), float(arck.get("dropout", 0.0))
            ).to(self.device).eval()
            self.anchor_residual.load_state_dict(arck["state_dict"])
            agck = torch.load(Path(anchor_gate_path).resolve(), map_location="cpu", weights_only=False)
            self.anchor_gate = PromotedAnchorGate(
                int(agck["hidden"]), float(agck.get("dropout", 0.0))
            ).to(self.device).eval()
            self.anchor_gate.load_state_dict(agck["state_dict"])

        self.experts = {}
        for genre in SPECIALIST_GENRES:
            epath = Path(expert_dir) / f"residual_{genre}_h128.pt"
            eck = torch.load(epath.resolve(), map_location="cpu", weights_only=False)
            expert = SpecialistResidual(int(eck["hidden"]), float(eck.get("dropout", 0.0))).to(self.device).eval()
            expert.load_state_dict(eck["state_dict"])
            self.experts[genre] = expert

        modules = [self.qwen, self.bridge, self.base, self.router, *self.experts.values()]
        if self.anchor_residual is not None:
            modules.append(self.anchor_residual)
        if self.anchor_gate is not None:
            modules.append(self.anchor_gate)
        for module in modules:
            module.eval()
            for param in module.parameters():
                param.requires_grad_(False)

    def to(self, device):
        self.device = torch.device(device)
        modules = [self.qwen, self.bridge, self.base, self.router, *self.experts.values()]
        if self.anchor_residual is not None:
            modules.append(self.anchor_residual)
        if self.anchor_gate is not None:
            modules.append(self.anchor_gate)
        for module in modules:
            module.to(self.device)
        self.teacher_mean = self.teacher_mean.to(self.device)
        self.teacher_std = self.teacher_std.to(self.device)
        return self

    def eval(self):
        modules = [self.qwen, self.bridge, self.base, self.router, *self.experts.values()]
        if self.anchor_residual is not None:
            modules.append(self.anchor_residual)
        if self.anchor_gate is not None:
            modules.append(self.anchor_gate)
        for module in modules:
            module.eval()
        return self

    def get_device(self):
        return self.device

    def clear_route_history(self):
        self.route_history.clear()

    def __call__(self, text: list[str] | str):
        is_string = isinstance(text, str)
        texts = [text] if is_string else list(text)
        query_texts = [
            f"Instruct: {self.instruction}\nQuery:{item}" if self.instruction else item
            for item in texts
        ]
        tokens = self.tokenizer(
            query_texts, return_tensors="pt", padding=True, truncation=True, max_length=256
        ).to(self.device)
        with torch.inference_mode():
            hidden = self.qwen(**tokens).last_hidden_state
            source_x = F.normalize(hidden[:, -1], p=2, dim=1).float()
            probs = torch.softmax(self.router(source_x), dim=1)
            top_prob, top_id = probs.max(dim=1)
            v3_x = self.bridge(source_x)
            base_z = self.base(v3_x)
            final_z = base_z.clone()
            if self.anchor_gate is not None:
                anchor_gate_prob = torch.sigmoid(self.anchor_gate(v3_x))
            else:
                anchor_gate_prob = torch.zeros((len(texts),), device=self.device)

            batch_routes = []
            for i in range(len(texts)):
                predicted = CLASSES[int(top_id[i].item())]
                probability = float(top_prob[i].item())
                anchor_probability = float(anchor_gate_prob[i].item())
                anchor_applied = (
                    self.anchor_residual is not None
                    and self.anchor_gate is not None
                    and anchor_probability >= self.anchor_gate_threshold
                )
                if anchor_applied:
                    selected = "generic"
                    final_z[i:i+1] = final_z[i:i+1] + self.anchor_residual(v3_x[i:i+1])
                elif predicted != "generic" and probability >= self.threshold:
                    selected = predicted
                    residual_z = self.experts[selected](v3_x[i:i+1])
                    final_z[i:i+1] = final_z[i:i+1] + residual_z
                else:
                    selected = "generic"
                route = {
                    "text": texts[i],
                    "predicted_domain": predicted,
                    "probability": probability,
                    "selected_domain": selected,
                    "anchor_residual_applied": anchor_applied,
                    "anchor_gate_probability": anchor_probability,
                    "anchor_gate_threshold": self.anchor_gate_threshold,
                    "threshold": self.threshold,
                    "probabilities": {CLASSES[j]: float(probs[i, j].item()) for j in range(len(CLASSES))},
                }
                batch_routes.append(route)
                self.route_history.append(route)

            emb = final_z * self.teacher_std + self.teacher_mean
            emb = emb[:, None, :]
            lengths = [1] * len(texts)

        # Kimodo mutates text_feat for empty-prompt masking. Tensors created
        # inside inference_mode are immutable to such in-place updates outside
        # inference mode, so return a normal cloned tensor.
        emb = emb.clone()
        if is_string:
            return emb[0], lengths[0]
        return emb, lengths
