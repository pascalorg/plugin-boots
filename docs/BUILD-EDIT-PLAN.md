# Build-EDIT plan — R rotate polish, edit-mode gaps, mask→transform grammar

Status: SPEC, implementation-ready (researched 2026-08-25 against the
genre-standard battle-royale builder grammar; codebase verified at the same
date — builder.tsx phase 4, 206-test suite green). The builder lane consumes
this directly. Companion doc: BUILD-GRAMMAR-V2.md (grid-locked placement —
separate lane, do not conflate).

Everything below names mechanics generically ("genre-standard"). No branded
names anywhere in this doc or in code comments.

---

## 0. Research digest — the genre-standard interaction grammar

Concrete facts collected from the genre reference (wiki + settings/controls
pages + patch history). Numbers are the canon values.

### Pieces & grid
- Four pieces: **wall / floor / stair-ramp / roof-pyramid**. Absolute
  world grid, tile 5.12 m; wall 5.12 × 0.16 × 3.84 (walls live on cell
  boundaries), floor 5.12 × 5.12 × 0.32, ramp 5.12 × 5.12 × 3.84 (cell
  diagonal), pyramid 5.12 × 5.12 × 1.92.
- Ghost preview is always tinted: **blue** = placeable, **red** = invalid,
  **yellow** = placed-but-obstructed (phases until the obstruction clears,
  then builds).

### Default PC binds (keyboard/mouse)
| Action | Default |
|---|---|
| Place piece / confirm | LMB |
| **Rotate piece** | **R** (contextual: reload when a gun is out, rotate when a build ghost is up) |
| Change material (while building) | RMB |
| **Enter edit** (aim at owned piece) | G (its own bind, "Building Edit") |
| **Select edit tiles** | LMB ("Select Building Edit") — hold + drag crosshair to paint |
| **Reset edit selection** | RMB ("Reset Building Edit") |
| Confirm edit | edit key again, or LMB-release with *Confirm Edit On Release* ON |
| Repair/Upgrade | F |
| Interact | E |

Controller: rotate on right bumper, place on right trigger, edit is
**hold**-to-enter with a tunable **Edit Hold Time** slider (PC entry is a tap
— instant).

### Edit mode, step by step (PC)
1. Aim at a piece you (or your team) own, press the edit key → the piece
   ghosts into a tile-grid overlay **in place** (no menu, camera untouched).
2. Hold LMB and **drag the crosshair across tiles to paint the selection**
   (selected tiles = the material that will be REMOVED). One gesture selects
   many tiles; no per-tile clicking.
3. Confirm: press the edit key again — or, with the **Confirm Edit On
   Release** setting ON, the edit applies the instant LMB is released
   (this is the pro-standard setting; it removes a whole keypress from the
   loop).
4. RMB at any point resets the selection to the piece's current state.
5. Edits are free (no resource cost) and re-editable forever; a piece can be
   restored to intact by confirming an empty selection.
- A **pre-edit** option lets you open the edit grid on the GHOST before
  placement (can be disabled in settings).
- A **simple-edit** assist mode (recent addition) skips tile painting
  entirely: one press executes the edit implied by the part of the piece
  you're aiming at (smaller shape subset, for new players).

### Tile-mask semantics per piece (selected = removed)
- **Wall — 3×3 grid**:
  - center tile → **window**
  - bottom-center tile (center may join it) → **door** (side-column bottom
    tiles → side door at that column)
  - middle-row side tile → off-center **window**
  - top row → 2/3-height wall; top two rows → **low half wall** (the
    crouch-cover edit)
  - full side column → narrower wall
  - staircase-shaped selection (corner + neighbors) → **diagonal/sloped
    wall**
- **Floor — 2×2 quadrants**: quarter, half, and L-shaped floors.
- **Stairs — direction grid**: swipe a direction across the grid to re-face
  the stairs (4 facings); half-width and 90°-turn (L) variants from partial
  selections. This is the genre's "edit a piece into a different piece"
  case: the shape you paint TRANSFORMS the piece, not just carves it.
- **Roof-pyramid — 2×2 corners**: raise/lower each corner; lowered corners
  turn the pyramid into directional ramp/shed variants.

### Rotation & flip
- **R adds 90° per press to the ghost** while a build piece is up. For
  stairs/ramps every press is a distinct facing (4-cycle — "flipping" a ramp
  IS rotating it 180°); for symmetric pieces (walls/floors) rotation is
  mostly a no-op and R is left contextual (reload).
- The rotation offset **persists across placements** and resets when you
  switch piece type.

### Turbo building (hold-to-place cadence)
- First piece **0.15 s** after the button goes down, every subsequent piece
  **0.05 s** as the targeted slot changes (values were tuned up to 0.15 once
  and reverted after community backlash — 0.05 is the canon feel).
- **0.15 s lockout** on a slot where a piece was just destroyed (prevents
  place/break spam wars); contested simultaneous placements resolve by
  random roll, not ping.

### Why editing feels instant (the synthesis that matters)
1. **Client-side prediction** — the edit applies locally the moment it's
   confirmed; the server reconciles after. Zero perceived latency.
2. **Crosshair-drag tile painting** — selection is aim, not clicks.
3. **Confirm folded into release** — one button-down…up gesture = select +
   confirm.
4. **Single-key reset** (RMB) and the edit key doubling as confirm/exit.
5. **The overlay renders on the piece in place** — no modal, no camera
   change, movement stays live while editing.

---

## 1. Where Boots already is (verified in code)

`src/game/builder.tsx` (+ `builder.test.ts`, 206-suite green):

- **4/B** equips builder, **Q** cycles wall → floor → roof
  (`viewmodel.tsx:211`), 1.5 m grid ghost, 90° yaw snap, reach shortens with
  pitch.
- **R rotate is SHIPPED** (phase 4): edge-triggered quarter turn over the
  auto-facing yaw (`rotateTurns` / `rotatedYaw()`), persists until piece
  TYPE changes or edit toggles, steers the snap resolver; roofs cycle 4
  ascent facings (2π symmetry). Tests cover wrap math, symmetry, snap
  steering.
- **Hold-to-place**: stamps on press and on every ghost-pose change while
  held, uniform `PLACE_INTERVAL = 0.18 s`. Occupied poses tint the ghost
  red and are skipped silently.
- **F edit is SHIPPED**: tap F aiming at a placed piece ≤ 6 m
  (`EDIT_RANGE`) → 3×3 overlay, hovered cell highlights via
  `raycastPieceCell` (mask-independent, so dead cells can be resurrected),
  **LMB toggles the cell under the crosshair** (`setPlacedMask`, instant —
  mesh + collider + voxel replica all swap through the piece-object-swap
  contract). F again or aiming off the piece exits. Z-undo pauses while
  editing; R resets and stays edge-warm.
- **Z undo** (G is the grenade everywhere). **E** interact (doors, gun
  table). **RMB** is ADS — but **only for pistol/rifle**
  (`viewmodel.tsx:248`): RMB is FREE while the builder is equipped.
- **R has no reload collision**: the arsenal is explicitly no-reload
  (`weapons.ts:1`); R's only consumer is builder rotate. `Tab` is captured
  in `GAME_KEYS` but consumed by nothing.
- **Keep** (`keep.ts` + pure math in `builder.tsx`): `planWallMask` maps
  511 → wall; `~center` → window pocket; `~bottom-center (± center)` → door
  pocket; fully-dead END COLUMNS trim the node span (`trimmedWallSpan`);
  anything else → best-effort trimmed wall flagged `exact: false`. Roofs →
  shed `roof-segment` node (mask ignored); floors always skipped.
- HUD: weapon line `BUILD · WALL (Q)`, edit-hint line
  `F exit · click toggles cell`, controls pill
  `Esc exit · G grenade · 6 hammer · Z undo` (no R yet).
- **Latent gap**: `viewmodel.tsx:215` feature-detects
  `builderDebug.isEditing` to block Q piece-cycling during edit — but
  builder.tsx never publishes that flag, so Q currently cycles pieces
  mid-edit (harmless but incoherent; the hook is already waiting).

Boots is single-player/local, so the genre's #1 instant-feel ingredient
(client prediction) is free: every mutation is already authoritative and
immediate. Our job is the interaction grammar, not netcode.

---

## 2. Spec (1) — R rotate: shipped; polish deltas

R-rotate exists and matches the researched grammar on every load-bearing
point (quarter turns, persistence until piece switch, roof 4-facings, snap
steering). Ship these deltas:

| # | Delta | File | Detail |
|---|---|---|---|
| R-1 | HUD discoverability | `hud.ts:209` | Controls pill → `Esc exit · G grenade · R rotate · F edit · Z undo` (drop `6 hammer` if the line crowds; the weapon line already teaches Q). |
| R-2 | Rotate tick SFX | `builder.tsx` rotate edge | `sfx.weaponSwitch()` (or a lighter click) on each accepted quarter turn — the genre gives rotation an audible detent. |
| R-3 | Walls: keep the current behavior | — | Genre leaves wall-R contextual/no-op; Boots does one better: a wall press turns the ghost perpendicular (deliberate corner grammar, tested at `builder.test.ts:261`). This IS our "next best per the grammar" — document, don't change. |
| R-4 | Floors: no-op by symmetry | — | π/2 symmetry makes every quarter turn identical; correct as-is. Do NOT add fake behavior. |

No store or input changes. R stays inert during edit mode (edge kept warm —
already coded).

---

## 3. Spec (2) — F edit: gap assessment vs the researched flow

| Grammar element | Genre | Boots today | Verdict |
|---|---|---|---|
| Enter | tap edit key aiming at owned piece (instant on PC) | tap F, ≤ 6 m, nearest hit | ✅ matches |
| Overlay in place, movement live | yes | yes (3×3 ghost grid, player moves freely) | ✅ |
| Tile selection | hold-LMB **drag-paint** across tiles | click toggles ONE cell per click | ❌ gap → **LATER** (phase cut §6) |
| Confirm | edit key again, or **release-to-confirm** setting | none — every click applies instantly | ✅ *deliberately better for Boots*: with no server round-trip and free re-edits, instant-apply IS release-to-confirm with a zero-length stage. Keep it. Revisit only if drag-paint (later) makes strokes feel dangerous — then stage the stroke and commit on LMB-release (that's exactly the genre's confirm-on-release). |
| **Reset edit** | RMB restores the selection | **missing** — restoring a carved piece means re-clicking every dead cell | ❌ gap → **THIS ROUND**: RMB while editing → `setPlacedMask(id, FULL_MASK)`. RMB is free in builder (ADS is pistol/rifle-only). One key, piece intact, matches genre exactly. |
| Exit | edit key / walk away cancels | F again, aim-off, or piece destroyed | ✅ matches |
| Q while editing | piece keys don't leak into edit | Q still cycles (missing `isEditing` flag) | ❌ gap → **THIS ROUND**: publish `builderDebug.isEditing` (boolean, written in the same useFrame branch that owns `edit`); `viewmodel.tsx` already feature-detects it — zero changes there. |
| Pre-edit (edit the ghost pre-placement) | optional setting | absent | LATER (nice-to-have; needs a mask on the ghost + `addPlaced({mask})`, which the store already accepts). |
| Edit-hint copy | n/a | `F exit · click toggles cell` | update → `F done · LMB carve · RMB reset` |

Implementation notes (this round):
- RMB in edit mode: read `session.input.state.altFiring` edge inside the
  `if (edit)` branch; on edge, `setPlacedMask(piece.id, FULL_MASK)` +
  `sfx.place()`; keep an `prevAltFire` ref warm in the inactive/non-edit
  paths like `prevFire`/`prevRotate`.
- `builderDebug.isEditing`: add to the exported `builderDebug` object
  (default `false`); set `true/false` alongside `setEdit` calls (or once
  per frame from `edit !== null`). Add a test asserting the flag flips.

---

## 4. Spec (3) — edit-to-TRANSFORM: mask patterns → piece transforms

The genre's stairs edit proves the pattern: a painted shape doesn't just
carve, it can REBUILD the piece as a different piece. Boots adopts this for
walls with **exit-time classification**: when edit mode closes (F, aim-off),
classify the final mask; exact-match patterns transform, everything else
stays a free-form carved mask. Exit-time = the genre's confirm, without
adding a staging buffer; mid-edit intermediate states can pass through a
transform pattern harmlessly.

Bit convention (unchanged, `store.ts`): bit = col + row·3, col 0 at local
−X, wall row 0 = bottom. `FULL_MASK = 511`.

### 4a. Mask constants (walls)

| Name | Alive cells | Mask value | Meaning |
|---|---|---|---|
| `HALF_WALL` | bottom row only | `0b000000111` = **7** | low cover wall (genre: remove top 2 rows) |
| `TWO_THIRD_WALL` | bottom two rows | `0b000111111` = **63** | 2/3 wall (genre: remove top row) |
| `STAIR_UP` | col heights 1,2,3 (bits 0,1,2,4,5,8) | `0b100110111` = **311** | staircase silhouette ascending toward local +X |
| `STAIR_DOWN` | col heights 3,2,1 (bits 0,1,2,3,4,6) | `0b001011111` = **95** | staircase silhouette ascending toward local −X |
| window @ col c | all but cell (c,1) | `511 & ~(1<<(c+3))` | off-center window (c ∈ {0,2}; c=1 already shipped) |
| door @ col c | all but cell (c,0) [± (c,1)] | `511 & ~(1<<c)` [`& ~(1<<(c+3))`] | side door pocket (c ∈ {0,2}; c=1 shipped) |

### 4b. Transforms (exit-time, exact match only)

**Wall `311` / `95` → RAMP (piece type `'roof'`).** The wall rebuilds as a
roof piece rising `WALL_H` along the wall's own run — the genre's
"diagonal mask = slope" made literal with our inclined piece.

- Yaw math (derivation: roof ascends along its local +Z; wall columns run
  along its local +X):
  - `311` (tall end at +X): `roofYaw = wrap(wallYaw + π/2)`
  - `95` (tall end at −X): `roofYaw = wrap(wallYaw − π/2)`
  (use the existing `rotatedYaw(wallYaw, ±1)` for the wrap.)
- Position: unchanged `[x, y, z]` (same base elevation; `piecePose('roof')`
  centers the plank at `y + WALL_H/2` with `ROOF_TILT`). Footprint widens
  from the 0.12 m wall plane to the 3 × 4.1 plank straddling the old wall
  line ±1.5 m plan run — acceptable; it reads as "the wall folded down into
  a ramp".
- Guard: refuse (red overlay flash + no sfx) if
  `isOccupied(placedMinusSelf, 'roof', x, y, z, roofYaw)`.
- Store: new action `transformPlaced(id, piece, yaw)` — swaps the piece
  object with `mask: FULL_MASK`, **same id**. The piece-object-swap contract
  (builder.tsx `PlacedPieceMesh` layout effect) already re-registers mesh,
  collider BVH, and voxel replica; Z-undo ordering is unaffected (id and
  list position preserved).
- Keep semantics: the transformed piece is a NATIVE roof piece → existing
  `createRoofNode` path (shed roof-segment, pitch atan(2.8/3)). No keep.ts
  changes needed for ramps.

**Explicitly NOT transforms** (they stay masks, because Keep already speaks
them): center window (511&~16), door pockets, end-column trims. Floors and
roofs get **no transforms this round** — floor's genre analog (2×2
quadrants) is already expressible as free-form 3×3 carving, and roof masks
are documented as game-only.

### 4c. Keep-plan extensions (mask-level, no transform needed)

Extend `planWallMask` (builder.tsx) + `keep.ts`, preserving current
semantics as the fallback:

1. **Half walls — dead TOP rows trim node height.** New plan fields
   `trimTopRows: number` (0–2, fully-dead rows counted from row 2 down).
   `keep.ts` passes `height: (3 − trimTopRows) · cellH` (cellH = 0.93̄).
   Masks 7 and 63 become `exact: true` walls at 0.93 m / 1.87 m. Dead
   BOTTOM rows with live rows above = floating wall → stays `exact: false`
   full-height best-effort (a wall node can't float).
2. **Off-center pockets.** Recognize window/door at ANY column (table 4a):
   plan gains `pocketCol: 0 | 1 | 2`. `keep.ts createPocketNode` replaces
   the hardcoded center `position[0] = 1.5` with
   `(pocketCol + 0.5) · cellW`, still in wall-local (untrimmed) frame.
   Column pockets combine with END-column trims only when the pocket column
   survives the trim; otherwise fall back to inexact.
3. **Precedence** (first match wins): full → window@col → door@col →
   height-trim (7/63) → span-trim (dead end columns) → best-effort inexact
   → skip (0). Order matters: 7 and 63 must be checked before the span-trim
   walk, and pocket patterns require the full ring minus exactly the pocket
   bits.

Tests to add (`builder.test.ts`): constants 7/63/311/95 classify; window
and door at cols 0/2 are `exact`; 311→roof yaw math both directions; trim
precedence (mask 7 is a height-trim, not inexact); transform occupancy
guard.

---

## 5. Spec (4) — full keybinding table after the change

Verified collision-free against `input.ts` GAME_KEYS and every consumer
(`viewmodel.tsx`, `doors.tsx`, `guntable.tsx`, `builder.tsx`, `grenade.tsx`).
R has no reload to collide with (no-reload arsenal); RMB is unused by the
builder weapon; Tab is captured but unconsumed (reserved).

### Global (any weapon)
| Key | Action |
|---|---|
| W A S D / Space / Shift | move / jump / sprint |
| E | interact (doors, gun table) |
| 1 / 2 / 3 / 5 / 6 | knife / pistol / rifle / minigun / hammer |
| 4 or B | equip builder |
| G | grenade (everywhere — group contract) |
| Wheel | cycle weapons |
| LMB | fire / place |
| RMB | ADS (pistol/rifle only) |
| Esc | exit game |

### Builder equipped, ghost active
| Key | Action |
|---|---|
| Q | cycle piece wall → floor → roof (blocked while editing — NEW gate) |
| **R** | rotate ghost +90° (walls: perpendicular/corner toggle; floors: no-op by symmetry; roofs: 4 ascent facings). Persists until piece switch or edit toggle. |
| LMB (hold) | place / turbo-sweep (first 0.15 s, then 0.05 s per pose change — NEW cadence, §6) |
| F | enter edit on aimed placed piece (≤ 6 m) |
| Z | undo last placement |

### Edit mode (F, on a placed piece)
| Key | Action |
|---|---|
| crosshair | selects the cell (hover highlight) |
| LMB | toggle cell (THIS round) → drag-paint stroke (LATER) |
| **RMB** | **reset mask to intact (511) — NEW** |
| F | done / exit (also: aiming off the piece, or piece destroyed) |
| Q / R / Z | inert (edge-trackers kept warm; Q gate is NEW) |
| exit-time | mask classified → exact 311/95 transforms wall→ramp (NEW) |

HUD copy: controls pill `Esc exit · G grenade · R rotate · F edit · Z undo`;
edit hint `F done · LMB carve · RMB reset`.

---

## 6. Spec (5) — phased cut

### THIS ROUND (R-rotate polish + edit polish; small, independent, testable)
1. **`builderDebug.isEditing` flag** (builder.tsx) — activates the
   already-shipped Q gate in viewmodel.tsx. ~5 lines + test.
2. **RMB reset-edit** (builder.tsx edit branch) — `altFiring` edge →
   `setPlacedMask(id, FULL_MASK)`, warm trackers, sfx. ~15 lines + test.
3. **HUD copy** (hud.ts pill + editHint string in builder.tsx). ~3 lines.
4. **Rotate detent sfx** (builder.tsx rotate edge). ~2 lines.
5. **Turbo cadence to genre values** (builder.tsx): split `PLACE_INTERVAL`
   into `TURBO_FIRST = 0.15` (fresh press) and `TURBO_NEXT = 0.05`
   (pose-change re-stamp while held). Feel-critical, trivial diff.
6. **Keep-plan extensions** (§4c): half-wall height trim + off-center
   pockets — pure functions in builder.tsx + small keep.ts change; fully
   headless-testable.
7. **Wall→ramp transform** (§4b): `transformPlaced` store action +
   exit-time classifier for 311/95 + occupancy guard + tests. The largest
   item; still bounded (~80 lines total) because the piece-object-swap
   contract does all the heavy lifting.

Ship order 1→5 first (pure polish, zero risk), then 6, then 7.

### LATER (next fleet round)
- **Drag-paint tile selection**: on LMB-down in edit mode, capture
  `paintValue = !alive(hitBit)` and apply to the pressed cell; while held,
  every NEW bit the crosshair enters is SET to `paintValue` (assign, never
  toggle — re-crossing a cell must not flicker). Stroke ends on release.
  If strokes feel destructive, stage the stroke mask and commit on release
  — that is the genre's confirm-on-release, and the store API
  (`setPlacedMask` once at release) already supports it.
- **Destroyed-slot lockout** (0.15 s before re-placing where a piece just
  died) — needs a destruction-event hook; pairs with enemy wall-attack
  work.
- **Pre-edit on the ghost** (mask the ghost before placement;
  `addPlaced({ mask })` already accepts it).
- **Yellow obstructed ghost state** (place-when-cleared) — BUILD-GRAMMAR-V2
  already lists it as deferred; keep it there.
- **Floor/roof transforms** (floor quadrant grammar, roof corner heights) —
  revisit after BUILD-GRAMMAR-V2's grid-locked slots land, since those
  masks change shape there.
- **Simple-edit assist** (one-press contextual edit: aim at wall bottom →
  door, middle → window) — cheap once classifiers exist; good
  gamepad/new-player story.

### Non-goals (decided, don't revisit silently)
- Press-to-confirm staging for single-cell clicks (instant-apply is the
  Boots signature; Keep-side re-edit is free).
- R behavior changes for walls/floors beyond the shipped grammar.
- Any netcode-motivated buffering — Boots is local-authoritative.
