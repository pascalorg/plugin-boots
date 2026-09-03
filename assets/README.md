# assets

## pascaline.glb — the avatar body

Pascaline, the Pascal mascot (pascalorg/pascaline), as a skinned Draco GLB on
the game's six-pivot rig. Loaded by `src/game/pascaline-model.ts` through the
generated `src/game/pascaline-glb.ts` (base64 — regenerate with
`bun run avatar:build`, which is the ONLY way this file should be produced: see
"Build chain" below).

Files:

- `pascaline-body.glb` — the rigged body straight out of `scripts/rig-pascaline.py`,
  one material (`model`: the generator's 1024 px atlas + normal + metallic-roughness),
  NO face plate. The input of the face step. rig-pascaline.py writes THIS file,
  never `pascaline.glb`.
- `pascaline-face.jpg` — the chosen face repaint (1024 px, JPEG q92); the plate is
  rebuilt from it offline.
- `pascaline-face-ref.png` — 520 px crop of the mascot's head from the design
  render; the style reference the repaint model gets as image 2.
- `pascaline.glb` — body + face plate: what ships. Two materials (`model`, `face`),
  two Draco primitives sharing the one skin, rig and extras byte-for-byte those of
  the body.
- `pascaline-tpose-ref.png` — the T-pose redraw the mesh was generated from.
- `pascaline-face-open.jpg` — the same paint with the mouth open mid-word (an edit
  of `pascaline-face.jpg`, fal-ai/nano-banana/edit request
  `01a064ec-fb1a-70b3-af7c-29ca63d2f080`, candidate 1; only the mouth differs).
  NOT wired yet: the plan is a per-avatar clone of the `face` material whose `.map`
  swaps to this plate while `isPeerTalking()` (voice.ts) so people can SEE who is
  talking. Build its plate with
  `face-plate.py apply pascaline-body.glb x.glb --paint pascaline-face-open.jpg --plate-only open-plate.png`
  (same projection, same tone match, no GLB written) and embed it as a second base64 module.

Provenance (2026-09-01/02):

1. `pascaline/png/fullbody.png` (the mascot's own render) →
   `pascaline-tpose-ref.png`: the same character redrawn in a T-pose by an
   image model (fal-ai/nano-banana/edit), so the mesh binds with the arms clear
   of the torso. Nothing else about the design was changed.
2. That image → fal-ai/hyper3d/rodin (image-to-3D, PBR, `TAPose`, quality
   high). Rodin returned an A-pose, which is fine: the rig script measures it.
3. `scripts/rig-pascaline.py --hair` in Blender 4.5 → `pascaline-body.glb`: hair
   texels hue-shifted from Rodin's auburn to the design's dark brown, facing
   detected from the texture, normalized to 1.85 m, decimated to 24k faces,
   1024 px JPEG textures, our own smooth two-bone weights on root → torso → head /
   armL → foreL → handL / armR → foreR → handR, root → legL → shinL /
   legR → shinR (elbows and knees the game bends). Measured dims (shoulders,
   segment lengths, arm rest angles, hat band, sleeve radius) ride along as
   node extras (`rigDims`) and the game reads them at load.
4. Face plate (2026-09-02). The generator's face is a smear at any texel count
   (the raw 2K source has the same raccoon eyes), and a peer's head is ~90 px at
   1.5 m on 1080p, so the fix is content + contrast on ONE undistorted picture:
   - `scripts/face-plate.py render pascaline-body.glb /tmp/plate` → the ~2.2k
     forward head polys (centroid z ≥ 0.755·H, |x| ≤ 0.20 m, normal.y ≥ 0.30,
     not occluded from the front) rendered flat by an orthographic camera whose
     0.51 m frame is DERIVED from the selection; `plate-input.png` is that render
     over #808080.
   - `scripts/face-repaint.mjs plate-input.png pascaline-face-ref.png /tmp/paint
     --n 4 --seed 1234` → fal-ai/nano-banana/edit repaints it as the mascot,
     framing kept (prompt in the script: white sclera, dark irises, thick brows,
     dark lip line — the cues that survive 60-100 px). Candidate index 1 of
     request `01a064e3-8dfb-7261-ab9d-477ac134b05d` was chosen at 96 px and is
     `pascaline-face.jpg`.
   - `scripts/face-plate.py apply pascaline-body.glb pascaline.glb --paint
     pascaline-face.jpg` → material `face`: 1024 px plate (JPEG q82 in the GLB,
     ~58 KB), ortho-projected UVs all inside [0.041, 0.957], sampler
     CLAMP_TO_EDGE, roughness 0.612 sampled from the body's metallic-roughness map
     over the same polys (no gloss step at the hat), metallic 0, no normal/MR
     textures, opaque. Skin tone is matched to the atlas (scale ≈ 1.00/0.98/0.99).
     The rest of the mesh, its UVs, weights, 13 bones and `rigDims` are untouched.
   - `bun test src/game/pascaline-glb.test.ts` pins the contract (two materials,
     clamp, opaque, Draco+skin on every primitive, ≥ 13 joints, JPEG images,
     rigDims, < 1 MB).

## Build chain

    bun run avatar:build              # pascaline-body.glb + pascaline-face.jpg → pascaline.glb → pascaline-glb.ts → test
    bun run avatar:build raw.glb      # re-rig a raw generator GLB into pascaline-body.glb first

`scripts/build-avatar.sh` runs rig (only if a raw GLB is given) → face-plate
apply → embed → contract test. Whoever changes the body last (new bones, new
mesh) runs it; the face plate is a pure post-process on any rigged body, so it
survives a re-rig. If the head mesh itself changed, pass
`FACE_PLATE_ARGS="--register"` (fits the paint's foreground bbox onto the new
mask) or repaint from a fresh `face-plate.py render`. The identity plate
(`--paint <prefix>-render.png --no-match-tone`) is pixel-identical to the
un-plated body and is the floor if no paint is acceptable.

## Looking at it

Full body, posed or not:

    /Applications/Blender.app/Contents/MacOS/Blender -b --python scripts/preview-glb.py -- assets/pascaline.glb /tmp/pascaline --pose legL:0.5,armR:1.2

Head only, at 1024 px AND at 96 px (the size a peer's head has at ~1 m on 1080p;
the 96 px files are the acceptance view — a face that does not read there does
not read in the game). `--engine BLENDER_EEVEE_NEXT` for a lit check of the
material seam:

    /Applications/Blender.app/Contents/MacOS/Blender -b --python scripts/preview-head.py -- assets/pascaline.glb /tmp/head [--engine BLENDER_EEVEE_NEXT]
    # → /tmp/head-front.png -threequarter.png -side.png -front-96.png -threequarter-96.png, prints HEAD_BBOX

## Blender 4.5 glTF facts learned the hard way

- The exporter derives `alphaMode` from the Principled **Alpha socket**
  (`gather_alpha_info`): unlinked at 1.0 → no alphaMode → OPAQUE.
  `Material.blend_method` is IGNORED on export (the importer sets
  `surface_render_method`, the exporter never reads it). Do not try to get a
  BLEND/OPAQUE material by setting blend_method.
- Sampler wrap comes from the Image Texture node's `extension`: `EXTEND` →
  `wrapS/wrapT` 33071 CLAMP_TO_EDGE; the default emits no wrap, which three's
  GLTFLoader reads as REPEAT.
- The exporter names a file-backed image after its file stem and a generated
  (`bpy.data.images.new`) image after its name — build textures you need to
  identify in the GLB as generated images.
- `bpy.ops.import_scene.gltf` adds a hidden 1 m bone-shape Icosphere at the
  origin on skinned imports; pass `disable_bone_shape=True` or every bbox you
  measure includes it.
