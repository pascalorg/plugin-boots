# Build grammar v2 — grid-locked placement

Status: SPEC (researched + agent-reviewed; implementation next fleet phase).
Fixes the owner's core complaint: the ghost floats freely in front of the
camera. In v2 the ghost only ever occupies discrete grid slots — it snaps,
never floats.

## Mechanics reference (sourced from the genre's canon)

- Building happens on an **absolute, world-aligned grid** (canonical tile
  5.12 m × 5.12 m × 3.84 m; walls live on cell BOUNDARIES, floors on cell
  faces, ramps on cell diagonals, pyramids on cell tops).
- Targeting is **look-driven near the player** (~1 cell reach), not a long
  free ray; aiming up builds the storey above; camera pitch picks the
  vertical slot (upper half of screen → stairs/up, lower → floor/down).
- **No floating pieces**: a piece must connect to terrain or an existing
  piece by at least one point; destroying support collapses everything no
  longer connected, in quick cascade.
- Ghost is ALWAYS snapped and tinted: blue = placeable, red = invalid
  (no support / occupied / out of reach), yellow (optional) = valid but
  temporarily obstructed, builds when cleared.
- **R rotates** the selected piece 90° (meaningful for stairs/roofs; state
  persists across placements; resets on piece-type switch).
- **Turbo building**: hold-to-place — first piece after 0.15 s, then one
  piece each time the target slot changes (min 0.05 s); one attempt per
  slot per hold; 0.15 s lockout on slots where a piece just died.
- **Edit grammar**: wall 3×3 (deselected tiles are removed: bottom-center →
  door, center → window, top rows → half wall, corner → slope), floor 2×2
  quadrants, roof 2×2 corner heights (ramp/shed/pyramid).

## Adaptation (our pieces: wall 3×2.8, floor 3×3, roof 3 m run rising 2.8)

**Grid.** `i = floor(x/3)`, `k = floor(z/3)`, storey `s = floor(y/2.8)`.
Grid is world-anchored — never derived from the camera.

**Slots.**
- Wall → cell edge: `Wx[i][k][s]` (plane x=3i) or `Wz[i][k][s]` (plane z=3k).
- Floor → cell face: `F[i][k][s]` at y = 2.8·s.
- Roof/ramp → cell diagonal: `R[i][k][s]` + yaw ∈ {0, 90, 180, 270}, low
  edge at 2.8·s rising to 2.8·(s+1) over the 3 m run.

**Target selection (each frame):**
1. Player cell `P`; ground-forward cardinal `d` from camera yaw.
2. Ray override: DDA the camera ray ≤ 6 m through grid planes; the first
   valid slot boundary it crosses wins (wall = first vertical plane, floor
   = first horizontal plane, roof = first cell entered).
3. Default: neighbor cell `N = P + d`. Wall → the P/N shared edge; floor →
   `F[N]` (pitch < −35° → `F[P]` under your feet); roof → `R[N]` ascending
   away from P.
4. Pitch bands: > +35° → same slot at s+1; < −35° → s−1.

**R semantics.** Wall: flips to the far edge of N. Floor: no-op. Roof: yaw
+= 90° per press (persists; double-press reads as descending). Reset on
piece-type switch.

**Validity (ghost tint).** Blue iff: slot empty ∧ reach ≤ 6 m ∧ supported
(terrain contact at s=0, or ≥1 shared edge/vertex with an existing piece or
scene geometry) ∧ not intersecting the player. Red otherwise.

**Support cascade.** On any piece delete/destruction: BFS from grounded
pieces over the contact graph; disconnected components collapse staggered
(~50 ms per ring) into debris.

**Turbo sweep.** Hold: place current slot if valid; re-place whenever the
target slot id changes (0.15 s first, ≥0.05 s after, dedupe per slot per
hold, 0.15 s deleted-slot lockout). Strafing while sweeping bridges walls
and floors continuously.

**Edit masks.** Wall keeps the 9-bit 3×3 mask (KEEP the repo's existing bit
convention — verify against builder.tsx/keep.ts before implementing; the
mask→node mapping in keep.ts is the source of truth). Add 4-bit 2×2 floor
masks (quarter/half/L) and 4 corner-height nibbles for roofs.

## The two flows players actually feel (spell them out in QA)

**Ceilings are floors, one storey up.** There is no ceiling piece. Select
the FLOOR piece and look up: past the +35° pitch band the target slot
becomes the top face of your own cell (y = 2.8·(s+1)). Click — a ceiling.
Look down past −35°: the floor lands under your feet. The grid decides,
never the free ray. Support rule applies: a ceiling must touch a wall or
existing piece, or it reads red.

**Slopes chain as you climb them.** The ROOF piece fills the cell you face,
rising 2.8 m over its 3 m run, ascent starting from YOUR side. R turns the
ascent 90° per press (180° = a descent), and the chosen orientation
persists until you switch piece type. The signature move: hold place and
RUN UP your own ramps — every cell you enter lays the next ramp one storey
higher (turbo: first piece 0.15 s, then one per new slot, ≥0.05 s apart).
Later: pyramid-style 2×2 corner edits (ramp/shed/flat/pyramid) on the roof
piece — deferred with the floor 2×2 masks.

## Open decisions for the implementing fleet
- Reach: 6 m (~2 cells) chosen to match the genre's ~1-tile feel.
- Whether scene walls count as "support" for s>0 placements (recommended:
  yes — building off the existing house is the whole point).
- Ghost yellow/obstructed state: defer unless cheap.
