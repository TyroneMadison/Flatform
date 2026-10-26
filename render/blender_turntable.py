"""Flatform turntable renderer for Blender 4.x (Cycles).

    blender -b -P blender_turntable.py -- --glb car.glb --out frames/studio --slug audi-r8 --look studio \
        --frames 72 --step 5 --res 2048x1536 [--scene scene.json] [--rig '{"lighting": {...}, "glass": {...}}']
        [--still 30 --still-out stills/x.png] [--pose '{"bones": {"LeftArm": [0, 0, -45]}, "retarget": {...}}']

Builds the Escalade ring studio, the showroom or the transparent look in code, normalises and frames the car
exactly like the in-app renderer (public/lib/studio.js), applies the Render step's light rig and glass, then turns
only the car by --step degrees per frame. The camera, lights and studio
never move. Prints "FLATFORM_FRAME <done> <total>" after each frame so Flatform can show progress.

Coordinates: Flatform's studio is Y-up with the camera on +Z. Blender is Z-up; the glTF importer maps (x, y, z) to
(x, -z, y), so here the camera sits on -Y and the car's nose at yaw 0 points to -Y.
"""
import argparse
import json
import re
import math
import os
import sys

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector

CAR_LENGTH = 4.6
RING = (1.0, 0.195, 0.133)  # #ff7a66, the app's coral accent, in linear RGB
GOLD = (0.888, 0.462, 0.147)  # #f2b56b, the showroom's floor ring
FILL = {"wide": 0.7, "square": 0.84}  # share of the frame width the car's footprint diagonal spans, as studio.js
LIGHTING = {"key": 1.0, "azimuth": -40.0, "elevation": 40.0, "kelvin": 5600.0, "fill": 1.0, "rim": 1.0}
GLASS = {"on": True, "tint": "#14202a", "opacity": 0.15}
GLASS_NAME = ("glass", "window", "windshield", "windscreen")
CAMERAS = {  # elevation in degrees, as in studio.js
    "front34": 13.0,
    "side": 6.0,
    "rear34": 13.0,
    "low": 2.5,
}
DEFAULTS = {
    "x": 0.0, "y": 0.0, "snap": True, "turn": 30.0, "scale": 1.0, "sameSize": True, "camera": "front34",
    "lens": 50.0, "autoOrient": True, "center": True, "flip": False, "reflection": 0.7,
    # Camera view mode (studio.js): "car" = the preset camera, "free" = the orbit camera saved in `orbit`
    # ({"position": [x, y, z], "target": [x, y, z]} in Flatform's Y-up metres). fit "all" = "Frame all" in car view.
    "view": "car", "orbit": None, "fit": "footprint",
}


def is_car_shape(size):
    """pipeline.js isCarShape: a car is longer than tall; anything clearly taller is not size-locked."""
    return size.z <= 1.15 * max(size.x, size.y)  # Blender is Z-up: size.z is the height


def model_scale(size, s):
    """pipeline.js modelScale: cars by length (locked with sameSize), others by their largest side."""
    car = is_car_shape(size)
    fit = CAR_LENGTH / max(max(size.x, size.y) if car else max(size.x, size.y, size.z), 1e-6)
    return fit * (1 if car and s["sameSize"] else s["scale"])


def fit_distance(radius, hfov, aspect, pad=1.1):
    """pipeline.js fitDistance: how far back a sphere of `radius` fits a frame of horizontal fov `hfov` (radians)."""
    half = math.atan(min(math.tan(hfov / 2), math.tan(hfov / 2) / aspect))
    return max(radius, 1e-6) * pad / math.sin(half)


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser(description="Flatform turntable")
    p.add_argument("--glb", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--slug", default="car")
    p.add_argument("--look", choices=["studio", "showroom", "transparent"], default="studio")
    p.add_argument("--frames", type=int, default=72)
    p.add_argument("--step", type=float, default=5.0)
    p.add_argument("--res", default="2048x1536")
    p.add_argument("--scene")
    p.add_argument("--rig")
    p.add_argument("--plate")  # spin sets only: the showroom photo {"slug", "modeled", "camera", "light"}
    # The scene's 3D room (public/lib/rooms.js): {"slug", "type", "kind", "camera", "light", hdri rooms: "files",
    # "turn", "height", "radius", "floor"}. Built round the model, scaled to it.
    p.add_argument("--room")
    p.add_argument("--still", type=float)
    p.add_argument("--still-out")
    p.add_argument("--samples", type=int, default=128)
    # Generate Spin Set: the "Max realism" profile JSON (realism.mjs MAX_REALISM) and an interior spin.
    p.add_argument("--profile")
    p.add_argument("--interior", action="store_true")
    # The scene look (public/lib/look.js blenderLook): engine, tone mapping, exposure, background, hdri, lights.
    p.add_argument("--scenelook")
    # Painted pieces (public/lib/tenno.js blenderMaterial per piece key) and face groups, written by the server.
    p.add_argument("--materials")
    # A humanoid pose: Euler degrees per standard bone (motion.js poseBones) and motion.js RETARGET for other names.
    p.add_argument("--pose")
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


def kelvin_color(k):
    """Same blackbody fit as studio.js kelvinColor, as sRGB 0-1."""
    t = k / 100
    r = 255 if t <= 66 else 329.698727446 * (t - 60) ** -0.1332047592
    g = 99.4708025861 * math.log(t) - 161.1195681661 if t <= 66 else 288.1221695283 * (t - 60) ** -0.0755148492
    b = 255 if t >= 66 else 0 if t <= 19 else 138.5177312231 * math.log(t - 10) - 305.0447927307
    return tuple(min(255.0, max(0.0, v)) / 255 for v in (r, g, b))


def srgb_to_linear(c):
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)


def apply_rig(lighting):
    """The Render step's light rig on top of the look's own key, fill and rim (multipliers, 1 = unchanged)."""
    objs = bpy.context.scene.objects
    az, el = math.radians(lighting["azimuth"]), math.radians(lighting["elevation"])
    # studio.js puts the key at (sin az cos el, sin el, cos az cos el) in Y-up; Blender is (x, -z, y).
    key = objs["key"]
    key.data.energy *= lighting["key"]
    key.data.color = srgb_to_linear(kelvin_color(lighting["kelvin"]))
    aim(key, (math.sin(az) * math.cos(el) * 12, -math.cos(az) * math.cos(el) * 12, math.sin(el) * 12))
    fill = objs["fill"]
    fill.data.energy *= lighting["fill"]
    aim(fill, (-math.sin(az) * 9, -math.cos(az) * 9, 3))
    objs["rim"].data.energy *= lighting["rim"]
    bg = bpy.context.scene.world.node_tree.nodes["Background"]
    bg.inputs["Strength"].default_value *= lighting["rim"]


def aim(obj, location, target=(0, 0, 0.6)):
    obj.location = location
    obj.rotation_euler = (Vector(target) - Vector(location)).to_track_quat("-Z", "Y").to_euler()


def glass_bsdf(mat, glass):
    """A named glass material: real glass, tinted, see-through by 1 - opacity."""
    tint = srgb_to_linear(tuple(int(glass["tint"][i:i + 2], 16) / 255 for i in (1, 3, 5)))
    mat.use_nodes = True
    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    for name in ("Base Color", "Roughness", "Metallic", "Transmission Weight"):
        for link in list(bsdf.inputs[name].links):
            mat.node_tree.links.remove(link)
    bsdf.inputs["Base Color"].default_value = (*tint, 1)
    bsdf.inputs["Roughness"].default_value = 0.05
    bsdf.inputs["Metallic"].default_value = 0.0
    bsdf.inputs["IOR"].default_value = 1.5
    bsdf.inputs["Transmission Weight"].default_value = 1 - glass["opacity"]


def tinted_glass(mat, glass):
    """Tripo bakes the whole car into one texture. Like studio.js: dark, unsaturated, glossy texels are glass,
    so they get roughness 0.05, no metal and the tint (by opacity). Done with nodes on the imported material."""
    nt = mat.node_tree
    bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if not bsdf or not bsdf.inputs["Base Color"].links or not bsdf.inputs["Roughness"].links:
        return
    tint = srgb_to_linear(tuple(int(glass["tint"][i:i + 2], 16) / 255 for i in (1, 3, 5)))
    base = bsdf.inputs["Base Color"].links[0].from_socket
    rough = bsdf.inputs["Roughness"].links[0].from_socket
    metal = bsdf.inputs["Metallic"].links[0].from_socket if bsdf.inputs["Metallic"].links else None

    def math_node(op, a, b):
        n = nt.nodes.new("ShaderNodeMath")
        n.operation = op
        for i, v in enumerate((a, b)):
            if isinstance(v, (int, float)):
                n.inputs[i].default_value = v
            else:
                nt.links.new(v, n.inputs[i])
        return n.outputs[0]

    sep = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(base, sep.inputs[0])
    r, g, b = sep.outputs
    lum = math_node("ADD", math_node("ADD", math_node("MULTIPLY", r, 0.2126), math_node("MULTIPLY", g, 0.7152)), math_node("MULTIPLY", b, 0.0722))
    spread = math_node("SUBTRACT", math_node("MAXIMUM", math_node("MAXIMUM", r, g), b), math_node("MINIMUM", math_node("MINIMUM", r, g), b))
    mask = math_node("MULTIPLY", math_node("MULTIPLY", math_node("LESS_THAN", lum, 0.08), math_node("LESS_THAN", spread, 0.03)), math_node("LESS_THAN", rough, 0.43))
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    nt.links.new(math_node("MULTIPLY", mask, glass["opacity"]), mix.inputs["Factor"])
    nt.links.new(base, mix.inputs["A"])
    mix.inputs["B"].default_value = (*tint, 1)
    nt.links.new(mix.outputs["Result"], bsdf.inputs["Base Color"])
    keep = math_node("SUBTRACT", 1.0, mask)
    nt.links.new(math_node("ADD", math_node("MULTIPLY", rough, keep), math_node("MULTIPLY", mask, 0.05)), bsdf.inputs["Roughness"])
    if metal:
        nt.links.new(math_node("MULTIPLY", metal, keep), bsdf.inputs["Metallic"])


def apply_glass(meshes, glass):
    if not glass["on"]:
        return
    for o in meshes:
        named = any(w in o.name.lower() for w in GLASS_NAME)
        for slot in o.material_slots:
            mat = slot.material
            if not mat:
                continue
            if named or any(w in mat.name.lower() for w in GLASS_NAME):
                glass_bsdf(mat, glass)
            elif mat.use_nodes:
                tinted_glass(mat, glass)


def build_showroom(reflection):
    """The modeled showroom (fallback to the photo), as studio.js: matte near-black room, dark glossy floor, thin
    warm-gold ring inset in the floor, two tall white LED bars in the back corners, a big ceiling softbox."""
    world(0.02)
    floor = plane("floor", 80, 80, (0, 0, 0), mat=principled("floor", (0.004, 0.004, 0.004), 0.2 - 0.12 * reflection))
    floor.data.materials[0].node_tree.nodes["Principled BSDF"].inputs["Specular IOR Level"].default_value = 0.3 + 0.4 * reflection
    plane("wall", 60, 24, (0, 8, 12), rotation=(math.radians(90), 0, 0), mat=principled("wall", (0.006, 0.006, 0.006), 0.9))
    bpy.ops.mesh.primitive_torus_add(major_radius=3.3, minor_radius=0.014, major_segments=320, minor_segments=12, location=(0, 0, 0.008))
    add_object(bpy.context.active_object, emission("gold ring", GOLD, 7.0))
    for x in (-4.8, 4.8):
        bpy.ops.mesh.primitive_cube_add(size=1, location=(x, 4.2, 1.3))
        bar = bpy.context.active_object
        bar.scale = (0.1, 0.1, 2.6)
        add_object(bar, emission("light bar", (1, 1, 1), 12.0))
        light("AREA", "bar light", (x, 4.0, 1.3), 160, size=(0.3, 2.6), target=(0, 0, 0.8))
    plane("ceiling", 60, 30, (0, 0, 6.02), rotation=(math.radians(180), 0, 0), mat=principled("ceiling", (0.004, 0.004, 0.004), 0.9))
    plane("ceiling softbox", 9, 5, (0, 5.5, 6.0), rotation=(math.radians(180), 0, 0), mat=emission("softbox", srgb_to_linear(kelvin_color(6500)), 5.0))
    light("AREA", "overhead softbox", (0, 0.6, 4.5), 550, size=(8, 5), target=(0, 0.6, 0), color=srgb_to_linear(kelvin_color(6500)))
    light("SUN", "key", (-6, -7, 8), 2.0, color=(1.0, 0.95, 0.89))
    light("SUN", "fill", (8, -6, 3), 0.5, color=(0.87, 0.91, 1.0))
    light("SUN", "rim", (1, 10, 6), 1.9)


def build_ring_studio(reflection):
    """Near-black room, glossy dark floor, coral ring, two light bars, overhead softbox, key/fill/rim."""
    world(0.02)
    floor = plane("floor", 80, 80, (0, 0, 0), mat=principled("floor", (0.006, 0.006, 0.006), 0.22 - 0.18 * reflection))
    floor.data.materials[0].node_tree.nodes["Principled BSDF"].inputs["Specular IOR Level"].default_value = 0.3 + 0.5 * reflection
    plane("wall", 60, 24, (0, 8, 12), rotation=(math.radians(90), 0, 0), mat=principled("wall", (0.008, 0.007, 0.006), 0.92))
    bpy.ops.mesh.primitive_torus_add(major_radius=3.3, minor_radius=0.024, major_segments=320, minor_segments=12, location=(0, 0, 0.012))
    add_object(bpy.context.active_object, emission("ring", RING, 9.0))
    for x in (-4.6, 4.6):  # just inside the frame of the fitted camera
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
        model.rotation_euler.z = -math.pi / 2  # Tripo: along X, nose on +X; turn the nose to -Y, the camera
    if s["flip"]:
        model.rotation_euler.z += math.pi
    lo, hi = bounds()
    size = hi - lo
    model.scale = [model_scale(size, s)] * 3
    lo, hi = bounds()
    center = (lo + hi) / 2
    if s["center"]:
        model.location.x -= center.x
        model.location.y -= center.y
    if s["snap"]:
        model.location.z -= lo.z
    pivot.location = (s["x"], 0, 0 if s["snap"] else s["y"])
    lo, hi = bounds()  # the bounding sphere and box corners in scene space, for "Frame all"
    corners = [Vector((x, y, z)) for x in (lo.x, hi.x) for y in (lo.y, hi.y) for z in (lo.z, hi.z)]
    return pivot, meshes, hi - lo, ((lo + hi) / 2, (hi - lo).length / 2, corners)


def bone_standard(name, retarget):
    """motion.js retargetName: strip mixamorig: and friends, then match a standard name."""
    n = re.sub(r"^mixamorig\d*[:_]?", "", name, flags=re.I)
    n = re.sub(r"^(bip01|b|def|org)[ _.-]", "", n, flags=re.I)
    n = re.sub(r"[.](l|r)$", lambda m: "_" + m.group(1), n, flags=re.I)
    n = re.sub(r"[ .-]", "_", n).lower()
    compact = n.replace("_", "")
    return retarget.get(n) or retarget.get(compact) or next((b for b in set(retarget.values()) if b.lower() == compact), None)


def apply_pose(pose):
    """rig.js applyMotion: each mapped bone turns by Euler degrees on top of its rest pose. three.js's XYZ Euler order
    is Blender's ZYX; the glTF importer keeps each joint's axes, so the numbers mean the same in both."""
    if not pose or not pose.get("bones"):
        return 0
    from mathutils import Euler
    done = 0
    for arm in (o for o in bpy.context.scene.objects if o.type == "ARMATURE"):
        seen = set()
        for pb in arm.pose.bones:
            std = bone_standard(pb.name, pose.get("retarget", {}))
            deg = pose["bones"].get(std) if std and std not in seen else None
            if deg is None:
                continue
            seen.add(std)
            pb.rotation_mode = "QUATERNION"
            pb.rotation_quaternion = Euler([math.radians(d) for d in deg], "ZYX").to_quaternion()
            done += 1
    bpy.context.view_layer.update()
    return done


def hex_linear(h):
    return srgb_to_linear(tuple(int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)))


def piece_key(index, name, group=None):
    """paint.js pieceKey: '<name>#<meshIndex>' or '<name>#<meshIndex>@<group>'."""
    return f"{name or 'mesh'}#{index}" + ("" if group is None else f"@{group}")


def mesh_key(meshes, obj):
    """The key paint.js gave this mesh: by its glTF name (Blender may add .001), else by import order."""
    base = obj.name.rsplit(".", 1)[0] if obj.name[-4:-3] == "." and obj.name[-3:].isdigit() else obj.name
    return piece_key(meshes.index(obj), base)


def group_faces(labels):
    """infer.js groupFaces order: labels by face count, biggest first (ties keep first appearance)."""
    counts = {}
    for lab in labels:
        counts[lab] = counts.get(lab, 0) + 1
    order = sorted(counts, key=lambda lab: -counts[lab])
    return order


def principled_from(spec, source=None):
    """A Principled BSDF material from tenno.js blenderMaterial, with Subsurface Weight / Radius (the subsurface_color
    tints the radius: Blender 4.x scatters the base colour). source: the imported material whose textures to keep."""
    mat = bpy.data.materials.new(spec.get("name", "piece"))
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    inputs = bsdf.inputs
    inputs["Base Color"].default_value = (*hex_linear(spec["base_color"]), 1)
    inputs["Metallic"].default_value = spec["metallic"]
    inputs["Roughness"].default_value = spec["roughness"]
    inputs["Coat Weight"].default_value = spec["coat_weight"]
    inputs["Coat Roughness"].default_value = spec["coat_roughness"]
    inputs["Sheen Weight"].default_value = spec["sheen_weight"]
    inputs["Sheen Roughness"].default_value = spec["sheen_roughness"]
    inputs["Sheen Tint"].default_value = (*hex_linear(spec["sheen_tint"]), 1)
    inputs["Transmission Weight"].default_value = spec["transmission_weight"]
    inputs["IOR"].default_value = spec["ior"]
    inputs["Emission Color"].default_value = (*hex_linear(spec["emission_color"]), 1)
    inputs["Emission Strength"].default_value = spec["emission_strength"]
    inputs["Alpha"].default_value = spec["alpha"]
    inputs["Subsurface Weight"].default_value = spec["subsurface_weight"]
    tint = hex_linear(spec["subsurface_color"])
    inputs["Subsurface Radius"].default_value = tuple(r * (0.5 + t) for r, t in zip(spec["subsurface_radius"], tint))
    inputs["Subsurface Scale"].default_value = 1.0
    if spec["transmission_weight"] > 0:
        mat.blend_method = "BLEND"
    if spec.get("textured") and source and source.use_nodes:
        src = next((n for n in source.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if src is not None and src.inputs["Base Color"].links:
            img = src.inputs["Base Color"].links[0].from_node
            if img.type == "TEX_IMAGE":
                tex = nt.nodes.new("ShaderNodeTexImage")
                tex.image = img.image
                if spec.get("slot"):  # a tint multiplies the diffuse, as in paint.js
                    mix = nt.nodes.new("ShaderNodeMix")
                    mix.data_type = "RGBA"
                    mix.blend_type = "MULTIPLY"
                    mix.inputs["Factor"].default_value = 1.0
                    nt.links.new(tex.outputs["Color"], mix.inputs["A"])
                    mix.inputs["B"].default_value = (*hex_linear(spec["base_color"]), 1)
                    nt.links.new(mix.outputs["Result"], inputs["Base Color"])
                else:
                    nt.links.new(tex.outputs["Color"], inputs["Base Color"])
    return mat


def apply_materials(meshes, spec):
    """Painted pieces: a Principled material per piece key, face groups split by label (infer.js groupFaces)."""
    materials = spec.get("materials", {})
    groups = spec.get("groups", {})
    for obj in meshes:
        key = mesh_key(meshes, obj)
        mesh = obj.data
        g = groups.get(key)
        if g and len(mesh.polygons) * 1 >= 1:
            raw = __import__("base64").b64decode(g["labels"])
            labels = [None if b == 255 else g["names"][b] for b in raw]
            if len(labels) == len(mesh.polygons):
                order = group_faces(labels)
                base = obj.material_slots[0].material if obj.material_slots else None
                mesh.materials.clear()
                for gi, lab in enumerate(order):
                    piece = materials.get(piece_key(meshes.index(obj), key.split("#")[0], gi))
                    mesh.materials.append(principled_from({**piece, "name": lab or "unlabelled"}, base) if piece else base)
                index_of = {lab: i for i, lab in enumerate(order)}
                for poly, lab in zip(mesh.polygons, labels):
                    poly.material_index = index_of[lab]
                continue
        single = materials.get(key)
        if single and obj.material_slots:
            for slot in obj.material_slots:
                slot.material = principled_from({**single, "name": key}, slot.material)
        for gi, slot in enumerate(obj.material_slots):
            piece = materials.get(piece_key(meshes.index(obj), key.split("#")[0], gi))
            if piece and len(obj.material_slots) > 1:
                slot.material = principled_from({**piece, "name": f"{key}@{gi}"}, slot.material)


def apply_look(look, meshes):
    """The scene look: engine, tone mapping and exposure, background, HDRI, light preset. None = untouched."""
    if not look:
        return
    scene = bpy.context.scene
    scene.render.engine = look.get("engine", "CYCLES")
    try:
        scene.view_settings.view_transform = look.get("tone", "Khronos PBR Neutral")
    except TypeError:
        pass
    scene.view_settings.exposure = math.log2(max(look.get("exposure", 1.0), 1e-3))
    world = scene.world
    nt = world.node_tree
    bg_node = nt.nodes["Background"]
    out = next(n for n in nt.nodes if n.type == "OUTPUT_WORLD")
    background = look.get("background") or {}
    if background.get("kind") in ("solid", "gradient") and not scene.render.film_transparent:
        bg_node.inputs["Color"].default_value = (*hex_linear(background["color"]), 1)
        bg_node.inputs["Strength"].default_value = 1.0
    hdri = look.get("hdri")
    if hdri and hdri.get("path") and os.path.exists(hdri["path"]):
        env = nt.nodes.new("ShaderNodeTexEnvironment")
        env.image = bpy.data.images.load(hdri["path"])
        mapping = nt.nodes.new("ShaderNodeMapping")
        mapping.inputs["Rotation"].default_value = (0, 0, math.radians(hdri.get("rotation", 0)))
        coord = nt.nodes.new("ShaderNodeTexCoord")
        nt.links.new(coord.outputs["Generated"], mapping.inputs["Vector"])
        nt.links.new(mapping.outputs["Vector"], env.inputs["Vector"])
        lit = nt.nodes.new("ShaderNodeBackground")
        lit.inputs["Strength"].default_value = hdri.get("intensity", 1.0)
        nt.links.new(env.outputs["Color"], lit.inputs["Color"])
        if hdri.get("background"):
            nt.links.new(lit.outputs["Background"], out.inputs["Surface"])
        else:  # the HDRI lights and reflects; the camera still sees the scene's own background
            mix = nt.nodes.new("ShaderNodeMixShader")
            path = nt.nodes.new("ShaderNodeLightPath")
            nt.links.new(path.outputs["Is Camera Ray"], mix.inputs["Fac"])
            nt.links.new(lit.outputs["Background"], mix.inputs[1])
            nt.links.new(bg_node.outputs["Background"], mix.inputs[2])
            nt.links.new(mix.outputs["Shader"], out.inputs["Surface"])
    lights = look.get("lights")
    if lights:
        objs = scene.objects
        for name in ("key", "fill", "rim"):
            cfg = lights[name]
            light_obj = objs.get(name)
            if light_obj is None:
                continue
            light_obj.hide_render = not cfg["on"]
            light_obj.data.energy = 2.2 * cfg["intensity"]
            light_obj.data.color = hex_linear(cfg["color"])
            az, el = math.radians(cfg["azimuth"]), math.radians(min(89.0, max(1.0, cfg["elevation"])))
            dist = 12 if name == "key" else 9
            aim(light_obj, (math.sin(az) * math.cos(el) * dist, -math.cos(az) * math.cos(el) * dist, math.sin(el) * dist))
        key = objs.get("key")
        if key is not None:
            key.data.use_shadow = lights.get("shadows", True)
            if key.data.type == "SUN":
                key.data.angle = math.radians(0.5 + 8 * lights.get("softness", 0.5))
    if scene.render.engine == "BLENDER_EEVEE_NEXT":
        ao = look.get("ao") or {}
        scene.eevee.use_gtao = bool(ao.get("on"))
        scene.eevee.use_raytracing = True


def build_plate(plate):
    """A photo scene: the car alone on a shadow catcher, lit to match the photo. Film is transparent; Flatform lays
    each frame over the plate (public/img/backplates/<slug>.jpg) when it makes the sprites."""
    light_ = plate["light"]
    sky, ground, ambient = light_["sky"]
    world(ambient * 2.5, hex_linear(sky))
    bpy.context.scene.render.film_transparent = True
    catcher = plane("shadow catcher", 30, 30, (0, 0, 0), mat=principled("catcher", hex_linear(ground), 0.6))
    catcher.is_shadow_catcher = True
    light("SUN", "key", (-6, -7, 8), 2.4 * light_["key"])
    light("SUN", "fill", (8, -6, 3), 1.2 * light_["fill"], color=(0.87, 0.91, 1.0))
    light("SUN", "rim", (1, 10, 6), 1.4 * light_["rim"])
    if plate["slug"] == "showroom":  # cool overhead softbox, white bars in the back corners, the ring's glow
        light("AREA", "overhead softbox", (0, 0.6, 6.3), 700, size=(8, 5), target=(0, 0.6, 0), color=srgb_to_linear(kelvin_color(6500)))
        for x in (-4.8, 4.8):
            light("AREA", "bar light", (x, 4.0, 1.5), 160, size=(0.3, 2.6), target=(0, 0, 0.8))
        glow = light("AREA", "ring glow", (0, 0, 0.01), 60 * light_["glow"][1], size=(6.6, 6.6), target=(0, 0, 1), color=hex_linear(light_["glow"][0]))
        glow.data.size_y = 6.6


REAL_SIZE = {"car": 4.6, "humanoid": 1.8}  # rooms.js roomScale: a car's length, a person's height (m)


def room_scale(size, kind):
    """rooms.js roomScale. size is Blender's (x, y, z = height) of the normalised model."""
    s = size.z / REAL_SIZE["humanoid"] if kind == "humanoid" else max(size.x, size.y) / REAL_SIZE["car"]
    return min(4.0, max(0.25, s)) if s > 0 else 1.0


def room_lights(light):
    """The room's sky and key/fill/rim, as build_plate. light: pipeline.js PLATES[slug].light, or None for the defaults."""
    if light:
        sky, _ground, ambient = light["sky"]
        world(ambient * 2.5, hex_linear(sky))
    else:
        world(0.6, (0.9, 0.9, 0.92))
    k = light or {"key": 1.0, "fill": 0.5, "rim": 0.8}
    light_("SUN", "key", (-6, -7, 8), 2.4 * k["key"])
    light_("SUN", "fill", (8, -6, 3), 1.2 * k["fill"], color=(0.87, 0.91, 1.0))
    light_("SUN", "rim", (1, 10, 6), 1.4 * k["rim"])


light_ = light  # build_room's argument is called light too


def build_cyc(color):
    """studio.js buildCyclorama: a flat floor, a quarter-circle cove and the back wall, 3.5 m behind the car."""
    r = 4.0
    profile = [(30 - i * 30 / 8, 0.0) for i in range(9)]  # (three z, three y)
    profile += [(-r * math.sin(i / 16 * math.pi / 2), r - r * math.cos(i / 16 * math.pi / 2)) for i in range(1, 17)]
    profile += [(-r, r + i * 3.0) for i in range(1, 7)]
    verts, faces = [], []
    for z, y in profile:
        verts += [(-30, -(z - 3.5), y), (30, -(z - 3.5), y)]
    for i in range(len(profile) - 1):
        faces.append((2 * i, 2 * i + 1, 2 * i + 3, 2 * i + 2))
    mesh = bpy.data.meshes.new("cyc")
    mesh.from_pydata(verts, [], faces)
    obj = bpy.data.objects.new("cyc", mesh)
    bpy.context.scene.collection.objects.link(obj)
    for p in mesh.polygons:
        p.use_smooth = True
    obj.data.materials.append(principled("cyc", hex_linear(color), 0.92))
    light_("AREA", "top", (0, 0, 7), 900, size=(8, 4), target=(0, 0, 0))
    return obj


def build_soft_studio(color):
    """studio.js buildSoftStudio: a 24 x 24 x 8 m grey room, softboxes either side of the camera and overhead."""
    objs = []
    wall = principled("walls", hex_linear(color), 0.95)
    for name, size, loc, rot in (
        ("floor", (24, 24), (0, 0, 0), (0, 0, 0)), ("ceiling", (24, 24), (0, 0, 8), (math.pi, 0, 0)),
        ("back", (24, 8), (0, 12, 4), (math.pi / 2, 0, 0)), ("front", (24, 8), (0, -12, 4), (-math.pi / 2, 0, 0)),
        ("left", (24, 8), (-12, 0, 4), (math.pi / 2, 0, math.pi / 2)), ("right", (24, 8), (12, 0, 4), (math.pi / 2, 0, -math.pi / 2)),
    ):
        objs.append(plane(name, *size, loc, rotation=rot, mat=principled("floor", hex_linear("#8d9097"), 0.9) if name == "floor" else wall))
    for x in (-5.5, 5.5):
        box = plane("softbox", 3, 4, (x, -4, 2.6), mat=emission("softbox", (1, 1, 1), 4.0))
        box.rotation_euler = (Vector((0, 0, 1.2)) - box.location).to_track_quat("Z", "Y").to_euler()
        objs.append(box)
        light_("AREA", "softbox light", (x, -4, 2.6), 500, size=(3, 4), target=(0, 0, 1.2))
    objs.append(plane("top softbox", 6, 4, (0, 0, 7.95), rotation=(math.pi, 0, 0), mat=emission("top softbox", (1, 1, 1), 4.0)))
    light_("AREA", "overhead", (0, 0, 7.9), 700, size=(6, 4), target=(0, 0, 0))
    return objs


def env_node(nt, path, turn):
    """An Environment Texture of the room's HDRI, turned by -turn about Z (rooms.js roomRotation, see its note)."""
    env = nt.nodes.new("ShaderNodeTexEnvironment")
    env.image = bpy.data.images.load(path, check_existing=True)
    mapping = nt.nodes.new("ShaderNodeMapping")
    mapping.inputs["Rotation"].default_value = (0, 0, -turn)
    return env, mapping


def build_hdri_room(room):
    """studio.js buildHdriRoom: the HDRI lights the scene from the world and is projected onto a dome round the model
    (three's GroundedSkybox shape) that only the camera sees, over a textured floor disc fading into it."""
    files, turn, h, radius = room["files"], room["turn"], room["height"], room["radius"]
    w = bpy.context.scene.world
    nt = w.node_tree
    env, mapping = env_node(nt, files["hdri"], turn)
    coord = nt.nodes.new("ShaderNodeTexCoord")
    nt.links.new(coord.outputs["Generated"], mapping.inputs["Vector"])
    nt.links.new(mapping.outputs["Vector"], env.inputs["Vector"])
    bg = nt.nodes["Background"]
    nt.links.new(env.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = 1.0
    # The dome: a sphere whose lower half is flattened onto the ground, as GroundedSkybox does.
    bpy.ops.mesh.primitive_uv_sphere_add(radius=radius, segments=128, ring_count=64, location=(0, 0, h - 0.02))
    dome = bpy.context.active_object
    dome.name = "room dome"
    y1 = -h * 1.5
    for v in dome.data.vertices:
        z = v.co.z
        if z < 0:
            v.co *= -h / z if z < y1 else 1 - z * z / (3 * y1 * y1)
    mat = bpy.data.materials.new("room dome")
    mat.use_nodes = True
    mn = mat.node_tree
    mn.nodes.clear()
    out = mn.nodes.new("ShaderNodeOutputMaterial")
    em = mn.nodes.new("ShaderNodeEmission")
    denv, dmap = env_node(mn, files["hdri"], turn)
    dco = mn.nodes.new("ShaderNodeTexCoord")
    mn.links.new(dco.outputs["Object"], dmap.inputs["Vector"])
    mn.links.new(dmap.outputs["Vector"], denv.inputs["Vector"])
    mn.links.new(denv.outputs["Color"], em.inputs["Color"])
    mn.links.new(em.outputs["Emission"], out.inputs["Surface"])
    dome.data.materials.append(mat)
    for ray in ("visible_diffuse", "visible_glossy", "visible_transmission", "visible_volume_scatter", "visible_shadow"):
        setattr(dome, ray, False)  # the world lights and reflects; the dome is only what the camera sees
    # The floor: a disc with the room's texture set, solid to 55% of its radius, then fading out.
    f = room["floor"]
    bpy.ops.mesh.primitive_circle_add(vertices=96, radius=f["radius"], fill_type="NGON", location=(0, 0, 0))
    floor = bpy.context.active_object
    floor.name = "room floor"
    mat = bpy.data.materials.new("room floor")
    mat.use_nodes = True
    mn = mat.node_tree
    bsdf = mn.nodes["Principled BSDF"]
    co = mn.nodes.new("ShaderNodeTexCoord")
    scale = mn.nodes.new("ShaderNodeVectorMath")
    scale.operation = "SCALE"
    scale.inputs["Scale"].default_value = 1 / f["tile"]
    mn.links.new(co.outputs["Object"], scale.inputs[0])

    def tex(path, data):
        t = mn.nodes.new("ShaderNodeTexImage")
        t.image = bpy.data.images.load(path, check_existing=True)
        if data:
            t.image.colorspace_settings.name = "Non-Color"
        mn.links.new(scale.outputs["Vector"], t.inputs["Vector"])
        return t
    mn.links.new(tex(files["diff"], False).outputs["Color"], bsdf.inputs["Base Color"])
    rough = mn.nodes.new("ShaderNodeMath")
    rough.operation = "MULTIPLY"
    mn.links.new(tex(files["rough"], True).outputs["Color"], rough.inputs[0])
    rough.inputs[1].default_value = f["roughness"]
    mn.links.new(rough.outputs[0], bsdf.inputs["Roughness"])
    nmap = mn.nodes.new("ShaderNodeNormalMap")
    mn.links.new(tex(files["nor"], True).outputs["Color"], nmap.inputs["Color"])
    mn.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    length = mn.nodes.new("ShaderNodeVectorMath")
    length.operation = "LENGTH"
    mn.links.new(co.outputs["Object"], length.inputs[0])
    fade = mn.nodes.new("ShaderNodeMapRange")
    fade.interpolation_type = "SMOOTHSTEP"
    fade.inputs["From Min"].default_value = 0.55 * f["radius"]
    fade.inputs["From Max"].default_value = f["radius"]
    fade.inputs["To Min"].default_value = 1.0
    fade.inputs["To Max"].default_value = 0.0
    mn.links.new(length.outputs["Value"], fade.inputs["Value"])
    mn.links.new(fade.outputs["Result"], bsdf.inputs["Alpha"])
    floor.data.materials.append(mat)
    return [dome, floor]


def build_room(room, size, reflection):
    """The scene's 3D room (rooms.js), built round the normalised model and scaled to it like studio.js."""
    if room["type"] == "showroom":
        build_showroom(reflection)
        return
    room_lights(room.get("light"))
    before = set(bpy.data.objects)
    if room["type"] == "cyc":
        build_cyc(room["color"])
    elif room["type"] == "studio":
        build_soft_studio(room["color"])
    elif room["type"] == "hdri":
        build_hdri_room(room)
    s = room_scale(size, room.get("kind", "car"))
    for o in set(bpy.data.objects) - before:
        if o.type != "LIGHT" or o.name not in ("key", "fill", "rim"):
            o.location *= s
            o.scale *= s


def plate_lighting(lighting, sun):
    """The rig moves and tints the photo's own sun, as in studio.js: its defaults leave the sun as matched."""
    out = dict(lighting)
    out["azimuth"] = sun["azimuth"] + lighting["azimuth"] - LIGHTING["azimuth"]
    out["elevation"] = min(88.0, max(3.0, sun["elevation"] + lighting["elevation"] - LIGHTING["elevation"]))
    out["kelvin"] = min(12000.0, max(1500.0, sun["kelvin"] + lighting["kelvin"] - LIGHTING["kelvin"]))
    return out


def aim_camera(data, location, target):
    obj = bpy.data.objects.new("camera", data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = location
    obj.rotation_euler = (Vector(target) - Vector(location)).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = obj
    return obj


def plate_camera(cam, aspect, s, sphere):
    """The camera pipeline.js plateCamera solved for the photo; Flatform's Y-up (x, y, z) is Blender's (x, -z, y).
    "Frame all" pulls back along the photo's own view until the whole model fits (studio.js applyPlateCamera)."""
    (px, py, pz), (tx, ty, tz) = cam["position"], cam["target"]
    data = bpy.data.cameras.new("camera")
    data.sensor_fit = "HORIZONTAL"
    data.angle = 2 * math.atan(math.tan(math.radians(cam["vfov"]) / 2) * aspect)
    location, target = Vector((px, -pz, py)), Vector((tx, -tz, ty))
    cam_obj = aim_camera(data, location, target)
    if s["fit"] == "all":  # the photo's camera aims at the floor: pull back along its view until every corner fits
        scene = bpy.context.scene
        for _ in range(40):
            bpy.context.view_layer.update()
            seen = [world_to_camera_view(scene, cam_obj, c) for c in sphere[2]]
            if all(0.04 <= v.x <= 0.96 and 0.04 <= v.y <= 0.96 and v.z > 0 for v in seen):
                break
            cam_obj.location = target + (cam_obj.location - target) * 1.06


def lens_camera(lens):
    data = bpy.data.cameras.new("camera")
    data.sensor_fit = "HORIZONTAL"
    data.sensor_width = 35
    data.lens = float(lens)
    return data


def free_camera(s):
    """Free roam: the orbit camera saved by the composer, with the lens slider's field of view."""
    (px, py, pz), (tx, ty, tz) = s["orbit"]["position"], s["orbit"]["target"]
    aim_camera(lens_camera(s["lens"]), (px, -pz, py), (tx, -tz, ty))


def place_camera(s, look, size, sphere):
    """Fitted to the car's footprint like studio.js applyCamera; size is the normalised car (x, y, z = height)."""
    aspect = 1.0 if look == "transparent" else 4 / 3
    lens = float(s["lens"])
    hfov = 2 * math.atan(17.5 / lens)  # 35 mm film gauge, like studio.js
    width = math.hypot(size.x, size.y) / (FILL["wide"] if aspect > 1 else FILL["square"])
    distance = width / 2 / math.tan(hfov / 2)
    target = Vector((0, 0, size.z / 2 + (0.06 * width if aspect > 1 else 0)))
    if s["fit"] == "all":  # "Frame all": the whole model, from the preset's angle
        distance = max(distance, fit_distance(sphere[1], hfov, aspect))
        target = sphere[0]
    el = math.radians(CAMERAS.get(s["camera"], 13.0))
    aim_camera(lens_camera(lens), (target.x, target.y - distance * math.cos(el), target.z + distance * math.sin(el)), target)


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


def apply_profile(scene, meshes, profile):
    """Max realism (realism.mjs): final-quality Cycles with every effect on. Each setting is tried on its own, so a
    Blender version without one still renders."""
    def put(obj, attr, value):
        try:
            setattr(obj, attr, value)
        except Exception as e:  # noqa: BLE001
            print(f"profile: {attr} not set ({e})")
    cy = scene.cycles
    put(cy, "samples", int(profile.get("samples", 512)))
    put(cy, "use_denoising", bool(profile.get("denoise", True)))
    put(cy, "use_adaptive_sampling", True)
    put(cy, "use_fast_gi", False)
    b = profile.get("bounces") or {}
    put(cy, "max_bounces", int(b.get("total", 12)))
    put(cy, "glossy_bounces", int(b.get("glossy", 8)))  # ray-traced reflections
    put(cy, "transmission_bounces", int(b.get("transmission", 12)))  # refraction through glass
    put(cy, "transparent_max_bounces", 16)
    put(cy, "caustics_reflective", True)
    put(cy, "caustics_refractive", bool(profile.get("refraction", True)))
    if profile.get("ambientOcclusion"):
        put(scene.world.light_settings, "distance", 1.0)
        put(cy, "ao_bounces_render", 3)
    tonemap = profile.get("tonemap", "AgX")
    for transform in (tonemap, "AgX", "Khronos PBR Neutral", "Standard"):
        try:
            scene.view_settings.view_transform = transform
            break
        except TypeError:
            continue
    if profile.get("subsurface"):  # interior leather and fabric scatter light a little
        for o in meshes:
            for slot in o.material_slots:
                m = slot.material
                if not m or not m.use_nodes or not re.search(r"seat|leather|fabric|cloth|interior|trim", (m.name or "").lower()):
                    continue
                bsdf = next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
                if bsdf and "Subsurface Weight" in bsdf.inputs:
                    bsdf.inputs["Subsurface Weight"].default_value = 0.15
    cabin = (profile.get("glass") or {}).get("litCabin")
    if cabin:  # a soft light inside the cabin so the interior reads through the glass
        light("POINT", "cabin", (0, 0, 1.05), 40, target=(0, 0, 0.6), color=(1.0, 0.96, 0.9))


def interior_camera(s):
    """An interior spin: the camera sits at head height in the cabin and turns with the frames."""
    cam = bpy.data.cameras.new("interior")
    cam.lens = 18
    return aim_camera(cam, (0.35, 0.0, 1.1), (0.35, -3.0, 1.0))


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
    rig = json.loads(args.rig) if args.rig else {}
    lighting = {**LIGHTING, **rig.get("lighting", {})}
    glass = {**GLASS, **rig.get("glass", {})}
    plate = json.loads(args.plate) if args.plate and args.look != "transparent" else None
    room = json.loads(args.room) if args.room and args.look != "transparent" else None
    photo = bool(plate) and not plate["modeled"]
    # The model first: a room is built round it and scaled to it.
    pivot, meshes, size, sphere = import_car(args.glb, s)
    if args.pose:  # after normalising, like studio.js applyModel, so the model is placed exactly as in the app
        print(f"FLATFORM_POSE {apply_pose(json.loads(args.pose))}", flush=True)
    if args.look == "transparent":
        build_transparent()
    elif photo:
        build_plate(plate)
        lighting = plate_lighting(lighting, plate["light"]["sun"])
    elif room:
        build_room(room, size, float(s["reflection"]))
        if room.get("light"):
            lighting = plate_lighting(lighting, room["light"]["sun"])
    elif args.look == "showroom" or (plate and plate["slug"] == "showroom"):
        build_showroom(float(s["reflection"]))
    else:
        build_ring_studio(float(s["reflection"]))
    apply_rig(lighting)
    apply_glass(meshes, glass)
    if args.materials and os.path.exists(args.materials):
        with open(args.materials, encoding="utf-8") as f:
            apply_materials(meshes, json.load(f))
    setup_render(width, height, "transparent" if photo else args.look, args.samples)
    apply_look(json.loads(args.scenelook) if args.scenelook else None, meshes)
    profile = json.loads(args.profile) if args.profile else None
    if profile:
        apply_profile(bpy.context.scene, meshes, profile)
    if args.interior:
        interior_camera(s)
    elif s["view"] == "free" and s["orbit"]:
        free_camera(s)
    elif plate or (room and room.get("camera")):
        plate_camera((plate or room)["camera"], width / height, s, sphere)
    else:
        place_camera(s, args.look, size, sphere)
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
