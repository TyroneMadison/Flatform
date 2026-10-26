"""Tests only: a rigged GLB posed the way renders pose it (render/blender_turntable.py apply_pose), shown from the
front, the side and three-quarter in quick Workbench pictures framed on the posed body, so a torn mesh is easy to
see. Also prints how far the posed mesh reaches (FLATFORM_BOUNDS).

    blender -b --factory-startup -P posed_views.py -- <rigged.glb> <pose json or ''> <out prefix>
"""
import math
import os
import sys

import bpy
from mathutils import Vector

here = os.path.dirname(os.path.abspath(__file__))
source = open(os.path.join(here, "..", "..", "render", "blender_turntable.py"), encoding="utf-8").read()
exec(compile(source[:source.rindex("\ntry:\n    main()")], "blender_turntable.py", "exec"))  # its functions, not its main()

glb, pose_json, out = sys.argv[sys.argv.index("--") + 1:][:3]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=glb)
pivot = bpy.data.objects.new("pivot", None)
bpy.context.scene.collection.objects.link(pivot)
if pose_json:
    apply_pose(glb, json.loads(pose_json), pivot)  # noqa: F821 - from blender_turntable.py
bpy.context.view_layer.update()
dg = bpy.context.evaluated_depsgraph_get()
lo, hi = Vector((1e9, 1e9, 1e9)), Vector((-1e9, -1e9, -1e9))
for o in bpy.context.scene.objects:
    if o.type != "MESH" or not o.visible_get():  # the importer's hidden bone-shape Icosphere
        continue
    e = o.evaluated_get(dg)
    me = e.to_mesh()
    for i, v in enumerate(me.vertices):
        if i % 7:
            continue
        p = o.matrix_world @ v.co
        lo = Vector(map(min, lo, p))
        hi = Vector(map(max, hi, p))
    e.to_mesh_clear()
print(f"FLATFORM_BOUNDS {lo.x:.4f} {lo.y:.4f} {lo.z:.4f} {hi.x:.4f} {hi.y:.4f} {hi.z:.4f}", flush=True)
c, size = (lo + hi) / 2, max(hi - lo) * 1.1
sc = bpy.context.scene
sc.render.engine = "BLENDER_WORKBENCH"
sc.render.resolution_x = sc.render.resolution_y = 700
sc.display.shading.light = "STUDIO"
sc.display.shading.color_type = "SINGLE"
sc.display.shading.single_color = (0.75, 0.74, 0.72)
sc.display.shading.show_cavity = True
sc.world = bpy.data.worlds.new("w")
sc.world.color = (0.035, 0.035, 0.04)
cam = bpy.data.cameras.new("c")
cam.type = "ORTHO"
cam.ortho_scale = size
co = bpy.data.objects.new("c", cam)
sc.collection.objects.link(co)
sc.camera = co
# The body's front is worked out from where the toes point (the posed model may face any way).
for name, ang in (("front", 0), ("side", 90), ("threequarter", 35)):
    d = Vector((math.sin(math.radians(ang)), -math.cos(math.radians(ang)), 0.15)).normalized()
    co.location = c + d * size * 3
    co.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
    sc.render.filepath = f"{out}-{name}.png"
    bpy.ops.render.render(write_still=True)
    print(f"FLATFORM_VIEW {sc.render.filepath}", flush=True)
