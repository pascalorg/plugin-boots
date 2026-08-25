# First-person three.js groundwork

Survey of open-source (MIT/Apache unless noted) three.js work relevant to a
first-person walk-and-edit mode, verified 2026-08-24. Hard constraint
throughout: the Pascal host renders with **WebGPURenderer**, so anything we
adopt must keep movement/collision on the CPU (BVH, octree, WASM physics,
camera math) and never touch WebGL-only calls.

## Shortlist — fastest path to a great-feeling walk mode

1. **three-mesh-bvh** (`gkjohnson/three-mesh-bvh`, MIT, ~3.5k★) — the
   `example/characterMovement.js` pattern: build a BVH over the house meshes
   we're already rendering, slide a capsule against it with `shapecast`.
   No physics engine, no WASM, ~200 lines to own. **Primary candidate for
   collisions** — the editor's walls/floors are already meshes. (Avoid its
   GPU shader extensions — WebGL-only.)
2. **@react-three/viverse** (`pmndrs/viverse`, ~130★) — `<SimpleCharacter/>`
   + BVH physics body, official first-person tutorial. Quickest R3F drop-in
   to prototype with, ejectable to (1).
3. **three-player-controller** (`hh-hang/three-player-controller`, MIT,
   ~254★, very active) — most feature-complete standalone controller:
   first/third person, BVH in a worker, ground detection, moving platforms,
   mobile joystick. Mine its step/ground logic.
4. **three.js `games_fps` example** (MIT) — `examples/jsm/math/Octree.js` +
   `Capsule.js` and a ~300-line player loop: gravity, jump, air control,
   throwing ballistics. Leanest vendorable core, zero deps.
5. **react-three-rapier + ecctrl (+ isaac-mason/sketches
   `rapier/pointer-controls`)** — the branch to take only when we need real
   dynamic objects: grab/carry via a joint or a kinematic "hold anchor"
   ~1.5 m in front of the camera, release with an impulse to throw.
   Rapier ships a built-in `KinematicCharacterController` (auto-step,
   snap-to-ground).

## Feel references (read, don't copy)

- **Mugen87/dive** (MIT) — cleanest complete vanilla three.js FPS
  architecture (weapons, nav-mesh AI, spatial audio), by a three.js core
  maintainer.
- **mrdoob/three-quake** (**GPL-2.0** — read only) — the gold standard for
  movement feel: acceleration, friction, air control in `cl_input.js`.
- **simondevyoutube/ThreeJS_Tutorial_FirstPersonCamera** (MIT) — head-bob
  phase and lerped pitch/yaw worth layering on any collider.
- **swift502/Sketchbook** (MIT, archived) — character state-machine design
  (idle/walk/sprint/jump transitions).
- **pmndrs/drei** — `PointerLockControls` + `KeyboardControls`, the standard
  R3F WASD input pattern; renderer-agnostic.
- **verekia/manapotion** (MIT) — pointer-lock/input state outside React
  re-renders; nice glue for a game mode inside a React app.

## Host groundwork already in place

The Pascal editor already ships a first-person mode (`setFirstPersonMode` +
`FirstPersonControls`: pointer lock, spawn point, capsule controller at eye
height) — but it is **view-only**: entering it sets the host's `noEditing`
gate. Boots v0 rides that mode as-is; the plugin's whole reason to exist is
to progressively bring *editing* into it (tool belt, work-the-cone,
grab & carry), using the shortlist above for collisions and interactions.

## License watch-list

`three-quake` (GPL-2.0), `enable3d` (LGPL-3.0), and the small unlicensed
sample repos (`doppl3r/*`, `icurtis1/*`) are reference-only — nothing from
them lands in this codebase.
