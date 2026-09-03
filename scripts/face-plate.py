"""
FACE PLATE — give Pascaline's forward head polys their own opaque, clamped
texture plate so the face can be painted at ~2000 px/m without touching the
body atlas, the body's UVs elsewhere, or the rig.

    Blender -b --python scripts/face-plate.py -- render assets/pascaline-body.glb /tmp/plate
    Blender -b --python scripts/face-plate.py -- apply  assets/pascaline-body.glb assets/pascaline.glb \
        --paint assets/pascaline-face.jpg [--register] [--no-match-tone] [--px N] [--plate-only out.png]

`render` writes <prefix>-render.png (RGBA: the flat albedo of the selected
polys seen by the plate camera, transparent elsewhere — the exact foreground
mask), <prefix>-input.png (the same RGB over #808080, alpha 1 — the picture a
2D image model repaints; never send alpha to a model) and <prefix>-frame.json.

`apply` re-renders that mask internally with the identical camera, builds the
plate from --paint (resampled to the plate size, optionally registered onto the
mask's bounding box, skin tone matched to the body atlas, foreground colour
dilated into the background so bilinear taps at the silhouette never see the
backdrop), gives the selected polys a second material `face` whose UVs are the
plate camera's orthographic projection, and exports the GLB exactly as
scripts/rig-pascaline.py does. Everything else — vertices, weights, the 13
bones, the rigDims extras, the body atlas — is left as it was. The input must
be an UN-plated body (a material named `face` is refused: re-projecting would
destroy the original UVs of any poly that leaves the selection).

Why a plate and not a bigger atlas: the whole front of the head owns ~14k
texels of the 1024 px atlas in 56 UV islands, and the image-to-3D generator's
content is already a smear; a repaint needs one contiguous, upright, undistorted
picture of the face. The frame is DERIVED from the selection so every selected
vertex projects inside [UV_EPS, 1 - UV_EPS] (a fixed frame once left collar
loops outside [0,1], and glTF samplers default to REPEAT), the plate sampler is
CLAMP_TO_EDGE (Image Texture extension EXTEND), and the plate's roughness is
sampled from the body's metallic-roughness map so the seam shows no gloss step.

Blender 4.5 exporter facts this relies on: alphaMode comes from the Principled
Alpha socket (unlinked 1.0 => no alphaMode => OPAQUE; Material.blend_method is
ignored); wrapS/wrapT come from the Image Texture node's `extension`; the
importer adds a 1 m bone-shape Icosphere unless disable_bone_shape=True.
"""

import json
import math
import os
import struct
import sys
import tempfile

import bpy
import numpy as np
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector

# ── constants ────────────────────────────────────────────────────────────────
PLATE_PX = 1024
FACE_MIN_Z_FRAC = 0.755  # of the body height: the front boundary lands on the black collar
FACE_HALF_W = 0.20  # m, centroid |x| limit either side of the midline
FACE_NORMAL_MIN_Y = 0.30  # forward-facing polys only (the model faces +Y in Blender)
FRAME_ABOVE = 0.02  # m of plate above the crown
FRAME_MARGIN = 0.04  # fraction of the selection's extent kept as plate margin
OCCLUSION_TOL = 0.004  # m: a ray hit this close to the centroid counts as hitting the poly
DILATE_PX = 12
TONE_CLAMP = (0.7, 1.3)
FACE_MATERIAL = "face"
FACE_IMAGE = "pascaline_face"
INPUT_GREY = 0.5
UV_EPS = 0.004
CAM_Y = 3.0
CLAMP_TO_EDGE = 33071
MAX_GLB_BYTES = 1_000_000
MAX_PLATE_JPEG = 200_000
REGISTER_FG_DELTA = 0.08

# ── args ─────────────────────────────────────────────────────────────────────
argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []


def usage():
    print(
        "usage: face-plate.py -- render in.glb out-prefix [--px N] [--min-ny F]\n"
        "       face-plate.py -- apply in.glb out.glb --paint plate.png "
        "[--register] [--no-match-tone] [--px N] [--min-ny F] [--plate-only out.png]"
    )
    sys.exit(2)


def opt(name, default=None):
    return argv[argv.index(name) + 1] if name in argv else default


if len(argv) < 3 or argv[0] not in ("render", "apply"):
    usage()
MODE, SRC, OUT = argv[0], argv[1], argv[2]
PX = int(opt("--px", PLATE_PX))
# Where the plate/atlas seam runs round the side of the face: lower puts more of
# the cheek on the plate (seam further round, under the hair mass).
FACE_NORMAL_MIN_Y = float(opt("--min-ny", FACE_NORMAL_MIN_Y))
PAINT = opt("--paint")
REGISTER = "--register" in argv
MATCH_TONE = "--no-match-tone" not in argv
PLATE_ONLY = opt("--plate-only")
if MODE == "apply" and not PAINT:
    print("apply needs --paint <image>")
    usage()


def fail(msg):
    print(f"FACE_PLATE FAIL: {msg}")
    sys.exit(1)


# ── import ───────────────────────────────────────────────────────────────────
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC, disable_bone_shape=True)
scene = bpy.context.scene
meshes = [o for o in scene.objects if o.type == "MESH"]
arms = [o for o in scene.objects if o.type == "ARMATURE"]
if len(meshes) != 1 or len(arms) != 1:
    fail(f"expected one mesh + one armature, got {len(meshes)} mesh / {len(arms)} armature")
body, arm = meshes[0], arms[0]
me = body.data
if any(m and m.name == FACE_MATERIAL for m in me.materials):
    fail(f"{SRC} already has a '{FACE_MATERIAL}' material — apply only to the un-plated body (assets/pascaline-body.glb)")
if len(me.materials) != 1 or me.materials[0] is None:
    fail(f"expected exactly one body material, got {[m and m.name for m in me.materials]}")
if me.uv_layers.active is None:
    fail("body mesh has no UV layer")
body_mat = me.materials[0]

M = body.matrix_world
M3 = M.to_3x3()
vs = [M @ v.co for v in me.vertices]
H = max(v.z for v in vs)
bpy.context.view_layer.update()
depsgraph = bpy.context.evaluated_depsgraph_get()


# ── selection: forward head polys the plate camera actually sees ─────────────
def select_face_polys():
    face_min_z = FACE_MIN_Z_FRAC * H
    down = Vector((0, -1, 0))
    sel, occluded = [], 0
    for p in me.polygons:
        c = sum((vs[i] for i in p.vertices), Vector()) / len(p.vertices)
        n = (M3 @ p.normal).normalized()
        if c.z < face_min_z or abs(c.x) > FACE_HALF_W or n.y < FACE_NORMAL_MIN_Y:
            continue
        hit, loc, _nrm, idx, _obj, _mw = scene.ray_cast(depsgraph, Vector((c.x, CAM_Y, c.z)), down)
        if hit and idx != p.index and (loc - c).length > OCCLUSION_TOL:
            occluded += 1
            continue
        sel.append(p.index)
    return sel, occluded


SEL, OCCLUDED = select_face_polys()
if len(SEL) < 200:
    fail(f"only {len(SEL)} polys selected — is this the rigged 1.85 m body facing +Y?")

# ── frame derived from the selection (every selected vertex lands inside) ────
TOP = H + FRAME_ABOVE
sel_verts = {i for pi in SEL for i in me.polygons[pi].vertices}
ZMIN = min(vs[i].z for i in sel_verts)
XMAX = max(abs(vs[i].x) for i in sel_verts)
FRAME = math.ceil(max(TOP - ZMIN, 2 * XMAX) * (1 + FRAME_MARGIN) / 0.01) * 0.01
ZC = TOP - FRAME / 2
print(
    f"FACE_SELECT polys={len(SEL)} occluded={OCCLUDED} of {len(me.polygons)} H={H:.4f} "
    f"zmin={ZMIN:.4f} xmax={XMAX:.4f} frame={FRAME:.2f} zc={ZC:.4f} px={PX} minNy={FACE_NORMAL_MIN_Y:.2f}"
)

# ── plate camera: orthographic, at +Y looking back, upright ─────────────────
cam_data = bpy.data.cameras.new("plate-cam")
cam_data.type = "ORTHO"
cam_data.ortho_scale = FRAME
cam = bpy.data.objects.new("plate-cam", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
cam.location = Vector((0, CAM_Y, ZC))
cam.rotation_euler = (math.radians(90), 0, math.radians(180))
scene.render.resolution_x = scene.render.resolution_y = PX
scene.render.resolution_percentage = 100
bpy.context.view_layer.update()


def image_feeding(nt, socket_name):
    """The Image Texture upstream of a Principled socket (through Separate Color
    / Normal Map nodes), or None."""
    for link in nt.links:
        if link.to_node.type == "BSDF_PRINCIPLED" and link.to_socket.name == socket_name:
            n = link.from_node
            seen = set()
            while n is not None and n.type != "TEX_IMAGE" and n.name not in seen:
                seen.add(n.name)
                ins = [i for i in n.inputs if i.is_linked]
                n = ins[0].links[0].from_node if ins else None
            return n if (n is not None and n.type == "TEX_IMAGE") else None
    return None


# Workbench TEXTURE shading shows the material's ACTIVE image node: make sure that
# is the base colour, not the normal or metallic-roughness map.
base_node = image_feeding(body_mat.node_tree, "Base Color")
if base_node is None:
    fail("body material has no Base Color image texture")
body_mat.node_tree.nodes.active = base_node


def render_mask(path):
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "FLAT"
    scene.display.shading.color_type = "TEXTURE"
    scene.display.shading.show_shadows = False
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print("wrote", path)


def read_pixels(img):
    w, h = img.size
    a = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(h, w, 4)


def write_png(path, rgba):
    h, w = rgba.shape[:2]
    img = bpy.data.images.new("face-plate-out", w, h, alpha=True)
    img.pixels.foreach_set(np.ascontiguousarray(rgba, dtype=np.float32).reshape(-1))
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)
    print("wrote", path)


def frame_info():
    return {
        "H": H,
        "frame": FRAME,
        "zc": ZC,
        "px": PX,
        "polys": len(SEL),
        "zmin": ZMIN,
        "xmax": XMAX,
        "occluded": OCCLUDED,
        "faceMinZ": FACE_MIN_Z_FRAC * H,
    }


# ── render mode ──────────────────────────────────────────────────────────────
if MODE == "render":
    render_mask(f"{OUT}-render.png")
    mask_img = bpy.data.images.load(f"{OUT}-render.png")
    rgba = read_pixels(mask_img)
    a = rgba[:, :, 3:4]
    flat = rgba.copy()
    flat[:, :, :3] = rgba[:, :, :3] * a + INPUT_GREY * (1 - a)
    flat[:, :, 3] = 1.0
    write_png(f"{OUT}-input.png", flat)
    with open(f"{OUT}-frame.json", "w") as f:
        json.dump(frame_info(), f)
    print("wrote", f"{OUT}-frame.json")
    print(f"FACE_RENDER polys={len(SEL)} frame={FRAME:.2f} zc={ZC:.4f} px={PX} fg={float((a > 0.5).mean()):.3f}")
    sys.exit(0)

# ── apply mode: the mask, re-rendered with the identical camera ──────────────
tmpdir = tempfile.mkdtemp(prefix="face-plate-")
mask_path = os.path.join(tmpdir, "mask.png")
render_mask(mask_path)
mask_img = bpy.data.images.load(mask_path)
mask_rgba = read_pixels(mask_img)
if mask_rgba.shape[0] != PX or mask_rgba.shape[1] != PX:
    fail(f"mask is {mask_rgba.shape[1]}x{mask_rgba.shape[0]}, expected {PX}x{PX}")
alpha = mask_rgba[:, :, 3] > 0.5

# ── plate: load the paint, resample, register, tone-match, dilate ────────────
paint_img = bpy.data.images.load(PAINT)
if tuple(paint_img.size) != (PX, PX):
    print(f"paint {paint_img.size[0]}x{paint_img.size[1]} → {PX}x{PX}")
    paint_img.scale(PX, PX)
paint = read_pixels(paint_img)
rgb = paint[:, :, :3].copy()


def fg_bbox(mask2d):
    ys, xs = np.nonzero(mask2d)
    if len(ys) == 0:
        return None
    return int(ys.min()), int(ys.max()), int(xs.min()), int(xs.max())


def bilinear_grid(src, sy, sx):
    """Sample src (h,w,c) at row coords sy (per output row) × column coords sx
    (per output column), bilinear, clamped."""
    h, w = src.shape[:2]
    sy = np.clip(sy, 0, h - 1)
    sx = np.clip(sx, 0, w - 1)
    y0 = np.floor(sy).astype(np.int64)
    x0 = np.floor(sx).astype(np.int64)
    y1 = np.minimum(y0 + 1, h - 1)
    x1 = np.minimum(x0 + 1, w - 1)
    fy = (sy - y0)[:, None, None]
    fx = (sx - x0)[None, :, None]
    top = src[y0][:, x0] * (1 - fx) + src[y0][:, x1] * fx
    bot = src[y1][:, x0] * (1 - fx) + src[y1][:, x1] * fx
    return top * (1 - fy) + bot * fy


if REGISTER:
    border = np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]])
    med = np.median(border, axis=0)
    pfg = np.abs(rgb - med).max(axis=2) > REGISTER_FG_DELTA
    pb, mb = fg_bbox(pfg), fg_bbox(alpha)
    if pb is None or mb is None or pb[1] - pb[0] < 8 or pb[3] - pb[2] < 8:
        print("REGISTER skipped: degenerate foreground bbox", pb, mb)
    else:
        print(f"REGISTER paint bbox y{pb[0]}..{pb[1]} x{pb[2]}..{pb[3]} → mask bbox y{mb[0]}..{mb[1]} x{mb[2]}..{mb[3]}")
        ys = np.arange(PX, dtype=np.float64)
        xs = np.arange(PX, dtype=np.float64)
        sy = pb[0] + (ys - mb[0]) * ((pb[1] - pb[0]) / max(1, mb[1] - mb[0]))
        sx = pb[2] + (xs - mb[2]) * ((pb[3] - pb[2]) / max(1, mb[3] - mb[2]))
        rgb = bilinear_grid(rgb, sy, sx).astype(np.float32)


def skin_mask(c):
    # The skin rule of scripts/rig-pascaline.py (facing detection).
    r, g, b = c[..., 0], c[..., 1], c[..., 2]
    return (r > 0.45) & (r > g) & (g > b) & ((r - b) > 0.15) & (g > 0.28)


if MATCH_TONE:
    ref_rgb = mask_rgba[:, :, :3]
    ref_skin = alpha & skin_mask(ref_rgb)
    paint_skin = alpha & skin_mask(rgb)
    if ref_skin.sum() < 500 or paint_skin.sum() < 500:
        print(f"MATCH_TONE skipped: skin pixels body={int(ref_skin.sum())} paint={int(paint_skin.sum())}")
    else:
        scale = ref_rgb[ref_skin].mean(axis=0) / np.maximum(rgb[paint_skin].mean(axis=0), 1e-3)
        scale = np.clip(scale, TONE_CLAMP[0], TONE_CLAMP[1])
        print(
            f"MATCH_TONE body skin {np.round(ref_rgb[ref_skin].mean(axis=0), 3).tolist()} "
            f"paint skin {np.round(rgb[paint_skin].mean(axis=0), 3).tolist()} scale {np.round(scale, 3).tolist()}"
        )
        rgb = np.clip(rgb * scale[None, None, :], 0, 1).astype(np.float32)

# Dilate foreground colour into the background so bilinear taps at the
# silhouette never see the backdrop (8-neighbour average, DILATE_PX rings).
known = alpha.copy()
for _ in range(DILATE_PX):
    if known.all():
        break
    grown = known.copy()
    acc = np.zeros_like(rgb)
    cnt = np.zeros(known.shape, dtype=np.float32)
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
        sh = np.roll(np.roll(known, dy, 0), dx, 1)
        sc = np.roll(np.roll(rgb, dy, 0), dx, 1)
        add = sh & ~known
        acc[add] += sc[add]
        cnt[add] += 1
        grown |= add
    fill = cnt > 0
    rgb[fill] = acc[fill] / cnt[fill][:, None]
    known = grown

plate = np.empty((PX, PX, 4), dtype=np.float32)
plate[:, :, :3] = rgb
plate[:, :, 3] = 1.0

if PLATE_ONLY:
    write_png(PLATE_ONLY, plate)
    print(f"FACE_PLATE_ONLY polys={len(SEL)} frame={FRAME:.2f} px={PX} → {PLATE_ONLY}")
    sys.exit(0)

# The plate is a NEW generated image, not the loaded paint file: the exporter
# names a file-backed image after its file stem, a generated one after its name,
# and the GLB image must be identifiable as the plate (`pascaline_face`).
plate_img = bpy.data.images.new(FACE_IMAGE, PX, PX, alpha=True)
plate_img.pixels.foreach_set(plate.reshape(-1))
plate_img.pack()
bpy.data.images.remove(paint_img)

# ── roughness: what the body's metallic-roughness map says about these polys ──
uv = me.uv_layers.active.data
mr_node = image_feeding(body_mat.node_tree, "Roughness")
if mr_node is not None and mr_node.image is not None:
    mr = read_pixels(mr_node.image)
    mh, mw = mr.shape[:2]
    gs = []
    for pi in SEL:
        u, v = uv[me.polygons[pi].loop_indices[0]].uv
        gs.append(mr[int(v * mh) % mh, int(u * mw) % mw, 1])
    FACE_ROUGHNESS = float(np.mean(gs))
    print(f"ROUGHNESS sampled from {mr_node.image.name} G over {len(gs)} polys: {FACE_ROUGHNESS:.3f} (sd {float(np.std(gs)):.3f})")
else:
    bsdf0 = next((n for n in body_mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    FACE_ROUGHNESS = float(bsdf0.inputs["Roughness"].default_value) if bsdf0 else 0.6
    print(f"ROUGHNESS: no metallic-roughness image on the body, using the body's constant {FACE_ROUGHNESS:.3f}")

# ── material + UVs ───────────────────────────────────────────────────────────
mat = bpy.data.materials.new(FACE_MATERIAL)
mat.use_nodes = True
nt = mat.node_tree
bsdf = nt.nodes["Principled BSDF"]
bsdf.inputs["Roughness"].default_value = FACE_ROUGHNESS
bsdf.inputs["Metallic"].default_value = 0.0
tex = nt.nodes.new("ShaderNodeTexImage")
tex.image = plate_img
tex.extension = "EXTEND"  # exporter → sampler wrapS/wrapT CLAMP_TO_EDGE
nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
# Alpha stays unlinked at 1.0: the exporter derives alphaMode from that socket
# (=> OPAQUE, no alphaMode key). blend_method is not consulted; leave it alone.
me.materials.append(mat)
face_slot = len(me.materials) - 1
for pi in SEL:
    p = me.polygons[pi]
    p.material_index = face_slot
    for li in p.loop_indices:
        co = world_to_camera_view(scene, cam, vs[me.loops[li].vertex_index])
        uv[li].uv = (co.x, co.y)
bpy.data.objects.remove(cam, do_unlink=True)

# ── export exactly like scripts/rig-pascaline.py ─────────────────────────────
bpy.ops.object.select_all(action="DESELECT")
body.select_set(True)
arm.select_set(True)
bpy.ops.export_scene.gltf(
    filepath=OUT,
    export_format="GLB",
    use_selection=True,
    export_yup=True,
    export_apply=True,
    export_skins=True,
    export_all_influences=False,
    export_animations=False,
    export_rest_position_armature=True,
    export_def_bones=False,
    export_draco_mesh_compression_enable=True,
    export_draco_mesh_compression_level=6,
    export_image_format="JPEG",
    export_jpeg_quality=82,
    export_materials="EXPORT",
    export_normals=True,
    export_texcoords=True,
    export_extras=True,
)
SIZE = os.path.getsize(OUT)
print(f"exported {OUT}: {SIZE / 1024:.0f} KB")

# ── self-check 1: the GLB JSON ───────────────────────────────────────────────
with open(OUT, "rb") as f:
    blob = f.read()
magic, version, total = struct.unpack_from("<III", blob, 0)
if magic != 0x46546C67 or version != 2 or total != len(blob):
    fail("GLB header mismatch")
jlen, jtype = struct.unpack_from("<II", blob, 12)
if jtype != 0x4E4F534A:
    fail("first GLB chunk is not JSON")
g = json.loads(blob[20 : 20 + jlen].decode("utf-8"))
problems = []
mats = g.get("materials", [])
by_name = {m.get("name"): m for m in mats}
if len(mats) != 2 or FACE_MATERIAL not in by_name:
    problems.append(f"materials {[m.get('name') for m in mats]}")
for m in mats:
    if "alphaMode" in m:
        problems.append(f"material {m.get('name')} has alphaMode {m['alphaMode']}")
face_mat = by_name.get(FACE_MATERIAL, {})
if "normalTexture" in face_mat:
    problems.append("face material has a normalTexture")
if "metallicRoughnessTexture" in face_mat.get("pbrMetallicRoughness", {}):
    problems.append("face material has a metallicRoughnessTexture")
plate_jpeg = None
try:
    tex_i = face_mat["pbrMetallicRoughness"]["baseColorTexture"]["index"]
    texture = g["textures"][tex_i]
    sampler = g["samplers"][texture["sampler"]]
    if sampler.get("wrapS") != CLAMP_TO_EDGE or sampler.get("wrapT") != CLAMP_TO_EDGE:
        problems.append(f"face sampler wrap {sampler.get('wrapS')}/{sampler.get('wrapT')} != {CLAMP_TO_EDGE}")
    image = g["images"][texture["source"]]
    if image.get("mimeType") != "image/jpeg":
        problems.append(f"face image mimeType {image.get('mimeType')}")
    if image.get("name") != FACE_IMAGE:
        problems.append(f"face image is named {image.get('name')!r}, expected {FACE_IMAGE!r}")
    plate_jpeg = g["bufferViews"][image["bufferView"]]["byteLength"]
except (KeyError, IndexError, TypeError) as e:
    problems.append(f"face baseColorTexture chain broken: {e!r}")
prims = [p for mesh in g.get("meshes", []) for p in mesh["primitives"]]
if len(prims) != 2:
    problems.append(f"{len(prims)} primitives, expected 2")
for p in prims:
    for attr in ("JOINTS_0", "WEIGHTS_0", "TEXCOORD_0"):
        if attr not in p["attributes"]:
            problems.append(f"primitive without {attr}")
    if "KHR_draco_mesh_compression" not in p.get("extensions", {}):
        problems.append("primitive without Draco")
skins = g.get("skins", [])
if len(skins) != 1 or len(skins[0].get("joints", [])) < 13:
    problems.append(f"skins {[(len(s.get('joints', []))) for s in skins]}")
if not any("rigDims" in (n.get("extras") or {}) for n in g.get("nodes", [])):
    problems.append("no rigDims extras on any node")
if SIZE >= MAX_GLB_BYTES:
    problems.append(f"GLB {SIZE} B >= {MAX_GLB_BYTES}")
if plate_jpeg is not None and plate_jpeg >= MAX_PLATE_JPEG:
    problems.append(f"plate JPEG {plate_jpeg} B >= {MAX_PLATE_JPEG} (rerun with --px 768)")
for img in g.get("images", []):
    if img.get("mimeType") != "image/jpeg":
        problems.append(f"image {img.get('name')} is {img.get('mimeType')}")

# ── self-check 2: re-import and measure the face UVs ─────────────────────────
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=OUT, disable_bone_shape=True)
face_loops, out_of_range = 0, 0
umin, umax = 1.0, 0.0
for o in bpy.context.scene.objects:
    if o.type != "MESH":
        continue
    m2 = o.data
    face_idx = {i for i, m in enumerate(m2.materials) if m and m.name == FACE_MATERIAL}
    if not face_idx or m2.uv_layers.active is None:
        continue
    uv2 = m2.uv_layers.active.data
    for p in m2.polygons:
        if p.material_index not in face_idx:
            continue
        for li in p.loop_indices:
            u, v = uv2[li].uv
            face_loops += 1
            umin, umax = min(umin, u, v), max(umax, u, v)
            if not (UV_EPS <= u <= 1 - UV_EPS and UV_EPS <= v <= 1 - UV_EPS):
                out_of_range += 1
if face_loops == 0:
    problems.append("re-import: no 'face' loops")
if out_of_range:
    problems.append(f"re-import: {out_of_range} of {face_loops} face loop UVs outside [{UV_EPS}, {1 - UV_EPS}]")
print(f"UV_CHECK face loops={face_loops} range=[{umin:.4f}, {umax:.4f}] out_of_range={out_of_range}")

if problems:
    for pr in problems:
        print("  -", pr)
    fail(f"{len(problems)} self-check problem(s)")
print(
    f"FACE_PLATE polys={len(SEL)} frame={FRAME:.2f} rough={FACE_ROUGHNESS:.3f} "
    f"plateJpeg={plate_jpeg} bytes={SIZE}"
)
