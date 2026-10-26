"""Flatform free auto-rig for humanoids (Blender 4.x / 5.x), the Blender half. No paid service.

The thinking (which way the body faces, where the limbs and joints are, how every vertex is bound) is
public/lib/autorig.js, run by Flatform between two Blender steps, each in the rig job's own folder:

    blender -b -P blender_autorig.py -- --glb model.glb --dump <job folder>
        writes mesh.json (objects and vertex counts), positions.f32 (every vertex, glTF coords) and tris.u32
    blender -b -P blender_autorig.py -- --glb model.glb --build <job folder> --out rigged.glb
        reads rig.json (bones in glTF coords, the body's forward and left) and weights.u8 (per vertex: bone, second
        bone, first bone's weight 0-255), builds the Mixamo-named skeleton (the names in public/lib/motion.js BONES,
        so rig.js mapBones finds every one), binds the mesh with those weights and saves a GLB with the skin.

The model is never moved, turned or scaled: the skeleton is built where the body already stands.
Bone axes follow the pose presets in motion.js: every bone's Y runs along it, spine, legs and feet bend about the
body's left, arms swing about their own X and lift about Z, which points forward.
Prints "FLATFORM_RIG <bones> <unweighted vertices>" when built, "FLATFORM_ERROR <message>" on failure.
"""
import argparse
import json
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Vector

BONES = ["Hips", "Spine", "Spine1", "Spine2", "Neck", "Head",
         "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand", "RightShoulder", "RightArm", "RightForeArm", "RightHand",
         "LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase", "RightUpLeg", "RightLeg", "RightFoot", "RightToeBase"]


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser(description="Flatform auto-rig")
    p.add_argument("--glb", required=True)
    p.add_argument("--dump")
    p.add_argument("--build")
    p.add_argument("--out")
    return p.parse_args(argv)


def import_meshes(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path)
    objs = list(bpy.context.scene.objects)
    if any(o.type == "ARMATURE" for o in objs):
        raise RuntimeError("This model already has a skeleton")
    meshes = sorted((o for o in objs if o.type == "MESH"), key=lambda o: o.name)
    if not meshes:
        raise RuntimeError("No mesh in this model")
    return meshes


def gl(v):
    """Blender (Z up) to glTF (Y up)."""
    return (v[0], v[2], -v[1])


def bl(v):
    """glTF (Y up) to Blender (Z up)."""
    return Vector((v[0], -v[2], v[1]))


def dump(meshes, folder):
    objects, pos, tris, base = [], [], [], 0
    for o in meshes:
        me = o.data
        n = len(me.vertices)
        co = np.empty(n * 3, dtype=np.float32)
        me.vertices.foreach_get("co", co)
        co = co.reshape(-1, 3)
        m = np.array(o.matrix_world, dtype=np.float64)
        w = co @ m[:3, :3].T + m[:3, 3]
        pos.append(np.stack([w[:, 0], w[:, 2], -w[:, 1]], axis=1).astype(np.float32))
        me.calc_loop_triangles()
        t = np.empty(len(me.loop_triangles) * 3, dtype=np.uint32)
        me.loop_triangles.foreach_get("vertices", t)
        tris.append(t + base)
        objects.append({"name": o.name, "verts": n})
        base += n
    np.concatenate(pos).tofile(os.path.join(folder, "positions.f32"))
    (np.concatenate(tris) if tris else np.zeros(0, np.uint32)).astype(np.uint32).tofile(os.path.join(folder, "tris.u32"))
    with open(os.path.join(folder, "mesh.json"), "w") as f:
        json.dump({"objects": objects, "verts": base}, f)
    print(f"FLATFORM_DUMP {base} {sum(len(t) for t in tris) // 3}", flush=True)


def build_armature(rig):
    forward, left = bl(rig["frame"]["forward"]), bl(rig["frame"]["left"])
    data = bpy.data.armatures.new("Armature")
    arm = bpy.data.objects.new("Armature", data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    for b in rig["bones"]:
        e = data.edit_bones.new(b["name"])
        e.head, e.tail = bl(b["head"]), bl(b["tail"])
        if b["parent"]:
            e.parent = data.edit_bones[b["parent"]]
            e.use_connect = False
        y = (e.tail - e.head).normalized()
        e.align_roll(forward if ("Arm" in b["name"] or "Hand" in b["name"] or "Shoulder" in b["name"]) else left.cross(y))
    bpy.ops.object.mode_set(mode="OBJECT")
    return arm


def cut_welds(meshes, folder):
    """Deletes the faces Flatform found welding two limbs together (cut.u32: triangle numbers in --dump order)."""
    path = os.path.join(folder, "cut.u32")
    cut = np.fromfile(path, dtype=np.uint32) if os.path.exists(path) else np.zeros(0, np.uint32)
    base, total = 0, 0
    for o in meshes:
        me = o.data
        me.calc_loop_triangles()
        k = len(me.loop_triangles)
        mine = cut[(cut >= base) & (cut < base + k)] - base
        base += k
        if not len(mine):
            continue
        poly = np.empty(k, dtype=np.int32)
        me.loop_triangles.foreach_get("polygon_index", poly)
        faces = set(poly[mine].tolist())
        bm = bmesh.new()
        bm.from_mesh(me)
        bm.faces.ensure_lookup_table()
        bmesh.ops.delete(bm, geom=[bm.faces[i] for i in faces], context="FACES_ONLY")
        bm.to_mesh(me)
        bm.free()
        total += len(faces)
    return total


def bind(meshes, arm, folder):
    """The weights Flatform worked out: vertex groups per bone, an Armature modifier, the skeleton as parent."""
    n = json.load(open(os.path.join(folder, "mesh.json")))["verts"]
    w = np.fromfile(os.path.join(folder, "weights.u8"), dtype=np.uint8)
    if len(w) != n * 3:
        raise RuntimeError("The weights do not match the model")
    b0, b1, q = w[:n], w[n:2 * n], w[2 * n:]
    names = [b.name for b in arm.data.bones]
    order = {name: i for i, name in enumerate(json.load(open(os.path.join(folder, "rig.json")))["names"])}
    base, unweighted = 0, 0
    for o in meshes:
        k = len(o.data.vertices)
        ob0, ob1, oq = b0[base:base + k], b1[base:base + k], q[base:base + k].astype(np.int32)
        for name in names:
            g = o.vertex_groups.new(name=name)
            i = order[name]
            for idx, wt in ((np.nonzero(ob0 == i)[0], oq), (np.nonzero((ob1 == i) & (ob0 != i))[0], 255 - oq)):
                if not len(idx):
                    continue
                vals = wt[idx]
                for v in np.unique(vals):
                    if v:
                        g.add(idx[vals == v].tolist(), float(v) / 255.0, "REPLACE")
        unweighted += int(np.count_nonzero(oq == 0) - np.count_nonzero((oq == 0) & (ob1 != ob0)))
        mw = o.matrix_world.copy()
        o.parent = arm
        o.matrix_world = mw
        o.modifiers.new("Armature", "ARMATURE").object = arm
        base += k
    return unweighted


def main():
    args = parse_args()
    meshes = import_meshes(args.glb)
    if args.dump:
        os.makedirs(args.dump, exist_ok=True)
        dump(meshes, args.dump)
        return
    if not (args.build and args.out):
        raise RuntimeError("Use --dump <folder>, or --build <folder> --out <file>")
    with open(os.path.join(args.build, "rig.json")) as f:
        rig = json.load(f)
    arm = build_armature(rig)
    cut_welds(meshes, args.build)
    unweighted = bind(meshes, arm, args.build)
    bpy.ops.export_scene.gltf(filepath=args.out, export_format="GLB", export_skins=True, export_animations=False)
    print(f"FLATFORM_RIG {len(BONES)} {unweighted}", flush=True)


try:
    main()
except Exception as error:  # noqa: BLE001 - report every failure to Flatform as a non-zero exit
    print(f"FLATFORM_ERROR {error}", flush=True)
    sys.exit(1)
