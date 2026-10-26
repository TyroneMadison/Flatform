"""Builds the Flatform Test app's sample models (CC0, made here): a T-pose humanoid with no skeleton and a simple car
with separate wheels and doors.

    blender -b -P test-app/make-samples.py -- test-app/seed

Writes humanoid.glb and car.glb into the folder. The humanoid is one closed mesh so bone heat weighting works.
"""
import math
import os
import sys

import bpy

out = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "."
os.makedirs(out, exist_ok=True)


def material(name, rgb, metallic=0.0, roughness=0.5):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1)
    b.inputs["Metallic"].default_value = metallic
    b.inputs["Roughness"].default_value = roughness
    return m


def export(path):
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB")


def capsule(a, b, r):
    """A cylinder from a to b with ball ends (Blender coordinates, metres)."""
    from mathutils import Vector
    a, b = Vector(a), Vector(b)
    d = b - a
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=d.length, location=(a + b) / 2, vertices=16)
    c = bpy.context.active_object
    c.rotation_mode = "QUATERNION"
    c.rotation_quaternion = d.to_track_quat("Z", "Y")
    parts = [c]
    for p in (a, b):
        bpy.ops.mesh.primitive_uv_sphere_add(radius=r, location=p, segments=16, ring_count=8)
        parts.append(bpy.context.active_object)
    return parts


# ---- humanoid: 1.8 m, T-pose, facing -Y (glTF +Z) ----
bpy.ops.wm.read_factory_settings(use_empty=True)
parts = []
parts += capsule((0, 0, 0.95), (0, 0, 1.42), 0.17)  # torso
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.12, location=(0, 0, 1.64), segments=24, ring_count=12)
parts.append(bpy.context.active_object)  # head
parts += capsule((0, 0, 1.42), (0, 0, 1.56), 0.06)  # neck
for s in (1, -1):
    parts += capsule((s * 0.12, 0, 1.44), (s * 0.85, 0, 1.44), 0.05)  # arm, out to the side
    parts += capsule((s * 0.10, 0, 0.95), (s * 0.11, 0, 0.08), 0.075)  # leg
    parts += capsule((s * 0.11, 0.02, 0.05), (s * 0.11, -0.16, 0.04), 0.045)  # foot, toes forward (-Y)
bpy.ops.object.select_all(action="DESELECT")
for p in parts:
    p.select_set(True)
bpy.context.view_layer.objects.active = parts[0]
bpy.ops.object.join()
body = bpy.context.active_object
body.name = "Body"
mod = body.modifiers.new("remesh", "REMESH")  # one closed surface
mod.mode = "VOXEL"
mod.voxel_size = 0.02
bpy.ops.object.modifier_apply(modifier="remesh")
bpy.ops.object.shade_smooth()
body.data.materials.append(material("skin", (0.62, 0.45, 0.36), roughness=0.6))
export(os.path.join(out, "humanoid.glb"))

# ---- car: 4.4 m long along X (like Tripo), nose on +X ----
bpy.ops.wm.read_factory_settings(use_empty=True)
paint = material("paint", (0.6, 0.02, 0.03), metallic=0.6, roughness=0.25)
tyre = material("tyre", (0.02, 0.02, 0.02), roughness=0.8)
glass = material("glass", (0.02, 0.03, 0.04), roughness=0.05)
bpy.ops.mesh.primitive_cube_add(location=(0, 0, 0.6))
car = bpy.context.active_object
car.name = "Body"
car.scale = (2.2, 0.9, 0.3)
car.data.materials.append(paint)
bpy.ops.mesh.primitive_cube_add(location=(-0.2, 0, 1.12))
cabin = bpy.context.active_object
cabin.name = "Windshield glass"
cabin.scale = (1.2, 0.8, 0.25)
cabin.data.materials.append(glass)
for name, x, y in (("Wheel_FL", 1.4, 0.85), ("Wheel_FR", 1.4, -0.85), ("Wheel_RL", -1.4, 0.85), ("Wheel_RR", -1.4, -0.85)):
    bpy.ops.mesh.primitive_cylinder_add(radius=0.34, depth=0.25, location=(x, y, 0.34), rotation=(math.pi / 2, 0, 0), vertices=32)
    w = bpy.context.active_object
    w.name = name
    w.data.materials.append(tyre)
for name, y in (("Door_L", 0.91), ("Door_R", -0.91)):
    bpy.ops.mesh.primitive_cube_add(location=(0.1, y, 0.65))
    d = bpy.context.active_object
    d.name = name
    d.scale = (0.6, 0.02, 0.25)
    d.data.materials.append(paint)
export(os.path.join(out, "car.glb"))
print("FLATFORM_SAMPLES", out)
