# -*- coding: shift_jis -*-
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from blender_generator import generate_blender_script
from blender_mcp_client import execute_script_file, get_scene_info
from comparison_adapter import make_comparison_sheet
from pipeline_state import append_review, current_pass, sync_pipeline_state
from png_probe import probe_png
from scene_spec import make_blockout_scene_spec, validate_scene_spec


def read_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Expected a JSON object")
    return payload


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")


def command_probe(args: argparse.Namespace) -> int:
    result = probe_png(args.reference)
    print(json.dumps(result, indent=2, ensure_ascii=True))
    return 0


def command_init_spec(args: argparse.Namespace) -> int:
    image_info = probe_png(args.reference)
    spec = make_blockout_scene_spec(args.reference, image_info)
    sync_pipeline_state(spec)
    errors = validate_scene_spec(spec)
    if errors:
        raise ValueError("Generated invalid SceneSpec: " + "; ".join(errors))
    write_json(Path(args.output), spec)
    print(f"SceneSpec written: {args.output}")
    return 0


def command_validate(args: argparse.Namespace) -> int:
    spec = read_json(Path(args.spec))
    errors = validate_scene_spec(spec)
    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        return 2
    sync_pipeline_state(spec)
    print("SceneSpec validation: OK")
    print(f"Current pass: {current_pass(spec)}")
    return 0


def command_generate(args: argparse.Namespace) -> int:
    spec = read_json(Path(args.spec))
    sync_pipeline_state(spec)
    script = generate_blender_script(spec)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(script, encoding="ascii")
    print(f"Blender script written: {output}")
    print(f"Generated through unlocked pass: {current_pass(spec)}")
    return 0


def command_status(args: argparse.Namespace) -> int:
    spec = read_json(Path(args.spec))
    state = sync_pipeline_state(spec)
    payload = {
        "currentPass": state.get("currentPass"),
        "completedPasses": state.get("completedPasses", []),
        "nextRequiredEvidence": state.get("nextRequiredEvidence", []),
    }
    if args.json:
        print(json.dumps(payload, indent=2, ensure_ascii=True))
    else:
        print(f"Current pass: {payload['currentPass']}")
        completed = payload["completedPasses"]
        print("Completed: " + (", ".join(completed) if completed else "none"))
        print("Next required evidence:")
        for item in payload["nextRequiredEvidence"]:
            print(f"- {item}")
    return 0


def command_compare(args: argparse.Namespace) -> int:
    make_comparison_sheet(args.reference, args.render, args.output)
    print(f"Comparison sheet written: {args.output}")
    return 0


def command_mcp_status(args: argparse.Namespace) -> int:
    response = get_scene_info(port=args.port, timeout=args.timeout)
    print(json.dumps(response, indent=2, ensure_ascii=True))
    return 0


def command_mcp_apply(args: argparse.Namespace) -> int:
    response = execute_script_file(args.script, port=args.port, timeout=args.timeout)
    print(json.dumps(response, indent=2, ensure_ascii=True))
    return 0


def command_review(args: argparse.Namespace) -> int:
    spec_path = Path(args.spec)
    spec = read_json(spec_path)
    layer_scores = None
    if args.layer_scores_json:
        parsed = json.loads(args.layer_scores_json)
        if not isinstance(parsed, dict):
            raise ValueError("--layer-scores-json must be a JSON object")
        layer_scores = parsed

    append_review(
        spec,
        pass_id=args.pass_id,
        action=args.action,
        summary=args.summary,
        render_screenshot=args.render_screenshot or "",
        comparison_image=args.comparison_image or "",
        ai_vision_score=args.ai_vision_score,
        visual_threshold=args.visual_threshold,
        layer_scores=layer_scores,
    )

    output = spec_path if args.in_place else Path(args.output)
    write_json(output, spec)
    print(f"Review recorded: {args.pass_id} -> {args.action}")
    print(f"Current pass: {current_pass(spec)}")
    print(f"SceneSpec written: {output}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Minimal img2blender quality-gated pipeline")
    subparsers = parser.add_subparsers(dest="command", required=True)

    probe = subparsers.add_parser("probe", help="Validate baseline PNG properties")
    probe.add_argument("reference")
    probe.set_defaults(func=command_probe)

    init_spec = subparsers.add_parser("init-spec", help="Create a blockout SceneSpec template")
    init_spec.add_argument("reference")
    init_spec.add_argument("output")
    init_spec.set_defaults(func=command_init_spec)

    validate = subparsers.add_parser("validate", help="Validate SceneSpec structure")
    validate.add_argument("spec")
    validate.set_defaults(func=command_validate)

    generate = subparsers.add_parser("generate", help="Generate pass-gated Blender Python from SceneSpec")
    generate.add_argument("spec")
    generate.add_argument("output")
    generate.set_defaults(func=command_generate)

    status = subparsers.add_parser("status", help="Report current unlocked build pass")
    status.add_argument("spec")
    status.add_argument("--json", action="store_true")
    status.set_defaults(func=command_status)

    compare = subparsers.add_parser("compare", help="Create a reference/render comparison sheet")
    compare.add_argument("reference")
    compare.add_argument("render")
    compare.add_argument("output")
    compare.set_defaults(func=command_compare)

    mcp_status = subparsers.add_parser("mcp-status", help="Query the local BlenderMCP scene")
    mcp_status.add_argument("--port", type=int, default=9876)
    mcp_status.add_argument("--timeout", type=float, default=3.0)
    mcp_status.set_defaults(func=command_mcp_status)

    mcp_apply = subparsers.add_parser("mcp-apply", help="Execute generated Blender Python through local BlenderMCP")
    mcp_apply.add_argument("script")
    mcp_apply.add_argument("--port", type=int, default=9876)
    mcp_apply.add_argument("--timeout", type=float, default=30.0)
    mcp_apply.set_defaults(func=command_mcp_apply)

    review = subparsers.add_parser("review", help="Record one visual review decision")
    review.add_argument("spec")
    review.add_argument("--pass-id", required=True)
    review.add_argument(
        "--action",
        choices=["continue", "refine-spec", "refine-blender", "request-input", "stop"],
        required=True,
    )
    review.add_argument("--summary", required=True)
    review.add_argument("--render-screenshot")
    review.add_argument("--comparison-image")
    review.add_argument("--ai-vision-score", type=float)
    review.add_argument("--visual-threshold", type=float, default=0.70)
    review.add_argument("--layer-scores-json")
    destination = review.add_mutually_exclusive_group(required=True)
    destination.add_argument("--in-place", action="store_true")
    destination.add_argument("--output")
    review.set_defaults(func=command_review)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
