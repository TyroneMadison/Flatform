"""Flatform Fill small holes, the Blender half (Blender 4.x / 5.x). The in-app half is public/lib/holes.js with the
same limits; the server picks this one when Blender is the renderer.

    blender -b -P blender_fillholes.py -- --glb model.glb --out filled.glb --report fill.json [--max-edges 32] [--max-size 0.1]

Per part (mesh object): copies of a vertex at one spot are joined (UV seams the importer split), open corners closer
than a ten-thousandth of the part are merged (tiny cracks), then rings of up to --max-edges open edges are filled.
A filled ring wider than --max-size of the part, or as big as the flat sheet it edges, is taken out again: that is
an opening, not a hole. New faces take the material and UVs of the faces beside them.
Writes {"holes": n, "cracks": n} to --report and prints "FLATFORM_FILL <holes> <cracks>", or "FLATFORM_ERROR <message>".
"""
import argparse
import json
import sys

import bmesh
import bpy
from mathutils import Vector


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser(description="Flatform fill small holes")
    p.add_argument("--glb", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--report", required=True)
    p.add_argument("--max-edges", type=int, default=32)
    p.add_argument("--max-size", type=float, default=0.1)
    return p.parse_args(argv)


def diagonal(points):
    pts = list(points)
    if not pts:
        return 0.0
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return (hi - lo).length


def island_areas(bm, skip):
    """Face -> area of the connected sheet it is on (new faces in `skip` do not join sheets)."""
    area_of = {}
    for f in bm.faces:
        if f in area_of or f in skip:
            continue
        seen, todo, total = [f], [f], 0.0
        area_of[f] = None
        while todo:
            g = todo.pop()
            total += g.calc_area()
            for e in g.edges:
                for h in e.link_faces:
                    if h not in area_of and h not in skip:
                        area_of[h] = None
                        seen.append(h)
                        todo.append(h)
        for g in seen:
            area_of[g] = total
    return area_of


def fill_part(obj, max_edges, max_size):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    size = diagonal(v.co for v in bm.verts)
    if size <= 0:
        bm.free()
        return 0, 0
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=size * 1e-5)  # seams: not counted
    open_corners = [v for v in bm.verts if v.is_boundary]
    before = len(bm.verts)
    bmesh.ops.remove_doubles(bm, verts=open_corners, dist=size * 1e-4)
    cracks = before - len(bm.verts)
    new = bmesh.ops.holes_fill(bm, edges=[e for e in bm.edges if e.is_boundary], sides=max_edges)["faces"]
    new_set = set(new)
    sheets = island_areas(bm, new_set) if new else {}
    drop = []
    for f in new:
        beside = [h for e in f.edges for h in e.link_faces if h not in new_set]
        sheet = sheets.get(beside[0], 0.0) if beside else 0.0
        if len(f.verts) > max_edges or diagonal(v.co for v in f.verts) > max_size * size or f.calc_area() >= 0.5 * sheet:
            drop.append(f)
            continue
        f.material_index = beside[0].material_index if beside else 0
        f.smooth = beside[0].smooth if beside else True
        for layer in bm.loops.layers.uv.values():
            for loop in f.loops:
                near = next((l for l in loop.vert.link_loops if l.face not in new_set), None)
                if near is not None:
                    loop[layer].uv = near[layer].uv
    if drop:
        bmesh.ops.delete(bm, geom=drop, context="FACES_ONLY")
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    return len(new) - len(drop), cracks


def main():
    args = parse_args()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=args.glb)
    holes = cracks = 0
    done = set()
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH" or obj.data in done:  # a mesh used by two objects is filled once
            continue
        done.add(obj.data)
        h, c = fill_part(obj, args.max_edges, args.max_size)
        holes += h
        cracks += c
    bpy.ops.export_scene.gltf(filepath=args.out, export_format="GLB")
    with open(args.report, "w", encoding="utf8") as f:
        json.dump({"holes": holes, "cracks": cracks}, f)
    print(f"FLATFORM_FILL {holes} {cracks}", flush=True)


try:
    main()
except Exception as e:  # one plain line for the app, then a non-zero exit
    print(f"FLATFORM_ERROR {e}", flush=True)
    sys.exit(1)
