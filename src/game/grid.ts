/**
 * Build Grammar v2 — pure slot math (no React, no three).
 *
 * The world carries an ABSOLUTE, world-aligned build grid (cells CELL m on
 * a side, storeys STOREY m tall). Pieces never float: they occupy discrete
 * SLOTS —
 *   walls  → cell EDGES:      Wx:i,k,s = plane x=CELL·i spanning z∈[3k,3k+3]
 *                             Wz:i,k,s = plane z=CELL·k spanning x∈[3i,3i+3]
 *   floors → cell FACES:      F:i,k,s  = the y=STOREY·s face of cell (i,k)
 *   roofs  → cell DIAGONALS:  R:i,k,s  = the cell volume, yaw picks ascent
 * A slot's POSE feeds builder.tsx unchanged: `position` is [x, baseY, z]
 * (baseY = STOREY·s; builder's piecePose derives the center height), `yaw`
 * rotates about Y exactly like PlacedPiece.yaw. Wall poses sit at the edge
 * midpoint; canonical wall yaw is 0 for Wz (length along X) and π/2 for Wx
 * (length along Z). Roof yaw = quarter·π/2, quarter counted from −Z
 * clockwise: 0 ascends toward −Z, 1 toward +X, 2 toward +Z, 3 toward −X.
 *
 * Targeting (resolveTargetSlot) is player-anchored with a ray override:
 * default target = the neighbor of the player's cell along the yaw
 * cardinal; a DDA march of the camera ray (≤ REACH) across grid planes
 * overrides it with the first slot boundary crossed; pitch beyond ±PITCH_BAND
 * retargets one storey up/down. Occupancy and support are injected so this
 * module stays pure (grid knows geometry, the game knows state).
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
export type BuildPieceKind = 'wall' | 'floor' | 'roof'

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

/** World pose of a slot. `rotQuarter` only matters for roofs. */
export function slotPose(slot: Slot, rotQuarter = 0): SlotPose {
  const baseY = slot.s * STOREY
  switch (slot.kind) {
    case 'Wx':
      return { position: [slot.i * CELL, baseY, slot.k * CELL + CELL / 2], yaw: Math.PI / 2 }
    case 'Wz':
      return { position: [slot.i * CELL + CELL / 2, baseY, slot.k * CELL], yaw: 0 }
    case 'F':
      return { position: [slot.i * CELL + CELL / 2, baseY, slot.k * CELL + CELL / 2], yaw: 0 }
    case 'R':
      return {
        position: [slot.i * CELL + CELL / 2, baseY, slot.k * CELL + CELL / 2],
        yaw: ((rotQuarter % 4) + 4) % 4 * (Math.PI / 2),
      }
  }
}

const cellOf = (v: number): number => Math.floor(v / CELL)
/** Feet resting exactly ON a floor plane belong to that storey. */
const storeyOf = (y: number): number => Math.floor((y + 0.1) / STOREY)

/** Ground-forward cardinal from camera yaw (camera looks down −Z at yaw 0). */
export function yawCardinal(yaw: number): [number, number] {
  const fx = -Math.sin(yaw)
  const fz = -Math.cos(yaw)
  return Math.abs(fx) >= Math.abs(fz) ? [Math.sign(fx) || 1, 0] : [0, Math.sign(fz) || 1]
}

/** Roof ascent quarter for a cardinal: −Z→0, +X→1, +Z→2, −X→3. */
function roofQuarter(d: [number, number]): number {
  if (d[0] === 1) return 1
  if (d[0] === -1) return 3
  if (d[1] === 1) return 2
  return 0
}

/**
 * DDA the eye ray over grid planes and return the first slot the PIECE kind
 * cares about: walls take the first VERTICAL plane crossed, floors the
 * first HORIZONTAL plane, roofs the first cell entered beyond the player's.
 */
function rayOverride(input: TargetInput): Slot | null {
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

  type Crossing = { t: number; axis: 'x' | 'z' | 'y'; plane: number }
  const crossings: Crossing[] = []
  const march = (o: number, d: number, step: number, axis: 'x' | 'z' | 'y') => {
    if (Math.abs(d) < 1e-9) return
    const dir = Math.sign(d)
    let plane = dir > 0 ? Math.ceil((o + d * RAY_START) / step) : Math.floor((o + d * RAY_START) / step)
    for (let guard = 0; guard < 8; guard++) {
      const t = (plane * step - o) / d
      if (t > REACH) return
      if (t >= RAY_START) crossings.push({ t, axis, plane })
      plane += dir
    }
  }
  march(ox, dx, CELL, 'x')
  march(oz, dz, CELL, 'z')
  march(oy, dy, STOREY, 'y')
  crossings.sort((a, b) => a.t - b.t)

  for (const c of crossings) {
    const x = ox + dx * c.t
    const y = oy + dy * c.t
    const z = oz + dz * c.t
    const s = Math.max(0, storeyOf(y - (c.axis === 'y' ? 0.05 * Math.sign(dy) : EYE * 0)))
    if (input.piece === 'wall' && c.axis === 'x') {
      return { kind: 'Wx', i: c.plane, k: cellOf(z), s: Math.max(0, storeyOf(y)) }
    }
    if (input.piece === 'wall' && c.axis === 'z') {
      return { kind: 'Wz', i: cellOf(x), k: c.plane, s: Math.max(0, storeyOf(y)) }
    }
    if (input.piece === 'floor' && c.axis === 'y') {
      return { kind: 'F', i: cellOf(x), k: cellOf(z), s: Math.max(0, c.plane) }
    }
    if (input.piece === 'roof' && c.axis !== 'y') {
      const i = c.axis === 'x' ? (dx > 0 ? c.plane : c.plane - 1) : cellOf(x)
      const k = c.axis === 'z' ? (dz > 0 ? c.plane : c.plane - 1) : cellOf(z)
      if (i !== startCellI || k !== startCellK) {
        return { kind: 'R', i, k, s: Math.max(0, storeyOf(y)) }
      }
    }
    void s
  }
  return null
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
  if (input.piece === 'roof') {
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

export function resolveTargetSlot(input: TargetInput, world: WorldProbe): TargetResult {
  const d = yawCardinal(input.yaw)
  const flip = (slot: Slot): Slot =>
    input.piece === 'wall' ? applyWallFlip(slot, d, input.rotState) : slot
  const candidates: Slot[] = []
  const override = rayOverride(input)
  if (override) candidates.push(flip(override))
  const fallback = flip(defaultSlot(input))
  if (!override || slotId(candidates[0]!) !== slotId(fallback)) candidates.push(fallback)

  const quarter =
    input.piece === 'roof' ? roofQuarter(yawCardinal(input.yaw)) + input.rotState : 0

  let firstFailing: TargetResult | null = null
  for (const slot of candidates) {
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
    const result: TargetResult = { slotId: id, slot, pose, valid: reason === 'ok', reason }
    if (result.valid) return result
    firstFailing ??= result
  }
  return firstFailing!
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
  }
  return out.map(slotId)
}

/** Terrain rule: slots whose base sits on the ground plane are self-grounded. */
export function isTerrainGrounded(id: string): boolean {
  const slot = parseSlotId(id)
  return slot !== null && slot.s === 0
}
