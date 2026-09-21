import importlib.util
import os

import comfy
import folder_paths


_ORIGINAL_PATH = os.path.join(
    folder_paths.base_path,
    "custom_nodes",
    "comfyui-minimax-h3-turbo",
    "__init__.py",
)
_spec = importlib.util.spec_from_file_location("agenttools_minimax_h3_turbo_original", _ORIGINAL_PATH)
if _spec is None or _spec.loader is None:
    raise RuntimeError(f"MiniMax H3 Turbo node could not be loaded: {_ORIGINAL_PATH}")
_original = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_original)


def _model_key(module_name):
    if module_name.startswith("diffusion_model."):
        return f"{module_name}.weight"
    return f"diffusion_model.{module_name}.weight"


def _object_key(module_name):
    base = module_name.rsplit(".linear", 1)[0]
    if base.startswith("diffusion_model."):
        return base
    return f"diffusion_model.{base}"


class MiniMaxH3TurboLoRACompat(_original.MiniMaxH3TurboLoRA):
    def apply_lora(self, model, lora_name, strength):
        path = folder_paths.get_full_path("loras", lora_name)
        lora = comfy.utils.load_torch_file(path, safe_load=True)
        modules = sorted({key.rsplit(".lora_", 1)[0] for key in lora})
        dm = model.model.diffusion_model
        pruned = getattr(dm, "use_adaln_curves", False)
        new_model = model.clone()

        if not pruned:
            to_load = {module: _model_key(module) for module in modules}
            new_model.add_patches(comfy.lora.load_lora(lora, to_load), strength)
            return (new_model,)

        backbone = [module for module in modules if "adaln_proj" not in module]
        adaln = [module for module in modules if "adaln_proj" in module]
        to_load = {module: _model_key(module) for module in backbone}
        new_model.add_patches(comfy.lora.load_lora(lora, to_load), strength)

        egrid = _original._egrid()
        shared = {"silu_temb": None}
        shift_v = float(getattr(dm, "sigma_shift_video", _original.SHIFT_V))
        shift_a = float(getattr(dm, "sigma_shift_audio", _original.SHIFT_A))

        def wrap(executor, *args, **kwargs):
            ts = args[1] if len(args) > 1 else kwargs.get("timestep")
            ctx = args[2] if len(args) > 2 else kwargs.get("context")
            payload = kwargs.get("minimax_payload") or {}
            has_vc = bool(payload.get("keyframes") or payload.get("refs"))
            unique_t = _original._unique_t(ts, shift_v, shift_a, has_vc)
            shared["silu_temb"] = _original._interp_egrid(unique_t, egrid, ctx.device, ctx.dtype)
            return executor(*args, **kwargs)

        new_model.add_wrapper_with_key(
            comfy.patcher_extension.WrappersMP.DIFFUSION_MODEL,
            "h3turbo",
            wrap,
        )
        for name in adaln:
            a = lora[name + ".lora_A.weight"]
            b = lora[name + ".lora_B.weight"] * strength
            key = _object_key(name)
            new_model.add_object_patch(
                key,
                _original._AdalnDelta(new_model.get_model_object(key), a, b, shared),
            )
        print(
            f"[AgentTools MiniMaxH3TurboCompat] pruned base: {len(backbone)} backbone patched "
            f"+ {len(adaln)} adaln injected at run time",
            flush=True,
        )
        return (new_model,)


NODE_CLASS_MAPPINGS = {
    "MiniMaxH3TurboLoRA": MiniMaxH3TurboLoRACompat,
    "MiniMaxH3TurboSampler": _original.MiniMaxH3TurboSampler,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxH3TurboLoRA": "MiniMax-H3 Turbo LoRA (AgentTools Compat)",
    "MiniMaxH3TurboSampler": "MiniMax-H3 Turbo Sampler (4-step)",
}
