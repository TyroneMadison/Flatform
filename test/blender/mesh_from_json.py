"""Tests only: a GLB from a JSON mesh (test/fixtures/humanoid-mesh.mjs output: glTF-space positions and triangles),
so the real Blender tests rig the same made-up armoured person the node tests do. Smooth shading keeps each
vertex shared in the GLB (flat shading would split every face into its own loose piece).

    blender -b --factory-startup -P mesh_from_json.py -- <mesh.json> <out.glb>
"""
import json
import sys

import bpy

src, out = sys.argv[sys.argv.index("--") + 1:][:2]
data = json.load(open(src))
bpy.ops.wm.read_factory_settings(use_empty=True)
p = data["positions"]
verts = [(p[i], -p[i + 2], p[i + 1]) for i in range(0, len(p), 3)]  # glTF (Y up) to Blender (Z up)
t = data["tris"]
faces = [(t[i], t[i + 1], t[i + 2]) for i in range(0, len(t), 3) if len({t[i], t[i + 1], t[i + 2]}) == 3]
mesh = bpy.data.meshes.new("Armoured")
mesh.from_pydata(verts, [], faces)
mesh.update()
for poly in mesh.polygons:
    poly.use_smooth = True
obj = bpy.data.objects.new("Armoured", mesh)
bpy.context.scene.collection.objects.link(obj)
mat = bpy.data.materials.new("Armour")
mat.diffuse_color = (0.7, 0.68, 0.62, 1)
mesh.materials.append(mat)
bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", export_yup=True)
print(f"FIXTURE {out} {len(verts)} {len(faces)}", flush=True)
