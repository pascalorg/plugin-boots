# Conforming Shell Fragments (S0) — surface partition over the voxel grid

The wall's REAL surface — the host mesh's own triangles, original UVs and
material instances — partitioned into small "conforming shell fragments"
that carve away with the voxel grid. The grid stays the single source of
truth for damage, collision, raycasts, structure and saves; the shell is a
pure VIEW over it. S0 scope: HOST WALLS ONLY, behind a flag that defaults
OFF. Placed pieces keep their brick look; glass stays on the shatter lane
(`isGlassLikeMesh`); save/keep/structure/raycasts are untouched.

## Architecture (four modules + wiring)

- `shell.ts` (pure, milestone 1): Sutherland–Hodgman clip of the host
  triangles against the grid's lattice planes in the SHELL frame, so every
  output triangle sits inside one cell; centroid nudged 1 mm along the
  inverse face normal assigns skin faces deterministically; greedy seeded
  region growth clusters surface cells into fragments of 1–6 cells
  (weighted mode 3, mulberry32 seeded by an FNV-1a hash of the nodeId);
  packing is material-major with per-fragment contiguous index blocks and
  a MANDATORY Uint32 index (the GPU backend promotes Uint16 and replaces
  the array — in-place range edits would silently detach). `SHELL_TRI_CAP`
  (12k clipped tris) or a clipper throw ⇒ `null` ⇒ per-target fallback to
  today's voxel-only path. Never crashes the voxelizer.
- `shell-render.tsx` (milestone 2): one multi-group mesh per shell; a
  fragment dies by overwriting its index block with one repeated vertex
  (degenerate triangles, zero area) + `addUpdateRange` partial upload. No
  draw-call or group changes ever. Host materials ride BY REFERENCE —
  never cloned, mutated or disposed. A fully-carved shell hides itself.
- `shell-debris.tsx` (milestone 3): a bounded pool (20 slots) of tumbling
  meshes that re-index the shared shell vertex arrays with a dead
  fragment's own index block — the chip that flies off is pixel-identical
  to the piece that just went degenerate. debris.tsx ballistics (gravity
  14, one damped bounce, shrink-out); ≤ 8 nearest dead fragments per
  carve; overflow reads through the regular voxel debris + dust.
- `destruction.ts` (milestone 4a, surgical): behind the flag, the WALL
  path of `ensureVoxelTarget` collects host triangles (glass-like meshes
  skipped, host materials deduped by reference), transforms them into the
  shell frame and attaches `target.shell` + `target.shellMaterials`.
- `voxel-walls.tsx` core mode (milestone 4a): a shelled target's skin
  voxels become the CORE — primed with `coreCellColor` (darkened
  structural read; wall cores pull toward the gypsum-gray family) and
  inset 20 % of the thickness-axis cell on BOTH sides so the core sits
  strictly inside the shell (no coplanar fighting). Framing sticks and
  boards are unchanged. Zero effect without `target.shell`.
- `shell-layer.tsx` + `game-root.tsx` (milestone 4b): mounting, carve
  fan-out, debris spawning, census (below).

## Frames (the one decision everything follows)

`buildVoxelGrid` grids index cells in a GRID frame (world rotated by the
basis `grid.q`; `origin` = min corner). The SHELL frame is the grid frame
with the origin moved to zero — `shell.ts` floors positions by the cell
size directly:

```
p_shell = rotateByBasis(grid.q, p_world) − grid.origin
p_world = q⁻¹ ⊗ (p_shell + grid.origin)
```

- The SHELL MESH renders shell-frame geometry inside a group transformed
  by `gridFrameToWorld(grid)` (voxel.ts, pure, tested): quaternion = the
  basis conjugate, position = the origin rotated out to world. Plain
  walls (identity basis) reduce to a translation by `origin`.
- DEBRIS is WORLD-frame: the pool is a module singleton (one slots array
  per session) and cannot be parented per target, so `ShellDebrisLayer`
  mounts ONCE at identity and every spawn passes world-frame data —
  vertex copies from `worldShellArrays` (built lazily on a target's first
  carve, cached for the session, uvs shared), a world carve point (mean
  of the carve's dead voxel centers — `grid.centers` ARE world-space),
  and a world floor from `probeLandingY`. Chips spawn exactly on the wall
  surface and fall along world −Y whatever the wall's yaw.

## Lifecycle (hybrid: host until first damage)

Flagged walls voxelize at prevoxelize like everything else but register
DORMANT — the host keeps rendering AND colliding (the existing dormant
machinery; core replicas pre-mount hidden and prime through the budgeted
queue). The FIRST DAMAGE wakes the target (`damageTarget` → `wakeTarget`):
`hideHostNode` retires the host and hands the colliders over while the
shell + core flip visible off the same `dormant` drop — an invisible swap,
because the shell IS the original surface (original triangles, original
UVs, host material instances). Esc restores the host through the session
ledger as always; only shell-owned geometry is disposed.

## Carve fan-out and drain ownership

`voxel-walls.tsx` owns `target.removedQueue` (drains AND clears it). The
shell lane never reads it: each `ShellTargetLayer` detects carves with a
revision-gated diff of `grid.alive` against its own seen-copy
(`diffNewlyDead` — all-ones at mount, so first-hit carves that land before
the React commit still surface), which is immune to frame-order races by
construction. Newly dead voxels map to LATTICE keys (`fragmentForCell` is
lattice-indexed — `grid.count` counts occupied voxels only, so the shell
is built over the full `nx·ny·nz` lattice) and expand along the thickness
axis into the voxel-less cavity cells of the same column
(`deadLatticeKeys`): edge-face fragments (wall tops, opening reveals) live
on cells `dropInteriorCells` never kept as voxels and would otherwise
float forever — they detach with the first skin carve of their column. A
full demolition (`aliveCount === 0`) also hides the whole group as a
backstop. The keys feed both consumers: a wrapper-owned `ShellLive` queue
for `<ShellMesh/>` and the wrapper's own `drainShellRemovals` bookkeeping
for the debris picks. The wrapper's frame callback runs at priority −1 so
shell death + chip spawn land in the same frame as the core removal
(negative priorities keep auto-render); correctness never depends on the
ordering — a mis-ordered frame delivers one frame late.

## Loading

No new stage weight: shell builds run inside `ensureVoxelTarget` on the
same 4 ms prevoxelize budget, so the veil's wall fraction (walls with
targets / total walls) already carries their cost (~25–50 ms house-wide,
flag ON only, amortized over a few extra prevoxelize frames). A separate
weight would double-count work the wall counter is measuring.

## Flag + census

- `shellFlags.wall` (default OFF) — SESSION-LATCHED: read once at the
  session's first wall voxelize; `setShellFlag('wall', v)` (QA:
  `__boots.setShell('wall', v)`) takes effect on the NEXT Jump in.
  `resetDestruction` re-arms the latch.
- `__boots.shell()` → `{ enabled, targets, fragments, killed }` — killed
  prefers the live wrappers' flags (they include the voxel-less edge
  fragments); headless falls back to the voxel-backed rule.

## Tests (headless, 964 on this branch)

shell.ts: clip area conservation, centroid containment, UV/normal
interpolation exactness, seeded determinism, cluster histogram,
fragmentForCell coverage, material-major contiguity. shell-render:
degenerate-overwrite isolation, removal replay, alive counts. shell-debris:
pool policy, ballistics, index slices, material lookup. Wiring: flag
latch, dormant registration + first-damage wake, glass skip, host
materials by reference, gridFrameToWorld round-trips (identity / yaw /
full basis), cavity-ward expansion (no floating edge strips), world-frame
debris data, and the integration pins — fragmentForCell covers every
alive cell, flag OFF is shell-free, and save-demolition + target censuses
are identical flag on/off after identical damage.

## Headed QA (post-merge)

1. `__boots.setShell('wall', true)` → re-enter the session (the latch).
2. Swap check: shoot a wall once — the surface must not visibly change
   at the wake (SSIM diff of the frames around the first hit; the shell
   is the host surface, so the swap should be invisible). Assert
   `__boots.countCoplanarSuspects() === 0` after the swap on a batched
   level.
3. Fragment detach: screenshot a carve — real textured chips (not cubes)
   tumbling from the hole, hole edges showing the darkened core inset
   strictly behind the surface.
4. Perf: `__boots.perfSections()` — watch the prevoxelize budget and the
   carve path; boom worst-frame within +2 ms of the flag-OFF baseline.
5. Esc: byte-identical editor restore (session ledger untouched by the
   shell lane).

## S1 candidates

Backing slivers for fragment backfaces, paint decal persistence on
shells, shell-from-start mode, roof/slab shells.
