# -*- coding: shift_jis -*-
from __future__ import annotations

import json
from typing import Any

from pipeline_state import current_pass, pass_order
from scene_spec import OBJECT_SECTIONS, validate_scene_spec

SUPPORTED_PRIMITIVES = {"cube", "plane", "sphere", "ellipsoid", "cylinder", "cone"}


def _literal(value: Any) -> str:
    return repr(value)


def generate_blender_script(spec: dict[str, Any]) -> str:
    errors = validate_scene_spec(spec)
    if errors:
        raise ValueError("Invalid SceneSpec: " + "; ".join(errors))

    order = pass_order(spec)
    unlocked = current_pass(spec)
    max_pass_index = len(order) - 1 if unlocked == "complete" else order.index(unlocked)

    unsupported: list[str] = []
    for section in OBJECT_SECTIONS:
        for item in spec.get(section, []):
            item_pass = str(item.get("buildPass") or "blockout")
            if item_pass not in order:
                raise ValueError(f"Unknown buildPass on {section}:{item.get('id', '<unnamed>')}: {item_pass}")
            if order.index(item_pass) > max_pass_index:
                continue
            primitive = item.get("primitive")
            if primitive not in SUPPORTED_PRIMITIVES:
                unsupported.append(f"{section}:{item.get('id', '<unnamed>')}:{primitive}")
    if unsupported:
        raise ValueError("Unsupported primitives: " + ", ".join(unsupported))

    payload = json.dumps(spec, ensure_ascii=True, separators=(",", ":"))
    return f'''# -*- coding: shift_jis -*-
import bpy
import json
import math
from mathutils import Vector

SCENE_SPEC = json.loads({_literal(payload)})
OBJECT_SECTIONS = {_literal(OBJECT_SECTIONS)}
PASS_ORDER = {_literal(order)}
UNLOCKED_PASS = {_literal(unlocked)}
MAX_PASS_INDEX = {max_pass_index}


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.meshes, bpy.data.curves, bpy.data.materials, bpy.data.cameras, bpy.data.lights):
        for block in list(datablocks):
            if block.users == 0:
                datablocks.remove(block)


def find_node_by_type(node_tree, bl_idname):
    for node in node_tree.nodes:
        if node.bl_idname == bl_idname:
            return node
    return None


def get_or_create_material(record):
    material = bpy.data.materials.get(record["id"])
    if material is None:
        material = bpy.data.materials.new(record["id"])
    base_color = record.get("baseColor", [0.8, 0.8, 0.8, 1.0])
    material.diffuse_color = base_color
    material.use_nodes = True
    node = find_node_by_type(material.node_tree, "ShaderNodeBsdfPrincipled")
    if node is not None:
        if "Base Color" in node.inputs:
            node.inputs["Base Color"].default_value = base_color
        if "Metallic" in node.inputs:
            node.inputs["Metallic"].default_value = float(record.get("metallic", 0.0))
        if "Roughness" in node.inputs:
            node.inputs["Roughness"].default_value = float(record.get("roughness", 0.5))
        emission = record.get("emissionColor")
        if emission is not None and "Emission Color" in node.inputs:
            node.inputs["Emission Color"].default_value = emission
        if "Emission Strength" in node.inputs:
            node.inputs["Emission Strength"].default_value = float(record.get("emissionStrength", 0.0))
    return material


def add_primitive(record, materials):
    transform = record.get("transform", {{}})
    location = transform.get("location", [0.0, 0.0, 0.0])
    rotation_deg = transform.get("rotationDeg", [0.0, 0.0, 0.0])
    size = transform.get("size", [1.0, 1.0, 1.0])
    primitive = record["primitive"]

    if primitive == "cube":
        bpy.ops.mesh.primitive_cube_add(location=location)
        obj = bpy.context.object
        obj.scale = [size[0] * 0.5, size[1] * 0.5, size[2] * 0.5]
    elif primitive == "plane":
        bpy.ops.mesh.primitive_plane_add(size=2.0, location=location)
        obj = bpy.context.object
        obj.scale = [size[0] * 0.5, size[1] * 0.5, 1.0]
    elif primitive in ("sphere", "ellipsoid"):
        bpy.ops.mesh.primitive_uv_sphere_add(location=location)
        obj = bpy.context.object
        obj.scale = [size[0] * 0.5, size[1] * 0.5, size[2] * 0.5]
    elif primitive == "cylinder":
        bpy.ops.mesh.primitive_cylinder_add(vertices=32, radius=1.0, depth=2.0, location=location)
        obj = bpy.context.object
        obj.scale = [size[0] * 0.5, size[1] * 0.5, size[2] * 0.5]
    elif primitive == "cone":
        bpy.ops.mesh.primitive_cone_add(vertices=32, radius1=1.0, radius2=0.0, depth=2.0, location=location)
        obj = bpy.context.object
        obj.scale = [size[0] * 0.5, size[1] * 0.5, size[2] * 0.5]
    else:
        raise ValueError(f"Unsupported primitive: {{primitive}}")

    obj.name = record.get("id", primitive)
    obj.rotation_euler = [math.radians(v) for v in rotation_deg]

    bevel_width = float(record.get("bevelWidth", 0.0))
    bevel_build_pass = str(record.get("bevelBuildPass") or record.get("buildPass") or "blockout")
    if bevel_width > 0.0 and PASS_ORDER.index(bevel_build_pass) <= MAX_PASS_INDEX:
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        bevel = obj.modifiers.new(name="img2blender_bevel", type="BEVEL")
        bevel.width = bevel_width
        bevel.segments = int(record.get("bevelSegments", 3))
        bevel.limit_method = "ANGLE"

    material_id = record.get("material")
    if material_id and material_id in materials and hasattr(obj.data, "materials"):
        obj.data.materials.append(materials[material_id])
    obj["img2blender_build_pass"] = record.get("buildPass", "blockout")
    obj["img2blender_confidence"] = float(record.get("confidence", 0.0))
    obj["img2blender_reference_region"] = record.get("referenceRegion", "")
    return obj


def add_light(record):
    light_type = str(record.get("type") or "POINT").upper()
    light_data = bpy.data.lights.new(record["id"], type=light_type)
    light_data.energy = float(record.get("energy", 1000.0))
    light_data.color = tuple(record.get("color", [1.0, 1.0, 1.0]))
    if light_type == "AREA":
        light_data.shape = str(record.get("shape") or "DISK")
        light_data.size = float(record.get("size", 5.0))
    elif light_type == "POINT":
        light_data.shadow_soft_size = float(record.get("shadowSoftSize", 0.25))
    elif light_type == "SUN":
        light_data.angle = math.radians(float(record.get("angleDeg", 0.526)))
    elif light_type == "SPOT":
        light_data.spot_size = math.radians(float(record.get("spotSizeDeg", 45.0)))
        light_data.spot_blend = float(record.get("spotBlend", 0.15))
        light_data.shadow_soft_size = float(record.get("shadowSoftSize", 0.25))

    light_obj = bpy.data.objects.new(record["id"], light_data)
    bpy.context.scene.collection.objects.link(light_obj)
    light_obj.location = record.get("location", [0.0, 0.0, 0.0])
    target = record.get("target")
    if target is not None:
        direction = Vector(target) - light_obj.location
        if direction.length > 0.0:
            light_obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    else:
        light_obj.rotation_euler = [math.radians(v) for v in record.get("rotationDeg", [0.0, 0.0, 0.0])]
    light_obj["img2blender_build_pass"] = record.get("buildPass", "lighting-pass")
    light_obj["img2blender_confidence"] = float(record.get("confidence", 0.0))
    light_obj["img2blender_reference_region"] = record.get("referenceRegion", "")
    return light_obj


def configure_world(record):
    world = bpy.context.scene.world
    if world is None:
        world = bpy.data.worlds.new("World")
        bpy.context.scene.world = world
    world.use_nodes = True
    background = find_node_by_type(world.node_tree, "ShaderNodeBackground")
    if background is not None:
        background.inputs["Color"].default_value = record.get("backgroundColor", [0.05, 0.05, 0.05, 1.0])
        background.inputs["Strength"].default_value = float(record.get("strength", 1.0))


def configure_render_settings(record):
    scene = bpy.context.scene
    engine = record.get("engine")
    if engine:
        scene.render.engine = engine
    view_transform = record.get("viewTransform")
    if view_transform:
        scene.view_settings.view_transform = view_transform
    if "look" in record:
        scene.view_settings.look = record.get("look") or "None"
    if "exposure" in record:
        scene.view_settings.exposure = float(record.get("exposure", 0.0))


def configure_camera(record):
    camera_data = bpy.data.cameras.new("img2blender_camera")
    camera_obj = bpy.data.objects.new("img2blender_camera", camera_data)
    bpy.context.scene.collection.objects.link(camera_obj)
    camera_obj.location = record.get("location", [0.0, -10.0, 5.0])
    camera_data.lens = float(record.get("focalLengthMm", 35.0))
    camera_data.sensor_width = float(record.get("sensorWidthMm", 36.0))
    target = Vector(record.get("target", [0.0, 0.0, 0.0]))
    direction = target - camera_obj.location
    camera_obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = camera_obj


def main():
    clear_scene()
    configure_world(SCENE_SPEC.get("world", {{}}))
    materials = {{record["id"]: get_or_create_material(record) for record in SCENE_SPEC.get("materials", [])}}
    for section in OBJECT_SECTIONS:
        for record in SCENE_SPEC.get(section, []):
            record_pass = str(record.get("buildPass") or "blockout")
            if record_pass not in PASS_ORDER:
                raise ValueError(f"Unknown buildPass: {{record_pass}}")
            if PASS_ORDER.index(record_pass) > MAX_PASS_INDEX:
                continue
            add_primitive(record, materials)
    for record in SCENE_SPEC.get("lights", []):
        record_pass = str(record.get("buildPass") or "lighting-pass")
        if record_pass not in PASS_ORDER:
            raise ValueError(f"Unknown light buildPass: {{record_pass}}")
        if PASS_ORDER.index(record_pass) > MAX_PASS_INDEX:
            continue
        add_light(record)
    configure_camera(SCENE_SPEC.get("camera", {{}}))
    configure_render_settings(SCENE_SPEC.get("renderSettings", {{}}))
    scene = bpy.context.scene
    ref = SCENE_SPEC.get("reference", {{}})
    if ref.get("width") and ref.get("height"):
        scene.render.resolution_x = int(ref["width"])
        scene.render.resolution_y = int(ref["height"])
        scene.render.resolution_percentage = 100
    scene["img2blender_schema_version"] = SCENE_SPEC.get("schemaVersion", "")
    scene["img2blender_reference"] = ref.get("path", "")


main()
'''
