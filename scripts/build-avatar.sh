#!/usr/bin/env bash
# BUILD THE AVATAR — the one command that turns the rigged body into the shipped
# module, so a re-rig can never silently ship a body without its face plate:
#
#     bun run avatar:build              # plate assets/pascaline-body.glb → assets/pascaline.glb → embed → test
#     bun run avatar:build raw.glb      # rig a raw generator GLB into assets/pascaline-body.glb first
#
# Rule: scripts/rig-pascaline.py writes assets/pascaline-body.glb, NEVER
# assets/pascaline.glb. pascaline.glb is always body + plate, produced here.
# The plate is reproducible offline from assets/pascaline-face.jpg (the chosen
# repaint); if the head mesh changed, pass FACE_PLATE_ARGS="--register" or
# repaint with scripts/face-repaint.mjs from a fresh `face-plate.py render`.
set -euo pipefail
cd "$(dirname "$0")/.."
BLENDER=${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}
extra=()
if [ -n "${FACE_PLATE_ARGS:-}" ]; then
  # shellcheck disable=SC2206
  extra=(${FACE_PLATE_ARGS})
fi

if [ $# -ge 1 ]; then
  echo "== rig $1 → assets/pascaline-body.glb"
  "$BLENDER" -b --python scripts/rig-pascaline.py -- "$1" assets/pascaline-body.glb --hair
fi

echo "== face plate assets/pascaline-body.glb + assets/pascaline-face.jpg → assets/pascaline.glb"
"$BLENDER" -b --python scripts/face-plate.py -- apply assets/pascaline-body.glb assets/pascaline.glb \
  --paint assets/pascaline-face.jpg "${extra[@]+"${extra[@]}"}"

echo "== embed"
node scripts/embed-avatar.mjs

echo "== contract test"
bun test src/game/pascaline-glb.test.ts
