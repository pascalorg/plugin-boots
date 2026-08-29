# Boots — the grand plan (living doc, 2026-08-25 night)

One page every fleet agent reads first. Deeper docs: `MASTERPLAN.md`
(vision + systems), `BUILD-GRAMMAR-V2.md` + `BUILD-GRAMMAR-V2-REVIEW.md`
(builder revamp spec — the REVIEW verdict is binding), `NIGHTLOG.md`
(round-by-round history), `RESEARCH.md` (sourced tech survey).

## Shipped (pushed to main, in prod as pinned releases)

- Phases 1–3 (QA-passed live): FPS viewmodel + real gun models · wall
  sandwich (pre-voxelized cladding, drywall sheets that tear as paper,
  charcoal-stick framing at true lumber section, through-holes) · rotary
  gun on the rear table · combat trees (fell / ignite→char→stump) ·
  dust-storm destruction · 3×3 wall masks (center pocket → REAL window
  node on Keep; roofs → roof-segment nodes) · overcast sky · no-death
  stagger + regen · gun-pickup countdown + robot waves · bot WALL RULE
  (path around, never through, until breached) · Bones-overlay hiding ·
  crash shield (GameBoundary) + hardened lazy BVHs.
- Phase 4 round 1: warhammer (slot 6) · mega-grenade on G (now INFINITE,
  0.6 s re-arm) · ADS on right-click (buttons-bitmask input fix; rifle
  goes semi-auto + −75 % spread while aiming) · siren-beacon countdown
  theatre ("⚠ AI robot zombies incoming") · boots ON the table facing the
  player + "PUT YOUR BOOTS ON" placard (centered, 1 m) · real display
  models on both tables (heavy table 4.5 m behind spawn) · material-keyed
  dust (drywall max / concrete small / wood splinters-only).
- Prod pins: boots `7f5b912` + bones `cdd3dab` (z-fight fix) via PR #419.

- Phase 4 (complete): warhammer slot 6, mega-grenade on G (infinite,
  stick-grenade model with in-hand wind-up + tumbling flight, staggered
  blast rings — no detonation hitch), ADS (buttons-bitmask input fix,
  rifle semi-auto while aiming), siren countdown theatre, material-keyed
  dust, boots + signs on the tables ("YOU ARE COOKED" after gear-up),
  bots path around walls, structural 30%-support collapse + hanging-stick
  rule, resurrection sweep (host wall rebuilds can't resurrect
  undamageable drywall), pipeline pre-warm (no gear-up lag).
- Phase 5 (complete): BUILD GRAMMAR V2 INTEGRATED — the ghost is
  slot-locked (grid.ts targeting, rawGhost/resolveSnap retired),
  piece-slots.ts is the single occupancy authority (grounding, collapse
  rings, died-slot turbo lockout), whole-building stacked-levels
  presence, E-interact on doors/windows/cabinets, quaternion voxel grids,
  turbo clad FIFO budget. 375 tests / 12.4k assertions green.
- Night round 2026-08-27 (fleet, 4 lanes + manager stitch): piece split
  wall/floor/STAIRS/roof (stairs = the walkable plank; roof = the 2×2
  corner patch, ghost previews the real bilinear preset, R cycles shape
  presets; grid.roofQuarter ±Z ascent fix) · direct piece hotkeys Z/X/C/V
  (undo → U) · F-edit overlays rebuilt as outlined lattices + corner
  wireframes (edit-overlay.tsx) with SWIPE carving on cell edits · third
  BUILD table at spawn ("START BUILDING" → builder pickup, no wave
  trigger) · in-game creative catalog (I → inventory.tsx menu →
  item-place.tsx ghost/fixture placements → item-keep.ts Save bridge;
  input.ts menuOpen latch, session lock-release guard, panel
  Save/Discard). 563 tests / 18.2k assertions green. Doc debt:
  BUILD-GRAMMAR-V2.md still says 3-piece grammar — refresh next round.

- Phase 6 round 1 (2026-08-27 night, fleet 4 lanes + manager stitch):
  combat is OPT-IN — the breaker SwitchWall by the gear table is the only
  wave trigger (gun pickup never spawns bots; pure tickWaveDirector +
  armWaves, invariant test-pinned; dedicated breakerThrow voice) · real
  catalog models in prod (itemModelLoader wires Draco+meshopt decoders —
  the proxy-box regression was a missing DRACOLoader) · item destruction
  wears the material (per-cell sub-mesh tones → voxels/debris/dust) ·
  perf: shot broadphase before BVH, warmup BVH drain + crater/scorch +
  audio prime, probeLandingY memo, settle-timer de-coalescing · ramp
  targeting ray-march fix + weapon-tracked HUD keybar with AZERTY
  captions. 610 tests / 19.8k assertions green.
- Phase 6 fix round 2 (2026-08-27, manager, post-QA): the two dead
  lanes landed by hand — roof framing clips to each plane's FOOTPRINT
  polygon (polyTris from enumerateRoofPlanes; hip jacks shorten, rake
  lines drop, no stick past the ridge, ridge boards stop at the real
  hip ridge) · roof voxels wear the real shingle tone (async GPU
  readback wired: setRoofTextureRenderer + resolveRoofSkinTone →
  skinRevision re-prime, paint ledger intact) · ceiling plates carve on
  EVERY upward hit (entrySkin steps half a cell along the shot — the
  halves-boundary float-noise bug) + zero-carve hits puff a chip
  fallback. 639 tests / 20.1k assertions green. See NIGHTLOG.
- Phase 6 round 2 (2026-08-27 night, fleet round 3: 2 lanes landed, 2
  died with zero output — roof-clip + colors/ceiling landed by the
  manager in fix round 2 above): paint FEEL — splat radius is distance-driven (`splatRadiusAt`,
  clamped quadratic ease 0.12 m at ≤1 m → 1.4 m at ≥8 m; one wall cell
  up close for legible writing, exaggerated late-bloom cone far out;
  PAINT_RANGE 7→9 m so the 8 m anchor is reachable), the spray can wears
  its palette color (valve-collar cap + "PRESS R" CanvasTexture band,
  bounded per-coat texture cache, hex-change-gated frame loop), and a
  writing-mode HUD prompt flips on while spraying a surface < 2 m ·
  frame-LAG recorder (perf-monitor.ts): 60 s Float32Array ring, zero
  per-frame allocations, spike log (>3× rolling mean, min 50 ms) tagged
  by the nearest `perfEvent` within 500 ms — call sites at grenade-boom /
  minigun-trigger / voxelize / clad-drain / item-load / wave-spawn;
  `__boots.perf()` snapshot ({frames, mean, p95, worst, spikes}) +
  `__boots.perfReset`, console dump on session exit. 634 tests / 19.9k
  assertions green.
- Phase 6 round 3 (2026-08-27 night 3, fleet: 2 perf lanes + 3 worktree
  branches, manager integrated): FIRST-BLAST HITCH KILLED — dormant
  replicas pre-mount hidden at prevoxelize time (skin priming drained
  2/frame; wake = a visibility flip, no InstancedMesh mount or primeSkin
  in the blast frame) + keyed budgeted settle drain (3 tasks / 16 ms
  pump; island, framing, structure-tick and cascade-wave timers ride
  it) · BOOM TRIM — snapVoiceGate (120 ms window, 5 snaps then one
  collapsed crack: 48-snap floods → ~6 voices), 240-slot preallocated
  blast debris queue drained 80/frame (damageSegment routes through it
  while the 0.25 s post-blast window is open), glass shatter staggered
  2/+40 ms/+80 ms · gable-residual — roof shells' excluded faces
  (gable ends, fascia) get their own #residual volume member, so first
  shots stop vanishing them · smooth-climb — walkOnClad/walkOnly
  handover (feet ride the smooth plank while bullets see voxels, demote
  at >12% damage), 0.35 m step offset in moveCapsule, full-speed slope
  projection · adaptive-storeys — session storey ladder (real level
  bases replace the uniform 2.8 m assumption; pieces conform to their
  slot's local span; Keep parents each piece to its real level). 731
  tests / 20.8k assertions green.
- Phase 6 fix round 3 (2026-08-28, manager, post-QA night 3): CLIMB
  positional (velocity had lied) — dormant piece grids skip capsule
  collision + walkable ground contacts resolve VERTICALLY in
  collideCapsule (tilted-normal push-out was cancelling horizontal
  advance); live ratio 0.755 → 0.999 · FIRST BLAST — post-prime WARM
  DRAW (one underground frame per dormant replica uploads its GPU
  buffers early), blast rings walk nodes 4/frame nearest-first
  (staggered steps, blastEpoch abort), grenade WAKE-AHEAD (fuse frames
  pre-wake the blast zone): detonation frame is CLEAN; one residual
  ~62–68 ms `wake item_…` spike at the first host-item wake (named
  tag; next-round lead) · warmup BVH drain re-opens for late item-GLB
  colliders · perf kit: `perfSections()`, spike `cpu`/`render` split,
  slow-submit renderer.info forensics, named wake tags,
  dormantPrimeQueueSize/settleTasksPending on `__boots`. 731 tests /
  20.8k assertions green.
- Phase 9 (2026-08-28 night, fleet 5 lanes — spray/support/drones/juice
  landed, breakage lane died with zero output; manager wired + stitched):
  SPRAY FEEL — nozzle mist cone + bounce-back puffs (paint DustMaterial
  variant, pure tint), feathered ACCUMULATING splats (packed
  (color<<8)|strength ledger, smoothstep falloff + rim speckle, coats
  lerp from the true primed cell tone via new skin-tone.ts —
  voxel-walls now shares the same helper, bit-identity test-pinned),
  48-slot drip pool on heavy wall coats, DecalGeometry splats on
  PRISTINE hosts (painting no longer voxelizes; decals convert to
  ledger coats on the destruction target-live hook, paint-keep votes
  merge them area-weighted), can-shake wrist flick + rattle SFX +
  nozzle-press lean · SUPPORT STRICT — scene-support probe grew a BVH
  narrow phase (grid-frame slot OBB, margin as contact tolerance;
  AABB overlap alone never grants), structural-nodeType anchor
  allowlist (props/items never prop a build), piece-as-unit death at
  <15% alive fraction (dead planks cascade long after walk-only
  demotion) · DRONES REAL — drone-sized capsule collision through the
  ground-bot pipeline (no phasing through floors/roofs/pieces),
  displacement-swept path probes + descent-corridor hold, 3D reach,
  meleeBlocked for all bot kinds + exact door-leaf swing sweep · JUICE —
  once-per-session micro-hints, hitmarker kinds (carve pulse / kill
  flare that owns its window), WAVE CLEARED banner, dual-rotor drone
  hum with squared distance falloff, metal items spark + ping on carve
  (metalness>0.5 at voxelize). 797 tests / 22.3k assertions green.
- Owner fix round 5 (2026-08-28, fleet 3 lanes + manager stitch):
  BOOM MOMENT — the detonation-frame hitch on big houses was the
  synchronous ring-1 carve inside explodeAt (4 full-depth nodes, roof
  nodes fanning to every sibling plane while costing 1): boom frame now
  carves only EXPLOSION_CORE_NODES=2 nearest nodes (instant hole at the
  blast point), the rest ride the 16 ms staggered steps; roof groups
  weigh their plane count against the per-step budget. 52-target /
  20.1k-voxel QA house: boom-carve-sync 7.0→5.4/0.2 ms, worst blast
  frame 16.6→≤15.3 ms, identical voxels removed. removedQueue upload
  budgeting NOT taken (measured trivial; would multiply full-buffer
  uploads on three r185 — WebGPU-path candidate only) · ROOF-EDGE
  WHITES — the roof #residual member was re-tracing rim faces (eave
  fascia, rake caps, ridge caps, soffits) already voxelized inside the
  kept planes' slab volumes, tinted near-white by
  dominantResidualMaterial: fillResidual now drops faces fully inside a
  kept plane's slab band (polygon dilated 0.15 m); gable ends keep ≥1
  deep vertex and stay residual. Host-shell replay: residual 91→39 tris,
  all 52 rim faces excluded. skin-tone hardening: alpha<128 texels are
  holes, backfilled from the nearest opaque texel (no white-margin
  bleed onto eave rows) · GLASS PLATES — routing was already correct
  (panes → world.glass, window voxel target dormant); the cubes were
  shatterPane's 26 spawnDebris cubes. Replaced with a self-contained
  96-cap instanced plate-shard pool (one draw call, 8 mm sliver, 0.06-
  0.22 m faces, oriented in the pane plane, full gravity + tumble +
  one dead bounce, area-scaled 10-34 count, per-pane-face floor probe,
  resetGlass clears it); crack-decal two-stage kept. New perf sections:
  boom-carve-sync/bots/sfx/dust, skin-drain, skin-reprime. 897 tests /
  23.9k assertions green.
- Owner wave-5 follow-up (2026-08-29): INTERIOR FLOOR "white — should be
  wood, dirt when broken". Floor-family slabs (nodeType slab/floor, never
  ceiling) now resolve through a new 'floor' tone kind — wood-family
  fallback #a0784e instead of the screed gray that read white when the
  finish map never resolves — and the dominant-material pick refuses the
  white ceiling underside (top faces, then non-down, then all).
  VoxelTarget.floorCore paints every under-layer (bottom skin + rim
  middles) as dirt subfloor (skin-tone.ts FLOOR_CORE_HEX #6b4a2f), and
  terrain-borne floor slabs mount one dirt underlay plane under the
  sandwich (voxel-walls floorUnderlayLayout, base ≤ 0.35 m) so a
  carved-through hole shows EARTH, not the host's white pad or lawn.
  Verified live on :3002 (wood floor intact, dirt hole carved). 915 tests.

## In flight

- Phase 4 round 2 (fleet): QA-driven refinements — builder/keep/hud/
  game-root/trees under active edit. Manager integrates, tests, deploys
  :3002, pushes per round.
- E2E gap verification (agent): Bones-installed scene (coplanar suspects
  = 0 in game) + host Nature-tree ignite path.
- QA round 2 (2026-08-26): GREEN at `edf3a42` — all round-1 paint fixes
  re-verified live, zero invariant violations. Manager confirmation on
  QA's Gate 2 flag: pyramid grammar (roof 2×2 corner heights, floor 2×2
  quadrant masks) was NOT scoped this round — the binding
  BUILD-GRAMMAR-V2-REVIEW verdict defers it, and it stays phase 6 item 2
  below. No fleet lane owned it; nothing failed to land.
- Pyramid grammar SHIPPED (hand-built, 2026-08-27, after the fleet lane
  stalled 6×): roof pieces carry 2×2 corner heights (roof-corners.ts
  bilinear patch — slope/corner/valley/flat/saddle), F-edit toggles the
  aimed corner (RMB snaps back to slope), Keep maps flat→slab (terrace),
  slope→shed exact, others→shed approximated (counts skipped). Floor
  quadrant masks are SUPERSEDED by the finer 3×3 F-edit that already
  shipped. transformPlaced slotId retention pinned by test as deliberate
  (folded ramps inherit the wall slot's structural role).
- Corner-roof QA (2026-08-27): 5/5 after the shed-parent fix — placement,
  F-corner toggle, flat→slab terrace (node-level), slope→shed now REAL
  (Keep mints one 'roof' container per save; segments under it grow
  shells — saved sheds had been invisible zero-size ghosts since phase
  3). Undo flag → backlog: a saved roof is 2 history steps (container +
  segment); batch Keep's creates into one transaction someday (same
  behavior as wall+pocket saves today).

## Next (phase 6 — the shape-preserving pass)

1. Items keep their SHAPE when breaking (owner call): fine
   silhouette-preserving voxelization + per-cell material colors SHIPPED
   (round 1); still open — glass-like item sub-meshes (shower panels…)
   route through the GLASS shatter system; v2 = convex mesh fracture.
2. Pyramid grammar: roof 2×2 corner heights + floor 2×2 quadrant masks
   (the FULL_MASK ripple round).
3. Paint tool; bots opening doors; real Bones members as the framing when
   Bones is installed (plugin-trees per-instance hide API is already
   shipped as reserve: globalThis.__pascalTreesRuntime).

## Backlog (owner-fed, ordered)

1. Skeleton-collapse verification on real scenes (phase-4 QA item f).
2. Roof/floor 2×2 corner-and-quadrant edits (pyramid grammar) — after v2.
3. Paint tool (slot 7?) — tint a wall's game copy, Keep patches the node.
4. Real Bones members instead of generated studs when Bones is installed.
5. Host Nature trees: full destruction (needs per-instance hide API in
   plugin-trees — cross-repo).
6. Bots: door-opening behavior, navmesh (Yuka) if hordes grow.
7. Third-person camera option; co-op (the far horizon).
8. Settle-drain hardening (night-3 review, REFUTED but cheap): structure.ts
   drainSettleTasks re-fetches a task mid-run without re-checking `due` —
   no current path re-arms inside the drain, but add
   `if (!task || task.due > t) continue` next time the file is open.
9. Wake-ahead v2: key the pre-wake off a PREDICTED landing point during
   flight (tonight's fix gates it to the fuse's final second — at-rest in
   practice; a predictor would buy back ~1 more second of wake budget).

## Standing rules (never violate)

- Non-destructive invariant: the game NEVER writes the scene store;
  everything restores on Esc. Keep is the only bridge.
- WebGPU-safe: CPU math + InstancedMesh + CanvasTexture only.
- No commercial game/movie names anywhere in the repo.
- Fluidity is a feature: caps, budgets, instancing.
- Fleet protocol: disjoint file ownership, contracts in prompts, manager
  integrates+commits+deploys, QA replays live with __boots; builder agents
  that stall twice → hand-build (proven twice tonight).
