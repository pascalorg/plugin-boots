# assets

## pascaline.glb — the avatar body

Pascaline, the Pascal mascot (pascalorg/pascaline), as a skinned Draco GLB on
the game's six-pivot rig. Loaded by `src/game/pascaline-model.ts` through the
generated `src/game/pascaline-glb.ts` (base64 — regenerate with
`node scripts/embed-avatar.mjs` after replacing this file).

Provenance (2026-09-01):

1. `pascaline/png/fullbody.png` (the mascot's own render) →
   `pascaline-tpose-ref.png`: the same character redrawn in a T-pose by an
   image model (fal-ai/nano-banana/edit), so the mesh binds with the arms clear
   of the torso. Nothing else about the design was changed.
2. That image → fal-ai/hyper3d/rodin (image-to-3D, PBR, `TAPose`, quality
   high). Rodin returned an A-pose, which is fine: the rig script measures it.
3. `scripts/rig-pascaline.py --hair` in Blender 4.5: hair texels hue-shifted from
   Rodin's auburn to the design's dark brown, facing detected from the
   texture, normalized to 1.85 m, decimated to 24k faces, 1024 px JPEG
   textures, our own smooth two-bone weights on root → torso → head /
   armL / armR (+ hands), root → legL / legR. Measured dims (shoulders, arm
   rest angles, hat band, sleeve radius) ride along as node extras
   (`rigDims`) and the game reads them at load.

Preview any GLB, posed or not:

    /Applications/Blender.app/Contents/MacOS/Blender -b --python scripts/preview-glb.py -- assets/pascaline.glb /tmp/pascaline --pose legL:0.5,armR:1.2
