"""
PREVIEW A HEAD — front, three-quarter and side close-ups of a GLB's head, framed
on the head alone, at 1024 px AND at 96 px (the size a peer's head has at ~1 m
on a 1080p screen with the game's 92° FOV; at 1.5 m it is ~90 px).

    /Applications/Blender.app/Contents/MacOS/Blender -b --python scripts/preview-head.py -- model.glb out-prefix
                                                    [--neck-frac 0.86] [--engine BLENDER_EEVEE_NEXT]

Writes <out-prefix>-front.png, -threequarter.png, -side.png (1024 px, 85 mm
lens, camera at 3.2 × head size) and, through `sips -Z 96`, -front-96.png and
-threequarter-96.png. The 96 px files are the acceptance view: a face that does
not read there does not read in the game.

Prints `HEAD_BBOX lo=... hi=... H=... size=...` so two renders (before/after a
texture change) can be proven to be framed alike. The glTF importer's hidden
bone-shape Icosphere is disabled — it is a 1 m sphere at the origin that would
otherwise enter every bbox.

Workbench (default) shows the flat albedo the way the game's unlit-ish materials
read at a glance; `--engine BLENDER_EEVEE_NEXT` adds a sun + world fill so the
PBR roughness/normal response shows like three's MeshStandardMaterial (use it to
check that a material seam does not show as a gloss step).
"""

import math
import subprocess
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
if len(argv) < 2:
    print("usage: preview-head.py -- model.glb out-prefix [--neck-frac F] [--engine E]")
    sys.exit(2)
SRC, OUT = argv[0], argv[1]
NECK_FRAC = float(argv[argv.index("--neck-frac") + 1]) if "--neck-frac" in argv else 0.86
ENGINE = argv[argv.index("--engine") + 1] if "--engine" in argv else "BLENDER_WORKBENCH"

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC, disable_bone_shape=True)
scene = bpy.context.scene
depsgraph = bpy.context.evaluated_depsgraph_get()


def mesh_world_verts():
    for o in scene.objects:
        if o.type != "MESH":
            continue
        ev = o.evaluated_get(depsgraph)
        mw = ev.matrix_world
        for v in ev.data.vertices:
            yield mw @ v.co


lo = Vector((1e9,) * 3)
hi = Vector((-1e9,) * 3)
for w in mesh_world_verts():
    lo = Vector((min(lo.x, w.x), min(lo.y, w.y), min(lo.z, w.z)))
    hi = Vector((max(hi.x, w.x), max(hi.y, w.y), max(hi.z, w.z)))
H = hi.z - lo.z
neck = lo.z + NECK_FRAC * H

hlo = Vector((1e9,) * 3)
hhi = Vector((-1e9,) * 3)
for w in mesh_world_verts():
    if w.z > neck:
        hlo = Vector((min(hlo.x, w.x), min(hlo.y, w.y), min(hlo.z, w.z)))
        hhi = Vector((max(hhi.x, w.x), max(hhi.y, w.y), max(hhi.z, w.z)))
center = (hlo + hhi) / 2
size = max(hhi - hlo)
r3 = lambda v: tuple(round(c, 4) for c in v)  # noqa: E731
print(f"HEAD_BBOX lo={r3(hlo)} hi={r3(hhi)} H={H:.4f} neck={neck:.4f} size={size:.4f}")

scene.render.engine = ENGINE
if ENGINE == "BLENDER_WORKBENCH":
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "TEXTURE"
    scene.display.shading.show_shadows = False
else:
    # Eevee: a sun + the world fill so roughness/normal show like three's
    # MeshStandardMaterial under the host's directional + hemisphere lights.
    sun = bpy.data.lights.new("sun", "SUN")
    sun.energy = 3.0
    so = bpy.data.objects.new("sun", sun)
    scene.collection.objects.link(so)
    so.rotation_euler = (math.radians(50), 0, math.radians(200))
    scene.render.film_transparent = False
scene.render.resolution_x = 1024
scene.render.resolution_y = 1024
world = bpy.data.worlds.new("w")
scene.world = world
world.color = (0.55, 0.58, 0.6)
cam_data = bpy.data.cameras.new("cam")
cam_data.lens = 85
cam = bpy.data.objects.new("cam", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
dist = size * 3.2


def shoot(name, offset):
    cam.location = center + offset
    cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.render.filepath = f"{OUT}-{name}.png"
    bpy.ops.render.render(write_still=True)
    print("wrote", scene.render.filepath)
    return scene.render.filepath


# The model faces +Y in Blender (-Z in three).
front = shoot("front", Vector((0, dist, size * 0.05)))
three_q = shoot("threequarter", Vector((dist * 0.62, dist * 0.78, size * 0.12)))
shoot("side", Vector((dist, 0.0, size * 0.05)))

# The acceptance view: the same renders at the size a peer's head has in the game.
for src in (front, three_q):
    small = src[:-4] + "-96.png"
    subprocess.run(["sips", "-Z", "96", src, "--out", small], check=True, capture_output=True)
    print("wrote", small)
