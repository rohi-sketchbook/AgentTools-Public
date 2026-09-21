# -*- coding: shift_jis -*-
from __future__ import annotations

from pathlib import Path
from typing import Any

BUILD_PASSES = [
    "blockout",
    "structural-pass",
    "form-refinement",
    "material-pass",
    "surface-pass",
    "lighting-pass",
    "interaction-pass",
    "optimization-pass",
]

SUPPORTED_LIGHT_TYPES = {"AREA", "POINT", "SUN", "SPOT"}

OBJECT_SECTIONS = [
    "road",
    "sidewalk",
    "buildings",
    "facade_modules",
    "windows",
    "signs",
    "street_lights",
    "traffic_lights",
    "poles",
    "guardrails",
    "road_markings",
    "puddles",
    "props",
    "vegetation",
]


def make_blockout_scene_spec(reference_path: str | Path, image_info: dict[str, Any]) -> dict[str, Any]:
    reference = Path(reference_path)
    aspect = image_info["width"] / image_info["height"]
    return {
        "schemaVersion": "0.1",
        "name": reference.stem + "_blockout",
        "reference": {
            "path": str(reference),
            "width": image_info["width"],
            "height": image_info["height"],
            "aspect": aspect,
        },
        "buildPasses": BUILD_PASSES.copy(),
        "pipelineState": {
            "passGateMode": "locked-sequential",
            "currentPass": "blockout",
            "completedPasses": [],
            "lastCompletedPass": "",
            "nextAction": "refine-spec",
        },
        "reviewHistory": [],
        "camera": {
            "type": "perspective",
            "focalLengthMm": 35.0,
            "sensorWidthMm": 36.0,
            "location": [0.0, -14.0, 6.0],
            "target": [0.0, 0.0, 2.0],
            "confidence": 0.1,
            "requiresVisionRefinement": True,
        },
        "world": {
            "backgroundColor": [0.015, 0.02, 0.035, 1.0],
            "strength": 0.25,
            "confidence": 0.1,
            "requiresVisionRefinement": True,
        },
        "materials": [
            {
                "id": "blockout_dark",
                "baseColor": [0.12, 0.14, 0.18, 1.0],
                "metallic": 0.0,
                "roughness": 0.7,
            },
            {
                "id": "blockout_mass",
                "baseColor": [0.24, 0.28, 0.34, 1.0],
                "metallic": 0.0,
                "roughness": 0.6,
            },
        ],
        "road": [
            {
                "id": "road_blockout",
                "primitive": "cube",
                "transform": {
                    "location": [0.0, 0.0, -0.1],
                    "rotationDeg": [0.0, 0.0, 0.0],
                    "size": [10.0, 18.0, 0.2],
                },
                "material": "blockout_dark",
                "confidence": 0.1,
                "referenceRegion": "lower-frame",
                "buildPass": "blockout",
                "requiresVisionRefinement": True,
            }
        ],
        "sidewalk": [],
        "buildings": [
            {
                "id": "primary_mass",
                "primitive": "cube",
                "transform": {
                    "location": [0.0, 2.5, 2.5],
                    "rotationDeg": [0.0, 0.0, 0.0],
                    "size": [7.0, 3.0, 5.0],
                },
                "material": "blockout_mass",
                "confidence": 0.05,
                "referenceRegion": "center-frame",
                "buildPass": "blockout",
                "requiresVisionRefinement": True,
            }
        ],
        "facade_modules": [],
        "windows": [],
        "signs": [],
        "street_lights": [],
        "traffic_lights": [],
        "poles": [],
        "guardrails": [],
        "road_markings": [],
        "puddles": [],
        "props": [],
        "vegetation": [],
        "lights": [],
        "emissive_sources": [],
        "reflection_targets": [],
        "atmosphere": {},
        "notes": [
            "This initial spec is a deterministic placeholder, not an image-derived scene understanding.",
            "Agent vision must refine camera, masses, proportions, and object inventory before blockout approval.",
        ],
    }


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _validate_vec3(value: Any, label: str, errors: list[str], *, positive: bool = False) -> None:
    if not isinstance(value, list) or len(value) != 3 or not all(_is_number(item) for item in value):
        errors.append(f"{label} must be a numeric vec3")
        return
    if positive and any(float(item) <= 0.0 for item in value):
        errors.append(f"{label} values must be > 0")


def validate_scene_spec(spec: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if spec.get("schemaVersion") != "0.1":
        errors.append("schemaVersion must be 0.1")

    camera = spec.get("camera")
    if not isinstance(camera, dict):
        errors.append("camera must be an object")
    else:
        _validate_vec3(camera.get("location"), "camera.location", errors)
        _validate_vec3(camera.get("target"), "camera.target", errors)
        focal = camera.get("focalLengthMm")
        if not _is_number(focal) or float(focal) <= 0.0:
            errors.append("camera.focalLengthMm must be > 0")

    if not isinstance(spec.get("world"), dict):
        errors.append("world must be an object")

    render_settings = spec.get("renderSettings", {})
    if not isinstance(render_settings, dict):
        errors.append("renderSettings must be an object")
    else:
        engine = render_settings.get("engine")
        if engine is not None and engine not in {"BLENDER_EEVEE", "BLENDER_WORKBENCH", "CYCLES"}:
            errors.append("renderSettings.engine must be BLENDER_EEVEE, BLENDER_WORKBENCH, or CYCLES")
        view_transform = render_settings.get("viewTransform")
        if view_transform is not None and (not isinstance(view_transform, str) or not view_transform.strip()):
            errors.append("renderSettings.viewTransform must be a non-empty string")
        look = render_settings.get("look")
        if look is not None and not isinstance(look, str):
            errors.append("renderSettings.look must be a string")
        exposure = render_settings.get("exposure")
        if exposure is not None and not _is_number(exposure):
            errors.append("renderSettings.exposure must be numeric")

    materials = spec.get("materials")
    material_ids: set[str] = set()
    if not isinstance(materials, list):
        errors.append("materials must be an array")
    else:
        for index, material in enumerate(materials):
            if not isinstance(material, dict):
                errors.append(f"materials[{index}] must be an object")
                continue
            material_id = material.get("id")
            if not isinstance(material_id, str) or not material_id.strip():
                errors.append(f"materials[{index}].id must be a non-empty string")
            elif material_id in material_ids:
                errors.append(f"duplicate material id: {material_id}")
            else:
                material_ids.add(material_id)

    object_ids: set[str] = set()
    for section in OBJECT_SECTIONS:
        records = spec.get(section)
        if not isinstance(records, list):
            errors.append(f"{section} must be an array")
            continue
        for index, record in enumerate(records):
            prefix = f"{section}[{index}]"
            if not isinstance(record, dict):
                errors.append(f"{prefix} must be an object")
                continue

            object_id = record.get("id")
            if not isinstance(object_id, str) or not object_id.strip():
                errors.append(f"{prefix}.id must be a non-empty string")
            elif object_id in object_ids:
                errors.append(f"duplicate object id: {object_id}")
            else:
                object_ids.add(object_id)

            primitive = record.get("primitive")
            if not isinstance(primitive, str) or not primitive.strip():
                errors.append(f"{prefix}.primitive must be a non-empty string")

            build_pass = record.get("buildPass")
            if build_pass not in BUILD_PASSES:
                errors.append(f"{prefix}.buildPass must be one of: {', '.join(BUILD_PASSES)}")

            material_id = record.get("material")
            if material_id is not None and material_id not in material_ids:
                errors.append(f"{prefix}.material references unknown material: {material_id}")

            confidence = record.get("confidence")
            if not _is_number(confidence) or not 0.0 <= float(confidence) <= 1.0:
                errors.append(f"{prefix}.confidence must be between 0 and 1")

            bevel_width = record.get("bevelWidth")
            if bevel_width is not None and (not _is_number(bevel_width) or float(bevel_width) < 0.0):
                errors.append(f"{prefix}.bevelWidth must be >= 0")
            bevel_segments = record.get("bevelSegments")
            if bevel_segments is not None and (
                not isinstance(bevel_segments, int)
                or isinstance(bevel_segments, bool)
                or not 1 <= bevel_segments <= 16
            ):
                errors.append(f"{prefix}.bevelSegments must be an integer between 1 and 16")
            bevel_build_pass = record.get("bevelBuildPass")
            if bevel_build_pass is not None and bevel_build_pass not in BUILD_PASSES:
                errors.append(f"{prefix}.bevelBuildPass must be one of: {', '.join(BUILD_PASSES)}")

            transform = record.get("transform")
            if not isinstance(transform, dict):
                errors.append(f"{prefix}.transform must be an object")
            else:
                _validate_vec3(transform.get("location"), f"{prefix}.transform.location", errors)
                _validate_vec3(transform.get("rotationDeg"), f"{prefix}.transform.rotationDeg", errors)
                _validate_vec3(transform.get("size"), f"{prefix}.transform.size", errors, positive=True)

    lights = spec.get("lights", [])
    if not isinstance(lights, list):
        errors.append("lights must be an array")
    else:
        for index, light in enumerate(lights):
            prefix = f"lights[{index}]"
            if not isinstance(light, dict):
                errors.append(f"{prefix} must be an object")
                continue

            light_id = light.get("id")
            if not isinstance(light_id, str) or not light_id.strip():
                errors.append(f"{prefix}.id must be a non-empty string")
            elif light_id in object_ids:
                errors.append(f"duplicate object/light id: {light_id}")
            else:
                object_ids.add(light_id)

            light_type = light.get("type")
            if light_type not in SUPPORTED_LIGHT_TYPES:
                errors.append(f"{prefix}.type must be one of: {', '.join(sorted(SUPPORTED_LIGHT_TYPES))}")

            build_pass = light.get("buildPass")
            if build_pass not in BUILD_PASSES:
                errors.append(f"{prefix}.buildPass must be one of: {', '.join(BUILD_PASSES)}")

            confidence = light.get("confidence")
            if not _is_number(confidence) or not 0.0 <= float(confidence) <= 1.0:
                errors.append(f"{prefix}.confidence must be between 0 and 1")

            _validate_vec3(light.get("location"), f"{prefix}.location", errors)
            if light.get("target") is not None:
                _validate_vec3(light.get("target"), f"{prefix}.target", errors)
            if light.get("rotationDeg") is not None:
                _validate_vec3(light.get("rotationDeg"), f"{prefix}.rotationDeg", errors)
            color = light.get("color")
            if color is not None:
                _validate_vec3(color, f"{prefix}.color", errors)
            energy = light.get("energy")
            if not _is_number(energy) or float(energy) <= 0.0:
                errors.append(f"{prefix}.energy must be > 0")
            if light_type == "AREA":
                size = light.get("size")
                if not _is_number(size) or float(size) <= 0.0:
                    errors.append(f"{prefix}.size must be > 0 for AREA")
            if light_type == "POINT":
                radius = light.get("shadowSoftSize", 0.25)
                if not _is_number(radius) or float(radius) < 0.0:
                    errors.append(f"{prefix}.shadowSoftSize must be >= 0 for POINT")
            if light_type == "SUN":
                angle = light.get("angleDeg", 0.526)
                if not _is_number(angle) or float(angle) < 0.0:
                    errors.append(f"{prefix}.angleDeg must be >= 0 for SUN")
            if light_type == "SPOT":
                spot_size = light.get("spotSizeDeg", 45.0)
                if not _is_number(spot_size) or not 0.0 < float(spot_size) <= 180.0:
                    errors.append(f"{prefix}.spotSizeDeg must be between 0 and 180 for SPOT")
                spot_blend = light.get("spotBlend", 0.15)
                if not _is_number(spot_blend) or not 0.0 <= float(spot_blend) <= 1.0:
                    errors.append(f"{prefix}.spotBlend must be between 0 and 1 for SPOT")
                radius = light.get("shadowSoftSize", 0.25)
                if not _is_number(radius) or float(radius) < 0.0:
                    errors.append(f"{prefix}.shadowSoftSize must be >= 0 for SPOT")

    return errors
