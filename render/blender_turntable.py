"""Flatform turntable renderer for Blender 4.x (Cycles).

    blender -b -P blender_turntable.py -- --glb car.glb --out frames/studio --slug audi-r8 --look studio \
        --frames 72 --step 5 --res 2048x1536 [--scene scene.json] [--rig '{"lighting": {...}, "glass": {...}}']
        [--still 30 --still-out stills/x.png]

Builds the Escalade ring studio, a 3D environment (public/lib/environments.js, passed as --environment) or the
transparent look in code, normalises and frames the car
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
from mathutils import Euler, Matrix, Quaternion, Vector

CAR_LENGTH = 4.6
RING = (1.0, 0.195, 0.133)  # #ff7a66, the app's coral accent, in linear RGB
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
    p.add_argument("--environment")  # environments.js blenderEnvironment: parts, mats, lights, sky, camera, light
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
    p.add_argument("--pose")  # blender.mjs blenderPose: {"bones": {name: [x, y, z] three.js Euler degrees}, "hips": ...}
    p.add_argument("--report-bones", action="store_true")  # tests: print each posed bone's head
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


def gltf_quat(q):
    """A glTF rotation [x, y, z, w] (Y up) as a Blender quaternion (Z up): the importer's (x, y, z) -> (x, -z, y)."""
    return Quaternion((q[3], q[0], -q[2], q[1]))


def three_euler(deg):
    """three.js Euler degrees, order XYZ (Rx * Ry * Rz), in glTF axes, as a glTF [x, y, z, w] rotation."""
    q = Quaternion((1, 0, 0), math.radians(deg[0])) @ Quaternion((0, 1, 0), math.radians(deg[1])) @ Quaternion((0, 0, 1), math.radians(deg[2]))
    return [q.x, q.y, q.z, q.w]


def glb_nodes(path):
    with open(path, "rb") as f:
        data = f.read()
    length = int.from_bytes(data[12:16], "little")
    return json.loads(data[20:20 + length].decode("utf-8")).get("nodes", [])


def apply_pose(glb, pose, pivot):
    """The Compose pose, the way rig.js applies it in the app: each bone turns by its Euler on top of its rest
    rotation (in the glTF node's own axes), the hips move by `hips` metres in the turntable's space. Works whatever
    axes the importer gave the Blender bones: the pose is worked out in glTF space and handed over as a change of
    each bone's armature-space rotation."""
    nodes = glb_nodes(glb)
    parent = {c: i for i, n in enumerate(nodes) for c in n.get("children", [])}
    index = {n.get("name"): i for i, n in enumerate(nodes)}
    arms = [o for o in bpy.data.objects if o.type == "ARMATURE"]
    posed = 0
    for arm in arms:
        bones = [b for b in arm.data.bones if b.name in index]  # parents before children
        # Rest (as loaded) and posed rotations of each bone node, relative to the armature's own node.
        rest_w, pose_w = {}, {}
        for b in bones:
            i = index[b.name]
            local = gltf_quat(nodes[i].get("rotation", [0, 0, 0, 1]))
            turn = gltf_quat(three_euler(pose["bones"][b.name])) if b.name in pose.get("bones", {}) else Quaternion()
            up = b.parent.name if b.parent and b.parent.name in rest_w else None
            rest_w[b.name] = (rest_w[up] if up else Quaternion()) @ local
            pose_w[b.name] = (pose_w[up] if up else Quaternion()) @ local @ turn
        bpy.context.view_layer.update()
        now = {b.name: arm.pose.bones[b.name].matrix.to_quaternion() for b in bones}  # as imported
        target = {n: (pose_w[n] @ rest_w[n].inverted()) @ now[n] for n in now}
        hips = pose.get("hips")
        for b in bones:
            pb = arm.pose.bones[b.name]
            pb.rotation_mode = "QUATERNION"
            # matrix = parent_posed @ (parent_rest^-1 @ rest) @ basis, so basis = (parent_posed @ parent_rest^-1 @ rest)^-1 @ target
            chain = b.matrix_local.to_quaternion()
            if b.parent:
                chain = target.get(b.parent.name, now.get(b.parent.name, Quaternion())) @ b.parent.matrix_local.to_quaternion().inverted() @ chain
            pb.rotation_quaternion = chain.inverted() @ target[b.name]
            if hips and b.name == hips["bone"]:
                x, y, z = hips["offset"]
                world = pivot.matrix_world.to_3x3() @ Vector((x, -z, y))
                frame = (arm.pose.bones[b.parent.name].matrix @ b.parent.matrix_local.inverted() @ b.matrix_local) if b.parent else b.matrix_local
                pb.location = pb.location + frame.to_3x3().inverted() @ (arm.matrix_world.to_3x3().inverted() @ world)
            posed += 1
            bpy.context.view_layer.update()
    print(f"FLATFORM_POSED {posed}", flush=True)
    return arms


def report_bones(arms, model):
    """Each bone's head in the model's glTF space (Y up), for the tests that check the pose against three.js."""
    bpy.context.view_layer.update()
    to_model = model.matrix_world.inverted()
    print(f"FLATFORM_MODEL {model.scale.x:.6f} {model.rotation_euler.z:.6f}", flush=True)
    for arm in arms:
        for pb in arm.pose.bones:
            v = to_model @ arm.matrix_world @ pb.head
            print(f"FLATFORM_BONE {pb.name} {v.x:.5f} {v.z:.5f} {-v.y:.5f}", flush=True)


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
        # The HDRI lights and reflects; the camera sees the scene's own background, or the place on a dome.
        mix = nt.nodes.new("ShaderNodeMixShader")
        path = nt.nodes.new("ShaderNodeLightPath")
        nt.links.new(path.outputs["Is Camera Ray"], mix.inputs["Fac"])
        nt.links.new(lit.outputs["Background"], mix.inputs[1])
        nt.links.new(bg_node.outputs["Background"], mix.inputs[2])
        nt.links.new(mix.outputs["Shader"], out.inputs["Surface"])
        if hdri.get("background"):
            height, radius = hdri.get("ground") or (1.7, 40)
            grounded_dome(hdri["path"], height, radius, hdri.get("rotation", 0), hdri.get("intensity", 1.0))
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


AREA_W = 15.0  # three.js RectAreaLight intensity per m² -> Blender watts. ponytail: hand-matched; retune against a reference frame
EMIT_W = 4.0  # three.js emissive multiplier -> Blender emission strength (same hand match as the old showroom)
SKY_STRENGTH = 0.15  # Blender's physical Sky Texture is far brighter than the app's suns; this keeps them in step
TO_BLENDER = Matrix(((1, 0, 0), (0, 0, -1), (0, 1, 0)))  # Flatform's Y-up (x, y, z) is Blender's (x, -z, y)


def bl(v):
    return (v[0], -v[2], v[1])


def see_through_back(mat):
    """Room walls face inward: from outside they let the camera through, like studio.js's BackSide walls."""
    nt = mat.node_tree
    out = next(n for n in nt.nodes if n.type == "OUTPUT_MATERIAL")
    surface = out.inputs["Surface"].links[0].from_socket
    mix = nt.nodes.new("ShaderNodeMixShader")
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    clear = nt.nodes.new("ShaderNodeBsdfTransparent")
    nt.links.new(geo.outputs["Backfacing"], mix.inputs["Fac"])
    nt.links.new(surface, mix.inputs[1])
    nt.links.new(clear.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs["Surface"])
    return mat


def env_material(name, spec):
    color = hex_linear(spec["color"])
    if spec.get("emit", 0) > 0:
        return emission(name, color, spec["emit"] * EMIT_W)
    return principled(name, color, spec.get("rough", 0.8), spec.get("metal", 0.0))


def env_object(name, mesh_obj, rot=None):
    mesh_obj.name = f"env {name}"
    mesh_obj.visible_shadow = False  # the place never blocks the key/fill/rim suns (studio.js: castShadow off)
    if rot:
        r = Euler([math.radians(a) for a in rot], "XYZ").to_matrix()
        mesh_obj.rotation_euler = (TO_BLENDER @ r @ TO_BLENDER.inverted()).to_euler()
    return mesh_obj


def mesh_from(name, verts, faces, mat_indices=None, mats=()):
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    for m in mats:
        me.materials.append(m)
    if mat_indices:
        for poly, i in zip(me.polygons, mat_indices):
            poly.material_index = i
    me.update()
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def room_mesh(p, mats):
    """A box seen from inside: floor on z = 0, faces wound inward (walls, ceiling, floor materials)."""
    w, h, d = p["room"]
    cx, cz = p["at"]
    x0, x1, y0, y1 = cx - w / 2, cx + w / 2, -(cz + d / 2), -(cz - d / 2)
    v = [(x0, y0, 0), (x1, y0, 0), (x1, y1, 0), (x0, y1, 0), (x0, y0, h), (x1, y0, h), (x1, y1, h), (x0, y1, h)]
    faces = [(0, 1, 2, 3), (4, 7, 6, 5), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]  # normals point in
    walls, ceiling, floor = (see_through_back(env_material(f"room {k}", mats[p[k]])) for k in ("walls", "ceiling", "floor"))
    return mesh_from("room", v, faces, [2, 1, 0, 0, 0, 0], (walls, ceiling, floor))


def cyc_mesh(p, mat):
    """env3d.js cycGeometry: floor from z to z + front, a quarter-circle cove of `radius`, the wall up to h."""
    w, h, r, front = p["cyc"]
    x, z0 = p["at"]
    profile = [(z0 + front, 0), (z0 + r, 0)]
    profile += [(z0 + r - r * math.sin(i / 16 * math.pi / 2), r - r * math.cos(i / 16 * math.pi / 2)) for i in range(1, 17)]
    profile.append((z0, h))
    verts = [bl((x + sx, y, z)) for z, y in profile for sx in (-w / 2, w / 2)]
    faces = [(2 * i, 2 * i + 1, 2 * i + 3, 2 * i + 2) for i in range(len(profile) - 1)]
    obj = mesh_from("cyc", verts, faces, mats=(mat,))
    for poly in obj.data.polygons:
        poly.use_smooth = True
    return obj


def env_world(sky, reflect):
    """The sky around the place: a colour, an HDRI at infinity or Blender's physical sky from the place's sun.
    `reflect` (an HDRI path) lights and reflects while the camera still sees the sky colour."""
    w = bpy.data.worlds.new("Flatform")
    w.use_nodes = True
    bpy.context.scene.world = w
    nt = w.node_tree
    bg = nt.nodes["Background"]  # apply_rig scales this one with the rim slider, like studio.js environmentIntensity
    out = next(n for n in nt.nodes if n.type == "OUTPUT_WORLD")
    if sky.get("path") and os.path.exists(sky["path"]):
        env = nt.nodes.new("ShaderNodeTexEnvironment")
        env.image = bpy.data.images.load(sky["path"])
        mapping = nt.nodes.new("ShaderNodeMapping")
        mapping.inputs["Rotation"].default_value = (0, 0, math.radians(sky.get("rotation", 0)))
        coord = nt.nodes.new("ShaderNodeTexCoord")
        nt.links.new(coord.outputs["Generated"], mapping.inputs["Vector"])
        nt.links.new(mapping.outputs["Vector"], env.inputs["Vector"])
        nt.links.new(env.outputs["Color"], bg.inputs["Color"])
        bg.inputs["Strength"].default_value = sky.get("intensity", 1.0)
        return
    if sky.get("sun"):
        tex = nt.nodes.new("ShaderNodeTexSky")
        for kind in ("NISHITA", "MULTIPLE_SCATTERING"):  # renamed in Blender 5
            try:
                tex.sky_type = kind
                break
            except TypeError:
                continue
        sun = sky["sunDir"]
        tex.sun_disc = False  # the key light is the sun
        tex.sun_elevation = math.radians(sun["elevation"])
        tex.sun_rotation = math.radians(sun["azimuth"]) + math.pi  # Cycles puts rotation 0 on +Y; Flatform's 0 is the camera side
        nt.links.new(tex.outputs["Color"], bg.inputs["Color"])
        bg.inputs["Strength"].default_value = SKY_STRENGTH
        return
    color = hex_linear(sky.get("color", "#000000"))
    bg.inputs["Color"].default_value = (*color, 1)
    bg.inputs["Strength"].default_value = 1.0
    if reflect and os.path.exists(reflect):
        env = nt.nodes.new("ShaderNodeTexEnvironment")
        env.image = bpy.data.images.load(reflect)
        nt.links.new(env.outputs["Color"], bg.inputs["Color"])
        seen = nt.nodes.new("ShaderNodeBackground")
        seen.inputs["Color"].default_value = (*color, 1)
        mix = nt.nodes.new("ShaderNodeMixShader")
        path = nt.nodes.new("ShaderNodeLightPath")
        nt.links.new(path.outputs["Is Camera Ray"], mix.inputs["Fac"])
        nt.links.new(bg.outputs["Background"], mix.inputs[1])
        nt.links.new(seen.outputs["Background"], mix.inputs[2])
        nt.links.new(mix.outputs["Shader"], out.inputs["Surface"])


def build_environment(env):
    """A 3D environment (public/lib/environments.js) around the car, part for part as public/lib/env3d.js builds
    it, lit like studio.js buildEnv: the place's own area lights plus key, fill and rim suns matched to it."""
    light_ = env["light"]
    env_world({**env["sky"], "sunDir": light_["sun"]}, env.get("reflect"))
    mats = {k: env_material(k, m) for k, m in env["mats"].items()}
    for i, p in enumerate(env["parts"]):
        if "room" in p:
            env_object(f"room {i}", room_mesh(p, env["mats"]))
            continue
        if "cyc" in p:
            env_object(f"cyc {i}", cyc_mesh(p, env_material(f"cyc {i}", env["mats"][p["mat"]])))
            continue
        if "glb" in p:
            if not (p.get("path") and os.path.exists(p["path"])):
                continue
            before = set(bpy.context.scene.objects)
            bpy.ops.import_scene.gltf(filepath=p["path"])
            root = bpy.data.objects.new(f"env glb {i}", None)
            bpy.context.scene.collection.objects.link(root)
            for o in set(bpy.context.scene.objects) - before:
                if o.parent is None:
                    o.parent = root
                o.name = f"env {o.name}"  # hidden with the rest when a place HDRI shows (grounded_dome)
                o.visible_shadow = False
            root.location = bl(p["at"])
            root.scale = (p.get("scale", 1),) * 3
            env_object(f"glb {i}", root, p.get("rot"))
            continue
        loc = bl(p["at"])
        if "box" in p:
            bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
            obj = bpy.context.active_object
            w, h, d = p["box"]
            obj.scale = (w, d, h)
        elif "cyl" in p:
            top, bottom, h = p["cyl"]
            bpy.ops.mesh.primitive_cone_add(vertices=24, radius1=bottom, radius2=top, depth=h, location=loc)
            obj = bpy.context.active_object
        else:
            bpy.ops.mesh.primitive_torus_add(major_radius=p["ring"][0], minor_radius=p["ring"][1], major_segments=320, minor_segments=12, location=loc)
            obj = bpy.context.active_object
        obj.data.materials.append(mats[p["mat"]])
        env_object(f"{p['mat']} {i}", obj, p.get("rot"))
    for i, l in enumerate(env["lights"]):
        w, h = l["area"]
        a = light("AREA", f"env light {i}", bl(l["at"]), l["power"] * w * h * AREA_W, size=(w, h), target=bl(l["aim"]), color=hex_linear(l["color"]))
        a.data.size_y = h
    light("SUN", "key", (-6, -7, 8), 2.4 * light_["key"])
    light("SUN", "fill", (8, -6, 3), 1.2 * light_["fill"], color=(0.87, 0.91, 1.0))
    light("SUN", "rim", (1, 10, 6), 1.4 * light_["rim"])


def grounded_dome(path, height, radius, rotation, strength):
    """studio.js showDome (three's GroundedSkybox): the HDRI on a sphere whose bottom is flattened into a floor
    `height` below its centre, so a place HDRI's ground meets the car at real scale. Hides the environment."""
    bpy.ops.mesh.primitive_uv_sphere_add(segments=96, ring_count=48, radius=radius, location=(0, 0, height - 0.01))
    dome = bpy.context.active_object
    dome.name = "hdri dome"
    for v in dome.data.vertices:
        v.co.z = max(v.co.z, -height)
    dome.visible_shadow = False
    mat = bpy.data.materials.new("hdri dome")
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    coord = nt.nodes.new("ShaderNodeTexCoord")
    mapping = nt.nodes.new("ShaderNodeMapping")  # the same turn as the world HDRI in apply_look
    mapping.inputs["Rotation"].default_value = (0, 0, math.radians(rotation))
    env = nt.nodes.new("ShaderNodeTexEnvironment")
    env.image = bpy.data.images.load(path)
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Strength"].default_value = strength
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(coord.outputs["Object"], mapping.inputs["Vector"])  # direction from the dome's centre, as in three
    nt.links.new(mapping.outputs["Vector"], env.inputs["Vector"])
    nt.links.new(env.outputs["Color"], em.inputs["Color"])
    nt.links.new(em.outputs["Emission"], out.inputs["Surface"])
    dome.data.materials.append(mat)
    for o in bpy.context.scene.objects:
        if o.name.startswith("env ") and o.type != "LIGHT":
            o.hide_render = True


def env_lighting(lighting, sun):
    """The rig moves and tints the place's own sun, as in studio.js: its defaults leave the sun as matched."""
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


def env_camera(cam, aspect, s, sphere):
    """The eye-level camera pipeline.js envCamera solved for the place; Flatform's Y-up (x, y, z) is Blender's
    (x, -z, y). "Frame all" pulls back along its own view until the whole model fits (studio.js applyEnvCamera)."""
    (px, py, pz), (tx, ty, tz) = cam["position"], cam["target"]
    data = bpy.data.cameras.new("camera")
    data.sensor_fit = "HORIZONTAL"
    data.angle = 2 * math.atan(math.tan(math.radians(cam["vfov"]) / 2) * aspect)
    location, target = Vector((px, -pz, py)), Vector((tx, -tz, ty))
    cam_obj = aim_camera(data, location, target)
    if s["fit"] == "all":  # the eye-level camera aims at the floor: pull back along its view until every corner fits
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
    env = json.loads(args.environment) if args.environment and args.look != "transparent" else None
    if args.look == "transparent":
        build_transparent()
    elif env:
        build_environment(env)
        lighting = env_lighting(lighting, env["light"]["sun"])
    else:
        build_ring_studio(float(s["reflection"]))
    apply_rig(lighting)
    pivot, meshes, size, sphere = import_car(args.glb, s)
    if args.pose:
        arms = apply_pose(args.glb, json.loads(args.pose), pivot)
        if args.report_bones:
            report_bones(arms, pivot.children[0])
    apply_glass(meshes, glass)
    if args.materials and os.path.exists(args.materials):
        with open(args.materials, encoding="utf-8") as f:
            apply_materials(meshes, json.load(f))
    setup_render(width, height, args.look, args.samples)
    apply_look(json.loads(args.scenelook) if args.scenelook else None, meshes)
    profile = json.loads(args.profile) if args.profile else None
    if profile:
        apply_profile(bpy.context.scene, meshes, profile)
    if args.interior:
        interior_camera(s)
    elif s["view"] == "free" and s["orbit"]:
        free_camera(s)
    elif env:
        env_camera(env["camera"], width / height, s, sphere)
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
