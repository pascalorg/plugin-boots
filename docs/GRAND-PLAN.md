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

## Standing rules (never violate)

- Non-destructive invariant: the game NEVER writes the scene store;
  everything restores on Esc. Keep is the only bridge.
- WebGPU-safe: CPU math + InstancedMesh + CanvasTexture only.
- No commercial game/movie names anywhere in the repo.
- Fluidity is a feature: caps, budgets, instancing.
- Fleet protocol: disjoint file ownership, contracts in prompts, manager
  integrates+commits+deploys, QA replays live with __boots; builder agents
  that stall twice → hand-build (proven twice tonight).
