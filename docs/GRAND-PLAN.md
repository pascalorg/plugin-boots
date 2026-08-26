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

## In flight

- Phase 4 round 2 (fleet): QA-driven refinements — builder/keep/hud/
  game-root/trees under active edit. Manager integrates, tests, deploys
  :3002, pushes per round.
- E2E gap verification (agent): Bones-installed scene (coplanar suspects
  = 0 in game) + host Nature-tree ignite path.

## Next (phase 5 — builder revamp, starts when phase 4 releases builder.tsx)

Build Grammar v2 integration per the REVIEW's 5-agent plan. Foundations
ALREADY SHIPPED (`grid.ts` + `support.ts`, 33 tests, ad1b970): absolute
world grid (CELL 3 / STOREY 2.8 / REACH 6), slots = wall edges / floor
faces / roof diagonals, player-anchored targeting (yaw-cardinal neighbor +
DDA ray override + ±35° pitch bands), R = wall far-edge flip (beats the
ray) / roof ascent cycle, ring-ordered support collapse. Remaining agents:
ghost-targeting (builder.tsx — the ghost NEVER floats again), support
hooks (collapse via dropTarget), store+keep (slotId on pieces), QA
(ceiling flow, ramp-chaining flow, turbo bridge, collapse cascade — see
"the two flows" section of the spec).

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
