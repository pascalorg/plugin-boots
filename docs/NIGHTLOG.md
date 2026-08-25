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
