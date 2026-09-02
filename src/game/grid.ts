/**
 * Build Grammar v2 — pure slot math (no React, no three).
 *
 * The world carries an ABSOLUTE, world-aligned build grid (cells CELL m on
 * a side, storeys STOREY m tall). Pieces never float: they occupy discrete
 * SLOTS —
 *   walls  → cell EDGES:      Wx:i,k,s = plane x=CELL·i spanning z∈[3k,3k+3]
 *                             Wz:i,k,s = plane z=CELL·k spanning x∈[3i,3i+3]
 *   floors → cell FACES:      F:i,k,s  = the y=STOREY·s face of cell (i,k)
 *   stairs/roofs → cell TOPS: R:i,k,s  = the cell volume, yaw picks ascent
 *                             (one R slot holds stairs OR a roof, never both)
 * A slot's POSE feeds builder.tsx unchanged: `position` is [x, baseY, z]
 * (baseY = STOREY·s; builder's piecePose derives the center height), `yaw`
 * rotates about Y exactly like PlacedPiece.yaw. Wall poses sit at the edge
 * midpoint; canonical wall yaw is 0 for Wz (length along X) and π/2 for Wx
 * (length along Z). R-slot yaw = quarter·π/2; the quarter's HIGH side lands
 * along: 0 → +Z, 1 → +X, 2 → −Z, 3 → −X (slotPose yaw carries local +Z,
 * the plank's high edge / a roof preset's high side, onto (sin, cos)).
 *
 * Targeting (resolveTargetSlot) is player-anchored with a ray override:
 * default target = the neighbor of the player's cell along the yaw
 * cardinal; a DDA march of the camera ray (≤ REACH) across grid planes
 * overrides it with the first slot boundary crossed; pitch beyond ±PITCH_BAND
 * retargets one storey up/down. For stairs/roofs the march is WORLD-AWARE
 * (resolveRayRSlot): it walks successive cell entries and takes the first
 * PLACEABLE one, and the pitch-band intent corrects each crossing's storey —
 * the raw crossing height is erratic at mid pitches (p4 ramp QA). Occupancy
 * and support are injected so this module stays pure (grid knows geometry,
 * the game knows state).
 *
 * GRID ANCHOR: a session may install a rigid XZ frame (setGridAnchor) that
 * aligns this lattice to the building's dominant walls — see the anchor
 * section below. All slot math above stays integer and unchanged; only the
 * resolveTargetSlot inputs (world→grid) and slotPose outputs (grid→world)
 * transform, and the default identity anchor keeps both seams no-ops.
 *
 * STOREY LADDER: real buildings use the host default 2.5 m per level (and
 * can vary per level), not this module's uniform 2.8 m STOREY — so a
 * session may also install a LADDER (setStoreyLadder): ascending boundary
 * elevations storeyY[] where storey s spans [storeyY[s], storeyY[s+1]).
 * Slot indices stay integers; only the Y seams change — storeyBase /
 * storeySpan / storeyOfY and the floor-piece y-plane march read the ladder.
 * The ladder composes with the anchor cleanly: the anchor transforms
 * XZ+yaw ONLY and the ladder transforms Y ONLY. No ladder set → pure
 * STOREY multiples, bit-exact legacy behavior.
 */

export const CELL = 3
export const STOREY = 2.8
export const REACH = 6
/** Camera pitch (radians) beyond which the target moves a storey up/down. */
export const PITCH_BAND = (35 * Math.PI) / 180
/** Eye height used to launch the targeting ray from the feet position. */
const EYE = 1.58
/** DDA starts slightly ahead so the player's own boundary never self-hits. */
const RAY_START = 0.4

export type SlotKind = 'Wx' | 'Wz' | 'F' | 'R'
export type Slot = { kind: SlotKind; i: number; k: number; s: number }
export type BuildPieceKind = 'wall' | 'floor' | 'stairs' | 'roof'

// ── GRID ANCHOR (session rigid frame) ───────────────────────────────────────
// Real buildings are rotated arbitrarily and sit off the 3 m lattice, so an
// absolute world grid can never run flush with their walls. Once per session
// the game may ANCHOR the grid to the building's dominant frame (derived in
// world.ts): a rigid XZ transform { x, z, yaw } — the lattice's origin moves
// to the anchor point and its axes rotate by yaw. Slot math stays 100%
// integer; only two seams transform: world→grid on the way IN
// (resolveTargetSlot's player pose — and with it the DDA ray, which is
// derived from that pose) and grid→world on the way OUT (slotPose). The
// identity anchor short-circuits both seams to bit-exact no-ops, so existing
// tests, QA scripts and saves are unaffected. Y is NEVER transformed —
// storeys and terrain grounding stay pure.

export type GridAnchor = { x: number; z: number; yaw: number }

const TWO_PI = Math.PI * 2

/** Live anchor — mutated in place (setGridAnchor copies) so the per-frame
 * seams read plain fields with no lookups. */
const _anchor: GridAnchor = { x: 0, z: 0, yaw: 0 }
/** True while the anchor is EXACTLY identity — both seams short-circuit. */
let _identity = true

/** Install the session anchor (copied — the caller keeps its object).
 * world.ts derives it; builder.tsx wires it alongside the support probe. */
export function setGridAnchor(anchor: GridAnchor): void {
  _anchor.x = anchor.x
  _anchor.z = anchor.z
  _anchor.yaw = anchor.yaw
  _identity = anchor.x === 0 && anchor.z === 0 && anchor.yaw === 0
}

/** The live anchor — a read-only view of module state, never mutate it
 * (allocation-free so hot paths like the builder's slot box can read it). */
export function getGridAnchor(): Readonly<GridAnchor> {
  return _anchor
}

/** Back to identity — session teardown (lives next to resetPieceSlots). */
export function resetGridAnchor(): void {
  _anchor.x = 0
  _anchor.z = 0
  _anchor.yaw = 0
  _identity = true
}

/** World→grid under the current anchor: rotate by −yaw about the anchor
 * point, then read coordinates from the anchor as origin. Allocates — for
 * QA/debug and tests; the IN seam below inlines this math into scratch. */
export function worldToGrid(x: number, z: number, yaw = 0): { x: number; z: number; yaw: number } {
  const c = Math.cos(_anchor.yaw)
  const s = Math.sin(_anchor.yaw)
  const dx = x - _anchor.x
  const dz = z - _anchor.z
  return { x: dx * c - dz * s, z: dx * s + dz * c, yaw: yaw - _anchor.yaw }
}

/** Grid→world — the exact inverse of worldToGrid (the slotPose OUT seam). */
export function gridToWorld(x: number, z: number, yaw = 0): { x: number; z: number; yaw: number } {
  const c = Math.cos(_anchor.yaw)
  const s = Math.sin(_anchor.yaw)
  return {
    x: _anchor.x + x * c + z * s,
    z: _anchor.z - x * s + z * c,
    yaw: yaw + _anchor.yaw,
  }
}

// ── STOREY LADDER (session storey elevations) ───────────────────────────────
// The uniform STOREY (2.8) is the fort-builder's own module, but the REAL
// building stacks its levels at the host default 2.5 m (and can vary per
// level) — pieces at s=1 would float 0.3 m above the real second floor.
// Once per session the game installs the building's ladder (derived in
// world.ts from the post-snap level group Ys): storeyY[] boundaries, storey
// s spanning [storeyY[s], storeyY[s+1]). Outside the ladder — above the sky
// rungs or below the bottom — storeys extend by pure STOREY multiples, so
// every helper stays total. No ladder → bit-exact legacy 2.8 multiples.

/** A building floating more than this above the terrain plane gets a
 * TERRAIN storey [0, base] prepended, so ground pieces still land ON the
 * ground; doubles as the terrain-grounding tolerance on storey bases. */
const TERRAIN_EPS = 0.05

/** Shortest storey worth minting a terrain sliver for — mirrors world.ts's
 * MIN_STOREY_SPAN (grid stays import-free of world; kept in sync). */
const MIN_TERRAIN_SPAN = 1

/** Live ladder — null = legacy uniform storeys (every existing test/QA
 * path stays green by construction). */
let _storeyY: number[] | null = null

/** THE DIRT the storeys are measured from: the ground elevation under the
 * building anchor, installed by builder.tsx BEFORE the ladder (the terrain
 * rung below normalizes against it). 0 on a flat lot — and 0 is what every
 * hand-built world and legacy test gets, so those paths are bit-identical.
 *
 * A literal 0 here was the builder's y = 0 assumption: on a lot whose yard
 * sits at +0.69 the bottom rung was SNAPPED to 0 and every ground-floor
 * piece was placed two thirds of a metre into the site slab; on an
 * excavated lot the uniform legacy storeys started metres in the air. */
let _terrainY = 0

/** Install the session's ground elevation (see _terrainY). Call it before
 * setStoreyLadder — the terrain rung is derived against it. */
export function setGridTerrainY(y: number): void {
  _terrainY = Number.isFinite(y) ? y : 0
}

/** The live ground elevation the storeys are measured from. */
export function gridTerrainY(): number {
  return _terrainY
}

/** Back to the lot plane — session teardown (next to resetStoreyLadder). */
export function resetGridTerrainY(): void {
  _terrainY = 0
}

/** Install the session storey ladder (copied + normalized: non-finite and
 * non-climbing entries drop, a lowest boundary above the terrain plane
 * prepends the terrain storey [0, base, …]). Fewer than two surviving
 * boundaries — or a null — resets to the uniform-STOREY fallback.
 * world.ts derives it; builder.tsx wires it alongside the grid anchor. */
export function setStoreyLadder(ys: readonly number[] | null | undefined): void {
  _storeyY = normalizeStoreyLadder(ys, _terrainY)
}

/**
 * The normalization setStoreyLadder applies, as pure math over an explicit
 * terrain elevation. Exported because the entry-settle watcher has to compare
 * a LIVE re-derivation against the INSTALLED ladder, and the installed one is
 * normalized — comparing raw against normalized reads as a permanent
 * disagreement and would re-publish the stamp forever.
 */
export function normalizeStoreyLadder(
  ys: readonly number[] | null | undefined,
  terrainY: number,
): number[] | null {
  if (!ys || ys.length < 2) return null
  const ladder: number[] = []
  for (const y of ys) {
    if (!Number.isFinite(y)) continue
    if (ladder.length > 0 && y <= ladder[ladder.length - 1]! + TERRAIN_EPS) continue
    ladder.push(y)
  }
  // Terrain rung: grounding needs SOME storey whose base sits ON the
  // GROUND (isTerrainGrounded — piece-slots roots the support graph there,
  // and without one GROUND placement is refused building-wide). A bottom
  // rung within a real storey of the dirt IS that rung — snap it to the
  // dirt: a slightly SUNK building (below it by more than EPS) used to get
  // no terrain storey at all, and a slightly RAISED one minted a degenerate
  // sub-MIN_TERRAIN_SPAN sliver that deriveStoreyLadder would have merged.
  // Only a bottom rung a full storey up gets a [ground, base] terrain
  // storey prepended; basement ladders (bottom rung a storey or more DOWN)
  // keep their own ground-level rung untouched. _terrainY is the ground
  // under the building, 0 on a flat lot.
  if (ladder.length > 0 && Math.abs(ladder[0]! - terrainY) > TERRAIN_EPS) {
    if (ladder[0]! - terrainY >= MIN_TERRAIN_SPAN) {
      ladder.unshift(terrainY)
    } else if (
      ladder[0]! - terrainY > -MIN_TERRAIN_SPAN &&
      (ladder.length < 2 || ladder[1]! > terrainY + TERRAIN_EPS)
    ) {
      ladder[0] = terrainY
    }
  }
  return ladder.length >= 2 ? ladder : null
}

/** The live ladder (normalized), or null in legacy uniform mode — QA/tests
 * read it through builderDebug; never mutate the returned array. */
export function getStoreyLadder(): readonly number[] | null {
  return _storeyY
}

/** Back to uniform 2.8 storeys — session teardown (next to resetGridAnchor). */
export function resetStoreyLadder(): void {
  _storeyY = null
}

/** Elevation of ladder boundary `b`, extended past both ends by pure
 * STOREY multiples (b may be negative or beyond the top sky rung). Callers
 * guarantee a ladder is installed. */
function boundaryY(b: number): number {
  const ladder = _storeyY!
  const last = ladder.length - 1
  if (b <= 0) return ladder[0]! + b * STOREY
  if (b >= last) return ladder[last]! + (b - last) * STOREY
  return ladder[b]!
}

/** Base elevation of storey `s` — the ground plus STOREY·s in legacy mode
 * (the ground is 0 on a flat lot, so that is the historical STOREY·s). */
export function storeyBase(s: number): number {
  if (!_storeyY) return _terrainY + s * STOREY
  return boundaryY(s)
}

/** Height of storey `s` (its base to the next boundary) — STOREY outside
 * the ladder and in legacy mode. Pieces conform to this span. */
export function storeySpan(s: number): number {
  if (!_storeyY) return STOREY
  return boundaryY(s + 1) - boundaryY(s)
}

/** Storey containing elevation `y`. Feet resting exactly ON a floor plane
 * belong to that storey (the legacy +0.1 grace). Below the ladder the
 * index runs negative — callers clamp, exactly like the legacy floor
 * division did for y < 0. */
export function storeyOfY(y: number): number {
  const yy = y + 0.1
  if (!_storeyY) return Math.floor((yy - _terrainY) / STOREY)
  const ladder = _storeyY
  const last = ladder.length - 1
  if (yy < ladder[0]!) return Math.floor((yy - ladder[0]!) / STOREY)
  if (yy >= ladder[last]!) return last + Math.floor((yy - ladder[last]!) / STOREY)
  for (let s = 0; s < last; s++) {
    if (yy < ladder[s + 1]!) return s
  }
  return last - 1 // unreachable: the loop covers [ladder[0], ladder[last])
}

/** Smallest boundary index at/above `y` (ladder mode y-plane march). */
function boundaryCeil(y: number): number {
  const ladder = _storeyY!
  const last = ladder.length - 1
  if (y <= ladder[0]!) return -Math.floor((ladder[0]! - y) / STOREY)
  if (y > ladder[last]!) return last + Math.ceil((y - ladder[last]!) / STOREY)
  for (let b = 1; b <= last; b++) {
    if (ladder[b]! >= y) return b
  }
  return last // unreachable: y ≤ ladder[last] was handled by the loop
}

/** Largest boundary index at/below `y` (ladder mode y-plane march). */
function boundaryFloor(y: number): number {
  const ladder = _storeyY!
  const last = ladder.length - 1
  if (y < ladder[0]!) return -Math.ceil((ladder[0]! - y) / STOREY)
  if (y >= ladder[last]!) return last + Math.floor((y - ladder[last]!) / STOREY)
  for (let b = last - 1; b >= 0; b--) {
    if (ladder[b]! <= y) return b
  }
  return 0 // unreachable: y ≥ ladder[0] was handled by the loop
}

export type SlotPose = {
  /** [x, baseY, z] — PlacedPiece.position semantics (builder piecePose). */
  position: [number, number, number]
  yaw: number
}

export type TargetInput = {
  /** Player FEET position. */
  position: [number, number, number]
  yaw: number
  pitch: number
  piece: BuildPieceKind
  /** R presses accumulated for the current piece type. */
  rotState: number
}

export type WorldProbe = {
  isOccupied: (slotId: string) => boolean
  isSupported: (slotId: string) => boolean
}

export type TargetResult = {
  slotId: string
  slot: Slot
  pose: SlotPose
  valid: boolean
  reason: 'ok' | 'occupied' | 'unsupported' | 'out-of-reach'
}

export function slotId(slot: Slot): string {
  return `${slot.kind}:${slot.i},${slot.k},${slot.s}`
}

export function parseSlotId(id: string): Slot | null {
  const m = /^(Wx|Wz|F|R):(-?\d+),(-?\d+),(-?\d+)$/.exec(id)
  if (!m) return null
  return { kind: m[1] as SlotKind, i: Number(m[2]), k: Number(m[3]), s: Number(m[4]) }
}

/** World pose of a slot. `rotQuarter` only matters for roofs. The lattice
 * pose is computed in the GRID frame, then the anchor OUT seam carries it
 * grid→world (identity skips the trig — poses stay bit-exact un-anchored).
 * Y is baseY either way: the anchor never touches elevation (the STOREY
 * LADDER owns Y — storeyBase reads it). */
export function slotPose(slot: Slot, rotQuarter = 0): SlotPose {
  const baseY = storeyBase(slot.s)
  let x: number
  let z: number
  let yaw: number
  switch (slot.kind) {
    case 'Wx':
      x = slot.i * CELL
      z = slot.k * CELL + CELL / 2
      yaw = Math.PI / 2
      break
    case 'Wz':
      x = slot.i * CELL + CELL / 2
      z = slot.k * CELL
      yaw = 0
      break
    case 'F':
      x = slot.i * CELL + CELL / 2
      z = slot.k * CELL + CELL / 2
      yaw = 0
      break
    case 'R':
      x = slot.i * CELL + CELL / 2
      z = slot.k * CELL + CELL / 2
      yaw = ((rotQuarter % 4) + 4) % 4 * (Math.PI / 2)
      break
  }
  if (_identity) return { position: [x, baseY, z], yaw }
  // OUT seam: rotate the grid pose by +yaw about the anchor point back into
  // world coordinates; the pose yaw carries the anchor yaw on top, wrapped
  // to [0, 2π) like the R-quarter expression above.
  const c = Math.cos(_anchor.yaw)
  const s = Math.sin(_anchor.yaw)
  return {
    position: [_anchor.x + x * c + z * s, baseY, _anchor.z - x * s + z * c],
    yaw: (((yaw + _anchor.yaw) % TWO_PI) + TWO_PI) % TWO_PI,
  }
}

const cellOf = (v: number): number => Math.floor(v / CELL)
/** Feet resting exactly ON a floor plane belong to that storey — the +0.1
 * grace lives in storeyOfY, which reads the session ladder when one is set. */
const storeyOf = storeyOfY

/** IN-seam scratch — one TargetInput reused every call (resolveTargetSlot
 * runs per frame; fresh objects here would be steady GC — same rationale as
 * the crossing pool below). Consumed synchronously, never escapes. */
const _gridInput: TargetInput = {
  position: [0, 0, 0],
  yaw: 0,
  pitch: 0,
  piece: 'wall',
  rotState: 0,
}

/** IN seam: the player pose world→grid. Everything the DDA derives from it
 * (ray origin at position + EYE, direction from yaw/pitch) lands in the
 * grid frame automatically — a rigid rotation commutes with that
 * construction. Y and pitch pass through untouched. Identity returns the
 * caller's own input: zero cost, bit-exact legacy behavior. */
function anchorInput(input: TargetInput): TargetInput {
  if (_identity) return input
  const c = Math.cos(_anchor.yaw)
  const s = Math.sin(_anchor.yaw)
  const dx = input.position[0] - _anchor.x
  const dz = input.position[2] - _anchor.z
  _gridInput.position[0] = dx * c - dz * s
  _gridInput.position[1] = input.position[1]
  _gridInput.position[2] = dx * s + dz * c
  _gridInput.yaw = input.yaw - _anchor.yaw
  _gridInput.pitch = input.pitch
  _gridInput.piece = input.piece
  _gridInput.rotState = input.rotState
  return _gridInput
}

/** Ground-forward cardinal from camera yaw (camera looks down −Z at yaw 0). */
export function yawCardinal(yaw: number): [number, number] {
  const fx = -Math.sin(yaw)
  const fz = -Math.cos(yaw)
  return Math.abs(fx) >= Math.abs(fz) ? [Math.sign(fx) || 1, 0] : [0, Math.sign(fz) || 1]
}

/** Ascent quarter for a facing cardinal — the HIGH side lands ALONG it, so
 * stairs/roofs always rise away from the player: +Z→0, +X→1, −Z→2, −X→3
 * (see the header: slotPose yaw q·π/2 maps local +Z onto (sin, cos)). The
 * pre-split code had the ±Z pair swapped, so Z-facing ramps rose back at
 * the player; the four-cardinal grid test pins the fix. */
function roofQuarter(d: [number, number]): number {
  if (d[0] === 1) return 1
  if (d[0] === -1) return 3
  if (d[1] === 1) return 0
  return 2
}

/**
 * DDA the eye ray over grid planes and return the first slot the PIECE kind
 * cares about: walls take the first VERTICAL plane crossed, floors the
 * first HORIZONTAL plane. Stairs/roofs (R slots) go through the world-aware
 * resolveRayRSlot march instead — never through here.
 */
type Crossing = { t: number; axis: 'x' | 'z' | 'y'; plane: number }
/** March scratch — ≤ 8 crossings per axis, reused every call (the builder
 * resolves a target every frame; fresh objects here were the loop's main
 * steady GC source). Entries are pooled; `_crossings` is consumed
 * synchronously inside rayOverride and never escapes. */
const _crossings: Crossing[] = []
const _crossingPool: Crossing[] = []
const byT = (a: Crossing, b: Crossing): number => a.t - b.t

function pushCrossing(t: number, axis: 'x' | 'z' | 'y', plane: number): void {
  let c = _crossingPool[_crossings.length]
  if (!c) {
    c = { t: 0, axis: 'x', plane: 0 }
    _crossingPool[_crossings.length] = c
  }
  c.t = t
  c.axis = axis
  c.plane = plane
  _crossings.push(c)
}

function marchAxis(o: number, d: number, step: number, axis: 'x' | 'z' | 'y'): void {
  if (Math.abs(d) < 1e-9) return
  const dir = Math.sign(d)
  let plane = dir > 0 ? Math.ceil((o + d * RAY_START) / step) : Math.floor((o + d * RAY_START) / step)
  for (let guard = 0; guard < 8; guard++) {
    const t = (plane * step - o) / d
    if (t > REACH) return
    if (t >= RAY_START) pushCrossing(t, axis, plane)
    plane += dir
  }
}

/** Y-plane march over the STOREY LADDER's boundaries (the crossing `plane`
 * is the BOUNDARY INDEX — the storey whose floor that boundary is, same
 * semantics as marchAxis's uniform plane index). No ladder → the legacy
 * uniform marchAxis, bit-exact. */
function marchYPlanes(o: number, d: number): void {
  if (!_storeyY) {
    marchAxis(o, d, STOREY, 'y')
    return
  }
  if (Math.abs(d) < 1e-9) return
  const dir = Math.sign(d)
  const start = o + d * RAY_START
  let b = dir > 0 ? boundaryCeil(start) : boundaryFloor(start)
  for (let guard = 0; guard < 8; guard++) {
    const t = (boundaryY(b) - o) / d
    if (t > REACH) return
    if (t >= RAY_START) pushCrossing(t, 'y', b)
    b += dir
  }
}

/**
 * THE ONE STOREY RULE. The ray picks the CELL; the pitch band picks the
 * STOREY. Past ±PITCH_BAND the player has said which level they mean —
 * exactly one up, or (walls and ramps) one down, or (floors) the slab under
 * their own feet — and that intent OVERRIDES the crossing height. Inside the
 * band there is no intent and the crossing height stands (null).
 *
 * WHY IT IS A CLAMP AND NOT A NUDGE (owner report 2026-09-01, "problem
 * placing floors as ceiling"). The ray's height is measured from the EYE, and
 * the eye is 1.58 m up: on any lot whose ground sits more than
 * (first boundary − 1.58 m) above the grid origin — which is most real lots,
 * this one has its terrain at 1.24 m with 2.5 m storeys — the eye is already
 * ABOVE the first storey boundary while the feet are still on storey 0. So
 * looking up at your own ceiling crossed boundary TWO, and the ceiling
 * resolved 5 m overhead: out of reach, unsupported, a red ghost that never
 * placed anything. Every unit test put the player's feet at y=0, where eye
 * 1.58 < boundary 2.8 hides the whole failure — which is why this shipped.
 *
 * Bumping "only when they disagree" (the old R-slot rule) cannot fix that: 2
 * and 1 disagree in the wrong direction. Clamping to the intent can, and it
 * makes the ray path agree with `defaultSlot` by construction — they used to
 * differ, which is why the fallback rescued the aim on some pitches and not
 * on others.
 */
function intentStorey(piece: BuildPieceKind, playerS: number, pitch: number): number | null {
  if (pitch > PITCH_BAND) return playerS + 1
  // Looking down with a FLOOR means the slab under your feet (s = your own
  // storey); with a wall or a ramp it means the level below.
  if (pitch < -PITCH_BAND) return Math.max(0, playerS - (piece === 'floor' ? 0 : 1))
  return null
}

function rayOverride(input: TargetInput): Slot | null {
  const [px, py, pz] = input.position
  const ox = px
  const oy = py + EYE
  const oz = pz
  const cp = Math.cos(input.pitch)
  const dx = -Math.sin(input.yaw) * cp
  const dy = Math.sin(input.pitch)
  const dz = -Math.cos(input.yaw) * cp
  const intent = intentStorey(input.piece, Math.max(0, storeyOf(py)), input.pitch)

  _crossings.length = 0
  marchAxis(ox, dx, CELL, 'x')
  marchAxis(oz, dz, CELL, 'z')
  marchYPlanes(oy, dy)
  _crossings.sort(byT)

  for (const c of _crossings) {
    const x = ox + dx * c.t
    const y = oy + dy * c.t
    const z = oz + dz * c.t
    if (input.piece === 'wall' && c.axis === 'x') {
      return { kind: 'Wx', i: c.plane, k: cellOf(z), s: intent ?? Math.max(0, storeyOf(y)) }
    }
    if (input.piece === 'wall' && c.axis === 'z') {
      return { kind: 'Wz', i: cellOf(x), k: c.plane, s: intent ?? Math.max(0, storeyOf(y)) }
    }
    if (input.piece === 'floor' && c.axis === 'y') {
      return { kind: 'F', i: cellOf(x), k: cellOf(z), s: intent ?? Math.max(0, c.plane) }
    }
  }
  return null
}

/**
 * R-slot ray targeting (stairs/roofs): march the aim ray's CELL entries and
 * return the first PLACEABLE slot. Two aim-feel fixes over the plain
 * first-crossing override (2026-08-27 owner QA, live repro):
 * - an occupied/unsupported cell no longer dead-ends the aim — one placed
 *   ramp used to make EVERY pitch from the same spot read "occupied"; the
 *   march walks on to the next cell the ray crosses, ≤ REACH;
 * - the storey obeys THE ONE STOREY RULE (intentStorey): the raw crossing
 *   height is erratic at mid pitches (a wall-top aim from outside resolved a
 *   GROUND cell), so beyond ±PITCH_BAND the pitch band CLAMPS the storey
 *   instead of nudging it. The nudge shipped as "bump only when they
 *   disagree", which silently did nothing on a raised lot: with the eye
 *   already above the first boundary a +50° aim crossed boundary TWO, that is
 *   ABOVE the intent, so nothing was bumped and the ramp resolved two storeys
 *   overhead — unsupported, out of reach. See intentStorey for the full story.
 * Returns the NEAREST failing result when nothing along the ray is
 * placeable (its reason drives the HUD status line), or null when the ray
 * exits reach without entering a new cell (caller falls back to the
 * player-anchored default slot).
 *
 * `input` is the GRID-frame pose (post anchor IN seam) — the march is pure
 * lattice math; `worldInput` is the caller's untouched world pose, passed
 * through to evaluateSlot (reach is measured in world coordinates).
 */
function resolveRayRSlot(
  input: TargetInput,
  worldInput: TargetInput,
  quarter: number,
  world: WorldProbe,
): TargetResult | null {
  const [px, py, pz] = input.position
  const ox = px
  const oy = py + EYE
  const oz = pz
  const cp = Math.cos(input.pitch)
  const dx = -Math.sin(input.yaw) * cp
  const dy = Math.sin(input.pitch)
  const dz = -Math.cos(input.yaw) * cp

  const startCellI = cellOf(ox + dx * RAY_START)
  const startCellK = cellOf(oz + dz * RAY_START)
  const playerS = Math.max(0, storeyOf(py))
  const intent = intentStorey(input.piece, playerS, input.pitch)

  _crossings.length = 0
  marchAxis(ox, dx, CELL, 'x')
  marchAxis(oz, dz, CELL, 'z')
  _crossings.sort(byT)

  let first: TargetResult | null = null
  let prevI = startCellI
  let prevK = startCellK
  let prevS = -1
  for (const c of _crossings) {
    const x = ox + dx * c.t
    const y = oy + dy * c.t
    const z = oz + dz * c.t
    const i = c.axis === 'x' ? (dx > 0 ? c.plane : c.plane - 1) : cellOf(x)
    const k = c.axis === 'z' ? (dz > 0 ? c.plane : c.plane - 1) : cellOf(z)
    if (i === startCellI && k === startCellK) continue // never your own cell
    // Pitch-band intent beats the erratic crossing height outright.
    const s = intent ?? Math.max(0, storeyOf(y))
    if (i === prevI && k === prevK && s === prevS) continue // x/z pair, same cell
    prevI = i
    prevK = k
    prevS = s
    const result = evaluateSlot({ kind: 'R', i, k, s }, quarter, worldInput, world)
    if (result.valid) return result
    if (!first) first = result
  }
  return first
}

/** Default slot: the neighbor of the player's cell along the yaw cardinal. */
function defaultSlot(input: TargetInput): Slot {
  const [px, py, pz] = input.position
  const i = cellOf(px)
  const k = cellOf(pz)
  // Same storey rule as the ray paths — one source of truth, so the fallback
  // can never land on a different level than the aim it is rescuing.
  const playerS = Math.max(0, storeyOf(py))
  const s = intentStorey(input.piece, playerS, input.pitch) ?? playerS
  const down = input.pitch < -PITCH_BAND
  const d = yawCardinal(input.yaw)

  if (input.piece === 'floor') {
    // Looking down builds under your feet; otherwise the neighbor cell.
    return down ? { kind: 'F', i, k, s } : { kind: 'F', i: i + d[0], k: k + d[1], s }
  }
  if (input.piece === 'stairs' || input.piece === 'roof') {
    return { kind: 'R', i: i + d[0], k: k + d[1], s }
  }
  // Wall: the NEAR shared edge between P and N. The R far-edge flip is
  // applied uniformly in resolveTargetSlot (it must also override the ray —
  // R is an explicit user command).
  if (d[0] === 1) return { kind: 'Wx', i: i + 1, k, s }
  if (d[0] === -1) return { kind: 'Wx', i, k, s }
  if (d[1] === 1) return { kind: 'Wz', i, k: k + 1, s }
  return { kind: 'Wz', i, k, s }
}

/** R on walls: shift the chosen edge one plane further along the facing
 * cardinal (the far edge of the target cell). */
function applyWallFlip(slot: Slot, d: [number, number], rotState: number): Slot {
  if (((rotState % 2) + 2) % 2 === 0) return slot
  if (slot.kind === 'Wx') return { ...slot, i: slot.i + (d[0] >= 0 ? 1 : -1) }
  if (slot.kind === 'Wz') return { ...slot, k: slot.k + (d[1] >= 0 ? 1 : -1) }
  return slot
}

const sameSlot = (a: Slot, b: Slot): boolean =>
  a.kind === b.kind && a.i === b.i && a.k === b.k && a.s === b.s

/** `input` here is the WORLD-frame pose: slotPose already returns world
 * coordinates (anchor OUT seam), so reach is measured world-vs-world — the
 * transform is rigid, so it equals the grid-frame distance anyway. */
function evaluateSlot(
  slot: Slot,
  quarter: number,
  input: TargetInput,
  world: WorldProbe,
): TargetResult {
  const id = slotId(slot)
  const pose = slotPose(slot, quarter)
  const dx = pose.position[0] - input.position[0]
  const dy = pose.position[1] - input.position[1]
  const dz = pose.position[2] - input.position[2]
  const reach = Math.hypot(dx, dy, dz) <= REACH + CELL / 2
  let reason: TargetResult['reason'] = 'ok'
  if (!reach) reason = 'out-of-reach'
  else if (world.isOccupied(id)) reason = 'occupied'
  else if (!world.isSupported(id)) reason = 'unsupported'
  return { slotId: id, slot, pose, valid: reason === 'ok', reason }
}

export function resolveTargetSlot(input: TargetInput, world: WorldProbe): TargetResult {
  // IN seam: slot RESOLUTION runs entirely in the grid frame — one rigid
  // world→grid transform of the player pose (anchorInput). The original
  // `input` stays the world pose for evaluateSlot's reach test. Identity
  // anchor: `grid === input`, nothing moves.
  const grid = anchorInput(input)
  const d = yawCardinal(grid.yaw)
  const wall = grid.piece === 'wall'

  // Stairs: R adds ascent quarter-turns on top of the facing. Roof: R
  // cycles SHAPE presets instead (builder-side), so the yaw stays aimed
  // by the facing alone — the preset's high side always rises away.
  const quarter =
    grid.piece === 'stairs'
      ? roofQuarter(d) + grid.rotState
      : grid.piece === 'roof'
        ? roofQuarter(d)
        : 0

  // R slots (stairs/roofs): world-aware ray march — same first-valid-wins /
  // nearest-failure-reports contract as the wall/floor path below.
  if (grid.piece === 'stairs' || grid.piece === 'roof') {
    const primary = resolveRayRSlot(grid, input, quarter, world)
    const base = defaultSlot(grid)
    if (primary) {
      if (primary.valid || sameSlot(primary.slot, base)) return primary
      const secondary = evaluateSlot(base, quarter, input, world)
      return secondary.valid ? secondary : primary
    }
    return evaluateSlot(base, quarter, input, world)
  }

  const raw = rayOverride(grid)
  const override = raw && wall ? applyWallFlip(raw, d, grid.rotState) : raw
  const base = defaultSlot(grid)
  const fallback = wall ? applyWallFlip(base, d, grid.rotState) : base

  // Ray override first, player-anchored fallback second (skipped when it is
  // the same slot); first valid wins, else the FIRST failing result reports.
  if (override) {
    const primary = evaluateSlot(override, quarter, input, world)
    if (primary.valid || sameSlot(override, fallback)) return primary
    const secondary = evaluateSlot(fallback, quarter, input, world)
    return secondary.valid ? secondary : primary
  }
  return evaluateSlot(fallback, quarter, input, world)
}

/**
 * Slots sharing an edge or vertex with `id` — the support/contact
 * adjacency. Symmetric by construction (each rule below has its mirror).
 */
export function slotsTouching(id: string): string[] {
  const slot = parseSlotId(id)
  if (!slot) return []
  const { i, k, s } = slot
  const out: Slot[] = []
  const push = (kind: SlotKind, pi: number, pk: number, ps: number) => {
    if (ps >= 0) out.push({ kind, i: pi, k: pk, s: ps })
  }

  if (slot.kind === 'Wx') {
    push('Wx', i, k - 1, s)
    push('Wx', i, k + 1, s)
    push('Wx', i, k, s - 1)
    push('Wx', i, k, s + 1)
    // Perpendicular walls meeting at the two columns (z=3k and z=3k+3).
    for (const kk of [k, k + 1]) {
      push('Wz', i - 1, kk, s)
      push('Wz', i, kk, s)
    }
    // Floors bordering the edge, below and above.
    for (const ss of [s, s + 1]) {
      push('F', i - 1, k, ss)
      push('F', i, k, ss)
    }
    push('R', i - 1, k, s)
    push('R', i, k, s)
  } else if (slot.kind === 'Wz') {
    push('Wz', i - 1, k, s)
    push('Wz', i + 1, k, s)
    push('Wz', i, k, s - 1)
    push('Wz', i, k, s + 1)
    for (const ii of [i, i + 1]) {
      push('Wx', ii, k - 1, s)
      push('Wx', ii, k, s)
    }
    for (const ss of [s, s + 1]) {
      push('F', i, k - 1, ss)
      push('F', i, k, ss)
    }
    push('R', i, k - 1, s)
    push('R', i, k, s)
  } else if (slot.kind === 'F') {
    push('F', i - 1, k, s)
    push('F', i + 1, k, s)
    push('F', i, k - 1, s)
    push('F', i, k + 1, s)
    // Bounding walls at this storey (they rest on the floor) and the storey
    // below (the floor rests on them).
    for (const ss of [s, s - 1]) {
      push('Wx', i, k, ss)
      push('Wx', i + 1, k, ss)
      push('Wz', i, k, ss)
      push('Wz', i, k + 1, ss)
    }
    push('R', i, k, s - 1)
    push('R', i, k, s)
  } else {
    // Roof occupies its cell: bounded by the 4 walls, the floor below and
    // the face above, plus adjacent roofs.
    push('Wx', i, k, s)
    push('Wx', i + 1, k, s)
    push('Wz', i, k, s)
    push('Wz', i, k + 1, s)
    push('F', i, k, s)
    push('F', i, k, s + 1)
    push('R', i - 1, k, s)
    push('R', i + 1, k, s)
    push('R', i, k - 1, s)
    push('R', i, k + 1, s)
    // Storey-diagonal roof chain (p5r2 QA gate c): a ramp's HIGH edge at
    // y=STOREY·(s+1) coincides with the LOW edge of the next cell's ramp
    // one storey up — real geometric contact on the shared cell boundary.
    // Both diagonals per axis keep the relation symmetric (a+[+1,0,+1s]
    // here has its mirror a+[−1,0,−1s] in the neighbor's own expansion).
    for (const ss of [s - 1, s + 1]) {
      push('R', i - 1, k, ss)
      push('R', i + 1, k, ss)
      push('R', i, k - 1, ss)
      push('R', i, k + 1, ss)
    }
  }
  return out.map(slotId)
}

/** Terrain rule: slots whose base sits ON the ground are self-grounded.
 * Legacy mode that is exactly storey 0 (whose base IS the ground); under a
 * ladder it is the storey whose base elevation is the ground — for an
 * elevated building that's the prepended terrain storey, for a basement
 * ladder the ground level's own rung (the basement storey below is NOT
 * terrain). Measured against _terrainY, not against absolute zero: on the
 * owner's lots the whole building sits metres off the lot plane, and
 * comparing to zero meant NO storey was ever terrain-grounded, so ground
 * placement was refused building-wide. */
export function isTerrainGrounded(id: string): boolean {
  const slot = parseSlotId(id)
  if (!slot) return false
  if (!_storeyY) return slot.s === 0
  return Math.abs(storeyBase(slot.s) - _terrainY) <= TERRAIN_EPS
}
