"""
PREVIEW A GLB — front and side renders, framed on the model, Workbench textured.

    /Applications/Blender.app/Contents/MacOS/Blender -b --python scripts/preview-glb.py -- model.glb out-prefix
                                                    [--pose legL:0.5,armR:1.57,head:0.3]

Writes <out-prefix>-front.png and <out-prefix>-side.png. `--pose` rotates named
bones about their local X (radians) before rendering — the same axis the game's
`articulate` drives — so a rigged export can be checked mid-stride and aiming.
"""

import math
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
SRC, OUT = argv[0], argv[1]
POSE = {}
if "--pose" in argv:
    for pair in argv[argv.index("--pose") + 1].split(","):
        name, val = pair.split(":")
        POSE[name] = float(val)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
scene = bpy.context.scene

if POSE:
    for o in scene.objects:
        if o.type == "ARMATURE":
            bpy.context.view_layer.objects.active = o
            bpy.ops.object.mode_set(mode="POSE")
            for name, val in POSE.items():
                pb = o.pose.bones.get(name)
                if pb is None:
                    print("no bone", name)
                    continue
                pb.rotation_mode = "XYZ"
                pb.rotation_euler = (val, 0, 0)
            bpy.ops.object.mode_set(mode="OBJECT")

# Frame the whole thing — on the evaluated (skinned, posed) vertices; a
# skinned mesh's bound_box is the rest cage and lies about a raised arm.
depsgraph = bpy.context.evaluated_depsgraph_get()
lo = Vector((1e9, 1e9, 1e9))
hi = Vector((-1e9, -1e9, -1e9))
for o in scene.objects:
    if o.type != "MESH":
        continue
    ev = o.evaluated_get(depsgraph)
    for v in ev.data.vertices:
        w = ev.matrix_world @ v.co
        lo = Vector((min(lo.x, w.x), min(lo.y, w.y), min(lo.z, w.z)))
        hi = Vector((max(hi.x, w.x), max(hi.y, w.y), max(hi.z, w.z)))
center = (lo + hi) / 2
size = max(hi - lo)
print(f"bbox lo {tuple(round(v, 3) for v in lo)} hi {tuple(round(v, 3) for v in hi)}")

scene.render.engine = "BLENDER_WORKBENCH"
scene.display.shading.light = "STUDIO"
scene.display.shading.color_type = "TEXTURE"
scene.display.shading.show_shadows = False
scene.render.resolution_x = 800
scene.render.resolution_y = 1000
world = bpy.data.worlds.new("w")
scene.world = world
world.color = (0.55, 0.58, 0.6)
cam_data = bpy.data.cameras.new("cam")
cam_data.lens = 50
cam = bpy.data.objects.new("cam", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
dist = size * 1.9


def shoot(name, offset):
    cam.location = center + offset
    cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.render.filepath = f"{OUT}-{name}.png"
    bpy.ops.render.render(write_still=True)
    print("wrote", scene.render.filepath)


# The game's Pascaline faces +Y in Blender (-Z in three): the "front" camera
# stands at +Y, a little to the side and above eye height, looking back.
shoot("front", Vector((dist * 0.25, dist, size * 0.12)))
shoot("side", Vector((dist, dist * 0.05, size * 0.1)))
