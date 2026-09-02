"""
RIG PASCALINE — turn a generated, unrigged Pascaline mesh into the skinned GLB
the game's AvatarRig loads.

    /Applications/Blender.app/Contents/MacOS/Blender -b --python scripts/rig-pascaline.py -- \
        in.glb out.glb [--flip] [--faces 24000] [--tex 1024] [--hair] [--preview out.png]

What it does, in order:
  1. imports the GLB (Rodin / Hunyuan output: one or more meshes, PBR textures),
     joins everything into one mesh, applies transforms;
  2. normalizes: feet on the ground, centred on x/y, height = RIG_HEIGHT (the
     game's rig units — remote-players plants a peer's root at their feet and
     the mirror stands the body on yours), and turns the model to face +Y in
     Blender, which the glTF exporter maps to -Z in three — the direction every
     Pascaline in the game faces (`facing(yaw) = (-sin yaw, -cos yaw)`);
  3. decimates to a game budget and shrinks textures (JPEG on export);
  4. builds the SIX-PIVOT skeleton the game articulates — root → torso → head,
     torso → armL/armR (+ handL/handR at the wrists), root → legL/legR — with
     bones laid ALONG the limbs so automatic weights bind the right vertices.
     Bone directions do not matter to the game: at load, AvatarRig wraps each
     articulated bone in an identity-rotated pivot in its parent's frame, and
     `articulate` drives `pivot.rotation.x` exactly as it drove the box rig's
     groups. Limb positions are MEASURED from the mesh (slices at hip and
     shoulder height), not guessed;
  5. binds with its own smooth two-bone weights (Blender's bone heat fails
     silently on generated meshes), exports a Y-up Draco GLB with the skin
     and, optionally, renders a preview PNG to look at.

The character is expected in a T or A pose (Rodin's TAPose gives an A-pose):
arms clear of the torso, legs apart enough to slice. Each arm's rest angle from
vertical goes into the GLB extras (armHangL/R) so the game can hang the arms
straight down through its pivots whatever pose the generator chose.
"""

import math
import sys

import bpy
from mathutils import Vector

# ── args ─────────────────────────────────────────────────────────────────────
argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
if len(argv) < 2:
    print("usage: rig-pascaline.py -- in.glb out.glb [--flip] [--faces N] [--tex N] [--hair] [--preview out.png]")
    sys.exit(2)
SRC, DST = argv[0], argv[1]
FLIP = "--flip" in argv
FACES = int(argv[argv.index("--faces") + 1]) if "--faces" in argv else 24000
TEX = int(argv[argv.index("--tex") + 1]) if "--tex" in argv else 1024
PREVIEW = argv[argv.index("--preview") + 1] if "--preview" in argv else None
HAIR = "--hair" in argv

# The game's rig height (sole to hat crown), in metres. The box rig read ~1.85;
# the player capsule is 1.78 with the eye at 1.58.
RIG_HEIGHT = 1.85

# ── 1. import + join ─────────────────────────────────────────────────────────
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
scene = bpy.context.scene
meshes = [o for o in scene.objects if o.type == "MESH"]
if not meshes:
    print("no meshes in", SRC)
    sys.exit(1)
# Drop any armature the generator may have left (we build our own).
for o in list(scene.objects):
    if o.type == "ARMATURE":
        bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.object.select_all(action="DESELECT")
for o in meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
if len(meshes) > 1:
    bpy.ops.object.join()
body = bpy.context.view_layer.objects.active
body.name = "Pascaline"
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
# Nothing else rides along: generators ship marker spheres and empties.
for o in list(scene.objects):
    if o is not body:
        bpy.data.objects.remove(o, do_unlink=True)
print(f"imported {SRC}: {len(body.data.vertices)} verts, {len(body.data.polygons)} faces")


def bbox(obj):
    vs = [obj.matrix_world @ v.co for v in obj.data.vertices]
    lo = Vector((min(v.x for v in vs), min(v.y for v in vs), min(v.z for v in vs)))
    hi = Vector((max(v.x for v in vs), max(v.y for v in vs), max(v.z for v in vs)))
    return lo, hi


# ── 2. normalize: face +Y, feet at z=0, centred, RIG_HEIGHT tall ─────────────
# Which way does she face? Generators are not consistent (two Rodin runs came
# back facing opposite ways) and no silhouette cue survived both — toes, hair
# mass and hat visor each read one model right and the other wrong. The
# TEXTURE knows: at head height the only skin-coloured surface is the face.
# The game wants -Z in three = +Y in Blender.
for img in bpy.data.images:
    if img.size[0] > TEX or img.size[1] > TEX:
        w, h = img.size
        k = TEX / max(w, h)
        img.scale(max(1, int(w * k)), max(1, int(h * k)))
        print(f"texture {img.name}: {w}x{h} → {img.size[0]}x{img.size[1]}")


def base_color_image():
    for mat in body.data.materials:
        if not mat or not mat.node_tree:
            continue
        for node in mat.node_tree.nodes:
            if node.type == "BSDF_PRINCIPLED":
                link = next((l for l in mat.node_tree.links if l.to_node == node and l.to_socket.name == "Base Color"), None)
                if link and link.from_node.type == "TEX_IMAGE" and link.from_node.image:
                    return link.from_node.image
    named = [i for i in bpy.data.images if any(k in i.name.lower() for k in ("diffuse", "albedo", "base"))]
    return named[0] if named else (max(bpy.data.images, key=lambda i: i.size[0] * i.size[1]) if bpy.data.images else None)


def facing_from_skin():
    img = base_color_image()
    uv_layer = body.data.uv_layers.active
    if img is None or uv_layer is None:
        return None
    w, h = img.size
    px = img.pixels[:]
    lo0, hi0 = bbox(body)
    h0 = hi0.z - lo0.z
    mesh = body.data
    seen = set()
    skin_y = []
    band_y = []
    for poly in mesh.polygons:
        for li in poly.loop_indices:
            vi = mesh.loops[li].vertex_index
            if vi in seen:
                continue
            seen.add(vi)
            co = body.matrix_world @ mesh.vertices[vi].co
            if not (lo0.z + 0.85 * h0 <= co.z <= lo0.z + 0.93 * h0):
                continue
            u, v = uv_layer.data[li].uv
            x = int(u * w) % w
            y = int(v * h) % h
            i = (y * w + x) * 4
            r, g, b = px[i], px[i + 1], px[i + 2]
            band_y.append(co.y)
            if r > 0.45 and r > g > b and (r - b) > 0.15 and g > 0.28:
                skin_y.append(co.y)
    if len(skin_y) < 20 or not band_y:
        return None
    fwd = sum(skin_y) / len(skin_y) - sum(band_y) / len(band_y)
    print(f"facing: {len(skin_y)} skin texels of {len(band_y)} at face height sit {fwd:+.3f} in y → face is {'+Y' if fwd > 0 else '-Y'}")
    return fwd


def brown_the_hair(img):
    """Rodin paints the mascot's hair auburn; the design is dark brown. Shift the
    hair-coloured texels (red-leaning, saturated, mid-dark) toward the reference
    brown. Skin is lighter and less saturated, leather and boots are more
    orange (hue 25–40°), so a narrow red window leaves them alone."""
    import numpy as np

    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    rgb = px.reshape(-1, 4)[:, :3]
    mx = rgb.max(axis=1)
    mn = rgb.min(axis=1)
    d = mx - mn
    sat = np.where(mx > 1e-6, d / np.maximum(mx, 1e-6), 0)
    r, g, b = rgb[:, 0], rgb[:, 1], rgb[:, 2]
    hue = np.zeros_like(mx)
    m = d > 1e-6
    rm = m & (mx == r)
    gm = m & (mx == g) & ~rm
    bm = m & ~rm & ~gm
    hue[rm] = ((g[rm] - b[rm]) / d[rm]) % 6
    hue[gm] = (b[gm] - r[gm]) / d[gm] + 2
    hue[bm] = (r[bm] - g[bm]) / d[bm] + 4
    hue = (hue * 60) % 360
    hair = ((hue < 22) | (hue > 345)) & (sat > 0.32) & (mx > 0.10) & (mx < 0.70)
    # Toward #4a2f22 in feel: less saturation, a little darker, hue to ~22°.
    tinted = rgb[hair]
    lum = tinted.mean(axis=1, keepdims=True)
    target = np.array([[0.36, 0.22, 0.15]], dtype=np.float32)
    mixed = tinted * 0.35 + (target * (lum / 0.25).clip(0.5, 1.6)) * 0.65
    rgb[hair] = mixed.clip(0, 1)
    img.pixels.foreach_set(px)
    img.update()
    print(f"hair: recoloured {int(hair.sum())} of {w * h} texels toward brown")


if HAIR:
    hair_img = base_color_image()
    if hair_img is not None:
        brown_the_hair(hair_img)

forward_y = facing_from_skin()
if forward_y is None:
    print("facing: no skin found at face height — assuming the glTF +Z front (-Y here)")
    forward_y = -1.0
turn = 0.0 if forward_y > 0 else math.pi
if FLIP:
    turn += math.pi
print(f"turn {math.degrees(turn):.0f}°")
# The glTF importer leaves objects in QUATERNION rotation mode, where an Euler
# assignment is silently ignored — the first cut of this script never turned
# anything and every preview showed her back.
body.rotation_mode = "XYZ"
body.rotation_euler = (0, 0, turn)
bpy.ops.object.transform_apply(rotation=True)
lo, hi = bbox(body)
height = hi.z - lo.z
s = RIG_HEIGHT / height
body.scale = (s, s, s)
bpy.ops.object.transform_apply(scale=True)
lo, hi = bbox(body)
body.location = (-(lo.x + hi.x) / 2, -(lo.y + hi.y) / 2, -lo.z)
bpy.ops.object.transform_apply(location=True)
lo, hi = bbox(body)
H = hi.z
print(f"normalized: height {H:.3f} m, width {hi.x - lo.x:.3f}, depth {hi.y - lo.y:.3f}")

# ── 3. decimate + shrink textures ────────────────────────────────────────────
faces = len(body.data.polygons)
if faces > FACES:
    mod = body.modifiers.new("decimate", "DECIMATE")
    mod.ratio = FACES / faces
    mod.use_collapse_triangulate = True
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.modifier_apply(modifier=mod.name)
    print(f"decimated {faces} → {len(body.data.polygons)} faces")
# ── 4. measure the body for bone placement ───────────────────────────────────
verts = [body.matrix_world @ v.co for v in body.data.vertices]


def slice_xs(z0, z1):
    return sorted(v.x for v in verts if z0 <= v.z < z1)


def split_lr(xs):
    """Two clusters (left = negative x, right = positive x) of a slice; their centres."""
    left = [x for x in xs if x < 0]
    right = [x for x in xs if x >= 0]
    cl = sum(left) / len(left) if left else -0.1
    cr = sum(right) / len(right) if right else 0.1
    return cl, cr


def widest_gap_split(xs):
    """Where a slice through both legs has its inner gap: the mid-x between them."""
    if len(xs) < 4:
        return 0.0
    best = 0.0
    at = 0.0
    for a, b in zip(xs, xs[1:]):
        if b - a > best:
            best = b - a
            at = (a + b) / 2
    return at


# Legs: a slice at the knee separates cleanly into two shells; their centres are
# the leg axes. The hip pivot height: where the crotch closes — scan down from
# the waist for the first slice with a real inner gap.
KNEE_Z = 0.28 * H
knee_xs = slice_xs(KNEE_Z - 0.03, KNEE_Z + 0.03)
leg_gap_x = widest_gap_split(knee_xs)
legL_x = sum(x for x in knee_xs if x < leg_gap_x) / max(1, len([x for x in knee_xs if x < leg_gap_x]))
legR_x = sum(x for x in knee_xs if x >= leg_gap_x) / max(1, len([x for x in knee_xs if x >= leg_gap_x]))
# Walk UP from the knee: the legs are two shells with a gap between them
# until the crotch closes it. The hip pivot sits a little above that.
hip_z = 0.50 * H
z = KNEE_Z
while z < 0.62 * H:
    xs = slice_xs(z - 0.006, z + 0.006)
    inner = [b - a for a, b in zip(xs, xs[1:]) if a < leg_gap_x <= b]
    if len(xs) < 8 or not inner or inner[0] < 0.012:
        hip_z = z + 0.02
        break
    z += 0.01
hip_z = min(max(hip_z, 0.42 * H), 0.58 * H)

# Torso and arms, from a chest slice: an A- or T-pose puts three shells in it
# (arm, torso, arm) with real gaps between them. The torso is the central
# shell; everything outside the gaps is arm.
def shells(xs, min_gap=0.02):
    """Split a sorted slice into shells at gaps wider than min_gap."""
    out = []
    cur = [xs[0]] if xs else []
    for a, b in zip(xs, xs[1:]):
        if b - a > min_gap:
            out.append(cur)
            cur = []
        cur.append(b)
    if cur:
        out.append(cur)
    return out


# Sleeves meet the jacket at the armpit, so the highest slice that still
# splits into three shells is the widest honest torso reading.
torso_half = None
for z0 in [0.74 * H - i * 0.01 for i in range(0, 22)]:
    xs = slice_xs(z0, z0 + 0.02)
    groups_x = shells(xs)
    if len(groups_x) >= 3:
        central = min(groups_x, key=lambda g: abs((g[0] + g[-1]) / 2))
        torso_half = (central[-1] - central[0]) / 2
        print(f"torso: three shells at z {z0:.3f} → half-width {torso_half:.3f}")
        break
if torso_half is None:
    chest_xs = slice_xs(0.68 * H, 0.74 * H)
    torso_half = (max(chest_xs) - min(chest_xs)) / 2 * 0.62 if chest_xs else 0.16
    print(f"torso: arms never clear the body — proportional half-width {torso_half:.3f}")

# The arm shells: everything clear of the torso, above the hips.
def arm_shell(sign):
    # Above the tool belt: its pouches and the hanging tape hang past the
    # torso's edge at hip height and would drag a line fit toward the hips.
    return [v for v in verts if sign * v.x > torso_half + 0.02 and v.z > hip_z + 0.13]


def arm_geometry(sign):
    """The arm as a line: principal axis of the arm shell, the shoulder where
    that line meets the torso's edge, the wrist a hand short of its far end."""
    pts = arm_shell(sign)
    if len(pts) < 50:
        return None
    n = len(pts)
    cx = sum(v.x for v in pts) / n
    cz = sum(v.z for v in pts) / n
    sxx = sum((v.x - cx) ** 2 for v in pts) / n
    szz = sum((v.z - cz) ** 2 for v in pts) / n
    sxz = sum((v.x - cx) * (v.z - cz) for v in pts) / n
    # Largest eigenvector of the 2×2 covariance.
    theta = 0.5 * math.atan2(2 * sxz, sxx - szz)
    ux, uz = math.cos(theta), math.sin(theta)
    # Point it down the arm: outward from the torso, and never upward (a
    # resting arm in an A or T pose runs level or down).
    if ux * sign < 0:
        ux, uz = -ux, -uz
    if uz > 0.3:
        ux, uz = -ux, -uz
    # Shoulder: the axis extrapolated back to the torso's edge.
    sx = sign * (torso_half + 0.015)
    t0 = (sx - cx) / ux if abs(ux) > 1e-6 else 0.0
    sz = cz + t0 * uz
    # Far end along the axis (99th percentile), minus the hand.
    proj = sorted((v.x - sx) * ux + (v.z - sz) * uz for v in pts)
    reach = proj[int(len(proj) * 0.99)]
    length = max(0.15, reach - 0.07 * H)
    # Sleeve radius near the shoulder, from the shell's depth off the axis.
    band = []
    for v in pts:
        t = (v.x - sx) * ux + (v.z - sz) * uz
        if 0.08 < t < 0.18:
            band.append(abs(v.y))
    top = sorted(band)[-max(1, len(band) // 5):] if band else [0.05]
    radius = sum(top) / len(top) + 0.008
    # How far from straight down the arm rests, as the rotation about the
    # forward axis that hangs it (the game applies this on the arm pivot).
    hang = -sign * math.atan2(abs(ux), -uz if uz < 0 else 1e-6)
    return {"sx": sx, "sz": sz, "ux": ux, "uz": uz, "len": length, "radius": radius, "hang": hang}


armL_geo = arm_geometry(-1)
armR_geo = arm_geometry(+1)
if not armL_geo or not armR_geo:
    print("could not find both arm shells — is the pose clear of the torso?")
    sys.exit(1)
SHOULDER_Z = (armL_geo["sz"] + armR_geo["sz"]) / 2
ARM_LEN = (armL_geo["len"] + armR_geo["len"]) / 2
T_POSE = abs(armR_geo["uz"]) < 0.35
neck_z = 0.86 * H
print(
    f"measured: {'T' if T_POSE else 'A'}-pose, hip z {hip_z:.3f}, legs x {legL_x:.3f}/{legR_x:.3f}, "
    f"torso half {torso_half:.3f}, shoulders z {SHOULDER_Z:.3f} x ±{abs(armR_geo['sx']):.3f}, "
    f"arm len {ARM_LEN:.3f}, hang L {math.degrees(armL_geo['hang']):.0f}° R {math.degrees(armR_geo['hang']):.0f}°, "
    f"sleeve r {armR_geo['radius']:.3f}"
)

# ── 5. the skeleton ──────────────────────────────────────────────────────────
arm_data = bpy.data.armatures.new("PascalineRig")
armature = bpy.data.objects.new("PascalineArmature", arm_data)
scene.collection.objects.link(armature)
bpy.context.view_layer.objects.active = armature
bpy.ops.object.mode_set(mode="EDIT")


def bone(name, head, tail, parent=None, connect=False):
    b = arm_data.edit_bones.new(name)
    b.head = Vector(head)
    b.tail = Vector(tail)
    b.roll = 0.0
    if parent is not None:
        b.parent = parent
        b.use_connect = connect
    return b


root = bone("root", (0, 0, hip_z), (0, 0, hip_z + 0.08))
torso = bone("torso", (0, 0, hip_z), (0, 0, neck_z), root)
head = bone("head", (0, 0, neck_z), (0, 0, H), torso)
def arm(name, g, parent):
    ux, uz = g["ux"], g["uz"]
    upper = bone(name, (g["sx"], 0, g["sz"]), (g["sx"] + ux * g["len"], 0, g["sz"] + uz * g["len"]), parent)
    hand = bone(
        "hand" + name[-1],
        upper.tail,
        (upper.tail.x + ux * 0.07 * H, 0, upper.tail.z + uz * 0.07 * H),
        upper,
        connect=True,
    )
    return upper, hand


armL, handL = arm("armL", armL_geo, torso)
armR, handR = arm("armR", armR_geo, torso)
legL = bone("legL", (legL_x, 0, hip_z), (legL_x, 0, 0.02), root)
legR = bone("legR", (legR_x, 0, hip_z), (legR_x, 0, 0.02), root)
bpy.ops.object.mode_set(mode="OBJECT")

# ── 6. bind ──────────────────────────────────────────────────────────────────
# Blender's bone-heat weights fail silently on a generated mesh (dozens of
# shells, non-manifold hair and pouches): every vertex came back weightless.
# So the weights are computed here, the envelope way but smooth: each vertex
# takes its two nearest bone SEGMENTS and blends them by how close the call
# is — 50/50 where they are equidistant (the joint), all one bone a blend
# width away. Rigid where it should be rigid, soft exactly at hips, shoulders
# and neck, and nothing is ever left behind at the origin.
BLEND = 0.10
bpy.ops.object.select_all(action="DESELECT")
body.select_set(True)
armature.select_set(True)
bpy.context.view_layer.objects.active = armature
bpy.ops.object.parent_set(type="ARMATURE_NAME")
deform = {b.name: b for b in arm_data.bones if b.name != "root"}
groups = {g.name: g for g in body.vertex_groups}
for name in deform:
    if name not in groups:
        groups[name] = body.vertex_groups.new(name=name)
for g in body.vertex_groups:
    g.remove(range(len(body.data.vertices)))


def seg_dist(p, a, b):
    ab = b - a
    t = max(0.0, min(1.0, (p - a).dot(ab) / max(1e-9, ab.length_squared)))
    return (a + ab * t - p).length


# Bones are lines but bodies have thickness: the torso's skin is a hand's
# width from its spine while a hanging arm's bone runs a finger's width from
# the jacket's side, so a plain distance would hand the jacket to the arm.
# Each bone gets the radius of the body part it drives, and distance is
# measured to that thick segment (clamped at zero inside it).
RADIUS = {
    "torso": torso_half * 0.85,
    "head": 0.10 * H,
    "armL": armL_geo["radius"] - 0.008,
    "armR": armR_geo["radius"] - 0.008,
    "handL": 0.04,
    "handR": 0.04,
    "legL": 0.07,
    "legR": 0.07,
}


def bone_dist(p, b):
    return max(0.0, seg_dist(p, b.head_local, b.tail_local) - RADIUS.get(b.name, 0.05))


# The hands are children of the arms and never articulated on their own, so a
# hand vertex is as good as an arm vertex; keep them as separate groups (the
# game hangs the weapon off the hand bone) but never blend arm↔hand — that
# seam does not move.
seams = {("armL", "handL"), ("handL", "armL"), ("armR", "handR"), ("handR", "armR")}
blended = 0
for v in body.data.vertices:
    p = body.matrix_world @ v.co
    ranked = sorted(((bone_dist(p, b), b.name) for b in deform.values()))
    (d1, n1), (d2, n2) = ranked[0], ranked[1]
    t = min(1.0, (d2 - d1) / BLEND)
    w1 = 0.5 + 0.5 * t
    if (n1, n2) in seams:
        w1 = 1.0
    groups[n1].add([v.index], w1, "REPLACE")
    if w1 < 1.0:
        groups[n2].add([v.index], 1.0 - w1, "REPLACE")
        blended += 1
print(f"bound {len(body.data.vertices)} vertices, {blended} blended across a joint")

# ── 6b. the tint bands' landing spots ────────────────────────────────────────
# The hat: the widest slice of the head region is the brim; the band sits a
# little above it, hugging the shell. The sleeve: the arm's radius near the
# shoulder, so an arm band wraps the jacket and does not float.
def slice_radius_x(z0, z1):
    xs = slice_xs(z0, z1)
    return (max(xs) - min(xs)) / 2 if len(xs) > 3 else 0.0


brim_z, brim_r = max(
    ((z, slice_radius_x(z - 0.006, z + 0.006)) for z in [0.86 * H + i * 0.008 for i in range(0, 18)]),
    key=lambda t: t[1],
)
hat_band_z = brim_z + 0.035
hat_radius = slice_radius_x(hat_band_z - 0.006, hat_band_z + 0.006) + 0.006
dims = {
    "height": round(H, 4),
    "hipZ": round(hip_z, 4),
    "neckZ": round(neck_z, 4),
    "shoulderZ": round(SHOULDER_Z, 4),
    "shoulderX": round((abs(armL_geo["sx"]) + abs(armR_geo["sx"])) / 2, 4),
    "legX": round((abs(legL_x) + abs(legR_x)) / 2, 4),
    "armLen": round(ARM_LEN, 4),
    "tPose": T_POSE,
    "hatBandZ": round(hat_band_z, 4),
    "hatRadius": round(hat_radius, 4),
    "armRadius": round((armL_geo["radius"] + armR_geo["radius"]) / 2, 4),
    # rotation.z the game puts on each arm pivot to hang the arm straight down
    "armHangL": round(armL_geo["hang"], 4),
    "armHangR": round(armR_geo["hang"], 4),
}
import json  # noqa: E402

# Carried in the GLB as node extras: the game reads them off userData.rigDims.
armature["rigDims"] = json.dumps(dims)

# ── 7. export ────────────────────────────────────────────────────────────────
bpy.ops.object.select_all(action="DESELECT")
body.select_set(True)
armature.select_set(True)
bpy.ops.export_scene.gltf(
    filepath=DST,
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
import os  # noqa: E402

print(f"exported {DST}: {os.path.getsize(DST) / 1024:.0f} KB")
print("RIG_DIMS " + json.dumps(dims))

# ── 8. preview ───────────────────────────────────────────────────────────────
if PREVIEW:
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "TEXTURE"
    scene.render.resolution_x = 900
    scene.render.resolution_y = 1100
    scene.render.film_transparent = False
    world = bpy.data.worlds.new("w")
    scene.world = world
    world.color = (0.55, 0.58, 0.6)
    cam_data = bpy.data.cameras.new("cam")
    cam = bpy.data.objects.new("cam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam_data.lens = 50
    # Front three-quarter view: the model faces +Y, so the camera sits at +Y.
    cam.location = (1.6, 4.2, 1.15)
    cam.rotation_euler = (math.radians(88), 0, math.radians(180 + 21))
    scene.render.filepath = PREVIEW
    bpy.ops.render.render(write_still=True)
    print("preview", PREVIEW)
