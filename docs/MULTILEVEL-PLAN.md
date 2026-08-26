# MULTILEVEL PLAN — Whole Building, Stacked, Destroyable; Roofs That Stay Roofs

Owner ask (verbatim intent): *"It should be the entire building, all the floors together,
stacked, destroyable. The roofs should look like a slope; when I shoot them they should be
voxels, but they should still look like a roof, not like blocks. Make sure I'm not stuck
just on my level."*

This document is the deep plan. Four phases (A–D), each shippable on its own, each with
architecture, data-model changes, restore-ledger implications, bot/nav impact, perf budget,
and a test plan. Appendix lists every single-level assumption in the codebase with file:line.

---

## 0. The Key Insight — voxels look blocky only when the grid ignores the surface

The whole "roof reads as a roof" problem is a **basis problem**, not a resolution problem.

Today `VoxelGridData` stores a single scalar `yaw` — "grid-axes rotation about world Y"
(`src/game/voxel.ts:35-40`). Every transform in the pipeline is a hand-rolled 2D rotation
touching only x/z: grid→world centers (`voxel.ts:163-164`), `removeSphere`
(`voxel.ts:362-373`), the DDA ray walk (`voxel.ts:422-431`), `raycastYawObb`
(`voxel.ts:261-337`), capsule collision (`destruction.ts:1136-1143`), sheet normals
(`destruction.ts:483-516`). A pitched basis is *inexpressible*.

Voxelize a 40° gable shell in that world-axis frame and you get everything the owner is
complaining about, mechanically guaranteed:

1. **Blocky silhouette.** The thin sloped shell stair-steps through near-isotropic cells;
   the eave/ridge line becomes a staircase of 0.3–0.5 m cubes.
2. **Budget blowout.** The AABB height is `run·tanθ` meters of mostly-empty space; with
   `solid=true` (`destruction.ts:615`) and `MAX_VOXELS 1600` (`voxel.ts:64`), cells inflate
   to chunky blocks — the exact diagonal-wall pathology already documented at
   `voxel.ts:196-200`.
3. **False crumbles.** At pitch ≥ ~34° consecutive cells along the slope are *diagonal*
   neighbors; `findUnsupportedIslands` is 6-connected seeded from `iy===0`
   (`voxel.ts:508-517`), so everything above the eave row can register unsupported and
   collapse on the first island pass.

**Fix: align the grid to the roof plane.** Give the grid a full orthonormal basis
(unit quaternion `q`, grid-local→world): X = eave/ridge direction, Y = **plane normal**,
Z = up-slope. All inputs are already on the node — no mesh analysis needed. Total plane yaw
ψ = `roof.rotation + segment.rotation` (`composeSegmentWorldMatrix`,
`editor/packages/viewer/src/systems/roof/roof-system.tsx:106-123`); pitch θ comes from
`getSegmentSlopeFrame` (`editor/packages/core/src/schema/nodes/roof-segment.ts:508-527`).
The basis quaternion is simply `q = Qy(ψ) · Qx(±θ)`. The framing plugin independently
proves this convention works — its rafters are euler `[0, ψ±π/2, θ]` boxes
(`plugin-bones/src/engines/roof-framing.ts:19-23, 767-781`).

In that frame, everything the wall pipeline already does well transfers verbatim:

- **Thin skin along the roof normal.** The grid's "thickness axis" (deck + shingle ≈
  0.15 m along the plane normal) is now a grid axis, so `dropInteriorCells`
  (`voxel.ts:202-252`) produces the same two-skin anatomy walls get — anisotropic cells,
  thin across the normal, coarse along eave/slope. Cell budget drops from ~1600 solid
  chunks to a few hundred plate-shaped cells.
- **Per-cell shingle-tone jitter.** Same trick as wall skins: hash cell index → small
  value/hue offset on the shingle material for the outer skin, deck tone for the inner
  skin. From 10 m away an undamaged voxelized roof is *visually indistinguishable* from
  the host mesh because the outer skin surface lies exactly in the shingle plane.
- **Sheet semantics on the slope.** `buildSheets`/`thicknessAxisOf`
  (`destruction.ts:437-470`) are pure grid-space — with the roof basis, the thickness
  axis IS the plane normal, so 1.2×2.4 m "sheets" tile naturally along eave/slope.
  Shingle sheets tear and slide/fly off the slope exactly like drywall panels tear off
  walls; only the outward-normal computation (`destruction.ts:504-516`) changes from
  yaw cos/sin to `applyQuaternion(q)`.
- **Correct support.** With slope connectivity restored to face-adjacency, islands work
  again — seeded from the eave bearing row (see Phase C) instead of `iy===0`.

A voxelized roof in a plane-aligned grid **is a roof made of roof-shaped cells**: crisp
sloped silhouette, shingle texture, plate-like debris, sheets that slide down the pitch.
That is the entire "still look like a roof, not like blocks" requirement, solved by one
data-model change. Slabs need none of this — they are horizontal, so the existing yaw=0
grid with the thickness axis pinned to Y (cellSizes override `{y: thickness/3}`) is the
wall-anatomy shape rotated onto its side.

---

## 1. Data-model changes (cross-phase summary)

| Structure | Today | Target | Where |
|---|---|---|---|
| `VoxelGridData.yaw: number` | scalar Y rotation | `quat: [x,y,z,w]` unit quaternion (grid-local→world); keep the "local frame = world rotated about world origin" convention (`voxel.ts:36-39`) so `origin` stays a local-frame min corner. Yaw-only grids construct `Qy(yaw)` — no behavior change. | `src/game/voxel.ts:35-40` |
| `SegmentMember.yaw: number` | yaw-only OBB sticks | add optional `pitch` (or full quaternion) so rafters/joists become raycastable framing members; generalize `raycastYawObb` to quaternion OBB | `src/game/destruction.ts:116-123`, `voxel.ts:261-337` |
| `findUnsupportedIslands` seed | hardcoded `iy===0` | parameterized seed set (default = bottom row; roofs = eave±ridge bearing rows; upper-storey targets = cells with live support below, Phase B) | `src/game/voxel.ts:504-517` |
| `GameWorld.levelId` | dead (reads nonexistent `useScene.selectedLevelId`, always null, `world.ts:812-817`) | delete, or repoint to `useViewer.getState().selection.levelId` for telemetry only | `src/game/world.ts:812-817` |
| Per-target support | per-grid island flood only | cross-target `SupportGraph` (already written, unwired: `src/game/support.ts`) keyed by target, `probeExternal` = "live target/collider under my base cells" | `src/game/support.ts:33-59, 103-180` |
| World snapshot | visibility-filtered, level-blind | force `levelMode='stacked'` + snap level Y before `collectWorld`; snapshot is then whole-building by construction | `src/game/session.ts:76-101`, `world.ts:704-832` |

---

## Phase A — Whole-building presence (all levels visible + collected, stairs walkable, every level's walls destructible)

**Ships:** jump in from any level mode and get the entire stacked building — solid,
destructible, walkable via stairs. Highest value / lowest risk; no voxel-core changes.

### A1. Force stacked level mode on enter (session.ts)

`enterGame` (`src/game/session.ts:76-101`) already forces editor `viewMode='3d'` and viewer
`cameraMode='perspective'` with teardown restores. Add the identical pattern:

```
const prevLevelMode = useViewer.getState().levelMode;
if (prevLevelMode !== 'stacked' && prevLevelMode !== 'manual') {
  useViewer.getState().setLevelMode('stacked');
  session.teardown.push(() => useViewer.getState().setLevelMode(prevLevelMode));
}
```

**Restore-ledger implication — deliberately do NOT ledger per-level visibility.** The
host's `LevelSystem` runs its own `useFrame` at priority 5 *during the game*
(`editor/packages/viewer/src/systems/level/level-system.tsx:44-73`) and re-asserts
visibility + shadow-only layer masks from `levelMode` every frame. Ledgering objects a
host frame-loop owns is the mistake `ForeignOverlayHide` already teaches us to avoid
(`src/game/game-root.tsx:96-99`). Setting the mode is sufficient; the mode restore on
teardown is the whole undo. `hideForGame` (`session.ts:57-61`) stays reserved for things
the game exclusively owns (overlay roots, damaged meshes, replaced trees).

Gotcha: solo mode hides *below* levels via `visible=false` but puts *above* levels in
shadow-only via layer masks with `visible=true` (`level-system.tsx:61-73`,
`viewer/src/lib/scene-visibility.ts:31-57`) — `collectWorld`'s visibility walk
(`world.ts:723-734`) misses the latter and would collect invisible-but-solid ghost floors.
Forcing stacked mode eliminates both halves of that asymmetry at once.

### A2. Snap level Y before snapshot (game-root.tsx / world.ts)

`LevelSystem` *lerps* group Y toward baseY (`level-system.tsx:56`); `collectWorld` bakes
collider inverse matrices at whatever position geometry currently sits
(`world.ts:763-764`) — mid-animation included. Before the world snapshot in `ActiveGame`'s
initializer (`game-root.tsx:405`), snap every level group to its true position: either call
the viewer's ready-made `snapLevelsToTruePositions()`
(`editor/packages/viewer/src/systems/level/level-utils.ts:15-56`) or set
`obj.position.y = baseY` directly from `getLevelElevations`
(`editor/packages/core/src/services/storey.ts:65-102`). No restore needed for Y — the
LevelSystem lerp reconverges on exit.

### A3. collectWorld needs no filter change — plus cleanup

With all levels visible, the existing visibility walk collects everything: `walls` map,
colliders, glass, doors span every storey, `buildingAabb` unions the full building
(`world.ts:751-753`), spawn distance adapts automatically (`world.ts:797-810`). Delete the
dead `selectedLevelId` read (`world.ts:812-817`). Free bonus: host trees on previously
hidden levels stop being flagged `hidden:true` and get proper combat replacements
(`world.ts:96-99, 598-629`).

Bones-style overlays are already multi-level-correct: overlay roots are collected
registry-wide (`world.ts:288-299`), cross-level `bones-foreign-<levelId>` groups are
hidden by name per frame (`game-root.tsx:104-141`); newly-visible levels' overlay roots
get caught by `OverlaySweep`'s 15-frame tick (`game-root.tsx:161-168`) — tighten to
sweep once immediately at session start so there is no 15-frame flash.

### A4. Stair traversal — ramp-proxy colliders (zero controller changes)

`collideCapsule` (`src/game/collision.ts`) is a pure 3-iteration capsule slide with NO
step-up logic; grounded = contact normal.y > 0.55 ≈ slopes to ~57° (`collision.ts:65`).
Host stairs are true sawtooth (risers ~0.27–0.3 m vs capsule bottom-sphere radius 0.34 —
marginal/jittery, `stair-system.tsx:160-170`). Two options:

- **(chosen) Ramp proxy:** for colliders whose node kind is `stair`/`stair-segment`
  (both already in `SOLID_KINDS`, `world.ts:138-139`), register a simple ramp prism BVH
  instead of the sawtooth mesh. The extrude profile already computes the ramp slope line
  for the `fillToFloor` underside (`stair-system.tsx:176-184`); `StairNode` gives
  width/totalRise/stepCount (`core/src/schema/nodes/stair.ts:23-95`,
  `stair-rise.ts:6-32`). Code-legal pitch ~37° « the 57° grounded threshold, so walking
  up/down Just Works, and enemies (same `collideCapsule`) benefit equally. Keep the real
  sawtooth mesh for *bullets* (`raycastWorld`) so shooting stairs still feels precise;
  the swap is per-use (movement collider vs hitscan collider) via a `rampProxy?` field on
  `ColliderEntry`.
- (rejected for A) Step-up pass in `collideCapsule` — better long-term (works for rubble
  and builder pieces too) but it touches the one function every mover depends on;
  defer to Phase D as an optional hardening item behind a flag.

### A5. Fall guard + teleport

`player.tsx:532-535` fall-guard respawn to `world.spawn` is fine (spawn is ground ring).
Fix `playerDebug.teleport` to accept y (`player.tsx:302-307`) — needed by the Phase A/B
E2E tests themselves.

### Bots/nav in Phase A
No changes. Ground bots remain ground-only (documented limitation); drones already track
player altitude (`enemies.tsx:288-311`) so upstairs play has at least one threat lane.
Explicitly acceptable for this phase — full fix is Phase D.

### Perf budget (A)
A 3-level house ≈ 50–80 wall targets vs ~20 today. Nothing prevoxelizes except walls
(`destruction.ts:660-673`, 4 ms/frame budget, `game-root.tsx:70`) so the cladding window
stretches from ~1 s to ~3 s — acceptable, verify no frame spikes. Voxel targets only
exist once shot, so steady-state cost is unchanged until combat spreads across storeys.
BVH construction is lazy per geometry (`world.ts:757-768`) — snapshot cost stays flat.
Budget assertion: session start < 150 ms added vs today on the 3-storey fixture.

### Test plan (A)
- Unit: `session.test` — enterGame from each levelMode ∈ {stacked, exploded, solo,
  manual} → levelMode forced stacked, teardown restores exact prior mode; exitGame ledger
  parity (extend `overlay-hide.test.ts` patterns).
- Unit: `world.test` — 3-level fixture scene: `collectWorld` collects walls from all
  levels; `buildingAabb.min.y≈0`, `max.y≈3×storey`; no `selectedLevelId` access.
- Unit: stairs — ramp proxy dims match `totalRise`/depth; `collideCapsule` walk-up sim
  (integrate movement 2 s at 37° ramp) gains full rise without jumping.
- E2E (existing playerDebug harness): jump in while soloing level 2 → level 1 walls
  visible and shootable; walk stairs to level 2; shoot a level-2 wall → voxelizes and
  carves; exit → editor solo mode restored, all meshes/ledger restored.

---

## Phase B — Floors/ceilings as destructible sandwiches + fall-through

**Ships:** shoot the floor under an enemy and they (or you) drop through; slabs voxelize
as thin horizontal plates with proper skins; support becomes cross-target so a floor
doesn't float over a demolished wall (and vice versa).

### B1. Slab anatomy (destruction.ts)

Today `ensureVoxelTarget` routes non-walls to the dumb 'volume' path — isotropic 0.15 m,
`solid=true`, no skins/sheets/segments (`destruction.ts:552-553, 614-631`). Add a
`'slab-sandwich'` lane for kinds `slab`/`ceiling` (+ defensive `floor`):

- Grid: yaw=0 (slabs are always horizontal — `slab.ts:37`, polygon in level-local XZ),
  anisotropic cellSizes `{x: 0.3, z: 0.3, y: thickness/2 clamped ≥0.025}` so the
  vertical extent (0.05–0.3 m) is the thickness axis — the wall-anatomy shape on its side.
  Slab solid occupies level-local Y ∈ [elevation − thickness, elevation]
  (`editor/packages/core/src/schema/nodes/slab.ts:24, 37`;
  `generateSolidSlabGeometry`, `slab-system.tsx:94-150`); world Y adds
  `level.baseY` from `getLevelElevations` (`storey.ts:65-101`).
- Skins: `dropInteriorCells` with thickness axis = Y gives top-surface (flooring tone) and
  bottom-surface (ceiling tone) skins; per-cell tone jitter as walls do.
- Sheets: `buildSheets` tiles subfloor panels in the XZ plane (thickness axis Y) —
  shooting a floor tears 1.2×2.4 panels that flip down into the room below.
- Joists (optional, stretch): call `frameFloor`
  (`plugin-bones/src/engines/floor-framing.ts:5-15, 150-208`) at voxelize time and convert
  `role==='joist'/'rim'` Members (level-local — add `level.baseY`) into `SegmentMember`
  sticks (yaw-only euler `[0,yaw,0]`, `floor-framing.ts:201` — no OBB generalization
  needed yet). A shot-open floor then shows joist bays like a shot-open wall shows studs.
  Bones' rendered overlay stays excluded (`OVERLAY_KIND_PREFIXES`, `world.ts:156-174`);
  reveal comes from re-running the pure engine, never from scraping overlay meshes.

### B2. Fall-through mechanics

`collideVoxelTargets` (`destruction.ts:1126-1188`) already stops treating carved cells as
solid, and the host slab collider flips `disabled` on voxelization (`destruction.ts:636-639`),
so fall-through works the moment the anatomy lane exists. Verify:

- Grounded state comes from contact normal.y > 0.55 against voxel top-skin cells — holds.
- Drone probe intentionally treats disabled colliders' worldBox as solid
  (`enemies.tsx:119-125`) — keep for drones, but ensure ground-bot melee probes
  (`enemies.tsx:131-144`) use the voxel raycast so bots can be dropped through floors.

### B3. Cross-target support (wire up support.ts)

Two per-target support breaks (both from `voxel.ts:508-517` flooding from the target's
*own* AABB bottom row): (a) an upper-storey wall on a slab is "supported" by its own base
row forever — demolishing the slab under it never collapses it; (b) symmetric for placed
builder pieces (`builder.tsx:631-666`). The designed fix already exists unused:
`SupportGraph` in `src/game/support.ts` (grounded roots `support.ts:53-59`,
live `probeExternal` `support.ts:33-36`, multi-source BFS `isSupported`
`support.ts:155-180`, staggered `computeCollapse` rings `support.ts:103-150`) —
committed in ad1b970, imported only by `support.test.ts`.

Minimal wiring (avoid full v2 grid adoption): register every voxel target as a graph node;
`probeExternal(target)` = short downward BVH/voxel probes from the target's base cells
("is there a live collider or live voxel cell within 0.2 m below"); grounded roots =
targets whose base world-Y ≤ terrain + ε. Hook the existing 140 ms island timer
(`destruction.ts:947-955`): after per-grid islands, recompute graph support for targets
whose supporters changed; unsupported targets crumble via the existing `crumbleIslands`
path (`destruction.ts:680-726`). Falls stagger by BFS ring for the chain-collapse feel.

**Crumble sampling (required before B ships):** `crumbleIslands` spawns one debris cube
per island voxel (`destruction.ts:695-703`); the global debris ring is 768 + 120 flat
(`debris.tsx:26, 123`). A slab collapse can exceed the whole ring in one frame. Sample
islands to ≤ ~150 debris pieces (probability ∝ cell volume), spawn a dust burst for the
rest.

**Debris/dust floors (polish):** debris bounces on the world plane `y=slot.ground`
(`debris.tsx:254-282`) and dust sinks through slabs (`dust.tsx:543`). Cheap fix: at spawn,
raycast once downward through colliders+voxels to pick the *landing plane* per debris slot
(store per-slot ground Y) — no per-frame collision. Same one-shot probe for dust settle
height. Defer full debris-vs-voxel collision forever; it's not worth it.

### Restore-ledger (B)
Unchanged mechanics: host slab/ceiling meshes hide via the session ledger and colliders
flip `disabled` in the same tick (`destruction.ts:636-639`); exit restores meshes and
re-enables colliders (`session.ts:175-177`). New: SupportGraph is per-session state —
build in `ActiveGame` init, drop on exit; nothing to restore.

### Bots/nav (B)
Ground bots can now be dropped through floors: on losing ground contact they fall (add
gravity to the settle rule — see D) or minimally: kill-credit a bot that ends below the
slab it stood on. Defer real pathing to D.

### Perf budget (B)
Slab anatomy ≈ 2 skins × (area/0.09) cells: a 60 m² slab ≈ 1300 cells — inside
`MAX_VOXELS 1600` but tight; large slabs must **split into per-room chunks** by the
polygon's convex decomposition or a simple 6×6 m tiling *before* gridding (same nodeId +
chunk suffix, each its own target — also improves island locality and collide-loop
early-out via worldBox). Budgets: voxelize-on-first-shot < 8 ms for a 6×6 chunk; collapse
frame < 6 ms with sampling.

### Test plan (B)
- Unit: slab grid — thickness axis Y, two skins, sheet tiling; world Y = baseY +
  elevation − thickness..elevation (fixture with non-default storey heights).
- Unit: support graph — wall-on-slab: carve slab under wall → wall target reported
  unsupported within one recompute; builder floor-on-wall symmetric case
  (extends `support.test.ts` which already covers graph math).
- Unit: crumble sampling — 2000-voxel island spawns ≤150 debris + dust events, ring
  never wholly evicted.
- E2E: stand on level-2 floor, grenade the slab (grenade routes via
  `FALLBACK_DESTRUCTIBLE`, `grenade.tsx:190-197`) → hole opens, player falls to level 1,
  lands grounded, no respawn trigger; debris rests on level-1 floor, not terrain.

---

## Phase C — Sloped roofs: plane-aligned voxel skins + rafters + shingle sheets

**Ships:** the owner's headline. Shoot a roof → it voxelizes in a roof-plane grid, keeps
its sloped silhouette and shingle look, tears in sheets that slide down the pitch, reveals
rafters, and collapses believably from the eaves.

### C1. Quaternion grid core (voxel.ts) — the prerequisite

Replace `yaw: number` with unit quaternion `q` end-to-end, keeping yaw-only behavior
bit-identical when `q = Qy(yaw)`:

1. **Build** (`buildVoxelGrid`, `voxel.ts:86-164`): fold `R(q)⁻¹` into each mesh inverse
   (generalize `makeRotationY(−yaw)` at :115-120 to `inverse.multiply(matrixFromQuat(q))`);
   the OBB shell test and backface-interior test are frame-agnostic. Compute
   `worldBounds` in the q-local frame — the recipe already exists for yaw at
   `buildDiagonalWallGrid` (`destruction.ts:265-274`); same code with a quaternion.
   Centers: `applyQuaternion(q)` of local center (replaces the hand-rolled rotation at
   :163-164).
2. **world→grid** (`removeSphere`, `voxel.ts:362-373`): `p_local = q⁻¹·p` on ALL THREE
   components — the Y cell-range bound at :370-371 must use local y. The r² kill check
   (:389-392) compares world centers vs world point — rotation-invariant, keep. The
   SkinLimit side-split (:376-387) is pure grid coords — unchanged.
3. **DDA** (`raycastVoxels`, `voxel.ts:422-431`): rotate ray origin+direction by `q⁻¹`,
   run the walk verbatim; rotations preserve distances so returned `t` stays a world
   distance (the comment at :405-409 generalizes).
4. **`raycastYawObb` → quaternion OBB** (`voxel.ts:261-337`): rotate ray into box frame
   by `q⁻¹`, same slab test. Also unblocks pitched `SegmentMember` rafters (C3).
5. **Capsule collision** (`collideVoxelTargets`, `destruction.ts:1126-1183`): the code
   assumes a vertical capsule stays vertical under Y rotation — false under pitch.
   Transform both capsule core endpoints by `q⁻¹`, take the swept AABB inflated by
   radius+r for the cell range; the push-out already runs on world centers (:1156-1182),
   unchanged.
6. **Sheets** (`buildSheets`, `destruction.ts:456-538`): grid-space logic unchanged;
   outward normal via `applyQuaternion(q)` instead of yaw cos/sin (:504-516).
7. **Island seeds** (`findUnsupportedIslands`, `voxel.ts:504-517`): parameterize with a
   seed set (see C4).

**Prototype first (de-risk):** a standalone test that builds a 40° gable-plane grid from
the merged-roof fixture mesh, asserts (a) live-cell count < 600 for a 6×8 m face,
(b) two skins along the normal, (c) DDA hit from above returns the same world point ±2 cm
as `raycastWorld` on the host mesh, (d) all yaw-only regression tests
(`destruction.test.ts`, diagonal-wall cases) pass unmodified with `q=Qy(yaw)`.

### C2. Roof target = per-PLANE grids, not per-node

The host renders ONE merged CSG mesh per roof node ("merged-roof",
`editor/packages/nodes/src/roof/renderer.tsx:101-131`;
`updateMergedRoofGeometry`, `roof-system.tsx:540-757`) — a hollow shell with 4 material
groups (0=Wall/Trim 1=Deck 2=Interior 3=Shingle, `roof-materials.ts:11`). One grid can't
align to two slopes. So `ensureVoxelTarget` gets a `'roof'` lane that shatters the node
into **one voxel target per plane**, plus small yaw-only targets for the gable-end walls:

- Enumerate planes from the schema, not the mesh: per segment child, roofType ∈
  hip|gable|shed|… (`roof-segment.ts:7`), slope frame from `getSegmentSlopeFrame`
  (:508-527), plane extents from width/depth/overhang; basis `q = Qy(ψ)·Qx(±θ)` with
  ψ = roof.rotation + segment.rotation (`composeSegmentWorldMatrix`,
  `roof-system.tsx:106-123`) and world offset = roof position + level baseY. Face
  geometry per type mirrors `getModuleFaces` (`roof-system.tsx:2431-2493`); fallback for
  exotic cases: cluster merged-mesh face normals (`collectGeometryPlanes` exists,
  `roof-system.tsx:2188-2207`).
- Voxel sources: feed each plane-grid the whole merged mesh (the q-frame OBB clips to the
  plane slab, so cross-plane bleed is bounded to the ridge seam) — cheap and robust; the
  ridge line cells get claimed by whichever grid builds them (dedupe by world-cell hash
  at the seam, first-writer-wins).
- One shot on the roof voxelizes ALL planes of that node in the same tick (like a wall's
  whole segment), hiding the single merged mesh once via the session ledger and disabling
  its one collider (`destruction.ts:636-639`) — partial-mesh hiding is impossible on a
  merged mesh, so per-plane lazy voxelization is not an option. Budget accordingly (below).
- Skins & look: outer skin = shingle tone + per-cell jitter (+ optional row-striping by
  grid-Z parity to fake shingle courses — free, reads great), inner skin = deck tone.
  Thin cells across the normal: `{normal: (deck+shingle)/2 ≈ 0.08, eave: 0.3, slope: 0.3}`.
- Sheets: shingle/deck sheets tile the slope; torn sheets get initial velocity down-slope
  `d = Ry(ψ)·(0,−sinθ, s·cosθ)` so they *slide then tumble* — this single touch sells
  "roof, not blocks" harder than anything else. Reuse the drywall sheet debris path.

### C3. Rafters (framing reveal)

At roof voxelize time, run the pure engines — `extractRoofs` + `frameRoofs`
(`plugin-bones/src/engines/roof-framing.ts:82-149, 205-242`) with default spec (24" o.c.
2x6, `plugin-bones/src/core/spec.ts:341-342`) — filter `role==='rafter'|'ridge'`, convert
Members ({dims, position, rotation:[0,ψ±π/2,θ], level-local} —
`plugin-bones/src/core/types.ts:126-155`) to pitched `SegmentMember`s (quaternion OBB from
C1 step 4; add level baseY — the studs' mesh-bounds drift correction at
`destruction.ts:301-322` shows the pattern). They render through the existing
`MemberLayer` instanced path (`voxel-walls.tsx:187-196`) with lumber tone; they intercept
bullets via the generalized OBB raycast and break like studs. A shot-open roof shows
rafters + ridge exactly like a shot-open wall shows studs.

### C4. Roof support semantics

Seed `findUnsupportedIslands` per grid: for a roof-plane grid, seeds = the **down-slope
boundary row** (grid Z==0, the eave bearing line) and the **ridge row** (Z==nz−1 —
rafters bear at both ends per the framing model). Equivalent geometric fallback: seed any
live cell whose world center is within one cell of the grid's minimum-world-Y live cell.
Cross-target (SupportGraph from B): eave seeds are live only while `probeExternal` finds
the bearing wall's top plate below them — blow out a full wall and the roof face sags:
eave seeds die → island flood marks the face unsupported → staggered crumble rings.
Face-adjacency along the slope is restored by the basis, so no false crumbles.

### Restore-ledger (C)
Per roof node: one hidden merged mesh + one disabled collider in the ledger (existing
mechanics), N plane-grids + rafter segments as session-only voxel state — dropped on
exit like wall targets. `Keep` (`keep.ts:110`) already passes roof y through; kept
in-game roofs are builder pieces, out of scope here.

### Perf budget (C)
Per gable roof node: 2 plane grids × ~400–600 skin cells + 2 gable-wall grids ×
~150 + ~20 rafter segments ≈ 1400 cells / 6–8 instanced draws — comparable to 3 walls.
First-shot voxelization of a whole roof node (all planes + framing engine run) must fit
one frame hitch budget: < 12 ms measured on the 3-storey fixture; if the framing engine
exceeds it, precompute Members during idle prevoxelize (extend `prevoxelizeTick`,
`destruction.ts:660-673`, walls-then-roofs priority). Hip roofs = 4 planes: cap combined
cells via coarser eave/slope cells, never via the normal axis (silhouette lives there).

### Test plan (C)
- Unit: quaternion grid — yaw-regression (all existing voxel/destruction tests green with
  `q=Qy(yaw)`); pitched build cell-count and skin assertions; DDA world-t equality across
  bases; capsule vs 40° roof face push-out along the plane normal.
- Unit: plane enumeration — gable/shed/hip fixtures → expected plane count, ψ/θ per
  plane vs `getSegmentSlopeFrame`; ridge-seam dedupe leaves no doubled cells.
- Unit: support — carve a band across mid-slope → upper strip crumbles from ridge only
  if ridge seeds also cut; eave-seed death after bearing-wall demolition (graph).
- Visual E2E: screenshot-diff undamaged host roof vs voxelized roof at 10 m — silhouette
  deviation < 1 cell; shoot ridge → sheets slide down-slope (velocity direction assert
  in unit, eyeball in E2E).

---

## Phase D — Bots multi-level + perf hardening

**Ships:** enemies that pressure every floor; frame-time holds at wave 10 in a 3-storey
fight.

### D1. Ground bots get real vertical physics

Replace pseudo-gravity settle toward y=0 (`enemies.tsx:376-378`, `BOT_SETTLE_RATE`,
`enemies.tsx:85`) with the shared path: bots already use `collideCapsule` — give them
gravity + grounded from contact like the player (`movement.ts:33-43` constants). A bot on
a floor stands on the slab collider/voxels; a bot over a hole falls through (B payoff).

### D2. Vertical navigation — stairs-as-lanes, not navmesh

No navmesh exists and none is warranted. Use the schema: `StairNode.fromLevelId/toLevelId`
(`stair.ts:23-95`) gives an exact level graph. Add to `GameWorld`: `stairLanes:
{from, to, bottom: Vec3, top: Vec3}` extracted in `collectWorld` from stair nodes + ramp
proxies (A4). Bot brain: if target's level ≠ mine (level = bucket feet.y via
`getLevelElevations` bands stored in the snapshot), steer wall-follow (`enemies.tsx:331-353`,
XZ-only — fine) toward the near stair endpoint, then ascend the ramp lane. Spawning:
`spawnWave` (`enemies.tsx:97-113`) stays ground-ring, but assign per-wave a fraction of
droids "hunters" that use lanes; drones unchanged (already altitude-aware,
`enemies.tsx:288-311`). Fix drone box-climb heuristic (`enemies.tsx:119-125`) to probe
voxels through blown-open floors so drones can enter breaches.

### D3. Perf hardening (the cliffs, in priority order)

1. **Unculled instanced meshes** — every voxel target draws always
   (`frustumCulled=false`, `voxel-walls.tsx:177, 249`); 3 storeys ≈ 120–240 draws /
   60–130k instances. Fix: per-target `boundingSphere` from grid worldBox + manual
   frustum/visibility gate per frame (cheap: one sphere test per target); plus distance
   LOD — beyond 40 m collapse skins to the coarse sheet layer.
2. **Per-frame member checksums** — `MemberLayer` re-checksums every member every frame
   (`voxel-walls.tsx:187-196`); switch to dirty flags set by carve/break events.
3. **O(targets) hot loops** — `collideVoxelTargets` (`destruction.ts:1126-1188`) ×
   (player + ~23 bots + grenades) and `raycastVoxelTargets` (:1089-1116): add a coarse
   uniform XZ grid of target worldBoxes (rebuild on target add/remove) so each capsule/ray
   touches ~3 targets instead of ~70. `raycastSegments` (:975-1016) same index.
4. **Effect pool pressure** — island sampling from B; verify dust pressure-halving
   (`dust.tsx:53`) holds in a two-floor simultaneous fight.
5. Budgets (3-storey fixture, wave 10, mid-tier GPU): < 6 ms script main loop, < 300
   draws total, prevoxelize window < 4 s, zero pool-wrap evictions of live debris.

### D4. Quality-of-life multi-level fixes
Gun tables at spawn stay ground-level (correct — spawn is ground). Nature scatter stays
terrain-level (correct by definition). Builder ghost `y = max(0, …)` from feet
(`builder.tsx:607`) already semi-works upstairs; align `LEVEL_STEP 1.4` snapping with host
level bands from `getLevelElevations` when standing inside the building (snap to
level baseY + n·1.4). Keep-flattening (`keep.ts:129, 154-167` — walls lose elevation) gets
a per-piece level lookup by `piece.position[1]` — separate small PR.

### Test plan (D)
- Unit: bot gravity — bot on 2nd floor slab stays; carve slab → bot falls, lands level 1.
- Unit: stair lanes — 2-level fixture: hunter bot at ground with player upstairs reaches
  the top stair endpoint within N sim-seconds.
- Perf harness: scripted wave-10 two-floor fight on the 3-storey fixture; assert frame
  budgets above; assert draw count via renderer.info.
- E2E: full loop — jump in, fight downstairs, retreat upstairs via stairs, bots follow,
  blow the floor under them, roof breach exit check, exit game → editor state pristine.

---

## Riskiest pieces & de-risk prototypes (do these first, in order)

1. **Quaternion grid core (C1)** — touches every voxel code path. Prototype: standalone
   branch converting `voxel.ts` with `q=Qy(yaw)` compat, entire existing test suite must
   stay green before any roof work. 1–2 days; if it stalls, Phases A/B still ship.
2. **Ridge-seam & plane decomposition (C2)** — hips/dutch/mansard have shared edges and
   odd faces. Prototype on gable+shed only; hip behind a fallback (world-axis volume grid,
   today's behavior) until seam dedupe is proven. Ship C for gable/shed first — most
   scenes are gable.
3. **Cross-target support graph (B3)** — collapse cascades can chain-react across a whole
   building. De-risk: cap cascade depth (3 rings/recompute), sample debris, and gate the
   graph behind a flag defaulting ON only after the E2E soak (10-minute scripted
   demolition) holds 60 fps and never deadlocks the island timers.
4. **Stair ramp proxy feel (A4)** — risk is feel (sliding on descent, jitter at landings).
   Prototype: single-stair fixture + movement-integration test; tune grounded threshold
   interactions before wiring bots to lanes.
5. **Whole-roof voxelize hitch (C2 budget)** — measure early on the largest fixture roof;
   the prevoxelize fallback (walls-then-roofs) is the escape hatch.

---

## Appendix — Assumption debt (every single-level / y=0 fix, file:line)

Ground & physics
- `src/game/collision.ts:77-84` — infinite ground plane at y=0; `y<0.02` grounded
  heuristic is terrain-only. Fix: none needed for A–C (upper floors ground via contact
  normal); document as terrain contract. D: keep.
- `src/game/collision.ts` (module) — no step-up offset exists. Fix: A4 ramp proxies;
  optional step-up pass in D.
- `src/game/voxel.ts:504-517` — island support = own-grid `iy===0` bottom row. Fix: B3
  parameterized seeds + SupportGraph; C4 eave/ridge seeds.
- `src/game/voxel.ts:35-40, 115-120, 163-164, 261-337, 362-373, 422-431` — yaw-only grid
  basis throughout. Fix: C1 quaternion generalization.
- `src/game/destruction.ts:1136-1143` — capsule query assumes verticality preserved under
  grid rotation. Fix: C1 step 5.

Spawn/session/world
- `src/game/world.ts:798-810` — spawn ring at y=0 ignoring building base elevation. Fix:
  acceptable (buildings sit at y=0); note for hillside lots.
- `src/game/world.ts:723-734` — collection silently drops hidden branches. Fix: A1/A2
  make all levels visible pre-snapshot (by design, keep the walk).
- `src/game/world.ts:812-817` — dead `selectedLevelId` read (field doesn't exist in
  useScene). Fix: delete in A3.
- `src/game/session.ts:76-101` — enterGame never touches levelMode. Fix: A1.
- `src/game/player.tsx:302-307` — teleport hardcodes y=0. Fix: A5.
- `src/game/player.tsx:532-535` — fall guard respawns to ground spawn. Keep (correct).
- `src/game/player.tsx:206-209` — damage flash bearing yaw-only. Fix: D (minor), add
  above/below tint.

Enemies
- `src/game/enemies.tsx:376-378` + `:85` — bots settle toward y=0. Fix: D1 gravity.
- `src/game/enemies-state.ts:108-126` — spawnBot y=0 (drones 2.4–3.6). Fix: D2 lanes;
  ground spawns stay ground.
- `src/game/enemies.tsx:97-113` — waves ring XZ-only around building center. Keep;
  hunters route via lanes (D2).
- `src/game/enemies.tsx:331-353` — wall-follow XZ-only. Keep (per-floor OK).
- `src/game/enemies.tsx:119-125` — drones climb disabled colliders' full worldBox. Fix:
  D2 voxel probe through breaches.

Effects
- `src/game/debris.tsx:48-49, 114, 177, 254-282` — debris bounces on world plane; falls
  through upper floors. Fix: B one-shot landing-plane probe per slot.
- `src/game/debris.tsx:26, 123` + `src/game/destruction.ts:695-703` — 768+120 pool vs
  1-debris-per-voxel crumble. Fix: B island sampling.
- `src/game/dust.tsx:543` — dust sinks through slabs. Fix: B settle-height probe
  (cosmetic).
- `src/game/dust.tsx:50-53` — global pools; verify under two-floor fights (D3.4).

World dressing
- `src/game/nature.tsx:29-34, 134, 212, 289, 305, 317, 332` — lawn/scatter at terrain
  heights. Keep (terrain features by definition).
- `src/game/world.ts:354-362` — ground-pad heuristics `PAD_MAX_BASE_Y 0.6` /
  `FOOTPRINT_MAX_Y 1.5`. Keep; revisit only for hillside lots.
- `src/game/guntable.tsx:50-69, 392` — gun tables at y=0 near spawn. Keep (spawn is
  ground).
- `src/game/trees-destruct.tsx:71-84, 113` — placement y defaults 0; deck trees already
  carry y. Keep; A3 removes the hidden-branch `hidden:true` gap (`world.ts:96-99`).
- `src/game/sky.tsx:119` — horizon disc at y=0. Keep.

Builder/Keep/v2 grid
- `src/game/builder.tsx:102, 607` — ghost y from feet, clamped ≥0, LEVEL_STEP 1.4
  half-storeys mismatch host level heights. Fix: D4 level-band snapping.
- `src/game/keep.ts:129, 154-167` — Keep flattens wall elevation onto selection.levelId
  (only roofs keep y, `keep.ts:110`). Fix: D4 per-piece level lookup.
- `src/game/grid.ts:26-27, 99, 156-187, 323-327` — v2 grid: fixed STOREY 2.8, terrain at
  y=0, `isTerrainGrounded s===0`; unwired. Fix: only if v2 grid ships; `probeExternal`
  (`support.ts:33-36`) is the designed escape hatch.
- `src/game/support.ts` (whole module) — written, tested, consumed by nothing. Fix: B3
  wires it.

HUD
- `src/game/hud.ts` — no minimap/level indicator. Optional D4: current-storey pip.
