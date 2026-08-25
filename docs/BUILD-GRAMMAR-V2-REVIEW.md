# Build grammar v2 — design-review verdict (2026-08-25)

Agent review of `BUILD-GRAMMAR-V2.md` against the live code. This document
is the implementation contract for the builder-revamp fleet round — specs
in the plan below OVERRIDE the raw spec where they disagree.

## Conflicts settled (code-informed decisions)

- **Grid constants**: v2 cells are 3 m / storey 2.8 m — replaces `GRID = 1.5`
  and `LEVEL_STEP = 1.4`. Legacy pieces at half-cells stay render-only
  (off-graph), no migration.
- **Reach**: 6 m everywhere (matches `EDIT_RANGE`), replaces `REACH = 3.2`.
- **R semantics**: wall R = edge FLIP to the far edge of the target cell
  (not an in-place quarter-turn); floor R = no-op; roof R = yaw quarter-turn
  cycle, persists across placements, resets on piece-type switch only.
- **Turbo**: 0.15 s first placement, ≥0.05 s repeats, one attempt per slot
  per hold (dedupe Set), 0.15 s lockout on slots where a piece just died.
- **Mask bit order (code is truth)**: `bit = col + row·3`, wall row 0 =
  BOTTOM, col 0 at the wall START (local −X); floor/roof row 0 = local −Z =
  roof LOW edge. CENTER_BIT = 4, BOTTOM_CENTER_BIT = 1. Any genre reference
  using row-0-top must be flipped.
- **Adjacency snap is REPLACED**: absolute slots subsume `resolveSnap`'s
  chain/stack/cap candidates. The rawGhost + resolveSnap pipeline and its
  tests retire with v2 — two placement authorities would fight.
- **Floor 2×2 masks: deferred** — keep 3×3 masks everywhere this round
  (FULL_MASK=511 ripples through ≥5 sites incl. Keep).
- **Ghost tints**: blue placeable / red invalid (occupied OR unsupported OR
  out of reach — today red means occupied only). Yellow deferred.

## Risks → mitigations (bake into specs)

- **Instant-voxelize × turbo** (up to 20 placements/s): route placement
  voxelization through a budgeted queue (reuse the `prevoxelizeTick`
  pattern); the plain fallback mesh renders until its turn.
- **Support graph**: no piece contact graph exists; build it on slot ids
  (O(1) adjacency), grounded-BFS on removal, staggered ~50 ms ring collapse
  routed through the SAME cleanup as undo (`dropTarget` + collider splice)
  so carved voxels never float.
- **Scene walls as support: yes** — but the probe must skip `disabled`
  colliders and query voxel-target liveness, so a demolished wall drops its
  dependents.

## Fleet plan (5 agents, sequenced)

1. **grid-core** (first, pure): NEW `src/game/grid.ts` — slot types
   Wx/Wz/F/R + storey, slotId codec, slot→world pose (piecePose-compatible),
   DDA ray→slot, neighbor + pitch-band selection, occupancy map, adjacency.
   Constants CELL=3, STOREY=2.8, REACH=6. `grid.test.ts`.
   CONTRACT: `resolveTargetSlot(rig, piece, rotState) → { slotId, pose,
   valid, reason }` + `slotsTouching(slotId)`.
2. **ghost-targeting** (`builder.tsx` only): replace rawGhost/resolveSnap/
   aimHeightAt with grid-core; 3-tint ghost; R per settled semantics; turbo
   rewrite per settled numbers; retire stale snap tests.
3. **support-graph**: NEW `src/game/support.ts` + hooks in builder/
   destruction: grounded-BFS over occupancy, staggered collapse → debris +
   dropTarget; scene-support probe w/ voxel liveness.
   CONTRACT: `onPieceRemoved(slotId)`, `isSupported(slotId)`.
4. **store+keep**: PlacedPiece gains `slotId`; keep.ts parity (floors →
   slab-node attempt or explicit skip counting; roofs unchanged).
5. **QA**: slot snapping never floats (ghost pose ∈ discrete set), turbo
   bridge sweep, collapse cascade, Keep round-trip, 20-placement burst perf
   trace (voxelize queue must not hitch).

Sequencing: 1 first; 2–4 parallel against its contract; 5 last.
