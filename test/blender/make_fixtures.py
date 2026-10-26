"""Test models for the real Blender tests (npm run test:blender), made fresh each run so nothing binary is checked in.

    blender -b --factory-startup -P make_fixtures.py -- <out folder>

car.glb: a box car about 4.4 m long along X with four wheels (named like Tripo parts).
mixamo-rig.glb: a small humanoid with a Mixamo-named skeleton (Hips, Spine ... LeftArm, LeftForeArm, LeftHand ...)
and a skinned body, one box per bone, exported the way Mixamo characters reach Flatform: as a GLB with a skin.
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Vector

out = sys.argv[sys.argv.index("--") + 1]
os.makedirs(out, exist_ok=True)


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def material(name, rgb):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (*rgb, 1)
    return m


def export(path):
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", export_yup=True, export_apply=False)
    print(f"FIXTURE {path}")


# ---- car ----
reset()
paint = material("Paint", (0.6, 0.05, 0.04))
tyre = material("Tyre", (0.02, 0.02, 0.02))
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.75))
body = bpy.context.object
body.name = "Body"
body.scale = (4.4, 1.8, 0.8)
body.data.materials.append(paint)
bpy.ops.mesh.primitive_cube_add(size=1, location=(-0.3, 0, 1.4))
cabin = bpy.context.object
cabin.name = "Cabin"
cabin.scale = (2.2, 1.6, 0.6)
cabin.data.materials.append(paint)
for name, x, y in (("Wheel_FL", 1.4, 0.9), ("Wheel_FR", 1.4, -0.9), ("Wheel_RL", -1.4, 0.9), ("Wheel_RR", -1.4, -0.9)):
    bpy.ops.mesh.primitive_cylinder_add(radius=0.36, depth=0.3, location=(x, y, 0.36), rotation=(math.pi / 2, 0, 0))
    bpy.context.object.name = name
    bpy.context.object.data.materials.append(tyre)
export(os.path.join(out, "car.glb"))

# ---- Mixamo-named rig ----
reset()
BONES = [  # name, parent, head, tail (metres, Blender Z up, facing -Y)
    ("Hips", None, (0, 0, 1.0), (0, 0, 1.1)),
    ("Spine", "Hips", (0, 0, 1.1), (0, 0, 1.22)),
    ("Spine1", "Spine", (0, 0, 1.22), (0, 0, 1.34)),
    ("Spine2", "Spine1", (0, 0, 1.34), (0, 0, 1.46)),
    ("Neck", "Spine2", (0, 0, 1.46), (0, 0, 1.56)),
    ("Head", "Neck", (0, 0, 1.56), (0, 0, 1.8)),
    ("LeftShoulder", "Spine2", (0.04, 0, 1.42), (0.18, 0, 1.42)),
    ("LeftArm", "LeftShoulder", (0.18, 0, 1.42), (0.46, 0, 1.42)),
    ("LeftForeArm", "LeftArm", (0.46, 0, 1.42), (0.72, 0, 1.42)),
    ("LeftHand", "LeftForeArm", (0.72, 0, 1.42), (0.82, 0, 1.42)),
    ("RightShoulder", "Spine2", (-0.04, 0, 1.42), (-0.18, 0, 1.42)),
    ("RightArm", "RightShoulder", (-0.18, 0, 1.42), (-0.46, 0, 1.42)),
    ("RightForeArm", "RightArm", (-0.46, 0, 1.42), (-0.72, 0, 1.42)),
    ("RightHand", "RightForeArm", (-0.72, 0, 1.42), (-0.82, 0, 1.42)),
    ("LeftUpLeg", "Hips", (0.1, 0, 0.98), (0.1, 0, 0.55)),
    ("LeftLeg", "LeftUpLeg", (0.1, 0, 0.55), (0.1, 0, 0.1)),
    ("LeftFoot", "LeftLeg", (0.1, 0, 0.1), (0.1, -0.14, 0.03)),
    ("LeftToeBase", "LeftFoot", (0.1, -0.14, 0.03), (0.1, -0.22, 0.03)),
    ("RightUpLeg", "Hips", (-0.1, 0, 0.98), (-0.1, 0, 0.55)),
    ("RightLeg", "RightUpLeg", (-0.1, 0, 0.55), (-0.1, 0, 0.1)),
    ("RightFoot", "RightLeg", (-0.1, 0, 0.1), (-0.1, -0.14, 0.03)),
    ("RightToeBase", "RightFoot", (-0.1, -0.14, 0.03), (-0.1, -0.22, 0.03)),
]
data = bpy.data.armatures.new("Armature")
arm = bpy.data.objects.new("Armature", data)
bpy.context.scene.collection.objects.link(arm)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode="EDIT")
for name, parent, head, tail in BONES:
    e = data.edit_bones.new(name)
    e.head, e.tail = head, tail
    e.roll = 0.3 if "Arm" in name else 0.0  # not the default roll, so bone axes differ from the world's
    if parent:
        e.parent = data.edit_bones[parent]
        e.use_connect = False
bpy.ops.object.mode_set(mode="OBJECT")

skin = material("Skin", (0.8, 0.55, 0.4))
mesh = bpy.data.meshes.new("Body")
obj = bpy.data.objects.new("Body", mesh)
bpy.context.scene.collection.objects.link(obj)
bm = bmesh.new()
groups = {}
for name, _, head, tail in BONES:
    h, t = Vector(head), Vector(tail)
    mid, d = (h + t) / 2, t - h
    half = Vector((max(abs(d.x) / 2, 0.05), max(abs(d.y) / 2, 0.05), max(abs(d.z) / 2, 0.05)))
    if name == "Head":
        half = Vector((0.1, 0.1, 0.12))
    res = bmesh.ops.create_cube(bm, size=1.0)
    for v in res["verts"]:
        v.co = mid + Vector((v.co.x * 2 * half.x, v.co.y * 2 * half.y, v.co.z * 2 * half.z))
    groups[name] = [v for v in res["verts"]]
bm.verts.index_update()
ids = {name: [v.index for v in vs] for name, vs in groups.items()}
bm.to_mesh(mesh)
bm.free()
mesh.materials.append(skin)
for name, vs in ids.items():
    obj.vertex_groups.new(name=name).add(vs, 1.0, "REPLACE")
obj.parent = arm
obj.modifiers.new("Armature", "ARMATURE").object = arm
export(os.path.join(out, "mixamo-rig.glb"))
