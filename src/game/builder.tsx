'use client'

import { useFrame } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Box3, BoxGeometry, type BufferGeometry, Color, Matrix4, type Group, type Mesh } from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { type BuildPiece, FULL_MASK, type PlacedPiece, useBoots } from '../store'
import { sfx } from './audio'
import { EYE_HEIGHT } from './collision'
import { spawnDebris } from './debris'
import { dropTarget, ensureVoxelTarget, useDestruction } from './destruction'
import {
  CELL,
  parseSlotId,
  resolveTargetSlot,
  type Slot,
  STOREY,
  type TargetInput,
  type TargetResult,
} from './grid'
import {
  isDeathLocked,
  isOccupied as slotIsOccupied,
  isSupported as slotIsSupported,
  onCollapse,
  onPieceRemoved,
  registerPlacement,
  resetPieceSlots,
  type SceneSupportProbe,
  setSceneSupportProbe,
} from './piece-slots'
import { playerRig } from './player'
import { getSession } from './session'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

/**
 * Build mode, grid-locked grammar (BUILD-GRAMMAR-V2 + REVIEW): wall / floor
 * / roof (Q cycles), the ghost ONLY ever occupies discrete world-grid slots
 * — it snaps, never floats. Placements are game-only state — the panel's
 * Keep converts walls (and, best-effort, roofs) into real scene nodes
 * afterwards, Discard forgets everything. Z undoes (piece + collider + any
 * voxel replica + support cascade) — G is the grenade now.
 *
 * ── GRID-LOCKED TARGETING (phase 5) ───────────────────────────────────────
 * Every frame the builder feeds grid.resolveTargetSlot the player rig
 * (FEET position, yaw, pitch, piece, R rotState) and a WorldProbe wired to
 * piece-slots.ts — THE single occupancy/support authority (slotId ↔ placed
 * piece id, support graph, scene-support probe). The ghost renders AT THE
 * RESOLVED SLOT POSE ONLY: blue = placeable, red = occupied OR unsupported
 * OR out of reach (the failing reason drives hud.ghostStatus). Ceilings are
 * floors one storey up (aim past the +35° pitch band with the floor piece);
 * ramps chain as you run up them holding place — see "the two flows" in
 * docs/BUILD-GRAMMAR-V2.md.
 *
 * R (edge) bumps rotState (0..3), grid semantics: wall = far-edge flip of
 * the target cell (parity — beats the ray), floor = no-op (key ignored),
 * roof = ascent quarter-turn cycle. Persists across placements; resets on
 * piece-TYPE switch only (REVIEW contract).
 *
 * TURBO hold-to-place: the press edge stamps immediately and arms
 * TURBO_FIRST (0.15 s); while held, every NEW target slot stamps at
 * TURBO_NEXT (0.05 s) cadence — at most one attempt per slotId per hold
 * (dedupe Set, cleared on release) and never into a slot whose piece died
 * < 0.15 s ago (piece-slots.isDeathLocked, stamped by onPieceRemoved).
 *
 * Undo (Z) and the support cascade share ONE removal path:
 * piece-slots.onPieceRemoved(slotId) → orphaned component collapses in BFS
 * rings (~50 ms apart) → the onCollapse listener (wired in PlacedPieces)
 * removes each piece from the store, so its unmount runs the exact undo
 * cleanup (collider splice + voxel dropTarget) + a debris burst.
 *
 * ── INSTANT BRICKS (phase 4) + TURBO CLAD BUDGET (phase 5) ────────────────
 * A placed piece is voxel-clad THE MOMENT it lands: PlacedPieceMesh routes
 * itself through requestPieceClad in its layout effect (before first
 * paint), so the merged-box mesh ledger-hides immediately, its collider
 * entry disables (voxels take over collision — never double-solid), and the
 * piece reads as bricks from the first frame. Degenerate grids fall back to
 * the plain solid mesh. Undo/mask-edit cleanup still drops the replica via
 * dropTarget.
 * BUDGET (REVIEW perf risk): a turbo sweep lands up to 20 pieces/s and 20
 * voxelizations/s would hitch. Placements arriving closer together than
 * CLAD_BURST_MS (~8/s — the threshold sits BETWEEN the turbo cadences, so
 * TURBO_FIRST singles stay instant and TURBO_NEXT sweep stamps defer) push
 * into a FIFO that PlacedPieces' frame loop drains CLAD_DRAIN_PER_FRAME
 * per frame; until its turn a deferred piece keeps the plain solid mesh —
 * visible, collidable, shootable (damageTarget voxelizes on demand, the
 * drain then no-ops on the existing target). Unmount cancels its pending
 * request, so a drained slot never clads a dead entry.
 *
 * ── 3×3 CELL MASK (phase 3) ───────────────────────────────────────────────
 * Every placed piece renders as a 3×3 grid of cell boxes honoring its
 * 9-bit `mask` (bit = col + row·3; wall cells 1 × 0.93 × 0.12, floor/roof
 * cells split the plane 3×3). The RENDERED mesh is ONE merged-box geometry
 * per (piece, mask) — cached module-wide — and doubles as the piece's
 * collider: on any mask change the piece object is swapped in the store,
 * so the mesh remounts its collider entry (fresh BVH via bvhFor) and any
 * voxel replica of the old shape is dropped.
 * EDIT MODE: with the builder equipped, aim at one of YOUR placed pieces
 * within 6 m and press F — a 3×3 ghost grid overlays the piece, the cell
 * under the crosshair highlights, LMB toggles that cell's mask bit
 * (pocket the middle of a wall = window; kill a side column = shorter
 * wall), RMB resets the mask to intact (511). F again — or aiming off the
 * piece — exits; exit-time classifies the final mask and EXACT staircase
 * silhouettes (311/95) rebuild the wall as a ramp in place (see
 * wallExitTransform). Placement, and the placement ghost, pause while
 * editing; Q piece-cycling is gated off via builderDebug.isEditing
 * (viewmodel.tsx feature-detects the flag).
 * NOTE: needs 'KeyF' in input.ts GAME_KEYS to receive the key.
 *
 * ── API (exported for tests / other systems) ──────────────────────────────
 *   PIECE_DIMS / piecePose      piece geometry + pose from base elevation.
 *   CELLS / maskBit / cellDims / cellCenter    3×3 cell math (local frame).
 *   raycastPieceCell(piece, ox, oy, oz, dx, dy, dz, maxDist)   ray vs the
 *       FULL piece box (mask-independent so dead cells can be re-added) →
 *       { t, col, row, bit } | null. RETURNS A REUSED MODULE OBJECT.
 *   turboStamp(cooldownLeft, freshPress, valid, attempted, locked)   pure
 *       slot-locked hold-to-place decision → cooldown to arm, or null.
 *   isOccupied(placed, piece, x, y, z, yaw)   identical-pose test, yaw
 *       compared modulo the piece's symmetry (wall π, floor π/2, roof 2π).
 *       Edit-exit transforms still guard on it; SLOT occupancy is
 *       piece-slots.ts's job now.
 *   rotatedYaw(autoYaw, quarterTurns)   pure R-rotate math: auto-facing yaw
 *       + quarter turns, wrapped to [−π, π) so poses stay comparable.
 *   requestPieceClad / cancelPieceClad / drainCladQueue / cladQueueSize /
 *   resetCladQueue + CLAD_BURST_MS / CLAD_DRAIN_PER_FRAME    the budgeted
 *       voxelize queue (see TURBO CLAD BUDGET above).
 *   builderDebug (dev, `globalThis.__bootsBuilder` in-game)   holdFire
 *       stands in for the held LMB in headless E2E; ghost() snapshots the
 *       resolved slot ghost (slotId, pose, valid, reason).
 * ──────────────────────────────────────────────────────────────────────────
 */

const WALL_H = 2.8
/** Turbo hold-to-place cadence: the fresh-press stamp arms the longer
 * lockout, held new-slot re-stamps run at the fast one (≥0.05 s apart). */
export const TURBO_FIRST = 0.15
export const TURBO_NEXT = 0.05

export const PIECE_DIMS: Record<BuildPiece, [number, number, number]> = {
  wall: [3, WALL_H, 0.12],
  floor: [3, 0.12, 3],
  roof: [3, 0.12, 4.1],
}

const ROOF_TILT = -Math.atan2(WALL_H, 3)

export function piecePose(piece: BuildPiece, baseY: number): { y: number; tilt: number } {
  if (piece === 'wall') return { y: baseY + WALL_H / 2, tilt: 0 }
  if (piece === 'floor') return { y: baseY + 0.06, tilt: 0 }
  return { y: baseY + WALL_H / 2, tilt: ROOF_TILT }
}

// --- 3×3 cell grid ----------------------------------------------------------

/** Cells per side of the build-battle grid. */
export const CELLS = 3

/** Mask bit for grid cell (col, row) — bit = col + row·CELLS. */
export function maskBit(col: number, row: number): number {
  return col + row * CELLS
}

/** One cell's box dims in the piece's local frame: walls split width ×
 * height (full thickness), floors/roofs split their plane (full slab). */
export function cellDims(piece: BuildPiece): [number, number, number] {
  const [w, h, d] = PIECE_DIMS[piece]
  if (piece === 'wall') return [w / CELLS, h / CELLS, d]
  return [w / CELLS, h, d / CELLS]
}

/** Local-frame center of grid cell (col, row). Col 0 sits at local −X;
 * wall row 0 is the BOTTOM row, floor/roof row 0 is the local −Z edge
 * (a roof's LOW edge given ROOF_TILT). */
export function cellCenter(piece: BuildPiece, col: number, row: number): [number, number, number] {
  const [w, h, d] = PIECE_DIMS[piece]
  const x = -w / 2 + (col + 0.5) * (w / CELLS)
  if (piece === 'wall') return [x, -h / 2 + (row + 0.5) * (h / CELLS), 0]
  return [x, 0, -d / 2 + (row + 0.5) * (d / CELLS)]
}

const pieceGeometries = new Map<BuildPiece, BoxGeometry>()
function geometryFor(piece: BuildPiece): BoxGeometry {
  let geometry = pieceGeometries.get(piece)
  if (!geometry) {
    geometry = new BoxGeometry(...PIECE_DIMS[piece])
    pieceGeometries.set(piece, geometry)
  }
  return geometry
}

/** Merged-box geometry for a piece's live cells, cached per (piece, mask) —
 * placed meshes AND their colliders come from here, so a mask edit swaps
 * both at once. Null when every cell is dead (nothing to render/collide). */
const maskGeometryCache = new Map<string, BufferGeometry>()
function geometryForMask(piece: BuildPiece, mask: number): BufferGeometry | null {
  const live = mask & FULL_MASK
  if (live === 0) return null
  if (live === FULL_MASK) return geometryFor(piece)
  const key = `${piece}|${live}`
  let geometry = maskGeometryCache.get(key)
  if (!geometry) {
    const dims = cellDims(piece)
    const parts: BoxGeometry[] = []
    for (let row = 0; row < CELLS; row++) {
      for (let col = 0; col < CELLS; col++) {
        if (!(live & (1 << maskBit(col, row)))) continue
        const center = cellCenter(piece, col, row)
        const box = new BoxGeometry(dims[0], dims[1], dims[2])
        box.translate(center[0], center[1], center[2])
        parts.push(box)
      }
    }
    geometry = mergeGeometries(parts) ?? geometryFor(piece)
    for (const part of parts) part.dispose()
    geometry.computeBoundingBox()
    maskGeometryCache.set(key, geometry)
  }
  return geometry
}

// --- Pose equality --------------------------------------------------------

const TWO_PI = Math.PI * 2
/** Yaw period under which the piece's box is self-identical. */
const YAW_SYMMETRY: Record<BuildPiece, number> = {
  wall: Math.PI,
  floor: Math.PI / 2,
  roof: TWO_PI,
}

function sameYaw(a: number, b: number, period: number): boolean {
  const d = (((a - b) % period) + period) % period
  return d < 0.01 || period - d < 0.01
}

/** True when an identical pose (up to yaw symmetry) is already placed. */
export function isOccupied(
  placed: readonly PlacedPiece[],
  piece: BuildPiece,
  x: number,
  y: number,
  z: number,
  yaw: number,
): boolean {
  for (const p of placed) {
    if (p.piece !== piece) continue
    if (
      Math.abs(p.position[0] - x) > 0.02 ||
      Math.abs(p.position[1] - y) > 0.02 ||
      Math.abs(p.position[2] - z) > 0.02
    ) {
      continue
    }
    if (sameYaw(p.yaw, yaw, YAW_SYMMETRY[piece])) return true
  }
  return false
}

// --- Turbo hold-to-place cadence -------------------------------------------

/**
 * Pure slot-locked hold-to-place decision for one frame: a stamp happens on
 * the press edge or, while held, whenever the target slot is NEW for this
 * hold — never while the cooldown is running, never twice into the same
 * slot per hold (`attempted`, the caller's per-hold dedupe Set), never into
 * a slot whose piece died < 0.15 s ago (`locked`,
 * piece-slots.isDeathLocked), and never over an invalid target (occupied /
 * unsupported / out of reach — grid.TargetResult.valid). Returns the
 * cooldown to arm for the NEXT stamp (TURBO_FIRST after a fresh press,
 * TURBO_NEXT for held re-stamps), or null when no stamp happens.
 */
export function turboStamp(
  cooldownLeft: number,
  freshPress: boolean,
  valid: boolean,
  attempted: boolean,
  locked: boolean,
): number | null {
  if (cooldownLeft > 0) return null
  if (!valid || attempted || locked) return null
  return freshPress ? TURBO_FIRST : TURBO_NEXT
}

// --- Edit-mode cell picking -------------------------------------------------

export type CellHit = { t: number; col: number; row: number; bit: number }
const _cellHit: CellHit = { t: 0, col: 0, row: 0, bit: 0 }

/** Local coordinate → cell index along one 3-cell axis, clamped. */
function clampCell(v: number, extent: number): number {
  const c = Math.floor(((v + extent / 2) / extent) * CELLS)
  return c < 0 ? 0 : c > CELLS - 1 ? CELLS - 1 : c
}

/**
 * Ray vs a placed piece's FULL 3×3 box — mask-independent, so aiming at a
 * dead cell's hole still resolves (that's how you toggle a cell back on).
 * The ray is taken into the piece's local frame (inverse of the render
 * rotation YXZ: Ry(yaw)·Rx(tilt)) and slab-tested against the whole box;
 * the entry point maps to (col, row) → mask bit. Pure, no allocations —
 * RETURNS A REUSED MODULE OBJECT, copy fields to keep them.
 */
export function raycastPieceCell(
  piece: Pick<PlacedPiece, 'piece' | 'position' | 'yaw'>,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDist: number,
): CellHit | null {
  const pose = piecePose(piece.piece, piece.position[1])
  // Translate to the piece center, then rotate by Ry(−yaw) followed by
  // Rx(−tilt) (inverse of the YXZ world rotation).
  let lox = ox - piece.position[0]
  let loy = oy - pose.y
  let loz = oz - piece.position[2]
  const cy = Math.cos(piece.yaw)
  const sy = Math.sin(piece.yaw)
  let ldx = dx
  let ldy = dy
  let ldz = dz
  // Ry(−yaw): x' = x·cos − z·sin, z' = x·sin + z·cos.
  let tx = lox * cy - loz * sy
  loz = lox * sy + loz * cy
  lox = tx
  tx = ldx * cy - ldz * sy
  ldz = ldx * sy + ldz * cy
  ldx = tx
  if (piece.piece === 'roof') {
    // Rx(−tilt): y' = y·cos + z·sin, z' = −y·sin + z·cos.
    const ct = Math.cos(pose.tilt)
    const st = Math.sin(pose.tilt)
    let ty = loy * ct + loz * st
    loz = -loy * st + loz * ct
    loy = ty
    ty = ldy * ct + ldz * st
    ldz = -ldy * st + ldz * ct
    ldy = ty
  }

  const dims = PIECE_DIMS[piece.piece]
  const hx = dims[0] / 2
  const hy = dims[1] / 2
  const hz = dims[2] / 2
  // Slab test.
  let tMin = 0
  let tMax = maxDist
  for (let axis = 0; axis < 3; axis++) {
    const o = axis === 0 ? lox : axis === 1 ? loy : loz
    const d = axis === 0 ? ldx : axis === 1 ? ldy : ldz
    const h = axis === 0 ? hx : axis === 1 ? hy : hz
    if (Math.abs(d) < 1e-9) {
      if (o < -h || o > h) return null
      continue
    }
    let t0 = (-h - o) / d
    let t1 = (h - o) / d
    if (t0 > t1) {
      const swap = t0
      t0 = t1
      t1 = swap
    }
    if (t0 > tMin) tMin = t0
    if (t1 < tMax) tMax = t1
    if (tMin > tMax) return null
  }
  const t = tMin
  const px = lox + ldx * t
  const py = loy + ldy * t
  const pz = loz + ldz * t
  const col = clampCell(px, dims[0])
  const row = piece.piece === 'wall' ? clampCell(py, dims[1]) : clampCell(pz, dims[2])
  _cellHit.t = t
  _cellHit.col = col
  _cellHit.row = row
  _cellHit.bit = maskBit(col, row)
  return _cellHit
}

// --- Keep planning (pure mask → node math; lives here, not in keep.ts, so
// headless tests can import it without keep's viewer dependency) ------------

export type WallPocket = 'none' | 'window' | 'door'

export type WallMaskPlan =
  | { kind: 'skip' }
  | {
      kind: 'wall'
      /** Fully-dead columns to trim off the wall's start (col 0) end. */
      trimStartCols: number
      /** Fully-dead columns to trim off the wall's end (col 2) end. */
      trimEndCols: number
      /** Fully-dead TOP rows (0–2, counted from row 2 down) that trim the
       * kept node's HEIGHT — mask 7 → a 0.93 m half wall, 63 → 1.87 m.
       * Dead BOTTOM rows never trim (a wall node can't float). */
      trimTopRows: number
      pocket: WallPocket
      /** Column (0–2) of the window/door pocket; meaningful only when
       * `pocket !== 'none'`. Col 0 sits at the wall's START (local −X). */
      pocketCol: number
      /** False when the mask holds detail the node mapping approximates
       * away (interior holes that are neither window nor door pockets). */
      exact: boolean
    }

/** All three bits of column `col` (rows 0..2). */
function columnBits(col: number): number {
  return (1 << maskBit(col, 0)) | (1 << maskBit(col, 1)) | (1 << maskBit(col, 2))
}

/** All three bits of row `row` (cols 0..2). */
function rowBits(row: number): number {
  return (1 << maskBit(0, row)) | (1 << maskBit(1, row)) | (1 << maskBit(2, row))
}

/** Fresh exact full-wall plan — patch fields per pattern before returning. */
function fullWallPlan(): Extract<WallMaskPlan, { kind: 'wall' }> {
  return {
    kind: 'wall',
    trimStartCols: 0,
    trimEndCols: 0,
    trimTopRows: 0,
    pocket: 'none',
    pocketCol: 1,
    exact: true,
  }
}

/**
 * Pure wall-mask → node plan for Keep. Precedence (first match wins):
 * full → window@col → door@col → height-trim (dead TOP rows over fully
 * alive lower rows: masks 7/63) → span-trim (dead END columns) →
 * best-effort trimmed wall flagged `exact: false` → skip (all dead).
 * Pockets are the full ring minus EXACTLY the pocket bits, at any column:
 * window = middle-row cell dead; door = bottom cell (± the cell above).
 */
export function planWallMask(rawMask: number): WallMaskPlan {
  const mask = rawMask & FULL_MASK
  if (mask === 0) return { kind: 'skip' }
  if (mask === FULL_MASK) return fullWallPlan()
  for (let col = 0; col < CELLS; col++) {
    if (mask === (FULL_MASK & ~(1 << maskBit(col, 1)))) {
      return { ...fullWallPlan(), pocket: 'window', pocketCol: col }
    }
  }
  for (let col = 0; col < CELLS; col++) {
    const doorBit = 1 << maskBit(col, 0)
    const overBit = 1 << maskBit(col, 1)
    if (mask === (FULL_MASK & ~doorBit) || mask === (FULL_MASK & ~(doorBit | overBit))) {
      return { ...fullWallPlan(), pocket: 'door', pocketCol: col }
    }
  }
  // Height trim: fully-dead TOP rows over fully-alive remaining rows (the
  // low-cover / 2/3-wall edits). Dead BOTTOM rows under live ones would
  // float the node, so those fall through to the best-effort path instead.
  let trimTopRows = 0
  while (trimTopRows < CELLS - 1 && (mask & rowBits(CELLS - 1 - trimTopRows)) === 0) {
    trimTopRows++
  }
  if (trimTopRows > 0) {
    let lowerFull = true
    for (let row = 0; row < CELLS - trimTopRows; row++) {
      if ((mask & rowBits(row)) !== rowBits(row)) {
        lowerFull = false
        break
      }
    }
    if (lowerFull) return { ...fullWallPlan(), trimTopRows }
  }
  let trimStartCols = 0
  while (trimStartCols < CELLS && (mask & columnBits(trimStartCols)) === 0) trimStartCols++
  let trimEndCols = 0
  while (
    trimEndCols < CELLS - trimStartCols &&
    (mask & columnBits(CELLS - 1 - trimEndCols)) === 0
  ) {
    trimEndCols++
  }
  let exact = true
  for (let col = trimStartCols; col < CELLS - trimEndCols; col++) {
    if ((mask & columnBits(col)) !== columnBits(col)) {
      exact = false
      break
    }
  }
  return { ...fullWallPlan(), trimStartCols, trimEndCols, exact }
}

/** World-space start/end of a wall piece after trimming dead end columns.
 * Yaw of +yaw maps local +X to (cos yaw, −sin yaw) on the XZ plane; col 0
 * (the mask's start end) sits at local −X. */
export function trimmedWallSpan(
  position: readonly [number, number, number],
  yaw: number,
  trimStartCols: number,
  trimEndCols: number,
): { start: [number, number]; end: [number, number] } {
  const half = PIECE_DIMS.wall[0] / 2
  const cellW = PIECE_DIMS.wall[0] / CELLS
  const dx = Math.cos(yaw)
  const dz = -Math.sin(yaw)
  const s = -half + trimStartCols * cellW
  const e = half - trimEndCols * cellW
  return {
    start: [position[0] + dx * s, position[2] + dz * s],
    end: [position[0] + dx * e, position[2] + dz * e],
  }
}

// --- Edit-exit transforms (exact mask patterns rebuild the piece) -----------

/** Bottom row only alive — low half-wall cover (Keep trims to 0.93 m). */
export const HALF_WALL_MASK = 0b000000111 // 7
/** Bottom two rows alive — 2/3 wall (Keep trims to 1.87 m). */
export const TWO_THIRD_WALL_MASK = 0b000111111 // 63
/** Staircase silhouette, column heights 1·2·3 ascending toward local +X
 * (bits 0,1,2 + 4,5 + 8). */
export const STAIR_UP_MASK = 0b100110111 // 311
/** Staircase silhouette, column heights 3·2·1 ascending toward local −X
 * (bits 0,1,2 + 3,4 + 6). */
export const STAIR_DOWN_MASK = 0b001011111 // 95

export type EditTransform = { piece: BuildPiece; yaw: number }

/**
 * Exit-time wall-mask classification: an EXACT staircase silhouette
 * rebuilds the wall as the inclined roof piece rising WALL_H along the
 * wall's own run ("the wall folds down into a ramp"). The roof ascends
 * along its local +Z while wall columns run along local +X, so the tall
 * end at +X (311) needs yaw + π/2 and the tall end at −X (95) needs
 * yaw − π/2. Anything else — including near-misses — stays a free-form
 * carved mask and returns null.
 */
export function wallExitTransform(mask: number, wallYaw: number): EditTransform | null {
  const m = mask & FULL_MASK
  if (m === STAIR_UP_MASK) return { piece: 'roof', yaw: rotatedYaw(wallYaw, 1) }
  if (m === STAIR_DOWN_MASK) return { piece: 'roof', yaw: rotatedYaw(wallYaw, -1) }
  return null
}

/**
 * The transform a CLOSING edit should apply to `piece`, or null. Walls
 * only; exact stair masks only; refused when an identical pose (up to the
 * target piece's yaw symmetry) already exists among the OTHER placed
 * pieces — the transform must never stack a duplicate.
 */
export function planEditExitTransform(
  piece: Pick<PlacedPiece, 'id' | 'piece' | 'position' | 'yaw' | 'mask'>,
  placed: readonly PlacedPiece[],
): EditTransform | null {
  if (piece.piece !== 'wall') return null
  const transform = wallExitTransform(piece.mask, piece.yaw)
  if (!transform) return null
  const others = placed.filter((p) => p.id !== piece.id)
  const [x, y, z] = piece.position
  if (isOccupied(others, transform.piece, x, y, z, transform.yaw)) return null
  return transform
}

// --- Ghost (slot-locked) ----------------------------------------------------

type GhostState = {
  /** Resolved grid slot (grid.ts codec) — the ghost NEVER leaves the set. */
  slotId: string
  /** Slot pose, PlacedPiece semantics: x/z center, y = base elevation. */
  x: number
  y: number
  z: number
  yaw: number
  piece: BuildPiece
  valid: boolean
  reason: TargetResult['reason']
  /** Legacy mirror for older E2E scripts: reason === 'occupied'. */
  occupied: boolean
}

/** Per-frame mirror of the resolved ghost for the dev handle (no allocs). */
const _debugGhost: GhostState = {
  slotId: '',
  x: 0,
  y: 0,
  z: 0,
  yaw: 0,
  piece: 'wall',
  valid: false,
  reason: 'unsupported',
  occupied: false,
}

/**
 * Dev-only handle (published as `globalThis.__bootsBuilder` while the game
 * runs — same pattern as `__bootsPlayer`): headless E2E can't engage pointer
 * lock, so `holdFire` stands in for the held LMB (it is OR-ed with the real
 * input each frame). `ghost()` snapshots the currently resolved slot ghost
 * (slotId + pose + valid + reason — QA asserts the pose is ∈ the discrete
 * slot set). `isEditing` mirrors the F edit mode each frame — viewmodel.tsx
 * feature-detects it to keep Q piece-cycling out of an open edit.
 */
export const builderDebug: { holdFire: boolean; isEditing: boolean; ghost: () => GhostState } = {
  holdFire: false,
  isEditing: false,
  ghost: () => ({ ..._debugGhost }),
}

/**
 * Pure R-rotate math: the ghost's auto-facing yaw plus `quarterTurns` manual
 * 90° presses, wrapped to [−π, π) so repeated pressing never grows the
 * angle unboundedly (sameYaw and pose storage stay well-conditioned).
 * Negative turn counts are valid (wrap the other way).
 */
export function rotatedYaw(autoYaw: number, quarterTurns: number): number {
  const yaw = autoYaw + (((quarterTurns % 4) + 4) % 4) * (Math.PI / 2)
  return ((((yaw + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI
}

/** Reused per-frame input for grid.resolveTargetSlot (no hot-loop allocs). */
const _targetInput: TargetInput = {
  position: [0, 0, 0],
  yaw: 0,
  pitch: 0,
  piece: 'wall',
  rotState: 0,
}

/** grid.resolveTargetSlot's world probe — piece-slots.ts is the single
 * occupancy/support authority (registry + support graph + scene probe). */
const slotWorldProbe = { isOccupied: slotIsOccupied, isSupported: slotIsSupported }

// --- Scene-support probe + collapse wiring ----------------------------------

/** Collider nodeId prefix for placed pieces (PlacedPieceMesh entries). */
const PIECE_NODE_PREFIX = '__boots-piece-'
/** Contact margin around a slot's volume for the scene-support test. */
const PROBE_MARGIN = 0.35
const _probeBox = new Box3()

/** AABB of the piece volume a slot holds (walls are planes, floors faces,
 * roofs the whole cell) — the box scene geometry must touch to prop it. */
function setSlotBox(slot: Slot, box: Box3): void {
  const x0 = slot.i * CELL
  const z0 = slot.k * CELL
  const y0 = slot.s * STOREY
  switch (slot.kind) {
    case 'Wx':
      box.min.set(x0, y0, z0)
      box.max.set(x0, y0 + STOREY, z0 + CELL)
      break
    case 'Wz':
      box.min.set(x0, y0, z0)
      box.max.set(x0 + CELL, y0 + STOREY, z0)
      break
    case 'F':
      box.min.set(x0, y0, z0)
      box.max.set(x0 + CELL, y0, z0 + CELL)
      break
    case 'R':
      box.min.set(x0, y0, z0)
      box.max.set(x0 + CELL, y0 + STOREY, z0 + CELL)
      break
  }
  box.expandByScalar(PROBE_MARGIN)
}

/**
 * Scene-support probe for piece-slots.setSceneSupportProbe: true while LIVE
 * scene geometry touches the slot's volume. Placed-piece colliders are
 * skipped (they support each other through the graph — counting them here
 * would prop every orphan). Disabled colliders defer to their voxel
 * replica's liveness: at least one alive voxel inside the box (REVIEW risk
 * note — a demolished scene wall must drop its dependents). Answers are
 * cached per slot by piece-slots; destruction hooks invalidate via
 * notifySceneSupportChanged.
 */
function makeSceneSupportProbe(world: GameWorld): SceneSupportProbe {
  return (id) => {
    const slot = parseSlotId(id)
    if (!slot) return false
    setSlotBox(slot, _probeBox)
    for (const entry of world.colliders) {
      if (entry.nodeId.startsWith(PIECE_NODE_PREFIX)) continue
      if (!entry.worldBox.intersectsBox(_probeBox)) continue
      if (!entry.disabled) return true
      const target = useDestruction.getState().targets.get(entry.nodeId)
      if (!target) continue
      const { centers, alive, count } = target.grid
      for (let v = 0; v < count; v++) {
        if (alive[v] === 0) continue
        const c = v * 3
        if (
          centers[c]! >= _probeBox.min.x &&
          centers[c]! <= _probeBox.max.x &&
          centers[c + 1]! >= _probeBox.min.y &&
          centers[c + 1]! <= _probeBox.max.y &&
          centers[c + 2]! >= _probeBox.min.z &&
          centers[c + 2]! <= _probeBox.max.z
        ) {
          return true
        }
      }
    }
    return false
  }
}

// --- Budgeted clad queue (TURBO CLAD BUDGET — see the header block) ----------

/** Placements arriving closer together than this (ms) read as a turbo burst
 * and defer. Sits between the turbo cadences: TURBO_FIRST placements
 * (≥150 ms apart — every single click) voxelize instantly, TURBO_NEXT sweep
 * stamps (50 ms apart) queue. 125 ms ≡ the REVIEW's ~8/s threshold. */
export const CLAD_BURST_MS = 125
/** Deferred voxelizations drained per frame (~120/s at 60 fps — comfortably
 * above the 20/s turbo worst case, so the backlog stays a few frames deep). */
export const CLAD_DRAIN_PER_FRAME = 2

const cladNow: () => number =
  typeof performance !== 'undefined' ? () => performance.now() : () => Date.now()

/** FIFO of deferred clads. Entries are never spliced — cancellation just
 * drops the nodeId from `cladPending`, and the drain skips stale rows —
 * so `cladHead` walks forward without reshuffling (no hot-loop work). */
const cladQueue: { world: GameWorld; nodeId: string }[] = []
let cladHead = 0
/** nodeIds still owed a clad — the dedupe (one queue row per piece) AND the
 * cancellation token (unmount deletes; the drain honors the deletion). */
const cladPending = new Set<string>()
let lastCladRequestAt = Number.NEGATIVE_INFINITY

/** Deferred clads still owed (skips cancelled rows) — QA/test hook. */
export function cladQueueSize(): number {
  return cladPending.size
}

/**
 * Voxel-clad `nodeId` now if placements are landing slowly (single clicks —
 * the instant-bricks feel is untouched), else join the FIFO: a burst is a
 * request < CLAD_BURST_MS after the previous one, and while ANY backlog
 * exists newcomers queue behind it regardless of their gap (FIFO order
 * beats freshness — draining must never starve the oldest plain piece).
 * `nowMs` is injectable for tests; callers omit it.
 */
export function requestPieceClad(world: GameWorld, nodeId: string, nowMs = cladNow()): void {
  const burst = nowMs - lastCladRequestAt < CLAD_BURST_MS
  lastCladRequestAt = nowMs
  if (!burst && cladPending.size === 0) {
    ensureVoxelTarget(world, nodeId)
    return
  }
  if (cladPending.has(nodeId)) return
  cladPending.add(nodeId)
  cladQueue.push({ world, nodeId })
}

/** Forget a pending clad (piece unmounted before its turn). Idempotent;
 * a nodeId that already clad — or was never queued — is a no-op. */
export function cancelPieceClad(nodeId: string): void {
  cladPending.delete(nodeId)
}

/**
 * Voxelize up to `limit` deferred pieces (cancelled rows don't count
 * against the budget). PlacedPieces drives this once per frame. A piece
 * that already clad through another door (damageTarget on a bullet hit)
 * no-ops here — ensureVoxelTarget returns the live target untouched.
 */
export function drainCladQueue(limit = CLAD_DRAIN_PER_FRAME): void {
  let clad = 0
  while (cladHead < cladQueue.length && clad < limit) {
    const request = cladQueue[cladHead++]!
    if (!cladPending.delete(request.nodeId)) continue // cancelled while queued
    ensureVoxelTarget(request.world, request.nodeId)
    clad++
  }
  if (cladHead >= cladQueue.length) {
    cladQueue.length = 0 // fully drained — release the world refs
    cladHead = 0
  }
}

/** Session teardown / test isolation: drop the backlog and the burst clock. */
export function resetCladQueue(): void {
  cladQueue.length = 0
  cladHead = 0
  cladPending.clear()
  lastCladRequestAt = Number.NEGATIVE_INFINITY
}

const PIECE_DEBRIS_COLOR = new Color('#9aa8b5')
/** Debris chunks per collapsed piece — a visible burst, not a particle storm
 * (cascades can evict dozens of pieces back-to-back). */
const COLLAPSE_DEBRIS = 7

/** One placed piece: the RENDERED merged-cell mesh doubles as its collider,
 * and the piece is voxel-clad THE MOMENT it lands — the layout effect
 * routes it through requestPieceClad (before first paint), which for a
 * single placement runs ensureVoxelTarget right away: it ledger-hides this
 * mesh, disables the collider entry it just pushed (voxels own collision +
 * bullets from frame one — never double-solid), and hands rendering to the
 * voxel replica: bricks from the beginning. TURBO bursts defer instead
 * (see the clad queue above): the piece stays this plain solid mesh —
 * visible, collidable, shootable — until the per-frame drain clads it.
 * A mask edit swaps the piece OBJECT in the store, so this effect re-runs:
 * the old collider entry is spliced out (and the voxel replica of the old
 * shape dropped) and a fresh entry with the new merged-cell BVH goes in,
 * then re-voxelizes into the new shape. Placed entries are always APPENDED
 * after the world's build-time colliders, so splicing them out never shifts
 * the door colliderIndices. */
function PlacedPieceMesh({ piece, world }: { piece: PlacedPiece; world: GameWorld }) {
  const meshRef = useRef<Mesh>(null)
  const geometry = geometryForMask(piece.piece, piece.mask)

  useLayoutEffect(() => {
    const mesh = meshRef.current
    if (!mesh || !geometry) return
    // A mask edit on a voxelized piece re-registers this SAME mesh object,
    // but ensureVoxelTarget had ledger-hidden it — bring it back before
    // re-cladding (also the visible fallback if voxelization refuses).
    mesh.visible = true
    mesh.updateWorldMatrix(true, false)
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
    const entry: ColliderEntry = {
      mesh,
      bvh: bvhFor(mesh),
      inverse: new Matrix4().copy(mesh.matrixWorld).invert(),
      worldBox: mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld),
      root: mesh,
      nodeId: `${PIECE_NODE_PREFIX}${piece.id}`,
      nodeType: 'block',
    }
    world.colliders.push(entry)
    // INSTANT BRICKS, budgeted: single placements voxelize now, not on
    // first hit; turbo bursts defer to the clad FIFO. Either way
    // ensureVoxelTarget hides the mesh and sets entry.disabled itself when
    // it runs; a null return means a degenerate grid — the plain solid
    // mesh above stays as the fallback (the same look a deferred piece
    // wears while it waits).
    requestPieceClad(world, entry.nodeId)
    return () => {
      cancelPieceClad(entry.nodeId) // still queued → never clad a dead entry
      entry.disabled = true
      const index = world.colliders.indexOf(entry)
      if (index !== -1) world.colliders.splice(index, 1)
      // Drop the voxel replica too (Z-undo or a mask edit would otherwise
      // leave carved voxels of the old shape floating).
      dropTarget(entry.nodeId)
    }
  }, [world, piece, geometry])

  if (!geometry) return null // every cell dead — nothing to render or collide
  const pose = piecePose(piece.piece, piece.position[1])
  return (
    <mesh
      castShadow
      geometry={geometry}
      position={[piece.position[0], pose.y, piece.position[2]]}
      ref={meshRef}
      rotation={[piece.piece === 'roof' ? pose.tilt : 0, piece.yaw, 0, 'YXZ']}
    >
      <meshStandardMaterial color="#9aa8b5" roughness={0.7} metalness={0.15} />
    </mesh>
  )
}

/** Solid, collidable render of everything placed this session — and the
 * session wiring for the slot registry: installs the scene-support probe,
 * re-registers any stored pieces (re-entry with a pending Keep/Discard),
 * owns the collapse listener (store removal + debris burst; the piece's
 * unmount then runs the exact undo cleanup: collider splice + voxel
 * dropTarget), and drains the budgeted clad FIFO a few pieces per frame.
 * Unmount = session teardown → resetPieceSlots() + resetCladQueue(). */
export function PlacedPieces({ world }: { world: GameWorld }) {
  const placed = useBoots((s) => s.placed)

  useFrame(() => {
    drainCladQueue()
  })

  useEffect(() => {
    setSceneSupportProbe(makeSceneSupportProbe(world))
    for (const p of useBoots.getState().placed) {
      if (p.slotId) registerPlacement(p.slotId, p.id)
    }
    const off = onCollapse((pieceId) => {
      const piece = useBoots.getState().removePlaced(pieceId)
      if (!piece) return
      const pose = piecePose(piece.piece, piece.position[1])
      for (let n = 0; n < COLLAPSE_DEBRIS; n++) {
        spawnDebris(
          piece.position[0] + (Math.random() - 0.5) * 2.4,
          pose.y + (Math.random() - 0.5) * 1.6,
          piece.position[2] + (Math.random() - 0.5) * 2.4,
          0.14,
          PIECE_DEBRIS_COLOR,
          2.5,
        )
      }
      sfx.crumble(10) // ~voxel-count scale (destruction.ts convention): one mid-weight fall
    })
    return () => {
      off()
      resetPieceSlots() // cancels pending rings; probe + registry die with the session
      resetCladQueue() // pending clads die too (their meshes just unmounted)
    }
  }, [world])

  return (
    <group userData={{ __boots: true }}>
      {placed.map((piece) => (
        <PlacedPieceMesh key={piece.id} piece={piece} world={world} />
      ))}
    </group>
  )
}

/** Max distance for entering/holding F edit mode on a placed piece. */
const EDIT_RANGE = 6
/** Stable bit list for the edit overlay's cells (no per-render allocs). */
const EDIT_CELL_BITS = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const

type EditState = {
  /** PlacedPiece id under edit. */
  id: number
  /** Mask bit of the cell under the crosshair. */
  hover: number
  /** Mirror of the piece's mask (drives overlay re-render on toggle). */
  mask: number
  piece: BuildPiece
  x: number
  y: number
  z: number
  yaw: number
}

/** Edit-exit confirm: classify the closing piece's final mask — an exact
 * stair silhouette rebuilds it as a ramp IN PLACE (same id: the
 * piece-object-swap contract re-registers mesh, collider BVH and voxel
 * replica; Z-undo ordering is untouched). An occupied target pose refuses
 * silently — the carve stays a carve, no sfx. */
function applyEditExitTransform(id: number): void {
  const state = useBoots.getState()
  const piece = state.placed.find((p) => p.id === id)
  if (!piece) return
  const transform = planEditExitTransform(piece, state.placed)
  if (!transform) return
  state.transformPlaced(id, transform.piece, transform.yaw)
  sfx.place()
}

export function Builder() {
  const ghostRef = useRef<Group>(null)
  const [ghost, setGhost] = useState<GhostState | null>(null)
  const [edit, setEdit] = useState<EditState | null>(null)
  const prevFire = useRef(false)
  const prevAltFire = useRef(false)
  const prevUndo = useRef(false)
  const prevEditKey = useRef(false)
  const prevRotate = useRef(false)
  /** R rotState (0..3) — grid semantics: wall far-edge flip (parity), roof
   * ascent quarter. Persists across placements and holsters; resets on
   * piece-TYPE switch ONLY (REVIEW contract). */
  const rotateTurns = useRef(0)
  const rotatePiece = useRef<BuildPiece>('wall')
  const placeCooldown = useRef(0)
  /** Slots already stamped during the CURRENT hold — one attempt per slot
   * per hold (turbo dedupe); cleared on release. */
  const holdAttempted = useRef<Set<string>>(new Set())

  const weapon = useBoots((s) => s.weapon)
  const buildPiece = useBoots((s) => s.buildPiece)
  const active = weapon === 'builder'

  useEffect(() => {
    ;(globalThis as Record<string, unknown>).__bootsBuilder = builderDebug
    return () => {
      builderDebug.holdFire = false
      builderDebug.isEditing = false
      getSession()?.hud.ghostStatus?.(null, 'builder')
      delete (globalThis as Record<string, unknown>).__bootsBuilder
    }
  }, [])

  // HUD mode-hint line: shown while the 3x3 cell editor is open, cleared on
  // exit/unmount (hud.editHint owns its own element — prompts never clobber it).
  const editing = edit !== null
  useEffect(() => {
    const session = getSession()
    if (!session) return
    session.hud.editHint(editing ? 'F done · LMB carve · RMB reset' : null)
    return () => {
      getSession()?.hud.editHint(null)
    }
  }, [editing])

  useFrame((_, dt) => {
    const session = getSession()
    if (!session) return
    placeCooldown.current -= dt

    if (!active) {
      if (ghost) setGhost(null)
      if (edit) {
        // Weapon-switch closes the edit too — same exit-time confirm.
        applyEditExitTransform(edit.id)
        setEdit(null)
      }
      session.hud.ghostStatus?.(null, 'builder')
      builderDebug.isEditing = false
      holdAttempted.current.clear()
      prevFire.current = session.input.state.firing || builderDebug.holdFire
      prevAltFire.current = session.input.state.altFiring
      prevEditKey.current = session.input.state.keys.has('KeyF')
      prevRotate.current = session.input.state.keys.has('KeyR')
      return
    }

    const firingNow = session.input.state.firing || builderDebug.holdFire
    const staggered = useBoots.getState().staggered
    // F edge — requires 'KeyF' in input.ts GAME_KEYS to ever be pressed.
    const editKey = session.input.state.keys.has('KeyF')
    const editKeyEdge = editKey && !prevEditKey.current
    prevEditKey.current = editKey

    // Aim ray (same convention as shooting.ts): eye origin, yaw/pitch dir.
    const cp = Math.cos(playerRig.pitch)
    const aox = playerRig.position.x
    const aoy = playerRig.position.y
    const aoz = playerRig.position.z
    const adx = -Math.sin(playerRig.yaw) * cp
    const ady = Math.sin(playerRig.pitch)
    const adz = -Math.cos(playerRig.yaw) * cp

    // ── EDIT MODE ─────────────────────────────────────────────────────────
    if (edit) {
      builderDebug.isEditing = true
      if (ghost) setGhost(null)
      session.hud.ghostStatus?.(null, 'builder') // no ghost while editing cells
      // Z undo is paused while editing, but keep its edge tracker warm so
      // holding Z across the exit never fires a stale undo. R's rotState
      // survives an edit (REVIEW: it resets on piece-type switch ONLY);
      // keep its edge tracker warm too.
      prevUndo.current = session.input.state.keys.has('KeyZ')
      prevRotate.current = session.input.state.keys.has('KeyR')
      const altFiringNow = session.input.state.altFiring
      const piece = useBoots.getState().placed.find((p) => p.id === edit.id)
      const hit = piece ? raycastPieceCell(piece, aox, aoy, aoz, adx, ady, adz, EDIT_RANGE) : null
      // Exit: F again, the piece is gone, or the aim left it. Exit-time is
      // the confirm: the final mask classifies, exact stair silhouettes
      // fold the wall into a ramp (see wallExitTransform).
      if (!piece || !hit || editKeyEdge) {
        if (piece) applyEditExitTransform(piece.id)
        setEdit(null)
        builderDebug.isEditing = false
        placeCooldown.current = TURBO_FIRST // a beat before hold-place resumes
        prevFire.current = firingNow
        prevAltFire.current = altFiringNow
        return
      }
      if (firingNow && !prevFire.current && !staggered) {
        useBoots.getState().setPlacedMask(piece.id, piece.mask ^ (1 << hit.bit))
        sfx.place()
      }
      // RMB resets the edit — the piece snaps back to intact (511). ADS is
      // pistol/rifle-only, so the builder owns RMB freely.
      if (altFiringNow && !prevAltFire.current && piece.mask !== FULL_MASK) {
        useBoots.getState().setPlacedMask(piece.id, FULL_MASK)
        sfx.place()
      }
      prevFire.current = firingNow
      prevAltFire.current = altFiringNow
      const mask = useBoots.getState().placed.find((p) => p.id === edit.id)?.mask ?? piece.mask
      if (edit.hover !== hit.bit || edit.mask !== mask) {
        setEdit({ ...edit, hover: hit.bit, mask })
      }
      return
    }
    builderDebug.isEditing = false
    if (editKeyEdge) {
      // Enter edit: nearest of YOUR placed pieces the crosshair touches ≤ 6 m.
      let best: PlacedPiece | null = null
      let bestT = EDIT_RANGE
      let bestBit = 0
      for (const p of useBoots.getState().placed) {
        const hit = raycastPieceCell(p, aox, aoy, aoz, adx, ady, adz, EDIT_RANGE)
        if (hit && hit.t <= bestT) {
          best = p
          bestT = hit.t
          bestBit = hit.bit
        }
      }
      if (best) {
        setEdit({
          id: best.id,
          hover: bestBit,
          mask: best.mask,
          piece: best.piece,
          x: best.position[0],
          y: best.position[1],
          z: best.position[2],
          yaw: best.yaw,
        })
        builderDebug.isEditing = true
        if (ghost) setGhost(null)
        prevFire.current = firingNow
        prevAltFire.current = session.input.state.altFiring
        return
      }
    }

    // R ROTATE (grid semantics): wall = far-edge flip of the target cell
    // (parity — beats the ray), roof = ascent quarter-turn cycle, floor =
    // no-op (the key is ignored, no detent). rotState persists across
    // placements; it resets when the piece TYPE changes only (a wall's
    // flip shouldn't secretly re-aim your next roof).
    if (buildPiece !== rotatePiece.current) {
      rotatePiece.current = buildPiece
      rotateTurns.current = 0
    }
    const rotateDown = session.input.state.keys.has('KeyR')
    if (rotateDown && !prevRotate.current && buildPiece !== 'floor') {
      rotateTurns.current = (rotateTurns.current + 1) % 4
      sfx.weaponSwitch() // audible detent per accepted quarter turn
    }
    prevRotate.current = rotateDown

    // GRID-LOCKED TARGET: the ghost only ever occupies a discrete slot.
    // resolveTargetSlot wants FEET; playerRig.position is the eye. The
    // world probe is piece-slots.ts — the single occupancy/support
    // authority (registry + support graph + scene probe + terrain rule).
    _targetInput.position[0] = playerRig.position.x
    _targetInput.position[1] = playerRig.position.y - EYE_HEIGHT
    _targetInput.position[2] = playerRig.position.z
    _targetInput.yaw = playerRig.yaw
    _targetInput.pitch = playerRig.pitch
    _targetInput.piece = buildPiece
    _targetInput.rotState = rotateTurns.current
    const target = resolveTargetSlot(_targetInput, slotWorldProbe)
    const pose = target.pose
    const occupied = target.reason === 'occupied'

    if (
      !ghost ||
      ghost.slotId !== target.slotId ||
      ghost.piece !== buildPiece ||
      ghost.yaw !== pose.yaw ||
      ghost.valid !== target.valid ||
      ghost.reason !== target.reason
    ) {
      setGhost({
        slotId: target.slotId,
        x: pose.position[0],
        y: pose.position[1],
        z: pose.position[2],
        yaw: pose.yaw,
        piece: buildPiece,
        valid: target.valid,
        reason: target.reason,
        occupied,
      })
    }
    _debugGhost.slotId = target.slotId
    _debugGhost.x = pose.position[0]
    _debugGhost.y = pose.position[1]
    _debugGhost.z = pose.position[2]
    _debugGhost.yaw = pose.yaw
    _debugGhost.piece = buildPiece
    _debugGhost.valid = target.valid
    _debugGhost.reason = target.reason
    _debugGhost.occupied = occupied

    // Failing reason drives the tiny status line under the crosshair
    // (hud.ts:ghostStatus, the documented caller). Change-gated in the
    // HUD; free per frame.
    session.hud.ghostStatus?.(target.valid ? null : target.reason, 'builder')

    // TURBO hold-to-place: press edge stamps and arms TURBO_FIRST; while
    // held, every NEW slot this hold stamps at TURBO_NEXT cadence. Dedupe:
    // one attempt per slotId per hold; died slots are locked out 0.15 s
    // (piece-slots stamps them on ANY removal — undo, cascade, weapon).
    // Invalid targets are skipped silently. Staggered hands can't stamp
    // (matches the viewmodel's fire block); prevFire still tracks the raw
    // button so recovery doesn't edge-place.
    const firing = session.input.state.firing || builderDebug.holdFire
    if (firing && !useBoots.getState().staggered) {
      const freshPress = !prevFire.current
      if (freshPress) holdAttempted.current.clear()
      const arm = turboStamp(
        placeCooldown.current,
        freshPress,
        target.valid,
        holdAttempted.current.has(target.slotId),
        isDeathLocked(target.slotId),
      )
      if (arm !== null) {
        placeCooldown.current = arm
        const stored = useBoots.getState().addPlaced({
          piece: buildPiece,
          position: [pose.position[0], pose.position[1], pose.position[2]],
          yaw: pose.yaw,
          slotId: target.slotId,
        })
        if (registerPlacement(target.slotId, stored.id)) {
          holdAttempted.current.add(target.slotId)
          sfx.place()
        } else {
          // The registry refused (two authorities disagreed — must not
          // happen, but the registry wins): roll the store append back.
          useBoots.getState().removePlaced(stored.id)
        }
      }
    } else if (holdAttempted.current.size > 0) {
      holdAttempted.current.clear() // hold released — dedupe set is per-hold
    }
    prevFire.current = firing
    prevAltFire.current = session.input.state.altFiring

    // UNDO on KeyZ (G is the grenade everywhere now). onPieceRemoved is the
    // ONE removal entry point: it stamps the died-slot lockout and cascades
    // anything the removal orphaned (the collapse listener in PlacedPieces
    // evicts those pieces through the same store path).
    const undoDown = session.input.state.keys.has('KeyZ')
    if (undoDown && !prevUndo.current) {
      const removed = useBoots.getState().removeLastPlaced()
      if (removed) {
        if (removed.slotId) onPieceRemoved(removed.slotId)
        sfx.weaponSwitch()
      }
    }
    prevUndo.current = undoDown
  })

  if (!active) return null

  // Edit-mode overlay: a 3×3 ghost grid over the piece — hovered cell hot,
  // live cells cool blue, dead cells faint red (click resurrects them).
  if (edit) {
    const pose = piecePose(edit.piece, edit.y)
    const dims = cellDims(edit.piece)
    return (
      <group
        position={[edit.x, pose.y, edit.z]}
        rotation={[edit.piece === 'roof' ? pose.tilt : 0, edit.yaw, 0, 'YXZ']}
        userData={{ __boots: true }}
      >
        {EDIT_CELL_BITS.map((bit) => {
          const center = cellCenter(edit.piece, bit % CELLS, Math.floor(bit / CELLS))
          const hovered = edit.hover === bit
          const alive = (edit.mask & (1 << bit)) !== 0
          return (
            <mesh key={bit} position={center}>
              <boxGeometry args={[dims[0] * 1.03, dims[1] * 1.03, dims[2] * 1.03]} />
              <meshBasicMaterial
                color={hovered ? '#ffd34d' : alive ? '#59a7ff' : '#ff5a4d'}
                depthWrite={false}
                opacity={hovered ? 0.55 : alive ? 0.18 : 0.3}
                transparent
              />
            </mesh>
          )
        })}
      </group>
    )
  }

  if (!ghost) return null
  const pose = piecePose(ghost.piece, ghost.y)
  // Inflated 1.03 like the edit overlay above: a ghost hovering over an
  // already-placed piece would otherwise sit exactly coplanar with its
  // faces and z-fight (transparent + no depthWrite still depth-TESTS).
  const ghostDims = PIECE_DIMS[ghost.piece]
  return (
    <group ref={ghostRef} userData={{ __boots: true }}>
      <mesh
        position={[ghost.x, pose.y, ghost.z]}
        rotation={[ghost.piece === 'roof' ? pose.tilt : 0, ghost.yaw, 0, 'YXZ']}
      >
        <boxGeometry args={[ghostDims[0] * 1.03, ghostDims[1] * 1.03, ghostDims[2] * 1.03]} />
        <meshBasicMaterial
          color={ghost.valid ? '#59a7ff' : '#ff5a4d'}
          depthWrite={false}
          opacity={0.38}
          transparent
        />
      </mesh>
    </group>
  )
}
