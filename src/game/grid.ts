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
 * Y is baseY either way: the anchor never touches elevation. */
export function slotPose(slot: Slot, rotQuarter = 0): SlotPose {
  const baseY = slot.s * STOREY
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
/** Feet resting exactly ON a floor plane belong to that storey. */
const storeyOf = (y: number): number => Math.floor((y + 0.1) / STOREY)

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

function rayOverride(input: TargetInput): Slot | null {
  const [px, py, pz] = input.position
  const ox = px
  const oy = py + EYE
  const oz = pz
  const cp = Math.cos(input.pitch)
  const dx = -Math.sin(input.yaw) * cp
  const dy = Math.sin(input.pitch)
  const dz = -Math.cos(input.yaw) * cp

  _crossings.length = 0
  marchAxis(ox, dx, CELL, 'x')
  marchAxis(oz, dz, CELL, 'z')
  marchAxis(oy, dy, STOREY, 'y')
  _crossings.sort(byT)

  for (const c of _crossings) {
    const x = ox + dx * c.t
    const y = oy + dy * c.t
    const z = oz + dz * c.t
    if (input.piece === 'wall' && c.axis === 'x') {
      return { kind: 'Wx', i: c.plane, k: cellOf(z), s: Math.max(0, storeyOf(y)) }
    }
    if (input.piece === 'wall' && c.axis === 'z') {
      return { kind: 'Wz', i: cellOf(x), k: c.plane, s: Math.max(0, storeyOf(y)) }
    }
    if (input.piece === 'floor' && c.axis === 'y') {
      return { kind: 'F', i: cellOf(x), k: cellOf(z), s: Math.max(0, c.plane) }
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
 * - the storey honors the PITCH-BAND intent: the raw crossing height is
 *   erratic at mid pitches (a wall-top aim from outside resolved a GROUND
 *   cell), so beyond ±PITCH_BAND a crossing that disagrees with the intent
 *   is bumped one storey up/down from the player's own.
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
  const up = input.pitch > PITCH_BAND
  const down = input.pitch < -PITCH_BAND

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
    let s = Math.max(0, storeyOf(y))
    // Pitch-band intent beats the erratic crossing height — but only when
    // they DISAGREE (a crossing already a storey up is never double-bumped).
    if (up && s <= playerS) s = playerS + 1
    else if (down && s >= playerS) s = Math.max(0, playerS - 1)
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
  let s = Math.max(0, storeyOf(py))
  if (input.pitch > PITCH_BAND) s += 1
  const down = input.pitch < -PITCH_BAND
  if (down) s = Math.max(0, s - (input.piece === 'floor' ? 0 : 1))
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

/** Terrain rule: slots whose base sits on the ground plane are self-grounded. */
export function isTerrainGrounded(id: string): boolean {
  const slot = parseSlotId(id)
  return slot !== null && slot.s === 0
}
