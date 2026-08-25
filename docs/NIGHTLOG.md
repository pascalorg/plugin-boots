# Night log

## Round 1 — 2026-08-25 (overnight, owner play-test feedback)

Landed:
- **Viewmodel pose** — weapons anchor low-right (classic FPS), full procedural
  stack: draw-in, breathing, look-lag spring, speed-cadenced run bob, landing
  dip. Muzzle flash rides the active gun's muzzle offset.
- **Weapon models** — new `weapon-models.tsx` (the dedicated agent stalled;
  manager wrote it to the agreed contract): pistol with slide/grip/guard/
  sights, rifle with receiver/handguard/mag/stock/muzzle brake, knife with
  guard + tapered blade, blueprint hammer. Grip at origin, -Z barrel,
  `MUZZLE_OFFSETS` exported.
- **Grass v2** — 5-blade tapered clusters (one InstancedMesh, ~300k tris),
  root-to-tip vertex-color gradient, density biased toward the building,
  bigger sparse clumps far out, flower discs, deeper ground tone.
- **Wall anatomy** — voxel targets generalized (`VoxelTarget`, any collider
  group), walls keep skins via `dropInteriorCells` + breakable studs
  (`StudMember` hp 3, `raycastStuds`/`damageStud`, analytic yaw-OBB ray).
  Renderer shows dents on chipped studs, hides broken ones; snap spawns
  falling wood + splinters.
- **Doors** — `doors.tsx`: E within 2.2 m toggles a 280 ms hinge swing away
  from the player, colliders off while open, creak/latch sfx, restore ledger
  on exit. Mounted in game-root; `__boots.doors` debug handle.
- **Everything breaks** — shooting pipeline rewritten: solid → voxel → stud →
  glass → bot with 1 cm class-priority tie-break; any destructible node kind
  (slabs, roofs, furniture, stairs…) voxelizes + carves on first hit.
- **Audio** — material voices (drywallCrunch, studHit/studSnap, doorCreak/
  doorLatch, woodCrumble) + round-robin detune so repeated shots never sound
  identical.
- **Integration (manager)** — created weapon-models.tsx; destruction now
  plays studHit on chips / studSnap directly, skips its generic crunch for
  walls (shooting.ts voices drywall); HUD prompt owner keys wired
  (guntable/doors); brand names scrubbed from src, package.json, MASTERPLAN.

Rough / next:
- Typical 0.10–0.15 m walls voxelize ONE cell thick at the 0.15 m cell, so
  the outer-skin/cavity/inner-skin read only appears on walls ≥ ~0.45 m.
  Needs anisotropic cells (thin cells across the thickness axis) — the
  owner's dual-skin ask is only half-visible until then.
- `sfx.woodCrumble` exported but not yet called anywhere.
- viewmodel derives its own look velocities; `playerRig.yawVelocity/
  pitchVelocity` (smoothed, from wiring) could replace that.
- No in-browser QA of this round yet (models scale/orientation, door swing
  in real plans, stud hit-feel) — round 2 starts with a play-test pass.

Checks: `bun run check-types` clean, `bun test` 28 pass / 387 expects.

## Round 2 — 2026-08-25 (overnight)

- **Wall anatomy v2** — `voxel.ts` grids are now anisotropic
  (`cellX/cellY/cellZ`, optional `VoxelCellOverride` on `buildVoxelGrid`);
  `destruction.ts` pins the wall thickness axis to thickness/max(3,…) cells,
  so 0.10–0.15 m walls really get outer skin / stud cavity / inner skin.
  `dropInteriorCells` picks the thickness axis by physical extent; DDA,
  removeSphere, and capsule push-out honor per-axis cells. 5 new grid tests.
- **Weapon models v2** — pistol (slide ribs, ejection port, hammer, closed
  trigger guard), rifle (charging handle, gas tube, front sight, 2-segment
  mag, stock wedge + butt pad), knife (fuller + bright edge), hammer (real
  two-prong claw). MUZZLE_OFFSETS retuned.
- **Viewmodel v2** — look-lag now reads `playerRig.yawVelocity/pitchVelocity`
  (teleport-safe, pre-smoothed); POSES retuned to the new model extents,
  everything clears the near plane through recoil.
- **Wiring** — `smoke.test.ts`: 11 headless tests over the full
  fire→voxelize→stud pipeline (skins+cavity, stud snap, slab volume, prop
  refusal).
- **Integration (manager)** — voxel-walls.tsx renders per-axis voxel scale
  (skins no longer draw as full cubes); input.ts pointer-lock promise
  rejection swallowed (console now clean on enter); doors stand down once a
  door is voxelized (no prompt/swing, colliders stay owned by destruction —
  fixes the invisible-collider resurrection); stud hp clamps to 0 on break.

Rough / next:
- Doors still never toggled in a LIVE browser (QA scene had no door) — seed
  one and verify open/close + walk-through.
- Two-skin read needs a close-up visual confirmation shot post per-axis
  scale fix.
- '1 Issue' editor badge after exit (likely host validation, pre-existing) —
  confirm not Boots-related.
- Headless fps floor ~3.5 (software GL) — validate smoothness on real HW.

Checks: `bun run check-types` clean, `bun test` 44 pass / 1828 expects.

## Round 3 — 2026-08-25 (live QA + diagonal-wall hotfix)

Live QA round (host UI at :3002, 4-wall room + door + standalone wall): no
worker source edits; wiring agent drove a full in-browser pass.

- **Doors on E** — PASS live: prompt in range, swings away from player,
  walk-through, close from inside, blocks again. `__boots.doors` works.
- **Door vs destruction** — PASS: rifle voxelizes the door, prompt stands
  down, toggle becomes a no-op.
- **Dual skins + studs** — PASS on axis-aligned walls: thin per-axis slab
  returns, outer skin / cavity+stud / inner skin all read, knife peels the
  outer skin only, capsule collides with live skins.
- **Viewmodel v2** — PASS: all three weapons low-right, muzzle toward
  center, no crosshair clipping. Knife silhouette weakest.
- **Console/exit/fps** — zero pageerrors, Esc restores scene pristine
  twice, ~120 fps steady through heavy destruction.

**Hotfix (manager)** — QA caught a severe regression: any wall >~5° off
world axes (i.e. every wall drawn in the rotated 3D view) vaporized on
first shot — `ensureVoxelTarget` ran `dropInteriorCells` on the legacy
isotropic branch too, and for deep diagonal AABBs the min physical extent
is the wall HEIGHT, keeping only top/bottom rows. Fix: skinning now runs
only in the anatomy branch, `dropInteriorCells` gained a `maxThickness`
bail (destruction passes `MAX_ANATOMY_THICKNESS`), and voxel.test.ts got a
diagonal-volume pass-through case.

Rough / next:
- Diagonal walls keep the legacy isotropic volume (no skins/cavity) — needs
  live re-verify post-hotfix; true anatomy would need an OBB-aligned grid.
- doors.tsx samples held keys per frame; a sub-frame E tap can be missed —
  consume the one-shot `KeyE` action instead.
- Knife viewmodel handle still reads slightly tube-like.
- Studs render slightly proud of the outer skin on voxelized walls (tan
  strips on the intact face) — okay-cartoony, could inset.
- Prop visuals stay intact while their colliders carve (guntable) — visual
  break-apart still open.
- Editor camera slightly more zoomed-out after exit (camera-controls state
  only, scene data untouched).

Checks: `bun run check-types` clean, `bun test` 45 pass / 1830 expects.

## Round 4 — 2026-08-25 (diagonal anatomy + QA sweep)

Landed:
- Diagonal walls get REAL anatomy: `VoxelGridData.yaw` (grid axis-aligned in
  a Y-rotated local frame, centers stay world), `buildDiagonalWallGrid` in
  destruction.ts — dual skins + cavity + breakable studs at any wall angle.
  raycastVoxels/removeSphere/collideVoxelTargets rotate queries internally;
  legacy grids take yaw==0 fast paths (byte-identical). 5 new voxel tests.
- Renderer wired for yaw grids (voxel-walls.tsx): instances now rotate
  [0, -yaw, 0] like studs — fixes QA's "venetian blinds" on diagonals.
- Stud depth derived from the grid's skin cells (`studDepth`): studs no
  longer render proud of intact drywall; smoke test re-derived (4.982) with
  a formula-robust `> 4.98` regression guard.
- Doors: tap-robust E via the one-shot action queue at useFrame priority -1
  (strips only KeyE, only when a door acts; guntable keeps keys-sampling).
  hud.ts `prompt()` clear branch now blanks textContent, so the doors-side
  blank-space workaround was dropped.
- Everything breaks: gun-table visible meshes ARE the colliders now (type
  'item') so its voxel replica is table-shaped and display guns blow off;
  builder pieces likewise self-colliding (type 'block'). New
  `dropTarget(nodeId)` in destruction.ts wired into builder G-undo so an
  undone voxelized piece drops its replica.
- Knife viewmodel reworked (blade-dominant, wood/steel grip); pistol mag
  baseplate flushed to the raked grip.
- Live QA (rotated room, 4 diagonal walls + door + table): axis-wall
  regression PASS, door tap/walk-through/stand-down PASS, prop carve PASS,
  island collapse sweep PASS, exit hygiene PASS twice, 120 fps steady.

Rough / next:
- Diagonal yaw-grid rendering fixed post-QA — needs one live screenshot to
  confirm the venetian-blind read is gone.
- Guns one-shot studs (damage 24-34 vs STUD_HP 3) — feel call for the owner.
- Bots deal ~45 hp/s at melee; a god-mode/bots-off toggle would deflake
  headless QA.
- guntable E is still keys-sampled (fine while it's hold-adjacent; queue
  pattern available if tap-robustness is wanted — one stripper per key).

Checks: `bun run check-types` clean, `bun test` 50 pass / 2337 expects.

## Phase 2, Round 1 — 2026-08-25 (can't die, grace countdown, builder feel)

Owner feedback round: no respawn-teleport on death, builder-generation build
mode, and a peaceful start with a ~5s countdown once you grab a gun.

Landed (5 agents + manager integration):
- **You can't die** (player.tsx / store.ts): respawn-teleport removed.
  `damagePlayer(amount, fromDir?)` is the one damage entry point — knockback
  shove (playerRig.shove, impulse accumulator), regen (+12 hp/s after 4s,
  writes chunked), and a 2.5s STAGGER instead of death: health pins at 1,
  `store.staggered` flips, walk-speed legs, no jump, camera sway, weapon
  droop + fire block (viewmodel.tsx), mercy window (no hp loss while
  staggered). Recovery at 40 hp. Safety net converts any raw health<=0
  store write into the stagger path.
- **Damage feel** (hud.ts / audio.ts): `damageFlash(angle?)` now directional
  — four edge-glow strips with cosine falloff (angle computed screen-relative
  in damagePlayer). Persistent low-HP vignette pulses on a severity-scaled
  heartbeat below 45 hp. Full-screen stagger overlay ("shake it off") keyed
  off `store.staggered`. Audio master chain grew a concussion lowpass
  (`sfx.setMuffle`) and a lookahead-scheduled `sfx.heartbeat()` handle.
- **Pacing** (enemies-state.ts / enemies.tsx): peaceful GRACE until the first
  gun pickup (pistol/rifle in owned) — building/breaking never wakes the
  machines. Then a one-shot 5s "They heard you — N" countdown top-center,
  WAVE 1 at zero; later intermissions show a subtle lowercase line. Melee
  routes through damagePlayer (knockback + directional flash for free).
  MERCY while staggered: ground bots hold a 4–6 m standoff ring, drones
  climb +1 m and hover. enemies.tsx also drives setMuffle on stagger edges
  and the heartbeat rate/level from health.
- **Builder feel** (builder.tsx): adjacency snap — walls chain end-to-end +
  stack (aim-gated), floors tile 4 ways, ramps dock low-edge to floor edges
  and wall bases (rise = WALL_H by construction). Hold-to-place sweeps runs
  (0.18s min interval, re-stamps on pose change). Occupancy check (pose
  modulo piece symmetry) tints the ghost red and skips silently. Pitch-
  shortened reach so the ghost tracks your aim. G-undo now splices the
  collider out and drops any voxel replica. 10 new tests.
- **Copy** (panel.tsx / README.md): builder-first story — "It's a game — and
  a way to build", grace/countdown and staggered-not-dead called out,
  hold-click runs documented.
- Manager integration: damageFlash cast in player.tsx made a direct typed
  call; redundant 0.5s stagger red-pulse/sfx removed from player.tsx (HUD
  overlay + enemies-driven heartbeat own it now); hud.ts staggered read made
  direct; audio.ts "exposed, not wired" comments updated (wired from
  enemies.tsx); builder placement gated while staggered to match the
  viewmodel fire block (prevFire still tracks the raw button).

Rough / next:
- Live QA pass pending (this round was headless-only): stagger feel timing,
  countdown legibility over the wave line, snap ergonomics at corners,
  drone hover during mercy.
- Stagger sway + weapon droop numbers are first-pass — tune after a live run.
- Ramp-on-ramp and wall-on-floor snaps intentionally absent (grammar keeps
  corners on the grid).

Checks: `bun run check-types` clean, `bun test` 65 pass / 2385 expects.
