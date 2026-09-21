# -*- coding: shift_jis -*-
from __future__ import annotations

import json
import socket
import struct
import tempfile
import threading
import unittest
import zlib
from pathlib import Path
import sys

THIS_DIR = Path(__file__).resolve().parent
MODULE_DIR = THIS_DIR.parent
if str(MODULE_DIR) not in sys.path:
    sys.path.insert(0, str(MODULE_DIR))

from blender_generator import generate_blender_script
from blender_mcp_client import get_scene_info
from comparison_adapter import make_comparison_sheet
from pipeline_state import append_review, current_pass
from png_probe import PNG_SIGNATURE, probe_png
from scene_spec import make_blockout_scene_spec, validate_scene_spec


def write_minimal_png_header(path: Path, width: int = 1280, height: int = 720) -> None:
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    payload = PNG_SIGNATURE + struct.pack(">I", 13) + b"IHDR" + ihdr + b"\x00\x00\x00\x00"
    path.write_bytes(payload)


def write_valid_rgb_png(path: Path, width: int = 4, height: int = 4) -> None:
    def chunk(kind: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(kind)
        crc = zlib.crc32(data, crc) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", crc)

    scanlines = bytearray()
    for y in range(height):
        scanlines.append(0)
        for x in range(width):
            scanlines.extend((x * 30, y * 30, 80))
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    path.write_bytes(
        PNG_SIGNATURE
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(scanlines)))
        + chunk(b"IEND", b"")
    )


class CoreTests(unittest.TestCase):
    def test_probe_accepts_8bit_non_interlaced_png(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "reference.png"
            write_minimal_png_header(path)
            result = probe_png(path)
            self.assertEqual(result["width"], 1280)
            self.assertEqual(result["height"], 720)
            self.assertTrue(result["safeBaseline"])

    def test_blockout_spec_validates(self) -> None:
        info = {"width": 1280, "height": 720}
        spec = make_blockout_scene_spec("references/reference.png", info)
        self.assertEqual(validate_scene_spec(spec), [])
        self.assertEqual(spec["pipelineState"]["currentPass"], "blockout")
        self.assertTrue(spec["camera"]["requiresVisionRefinement"])
        self.assertEqual(spec["lights"], [])

    def test_validation_rejects_duplicate_ids_and_unknown_material(self) -> None:
        info = {"width": 1280, "height": 720}
        spec = make_blockout_scene_spec("references/reference.png", info)
        spec["buildings"].append(
            {
                "id": "primary_mass",
                "primitive": "cube",
                "transform": {
                    "location": [0.0, 0.0, 1.0],
                    "rotationDeg": [0.0, 0.0, 0.0],
                    "size": [1.0, 1.0, 1.0],
                },
                "material": "missing_material",
                "confidence": 0.5,
                "referenceRegion": "center-frame",
                "buildPass": "not-a-pass",
            }
        )
        errors = validate_scene_spec(spec)
        self.assertTrue(any("duplicate object id" in error for error in errors))
        self.assertTrue(any("unknown material" in error for error in errors))
        self.assertTrue(any("buildPass" in error for error in errors))

    def test_generated_blender_script_is_python_syntax(self) -> None:
        info = {"width": 1280, "height": 720}
        spec = make_blockout_scene_spec("references/reference.png", info)
        script = generate_blender_script(spec)
        compile(script, "generated_blockout.py", "exec")
        self.assertIn("import bpy", script)
        self.assertIn("primary_mass", script)
        self.assertIn("material.diffuse_color = base_color", script)
        self.assertIn('type="BEVEL"', script)
        self.assertIn("bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)", script)
        self.assertIn("PASS_ORDER.index(bevel_build_pass) <= MAX_PASS_INDEX", script)
        self.assertIn('find_node_by_type(material.node_tree, "ShaderNodeBsdfPrincipled")', script)
        self.assertIn('find_node_by_type(world.node_tree, "ShaderNodeBackground")', script)

    def test_validation_rejects_invalid_bevel_settings(self) -> None:
        info = {"width": 1280, "height": 720}
        spec = make_blockout_scene_spec("references/reference.png", info)
        spec["buildings"][0]["bevelWidth"] = -0.1
        spec["buildings"][0]["bevelSegments"] = 0
        spec["buildings"][0]["bevelBuildPass"] = "not-a-pass"
        errors = validate_scene_spec(spec)
        self.assertTrue(any("bevelWidth" in error for error in errors))
        self.assertTrue(any("bevelSegments" in error for error in errors))
        self.assertTrue(any("bevelBuildPass" in error for error in errors))

    def test_light_records_validate_and_generate(self) -> None:
        info = {"width": 1280, "height": 720}
        spec = make_blockout_scene_spec("references/reference.png", info)
        spec["renderSettings"] = {
            "engine": "BLENDER_EEVEE",
            "viewTransform": "AgX",
            "look": "None",
            "exposure": 0.0,
        }
        spec["lights"].append(
            {
                "id": "preview_key",
                "type": "AREA",
                "location": [0.0, -3.0, 5.0],
                "target": [0.0, 2.5, 2.0],
                "color": [1.0, 0.95, 0.9],
                "energy": 900.0,
                "size": 6.0,
                "confidence": 0.8,
                "referenceRegion": "whole-frame",
                "buildPass": "blockout",
            }
        )
        self.assertEqual(validate_scene_spec(spec), [])
        script = generate_blender_script(spec)
        self.assertIn("preview_key", script)
        self.assertIn("bpy.data.lights.new", script)
        self.assertIn("light_data.size", script)
        self.assertIn("configure_render_settings", script)
        self.assertIn("scene.view_settings.view_transform", script)

        spec["lights"][0]["type"] = "LASER"
        spec["lights"][0]["energy"] = 0.0
        errors = validate_scene_spec(spec)
        self.assertTrue(any("lights[0].type" in error for error in errors))
        self.assertTrue(any("lights[0].energy" in error for error in errors))

        spec["renderSettings"]["engine"] = "NOT_A_RENDERER"
        errors = validate_scene_spec(spec)
        self.assertTrue(any("renderSettings.engine" in error for error in errors))

    def test_visual_pass_requires_evidence_to_continue(self) -> None:
        info = {"width": 1280, "height": 720}
        spec = make_blockout_scene_spec("references/reference.png", info)
        with self.assertRaisesRegex(ValueError, "render screenshot"):
            append_review(
                spec,
                pass_id="blockout",
                action="continue",
                summary="looks good",
                ai_vision_score=0.9,
            )
        self.assertEqual(current_pass(spec), "blockout")

    def test_continue_unlocks_next_pass(self) -> None:
        info = {"width": 1280, "height": 720}
        spec = make_blockout_scene_spec("references/reference.png", info)
        append_review(
            spec,
            pass_id="blockout",
            action="continue",
            summary="blockout accepted",
            render_screenshot="output/renders/blockout.png",
            comparison_image="output/comparisons/blockout.png",
            ai_vision_score=0.82,
        )
        self.assertEqual(current_pass(spec), "structural-pass")

    def test_blender_mcp_client_uses_local_json_protocol(self) -> None:
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.bind(("127.0.0.1", 0))
        server.listen(1)
        port = server.getsockname()[1]
        received: list[dict] = []

        def serve_once() -> None:
            try:
                client, _ = server.accept()
                with client:
                    payload = client.recv(8192)
                    received.append(json.loads(payload.decode("utf-8")))
                    client.sendall(json.dumps({"status": "success", "result": {"name": "Scene"}}).encode("utf-8"))
            finally:
                server.close()

        thread = threading.Thread(target=serve_once, daemon=True)
        thread.start()
        response = get_scene_info(port=port, timeout=2.0)
        thread.join(timeout=2.0)
        self.assertEqual(response["status"], "success")
        self.assertEqual(received[0]["type"], "get_scene_info")
        self.assertEqual(received[0]["params"], {})

    def test_upstream_comparison_adapter_writes_sheet(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            reference = root / "reference.png"
            render = root / "render.png"
            output = root / "comparison.png"
            write_valid_rgb_png(reference)
            write_valid_rgb_png(render)
            make_comparison_sheet(reference, render, output)
            self.assertTrue(output.is_file())
            self.assertGreater(output.stat().st_size, 0)

    def test_future_pass_geometry_is_not_emitted_early(self) -> None:
        info = {"width": 1280, "height": 720}
        spec = make_blockout_scene_spec("references/reference.png", info)
        spec["windows"].append(
            {
                "id": "future_windows",
                "primitive": "cube",
                "transform": {
                    "location": [0.0, 0.0, 1.0],
                    "rotationDeg": [0.0, 0.0, 0.0],
                    "size": [1.0, 1.0, 1.0],
                },
                "material": "blockout_mass",
                "confidence": 0.5,
                "referenceRegion": "center-frame",
                "buildPass": "surface-pass",
            }
        )
        script = generate_blender_script(spec)
        self.assertIn("future_windows", script)
        self.assertIn("MAX_PASS_INDEX = 0", script)
        self.assertIn("if PASS_ORDER.index(record_pass) > MAX_PASS_INDEX", script)


if __name__ == "__main__":
    unittest.main()
