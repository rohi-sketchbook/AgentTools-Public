# -*- coding: shift_jis -*-
from __future__ import annotations

from typing import Any

DEFAULT_PASS_ORDER = [
    "blockout",
    "structural-pass",
    "form-refinement",
    "material-pass",
    "surface-pass",
    "lighting-pass",
    "interaction-pass",
    "optimization-pass",
]

VISUAL_PASS_IDS = set(DEFAULT_PASS_ORDER) - {"optimization-pass"}
VALID_ACTIONS = {"continue", "refine-spec", "refine-blender", "request-input", "stop"}
DEFAULT_VISUAL_THRESHOLD = 0.70


def pass_order(spec: dict[str, Any]) -> list[str]:
    raw = spec.get("buildPasses")
    if not isinstance(raw, list) or not raw:
        return DEFAULT_PASS_ORDER.copy()

    result: list[str] = []
    for item in raw:
        if isinstance(item, str) and item.strip():
            result.append(item.strip())
        elif isinstance(item, dict) and isinstance(item.get("id"), str) and item["id"].strip():
            result.append(item["id"].strip())
    return result or DEFAULT_PASS_ORDER.copy()


def review_completes_pass(entry: dict[str, Any], pass_id: str) -> bool:
    if entry.get("passId") != pass_id or entry.get("action") != "continue":
        return False

    if pass_id in VISUAL_PASS_IDS:
        visual = entry.get("visualEvidence")
        if not isinstance(visual, dict):
            return False
        if not visual.get("renderScreenshot") or not visual.get("comparisonImage"):
            return False

        score = entry.get("aiVisionScore")
        threshold = entry.get("visualAcceptanceThreshold", DEFAULT_VISUAL_THRESHOLD)
        if not isinstance(score, (int, float)) or isinstance(score, bool):
            return False
        if not isinstance(threshold, (int, float)) or isinstance(threshold, bool):
            return False
        if float(score) < float(threshold):
            return False

    return True


def completed_passes(spec: dict[str, Any]) -> list[str]:
    order = pass_order(spec)
    history = spec.get("reviewHistory")
    if not isinstance(history, list):
        return []

    completed: list[str] = []
    for pass_id in order:
        if any(isinstance(entry, dict) and review_completes_pass(entry, pass_id) for entry in history):
            completed.append(pass_id)
        else:
            break
    return completed


def current_pass(spec: dict[str, Any]) -> str:
    order = pass_order(spec)
    completed = completed_passes(spec)
    if len(completed) >= len(order):
        return "complete"
    return order[len(completed)]


def next_required_evidence(spec: dict[str, Any]) -> list[str]:
    pass_id = current_pass(spec)
    if pass_id == "complete":
        return []

    result = ["SceneSpec for the current pass validates"]
    if pass_id in VISUAL_PASS_IDS:
        result.extend(
            [
                "Blender render screenshot for the current pass",
                "side-by-side reference/render comparison image",
                f"agent vision score >= {DEFAULT_VISUAL_THRESHOLD:.2f}",
                "one review action after visual inspection",
            ]
        )
    else:
        result.append("one review action after optimization validation")
    return result


def sync_pipeline_state(spec: dict[str, Any]) -> dict[str, Any]:
    completed = completed_passes(spec)
    current = current_pass(spec)
    state = spec.setdefault("pipelineState", {})
    if not isinstance(state, dict):
        state = {}
        spec["pipelineState"] = state

    state.update(
        {
            "passGateMode": "locked-sequential",
            "currentPass": current,
            "completedPasses": completed,
            "lastCompletedPass": completed[-1] if completed else "",
            "nextRequiredEvidence": next_required_evidence(spec),
        }
    )
    return state


def can_review_pass(spec: dict[str, Any], pass_id: str) -> tuple[bool, str]:
    order = pass_order(spec)
    if pass_id not in order:
        return False, f"unknown build pass: {pass_id}"

    current = current_pass(spec)
    completed = completed_passes(spec)
    if pass_id in completed:
        return True, "completed pass may be re-reviewed"
    if current == "complete":
        return False, "pipeline is already complete"
    if pass_id != current:
        return False, f"pass is locked; current unlocked pass is {current}"
    return True, "current pass is unlocked"


def append_review(
    spec: dict[str, Any],
    *,
    pass_id: str,
    action: str,
    summary: str,
    render_screenshot: str = "",
    comparison_image: str = "",
    ai_vision_score: float | None = None,
    visual_threshold: float = DEFAULT_VISUAL_THRESHOLD,
    layer_scores: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if action not in VALID_ACTIONS:
        raise ValueError(f"invalid action: {action}")

    allowed, reason = can_review_pass(spec, pass_id)
    if not allowed:
        raise ValueError(reason)

    if action == "continue" and pass_id in VISUAL_PASS_IDS:
        if not render_screenshot:
            raise ValueError("continue requires a Blender render screenshot")
        if not comparison_image:
            raise ValueError("continue requires a comparison image")
        if ai_vision_score is None:
            raise ValueError("continue requires an agent vision score")
        if not 0.0 <= float(ai_vision_score) <= 1.0:
            raise ValueError("agent vision score must be between 0 and 1")
        if float(ai_vision_score) < float(visual_threshold):
            raise ValueError(
                f"continue rejected: vision score {float(ai_vision_score):.3f} "
                f"is below threshold {float(visual_threshold):.3f}"
            )

    entry: dict[str, Any] = {
        "passId": pass_id,
        "action": action,
        "summary": summary,
        "visualAcceptanceThreshold": float(visual_threshold),
    }
    if ai_vision_score is not None:
        entry["aiVisionScore"] = float(ai_vision_score)
    if layer_scores is not None:
        entry["layerScores"] = layer_scores
    if render_screenshot or comparison_image:
        entry["visualEvidence"] = {
            "renderScreenshot": render_screenshot,
            "comparisonImage": comparison_image,
        }

    history = spec.setdefault("reviewHistory", [])
    if not isinstance(history, list):
        history = []
        spec["reviewHistory"] = history
    history.append(entry)
    sync_pipeline_state(spec)
    return entry
