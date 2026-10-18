"""Flatform turntable renderer for Blender 4.x (Cycles).

    blender -b -P blender_turntable.py -- --glb car.glb --out frames/studio --slug audi-r8 --look studio \
        --frames 72 --step 5 --res 2048x1536 [--scene scene.json] [--still 30 --still-out stills/x.png]

Builds the Escalade gold-ring studio (or the transparent look) in code, normalises the car exactly like the in-app
renderer (public/lib/studio.js), then turns only the car by --step degrees per frame. The camera, lights and studio
never move. Prints "FLATFORM_FRAME <done> <total>" after each frame so Flatform can show progress.

Coordinates: Flatform's studio is Y-up with the camera on +Z. Blender is Z-up; the glTF importer maps (x, y, z) to
(x, -z, y), so here the camera sits on -Y and the car's nose at yaw 0 points to -Y.
"""
import argparse
import json
import math
import os
import sys

import bpy
from mathutils import Vector

CAR_LENGTH = 4.6
GOLD = (0.871, 0.565, 0.150)  # #f0c66b in linear RGB
CAMERAS = {  # elevation in degrees, as in studio.js
    "front34": 13.0,
    "side": 6.0,
    "rear34": 13.0,
    "low": 2.5,
}
DEFAULTS = {
    "x": 0.0, "y": 0.0, "snap": True, "turn": 30.0, "scale": 1.0, "sameSize": True, "camera": "front34",
    "lens": 50.0, "autoOrient": True, "center": True, "flip": False, "reflection": 0.7,
}


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser(description="Flatform turntable")
    p.add_argument("--glb", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--slug", default="car")
    p.add_argument("--look", choices=["studio", "transparent"], default="studio")
    p.add_argument("--frames", type=int, default=72)
    p.add_argument("--step", type=float, default=5.0)
    p.add_argument("--res", default="2048x1536")
    p.add_argument("--scene")
    p.add_argument("--still", type=float)
    p.add_argument("--still-out")
    p.add_argument("--samples", type=int, default=128)
    return p.parse_args(argv)


def emission(name, color, strength):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    em = nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = (*color, 1.0)
    em.inputs["Strength"].default_value = strength
    mat.node_tree.links.new(em.outputs["Emission"], out.inputs["Surface"])
    return mat


def principled(name, color, roughness, metallic=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    return mat


def add_object(obj, mat=None):
    if mat:
        obj.data.materials.append(mat)
    return obj


def plane(name, size_x, size_y, location, rotation=(0, 0, 0), mat=None):
    bpy.ops.mesh.primitive_plane_add(size=1, location=location, rotation=rotation)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = (size_x, size_y, 1)
    return add_object(obj, mat)


def light(kind, name, location, energy, size=(1, 1), target=(0, 0, 0.6), color=(1, 1, 1)):
    data = bpy.data.lights.new(name, kind)
    data.energy = energy
    data.color = color
    if kind == "AREA":
        data.shape = "RECTANGLE"
        data.size, data.size_y = size
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = location
    direction = Vector(target) - Vector(location)
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    return obj


def world(strength, color=(1, 1, 1)):
    w = bpy.data.worlds.new("Flatform")
    w.use_nodes = True
    bg = w.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (*color, 1)
    bg.inputs["Strength"].default_value = strength
    bpy.context.scene.world = w


def build_gold_studio(reflection):
    """Near-black room, glossy dark floor, gold ring, two light bars, overhead softbox, key/fill/rim."""
    world(0.02)
    floor = plane("floor", 80, 80, (0, 0, 0), mat=principled("floor", (0.006, 0.006, 0.006), 0.22 - 0.18 * reflection))
    floor.data.materials[0].node_tree.nodes["Principled BSDF"].inputs["Specular IOR Level"].default_value = 0.3 + 0.5 * reflection
    plane("wall", 60, 24, (0, 8, 12), rotation=(math.radians(90), 0, 0), mat=principled("wall", (0.008, 0.007, 0.006), 0.92))
    bpy.ops.mesh.primitive_torus_add(major_radius=3.3, minor_radius=0.024, major_segments=320, minor_segments=12, location=(0, 0, 0.012))
    add_object(bpy.context.active_object, emission("gold ring", GOLD, 9.0))
    for x in (-5.9, 5.9):
        bpy.ops.mesh.primitive_cube_add(size=1, location=(x, 3.8, 1.75))
        bar = bpy.context.active_object
        bar.scale = (0.12, 0.12, 3.5)
        add_object(bar, emission("light bar", (1, 1, 1), 14.0))
        light("AREA", "bar light", (x, 3.6, 1.75), 220, size=(0.3, 3.5), target=(0, 0, 1))
    light("AREA", "overhead softbox", (0, 0.6, 6.3), 900, size=(7, 3), target=(0, 0.6, 0))
    light("SUN", "key", (-6, -7, 8), 2.2, color=(1.0, 0.95, 0.89))
    light("SUN", "fill", (8, -6, 3), 0.5, color=(0.87, 0.91, 1.0))
    light("SUN", "rim", (1, 10, 6), 2.0)


def build_transparent():
    """No background, a soft contact shadow only (shadow catcher), even studio light."""
    world(0.6, (0.8, 0.8, 0.8))
    scene = bpy.context.scene
    scene.render.film_transparent = True
    catcher = plane("shadow catcher", 30, 30, (0, 0, 0), mat=principled("catcher", (0.8, 0.8, 0.8), 1.0))
    catcher.is_shadow_catcher = True
    light("AREA", "top", (0, 0, 7), 1400, size=(6, 6), target=(0, 0, 0))
    light("SUN", "key", (-6, -7, 8), 2.6, color=(1.0, 0.95, 0.89))
    light("SUN", "fill", (8, -6, 3), 0.9, color=(0.87, 0.91, 1.0))
    light("SUN", "rim", (1, 10, 6), 1.2)


def import_car(path, s):
    """Imports the GLB and normalises it: length along the camera axis, CAR_LENGTH long, centred, tyres on z = 0."""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    imported = [o for o in bpy.data.objects if o not in before]
    pivot = bpy.data.objects.new("turntable", None)
    model = bpy.data.objects.new("model", None)
    bpy.context.scene.collection.objects.link(pivot)
    bpy.context.scene.collection.objects.link(model)
    model.parent = pivot
    for o in imported:
        if o.parent is None:
            o.parent = model
    meshes = [o for o in imported if o.type == "MESH"]

    def bounds():
        bpy.context.view_layer.update()
        pts = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
        lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
        hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
        return lo, hi

    lo, hi = bounds()
    size = hi - lo
    if s["autoOrient"] and size.x > size.y:
        model.rotation_euler.z = math.pi / 2
    if s["flip"]:
        model.rotation_euler.z += math.pi
    lo, hi = bounds()
    size = hi - lo
    model.scale = [CAR_LENGTH / max(size.x, size.y, 1e-6) * (1 if s["sameSize"] else s["scale"])] * 3
    lo, hi = bounds()
    center = (lo + hi) / 2
    if s["center"]:
        model.location.x -= center.x
        model.location.y -= center.y
    if s["snap"]:
        model.location.z -= lo.z
    pivot.location = (s["x"], 0, 0 if s["snap"] else s["y"])
    return pivot


def place_camera(s, look):
    aspect = 4 / 3 if look == "studio" else 1.0
    lens = float(s["lens"])
    hfov = 2 * math.atan(17.5 / lens)  # 35 mm film gauge, like studio.js
    width = 10.4 if aspect > 1 else 7.4
    distance = width / 2 / math.tan(hfov / 2)
    target_z = 1.15 if aspect > 1 else 0.75
    el = math.radians(CAMERAS.get(s["camera"], 13.0))
    cam_data = bpy.data.cameras.new("camera")
    cam_data.sensor_fit = "HORIZONTAL"
    cam_data.sensor_width = 35
    cam_data.lens = lens
    cam = bpy.data.objects.new("camera", cam_data)
    bpy.context.scene.collection.objects.link(cam)
    cam.location = (0, -distance * math.cos(el), target_z + distance * math.sin(el))
    direction = Vector((0, 0, target_z)) - cam.location
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = cam


def setup_render(width, height, look, samples):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA" if look == "transparent" else "RGB"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    for transform in ("Khronos PBR Neutral", "AgX", "Standard"):  # match the in-app neutral tone mapping when possible
        try:
            scene.view_settings.view_transform = transform
            break
        except TypeError:
            continue
    # Use a GPU when there is one; otherwise Cycles renders on the CPU.
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        for backend in ("OPTIX", "CUDA", "HIP", "METAL", "ONEAPI"):
            try:
                prefs.compute_device_type = backend
            except TypeError:
                continue
            prefs.get_devices()
            devices = [d for d in prefs.devices if d.type == backend]
            if devices:
                for d in devices:
                    d.use = True
                scene.cycles.device = "GPU"
                break
    except Exception as e:  # noqa: BLE001 - CPU rendering still works
        print(f"GPU not used: {e}")


def render_to(path):
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def main():
    args = parse_args()
    s = dict(DEFAULTS)
    if args.scene and os.path.exists(args.scene):
        with open(args.scene, encoding="utf-8") as f:
            s.update({k: v for k, v in json.load(f).items() if k in DEFAULTS})
    width, height = (int(n) for n in args.res.lower().split("x"))
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if args.look == "transparent":
        build_transparent()
    else:
        build_gold_studio(float(s["reflection"]))
    pivot = import_car(args.glb, s)
    place_camera(s, args.look)
    setup_render(width, height, args.look, args.samples)
    os.makedirs(args.out, exist_ok=True)
    for i in range(args.frames):
        # Same direction as the in-app renderer: positive yaw turns the car clockwise seen from above.
        pivot.rotation_euler.z = -math.radians(float(s["turn"]) + i * args.step)
        render_to(os.path.join(args.out, f"{args.slug}_{i:03d}.png"))
        print(f"FLATFORM_FRAME {i + 1} {args.frames}", flush=True)
    if args.still is not None and args.still_out:
        pivot.rotation_euler.z = -math.radians(args.still)
        os.makedirs(os.path.dirname(args.still_out), exist_ok=True)
        render_to(args.still_out)
        print("FLATFORM_STILL", flush=True)


try:
    main()
except Exception as error:  # noqa: BLE001 - report every failure to Flatform as a non-zero exit
    print(f"FLATFORM_ERROR {error}", flush=True)
    sys.exit(1)
