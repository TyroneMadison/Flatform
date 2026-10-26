"""Flatform free auto-rig for humanoids (Blender 4.x / 5.x). No paid service.

    blender -b -P blender_autorig.py -- --glb model.glb --out rigged.glb

Imports the model, builds a skeleton with Mixamo bone names (the names in public/lib/motion.js BONES, so rig.js
mapBones finds every one), places the joints from the mesh itself, binds the mesh with automatic (bone heat) weights
and saves a GLB with the skin. Expects a humanoid standing upright on its feet, facing the camera (glTF +Z, Blender -Y);
arms can be out (T-pose), angled (A-pose) or down.

Bone axes follow the pose presets in motion.js: every bone's Y runs along it, spine, legs and feet bend about +X
(the model's left), arms swing about their own X and lift about Z, which points forward.
Prints "FLATFORM_RIG <bones> <unweighted vertices>" when done, "FLATFORM_ERROR <message>" on failure.
"""
import argparse
import sys

import bpy
from mathutils import Vector

BONES = ["Hips", "Spine", "Spine1", "Spine2", "Neck", "Head",
         "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand", "RightShoulder", "RightArm", "RightForeArm", "RightHand",
         "LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase", "RightUpLeg", "RightLeg", "RightFoot", "RightToeBase"]
X = Vector((1, 0, 0))
FORWARD = Vector((0, -1, 0))


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser(description="Flatform auto-rig")
    p.add_argument("--glb", required=True)
    p.add_argument("--out", required=True)
    return p.parse_args(argv)


def import_meshes(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path)
    objs = list(bpy.context.scene.objects)
    if any(o.type == "ARMATURE" for o in objs):
        raise RuntimeError("This model already has a skeleton")
    meshes = [o for o in objs if o.type == "MESH"]
    if not meshes:
        raise RuntimeError("No mesh in this model")
    return meshes


def landmarks(meshes):
    """Joint positions in world space, from the bounds and where the vertices are."""
    pts = [o.matrix_world @ v.co for o in meshes for v in o.data.vertices]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    h = hi.z - lo.z
    if h <= 0 or h < 0.8 * (hi.y - lo.y):
        raise RuntimeError("This does not look like a standing humanoid (it is not taller than it is deep)")
    z = lambda f: lo.z + f * h  # noqa: E731
    mean = lambda vs, i, d: sum(v[i] for v in vs) / len(vs) if vs else d  # noqa: E731
    torso = [p for p in pts if z(0.55) < p.z < z(0.75)]
    cx = mean(torso, 0, (lo.x + hi.x) / 2)
    cy = mean(torso, 1, (lo.y + hi.y) / 2)
    # Legs: the vertices low down, split left and right of the middle.
    low = [p for p in pts if p.z < z(0.2)]
    leg_l = mean([p for p in low if p.x > cx], 0, cx + 0.09 * h)
    leg_r = mean([p for p in low if p.x < cx], 0, cx - 0.09 * h)
    # Hand tips: the outermost vertices on each side (5% band), wherever the arms point.
    band = 0.05 * (hi.x - lo.x)
    tip_l = [p for p in pts if p.x > hi.x - band and p.z > z(0.3)]
    tip_r = [p for p in pts if p.x < lo.x + band and p.z > z(0.3)]
    j = {}
    j["Hips"] = Vector((cx, cy, z(0.52)))
    j["Spine"] = Vector((cx, cy, z(0.58)))
    j["Spine1"] = Vector((cx, cy, z(0.65)))
    j["Spine2"] = Vector((cx, cy, z(0.72)))
    j["Neck"] = Vector((cx, cy, z(0.82)))
    j["Head"] = Vector((cx, cy, z(0.87)))
    j["HeadTop"] = Vector((cx, cy, z(1.0)))
    for side, s, tips in (("Left", 1, tip_l), ("Right", -1, tip_r)):
        shoulder = Vector((cx + s * 0.02 * h, cy, z(0.80)))
        arm = Vector((cx + s * 0.10 * h, cy, z(0.80)))
        tip = Vector((mean(tips, 0, arm.x + s * 0.4 * h), mean(tips, 1, cy), mean(tips, 2, z(0.8))))
        if (tip - arm).length < 0.25 * h:  # arms hug the body: no clear tip, hang them down the sides
            tip = Vector((arm.x + s * 0.04 * h, cy, z(0.40)))
        j[side + "Shoulder"] = shoulder
        j[side + "Arm"] = arm
        j[side + "ForeArm"] = arm.lerp(tip, 0.42)
        j[side + "Hand"] = arm.lerp(tip, 0.76)
        j[side + "HandTip"] = tip
        x = leg_l if s > 0 else leg_r
        j[side + "UpLeg"] = Vector((x, cy, z(0.50)))
        j[side + "Leg"] = Vector((x, cy, z(0.27)))
        j[side + "Foot"] = Vector((x, cy, z(0.05)))
        j[side + "ToeBase"] = Vector((x, cy - 0.07 * h, z(0.01)))
        j[side + "ToeEnd"] = Vector((x, cy - 0.12 * h, z(0.01)))
    return j


# bone: (head joint, tail joint, parent)
LAYOUT = {
    "Hips": ("Hips", "Spine", None), "Spine": ("Spine", "Spine1", "Hips"), "Spine1": ("Spine1", "Spine2", "Spine"),
    "Spine2": ("Spine2", "Neck", "Spine1"), "Neck": ("Neck", "Head", "Spine2"), "Head": ("Head", "HeadTop", "Neck"),
}
for _s in ("Left", "Right"):
    LAYOUT.update({
        _s + "Shoulder": (_s + "Shoulder", _s + "Arm", "Spine2"), _s + "Arm": (_s + "Arm", _s + "ForeArm", _s + "Shoulder"),
        _s + "ForeArm": (_s + "ForeArm", _s + "Hand", _s + "Arm"), _s + "Hand": (_s + "Hand", _s + "HandTip", _s + "ForeArm"),
        _s + "UpLeg": (_s + "UpLeg", _s + "Leg", "Hips"), _s + "Leg": (_s + "Leg", _s + "Foot", _s + "UpLeg"),
        _s + "Foot": (_s + "Foot", _s + "ToeBase", _s + "Leg"), _s + "ToeBase": (_s + "ToeBase", _s + "ToeEnd", _s + "Foot"),
    })


def build_armature(j):
    data = bpy.data.armatures.new("Armature")
    arm = bpy.data.objects.new("Armature", data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    for name in BONES:
        head, tail, parent = LAYOUT[name]
        b = data.edit_bones.new(name)
        b.head, b.tail = j[head], j[tail]
        if parent:
            b.parent = data.edit_bones[parent]
            b.use_connect = False
        y = (b.tail - b.head).normalized()
        b.align_roll(FORWARD if ("Arm" in name or "Hand" in name or "Shoulder" in name) else X.cross(y))
    bpy.ops.object.mode_set(mode="OBJECT")
    return arm


def nearest_bone(arm, p):
    best, name = None, None
    for b in arm.data.bones:
        a, c = arm.matrix_world @ b.head_local, arm.matrix_world @ b.tail_local
        ab = c - a
        t = max(0.0, min(1.0, (p - a).dot(ab) / max(ab.length_squared, 1e-12)))
        d = (a + ab * t - p).length
        if best is None or d < best:
            best, name = d, b.name
    return name


def bind(meshes, arm):
    """Automatic weights; any vertex bone heat leaves without a weight goes to its nearest bone."""
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes:
        o.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    unweighted = 0
    for o in meshes:
        for v in o.data.vertices:
            if not any(g.weight > 0 for g in v.groups):
                name = nearest_bone(arm, o.matrix_world @ v.co)
                group = o.vertex_groups.get(name) or o.vertex_groups.new(name=name)
                group.add([v.index], 1.0, "REPLACE")
                unweighted += 1
    return unweighted


def main():
    args = parse_args()
    meshes = import_meshes(args.glb)
    arm = build_armature(landmarks(meshes))
    unweighted = bind(meshes, arm)
    bpy.ops.export_scene.gltf(filepath=args.out, export_format="GLB", export_skins=True, export_animations=False)
    print(f"FLATFORM_RIG {len(BONES)} {unweighted}", flush=True)


try:
    main()
except Exception as error:  # noqa: BLE001 - report every failure to Flatform as a non-zero exit
    print(f"FLATFORM_ERROR {error}", flush=True)
    sys.exit(1)
