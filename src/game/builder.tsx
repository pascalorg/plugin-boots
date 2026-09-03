'use client'

import { useFrame } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  Box3,
  BoxGeometry,
  type BufferGeometry,
  Color,
  EdgesGeometry,
  type Group,
  Matrix4,
  type Mesh,
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import {
  type BuildOpening,
  type BuildPiece,
  FULL_MASK,
  type PlacedPiece,
  useBoots,
} from '../store'
import { sfx } from './audio'
import { EYE_HEIGHT } from './collision'
import { spawnDebris } from './debris'
import { dropTarget, ensureVoxelTarget, useDestruction } from './destruction'
import { CornerEditOverlay, disposeOverlayGeometryCaches, EditOverlay } from './edit-overlay'
import {
  CELL,
  getGridAnchor,
  getStoreyLadder,
  type GridAnchor,
  gridTerrainY,
  parseSlotId,
  resetGridAnchor,
  resetGridTerrainY,
  resetStoreyLadder,
  resolveTargetSlot,
  setGridAnchor,
  setGridTerrainY,
  setStoreyLadder,
  type Slot,
  storeyBase,
  storeySpan,
  type TargetInput,
  type TargetResult,
  worldToGrid,
} from './grid'
import { groundSurfaceY } from './ground'
import { itemGhostActive } from './item-place'
import { perfEvent } from './perf-monitor'
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
import {
  CORNER_RISE,
  cornerRoofGeometry,
  cornersEqual,
  disposeCornerRoofGeometryCache,
  raycastRoofCorner,
  ROOF_PRESETS,
  type RoofCorners,
  SLOPE_CORNERS,
  toggleCorner,
} from './roof-corners'
import { getSession } from './session'
import {
  buildSyncOn,
  forgetGridStamp,
  forgetSharedPieces,
  isForeignPiece,
  publishGridStamp,
  reconcileSharedPieces,
  setBuildSyncNotice,
  sharedBuildDebug,
} from './shared-build'
import { bvhFor, type ColliderEntry, type GameWorld, installGroundProbes } from './world'

/**
 * Build mode, grid-locked grammar (BUILD-GRAMMAR-V2 + REVIEW): wall / floor
 * / stairs / roof (direct hotkeys Z/X/C/V while the builder is held, Q
 * still cycles), the ghost ONLY ever occupies discrete world-grid slots —
 * it snaps, never floats. 'stairs' is the walkable tilted plank; 'roof' is
 * the 2×2 corner-height patch (both live on R slots — one per slot).
 * Placements are game-only state — the panel's Keep converts them into real
 * scene nodes afterwards, Discard forgets everything. U undoes (piece +
 * collider + any voxel replica + support cascade) — Z selects the wall now,
 * G is the grenade.
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
 * stairs = ascent quarter-turn cycle, roof = SHAPE-preset cycle (slope →
 * corner-tip → valley → flat cap; yaw stays aimed by the facing). Persists
 * across placements; resets on piece-TYPE switch only (REVIEW contract).
 *
 * TURBO hold-to-place: the press edge stamps immediately and arms
 * TURBO_FIRST (0.15 s); while held, every NEW target slot stamps at
 * TURBO_NEXT (0.05 s) cadence — at most one attempt per slotId per hold
 * (dedupe Set, cleared on release) and never into a slot whose piece died
 * < 0.15 s ago (piece-slots.isDeathLocked, stamped by onPieceRemoved).
 *
 * Undo (U) and the support cascade share ONE removal path:
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
 * 9-bit `mask` (bit = col + row·3; wall cells 1 × 0.93 × 0.12, floor/stairs
 * cells split the plane 3×3; corner-roof patches ignore it). The RENDERED mesh is ONE merged-box geometry
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
 * ── THE WALL FAMILY: DOORS AND WINDOWS (owner ask 2026-09-01) ──────────────
 * "In the build menu make sure I could place windows and doors as well. In a
 * way that makes sense. And that I could use them by pressing E afterward."
 * A door and a window are NOT new pieces: they are a WALL whose middle
 * column is pocketed (DOOR_MASK / WINDOW_MASK — the exact patterns
 * planWallMask already classifies). That choice is the whole design:
 *   - the aperture is a real hole in the rendered mesh, the collider and the
 *     voxel replica from the first frame, because the mask already drives all
 *     three (geometryForMask);
 *   - multiplayer replication is free — the piece record already carries
 *     `mask`, so a peer's door arrives as a door with NO wire-format change;
 *   - Keep already turns those exact masks into real host door/window nodes
 *     pocketed into the wall (keep.ts's MASK → NODE MAPPING);
 *   - support, occupancy and slot addressing are untouched: it is a wall.
 * The swinging leaf/sash that E operates is derived from the same mask by
 * fittings.tsx — nothing about it is stored.
 * SELECTION: Z is the wall FAMILY key — press it again to step solid → door
 * → window (nextWallVariant); Q cycles the whole menu (BUILD_CYCLE). The
 * ghost previews the pocketed mask, so you see the hole before you place.
 *
 * ── API (exported for tests / other systems) ──────────────────────────────
 *   PIECE_DIMS / pieceDims / piecePose    piece geometry + pose from base
 *       elevation; span-parameterized where height matters (ADAPTIVE
 *       STOREYS: pieces conform to their slot's grid.storeySpan, stamped
 *       into PlacedPiece.height at placement — legacy default WALL_H).
 *   CELLS / maskBit / cellDims / cellCenter    3×3 cell math (local frame).
 *   raycastPieceCell(piece, ox, oy, oz, dx, dy, dz, maxDist)   ray vs the
 *       FULL piece box (mask-independent so dead cells can be re-added) →
 *       { t, col, row, bit } | null. RETURNS A REUSED MODULE OBJECT.
 *   turboStamp(cooldownLeft, freshPress, valid, attempted, locked)   pure
 *       slot-locked hold-to-place decision → cooldown to arm, or null.
 *   isOccupied(placed, piece, x, y, z, yaw)   identical-pose test, yaw
 *       compared modulo the piece's symmetry (wall π, floor π/2,
 *       stairs/roof 2π).
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

/** The LEGACY storey span — the default wherever a piece carries no
 * `height` of its own (pieces placed before adaptive storeys, hand-built
 * test fixtures). Placement stamps grid.storeySpan(slot.s) instead, so
 * pieces conform to the building's real level heights. */
export const WALL_H = 2.8
/** Turbo hold-to-place cadence: the fresh-press stamp arms the longer
 * lockout, held new-slot re-stamps run at the fast one (≥0.05 s apart). */
export const TURBO_FIRST = 0.15
export const TURBO_NEXT = 0.05

/** Roof dims are the FALLBACK box only (legacy corner-less pieces): placed
 * roofs render/collide as the bilinear patch (roof-corners.ts).
 * Stairs plank: a 3 m cell run rising exactly ONE STOREY (2.8 m) — its
 * length is the hypotenuse √(3² + 2.8²) ≈ 4.103, hence 4.1. Deliberately
 * NOT a 45° / 4.24 m plank: STOREY (2.8) ≠ CELL (3), and a 45° rise would
 * top out 0.2 m proud of the storey line, so stacked levels and the
 * ramp-chain flow wouldn't land flush.
 * These are the LEGACY (span 2.8) dims — span-aware callers go through
 * pieceDims(piece, span). */
export const PIECE_DIMS: Record<BuildPiece, [number, number, number]> = {
  wall: [3, WALL_H, 0.12],
  floor: [3, 0.12, 3],
  stairs: [3, 0.12, 4.1],
  roof: [3, 0.12, 3],
}

/** Span-parameterized dims cache — a handful of spans per session (one per
 * building level), so the maps stay tiny. Nested (piece → span) so hot
 * paths (raycastPieceCell runs per frame in edit mode) never build key
 * strings on cache hits. */
const pieceDimsCache = new Map<BuildPiece, Map<number, [number, number, number]>>()

/** Piece dims under a storey span: walls are span tall, the stairs plank is
 * the hypotenuse over a CELL run rising exactly the span; floors/roof
 * fallback boxes don't care. The legacy span returns PIECE_DIMS itself
 * (bit-exact, including the deliberate 4.1 plank). Treat the result as
 * read-only — tuples are cached and shared. */
export function pieceDims(piece: BuildPiece, span = WALL_H): [number, number, number] {
  if (span === WALL_H || (piece !== 'wall' && piece !== 'stairs')) return PIECE_DIMS[piece]
  let bySpan = pieceDimsCache.get(piece)
  if (!bySpan) {
    bySpan = new Map()
    pieceDimsCache.set(piece, bySpan)
  }
  let dims = bySpan.get(span)
  if (!dims) {
    dims =
      piece === 'wall'
        ? [PIECE_DIMS.wall[0], span, PIECE_DIMS.wall[2]]
        : [PIECE_DIMS.stairs[0], PIECE_DIMS.stairs[1], Math.hypot(CELL, span)]
    bySpan.set(span, dims)
  }
  return dims
}

/** ≈ −43.0°, atan2(rise = one STOREY, run = one CELL) — not 45° by design
 * (see the PIECE_DIMS.stairs note above). */
const STAIR_TILT = -Math.atan2(WALL_H, 3)

/** Rendered pose from a base elevation. `span` is the piece's storey span
 * (PlacedPiece.height; legacy 2.8): walls center at span/2, the stairs
 * plank tilts to rise exactly one LOCAL storey over its CELL run. */
export function piecePose(
  piece: BuildPiece,
  baseY: number,
  span = WALL_H,
): { y: number; tilt: number } {
  if (piece === 'wall') return { y: baseY + span / 2, tilt: 0 }
  if (piece === 'stairs') {
    return {
      y: baseY + span / 2,
      tilt: span === WALL_H ? STAIR_TILT : -Math.atan2(span, CELL),
    }
  }
  return { y: baseY + 0.06, tilt: 0 }
}

// --- 3×3 cell grid ----------------------------------------------------------

/** Cells per side of the build-battle grid. */
export const CELLS = 3

/** Mask bit for grid cell (col, row) — bit = col + row·CELLS. */
export function maskBit(col: number, row: number): number {
  return col + row * CELLS
}

/** One cell's box dims in the piece's local frame: walls split width ×
 * height (full thickness), floors/stairs split their plane (full slab).
 * `span` is the piece's storey span — wall rows are span/3 tall. */
export function cellDims(piece: BuildPiece, span = WALL_H): [number, number, number] {
  const [w, h, d] = pieceDims(piece, span)
  if (piece === 'wall') return [w / CELLS, h / CELLS, d]
  return [w / CELLS, h, d / CELLS]
}

/** Local-frame center of grid cell (col, row). Col 0 sits at local −X;
 * wall row 0 is the BOTTOM row, floor/stairs row 0 is the local −Z edge
 * (the stairs' LOW edge given STAIR_TILT). */
export function cellCenter(
  piece: BuildPiece,
  col: number,
  row: number,
  span = WALL_H,
): [number, number, number] {
  const [w, h, d] = pieceDims(piece, span)
  const x = -w / 2 + (col + 0.5) * (w / CELLS)
  if (piece === 'wall') return [x, -h / 2 + (row + 0.5) * (h / CELLS), 0]
  return [x, 0, -d / 2 + (row + 0.5) * (d / CELLS)]
}

const pieceGeometries = new Map<string, BoxGeometry>()
function geometryFor(piece: BuildPiece, span: number): BoxGeometry {
  const key = `${piece}|${span}`
  let geometry = pieceGeometries.get(key)
  if (!geometry) {
    geometry = new BoxGeometry(...pieceDims(piece, span))
    pieceGeometries.set(key, geometry)
  }
  return geometry
}

/** Merged-box geometry for a piece's live cells, cached per (piece, mask,
 * span) — placed meshes AND their colliders come from here, so a mask edit
 * swaps both at once. Null when every cell is dead (nothing to
 * render/collide). */
const maskGeometryCache = new Map<string, BufferGeometry>()
export function geometryForMask(
  piece: BuildPiece,
  mask: number,
  span = WALL_H,
): BufferGeometry | null {
  const live = mask & FULL_MASK
  if (live === 0) return null
  if (live === FULL_MASK) return geometryFor(piece, span)
  const key = `${piece}|${live}|${span}`
  let geometry = maskGeometryCache.get(key)
  if (!geometry) {
    const dims = cellDims(piece, span)
    const parts: BoxGeometry[] = []
    for (let row = 0; row < CELLS; row++) {
      for (let col = 0; col < CELLS; col++) {
        if (!(live & (1 << maskBit(col, row)))) continue
        const center = cellCenter(piece, col, row, span)
        const box = new BoxGeometry(dims[0], dims[1], dims[2])
        box.translate(center[0], center[1], center[2])
        parts.push(box)
      }
    }
    geometry = mergeGeometries(parts) ?? geometryFor(piece, span)
    for (const part of parts) part.dispose()
    geometry.computeBoundingBox()
    maskGeometryCache.set(key, geometry)
  }
  return geometry
}

/** Session teardown (next to resetStoreyLadder): the caches above key on
 * the raw float SPAN, and spans derive from each building's measured level
 * elevations — a long editor run Jumping into many buildings would grow
 * merged-geometry CPU+GPU memory monotonically (up to 511 masks × pieces
 * per span family) with no other release path. dispose() is idempotent,
 * so the FULL_MASK fallback rows shared with pieceGeometries are safe. */
export function disposePieceGeometryCaches(): void {
  for (const geometry of pieceGeometries.values()) geometry.dispose()
  pieceGeometries.clear()
  for (const geometry of maskGeometryCache.values()) geometry.dispose()
  maskGeometryCache.clear()
  pieceDimsCache.clear()
}

// --- Pose equality --------------------------------------------------------

const TWO_PI = Math.PI * 2
/** Yaw period under which the piece's box is self-identical (roof patches
 * carry direction in their corner pattern, so they compare like stairs). */
const YAW_SYMMETRY: Record<BuildPiece, number> = {
  wall: Math.PI,
  floor: Math.PI / 2,
  stairs: TWO_PI,
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

/**
 * Pure swipe-carve gate for one edit-mode frame: a swipe STARTS only on a
 * fresh press edge — a fire hold carried INTO edit mode (turbo-chaining
 * pieces, then tapping F) must never carve on entry — and stays live until
 * the button releases; a live swipe carves each cell once per hold
 * (`swipedBit`, the caller's per-hold dedupe Set).
 */
export function swipeStep(
  firing: boolean,
  prevFiring: boolean,
  active: boolean,
  swipedBit: boolean,
): { active: boolean; carve: boolean } {
  const next = firing && (active || !prevFiring)
  return { active: next, carve: next && !swipedBit }
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
  piece: Pick<PlacedPiece, 'piece' | 'position' | 'yaw' | 'height'>,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDist: number,
): CellHit | null {
  const span = piece.height ?? WALL_H
  const pose = piecePose(piece.piece, piece.position[1], span)
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
  if (pose.tilt !== 0) {
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

  const dims = pieceDims(piece.piece, span)
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
// --- The wall family: door / window presets --------------------------------

/** The column every built aperture is pocketed into: the MIDDLE one. A 3 m
 * wall with a centered opening is the answer that always reads right, and it
 * keeps R free for the wall's far-edge parity flip (a door that wandered
 * columns on every R press would fight the aim). */
export const OPENING_COL = 1

/** DOOR: the middle column's bottom TWO cells dead — a cell-wide doorway
 * 2·span/3 tall (1.87 m on a classic 2.8 storey). planWallMask reads it as
 * `pocket: 'door'` at that column and Keep pockets a real door node there. */
export const DOOR_MASK =
  FULL_MASK & ~((1 << maskBit(OPENING_COL, 0)) | (1 << maskBit(OPENING_COL, 1))) // 493

/** WINDOW: the middle column's MIDDLE cell dead — a cell-wide, span/3-tall
 * opening at chest height. planWallMask reads it as `pocket: 'window'`. */
export const WINDOW_MASK = FULL_MASK & ~(1 << maskBit(OPENING_COL, 1)) // 495

/** The 3×3 mask the build menu's current selection places. Only walls can
 * carry an aperture; everything else is intact. */
export function wallOpeningMask(piece: BuildPiece, opening: BuildOpening): number {
  if (piece !== 'wall' || opening === null) return FULL_MASK
  return opening === 'door' ? DOOR_MASK : WINDOW_MASK
}

/** One entry of the build menu — a piece plus, for walls, its variant. */
export type BuildSelection = { piece: BuildPiece; opening: BuildOpening }

/** The build menu in Q-cycle order: the WALL FAMILY first (solid, door,
 * window — one slot, one mask apart), then floor, stairs, roof. Mirrored as
 * display data by hud.ts (which must not import this module). */
export const BUILD_CYCLE: ReadonlyArray<BuildSelection> = [
  { piece: 'wall', opening: null },
  { piece: 'wall', opening: 'door' },
  { piece: 'wall', opening: 'window' },
  { piece: 'floor', opening: null },
  { piece: 'stairs', opening: null },
  { piece: 'roof', opening: null },
]

/** Q: the next entry of BUILD_CYCLE after this selection (wrapping). An
 * unknown selection — e.g. an opening left on a non-wall by a future caller
 * — restarts the cycle at the solid wall. Pure; viewmodel.tsx's Q handler. */
export function nextBuildSelection(piece: BuildPiece, opening: BuildOpening): BuildSelection {
  const at = BUILD_CYCLE.findIndex((s) => s.piece === piece && s.opening === opening)
  return BUILD_CYCLE[(at + 1) % BUILD_CYCLE.length]!
}

/** Z pressed while already on the wall family: solid → door → window → solid.
 * Pure. */
export function nextWallVariant(opening: BuildOpening): BuildOpening {
  return opening === null ? 'door' : opening === 'door' ? 'window' : null
}

/** Staircase silhouette, column heights 1·2·3 ascending toward local +X
 * (bits 0,1,2 + 4,5 + 8). */
export const STAIR_UP_MASK = 0b100110111 // 311
/** Staircase silhouette, column heights 3·2·1 ascending toward local −X
 * (bits 0,1,2 + 3,4 + 6). */
export const STAIR_DOWN_MASK = 0b001011111 // 95

export type EditTransform = { piece: BuildPiece; yaw: number }

/**
 * Exit-time wall-mask classification: an EXACT staircase silhouette
 * rebuilds the wall as the inclined stairs piece rising WALL_H along the
 * wall's own run ("the wall folds down into a ramp"). The stairs ascend
 * along their local +Z while wall columns run along local +X, so the tall
 * end at +X (311) needs yaw + π/2 and the tall end at −X (95) needs
 * yaw − π/2. Anything else — including near-misses — stays a free-form
 * carved mask and returns null.
 */
export function wallExitTransform(mask: number, wallYaw: number): EditTransform | null {
  const m = mask & FULL_MASK
  if (m === STAIR_UP_MASK) return { piece: 'stairs', yaw: rotatedYaw(wallYaw, 1) }
  if (m === STAIR_DOWN_MASK) return { piece: 'stairs', yaw: rotatedYaw(wallYaw, -1) }
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
  /** The 3×3 cell mask the click will place — FULL_MASK for everything but
   * the wall family's door/window variants, whose pocket the ghost previews
   * (wallOpeningMask). */
  mask: number
  /** The resolved slot's storey span — the piece the click will place
   * conforms to it (wall height, stairs rise, roof corner rise). */
  span: number
  /** Roof only: the R-cycled shape preset's corner pattern (the ghost
   * previews the patch the click will place). Null for other pieces. */
  corners: RoofCorners | null
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
  mask: FULL_MASK,
  span: WALL_H,
  corners: null,
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
 * `anchor()` snapshots the session grid anchor and `worldToGrid(x, z, yaw?)`
 * maps a world pose under it — with a non-identity anchor the ghost pose is
 * OFF the absolute lattice by design, so QA asserts lattice membership in
 * the GRID frame instead. `ladder()` snapshots the session storey ladder
 * (null = legacy uniform 2.8 storeys) — ghost baseY sits on its rungs.
 */
export const builderDebug: {
  holdFire: boolean
  isEditing: boolean
  ghost: () => GhostState
  anchor: () => GridAnchor
  ladder: () => number[] | null
  terrainY: () => number
  worldToGrid: (x: number, z: number, yaw?: number) => { x: number; z: number; yaw: number }
} = {
  holdFire: false,
  isEditing: false,
  ghost: () => ({ ..._debugGhost }),
  anchor: () => ({ ...getGridAnchor() }),
  ladder: () => {
    const ladder = getStoreyLadder()
    return ladder ? [...ladder] : null
  },
  // The dirt the storeys are measured from — a sunk lattice (ground pieces
  // half buried, ceilings at chest height) is this number disagreeing with
  // the ground the player is actually standing on.
  terrainY: () => gridTerrainY(),
  worldToGrid: (x, z, yaw = 0) => worldToGrid(x, z, yaw),
}

/** Closure-free placed lookup — the edit-mode frame path scans per frame. */
function findPlaced(placed: readonly PlacedPiece[], id: number): PlacedPiece | null {
  for (let i = 0; i < placed.length; i++) {
    if (placed[i]!.id === id) return placed[i]!
  }
  return null
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

/** The do-nothing anchor — worlds that derived none run the legacy grid. */
const IDENTITY_ANCHOR: GridAnchor = { x: 0, z: 0, yaw: 0 }

// --- Scene-support probe + collapse wiring ----------------------------------

/** Collider nodeId prefix for placed pieces (PlacedPieceMesh entries). */
const PIECE_NODE_PREFIX = '__boots-piece-'
/** Collider nodeId prefix for placed ITEMS (item-place.tsx entries) —
 * "props never anchor": dropped furniture must never prop a build. */
const ITEM_NODE_PREFIX = '__boots-item-'
/** Contact tolerance around a slot's volume for the scene-support test —
 * a NARROW-PHASE margin: the OBB the collider BVH is tested against grows
 * by this, it is never a plain world-AABB inflation (SUPPORT-STRICT: an
 * inflated AABB is exactly the over-grant that propped floating walls off
 * a host roof's bounding box). */
const PROBE_MARGIN = 0.35
/** ANCHOR ALLOWLIST — the structural host kinds that can prop placed
 * pieces ("props never anchor", the fort-builder genre rule: a bookshelf
 * must not hold a sky bridge up). Doors/windows count as structure — they
 * fill structural openings and read as part of their wall. THE GROUND
 * ITSELF is structure too: 'site' is the sculpted heightfield, and leaving
 * it out meant a piece resting on real dirt away from the building had
 * nothing holding it up (the storey-index terrain rule only knows ONE
 * elevation, so it grants support to a slot floating over a slope and
 * refuses it to one sitting on higher ground). The probe's narrow phase
 * tests the terrain's own triangles, so this grants contact, not the
 * heightfield's lot-wide bounding box. Item-family kinds, fences, generic
 * blocks and the rest of SOLID_KINDS are collision geometry only. */
const SUPPORT_NODE_TYPES: ReadonlySet<string> = new Set([
  'site',
  'wall',
  'slab',
  'roof',
  'roof-segment',
  'floor',
  'ceiling',
  'stair',
  'stair-segment',
  'column',
  'door',
  'window',
])
/** Broad-phase world AABB of the (margin-expanded) slot volume. */
const _probeBox = new Box3()
/** Narrow-phase slot volume + PROBE_MARGIN, axis-aligned in the GRID frame
 * (a world-space OBB under a non-identity anchor). */
const _slotObb = new Box3()
/** Grid→world rigid transform of the session anchor (rotY(yaw)·T). */
const _gridToWorld = new Matrix4()
/** _slotObb's frame → one collider's mesh-local frame (BVH space). */
const _obbToLocal = new Matrix4()

/** The piece volume a slot holds (walls are planes, floors faces, R slots
 * — stairs/roofs — the whole cell), expanded by the PROBE_MARGIN contact
 * tolerance. Writes TWO scratch boxes: `_slotObb` gets the grid-frame box
 * (the narrow-phase OBB — under the anchor it is oriented in world space),
 * `box` gets its exact world AABB (the broad-phase pre-filter; identity
 * anchors copy bit-exact, otherwise the four XZ corners rotate out and
 * wrap — Y never transforms). */
function setSlotBox(slot: Slot, box: Box3): void {
  const gx0 = slot.i * CELL
  const gz0 = slot.k * CELL
  const gy0 = storeyBase(slot.s)
  // Grid-frame extents (Wx/Wz are zero-thickness planes, F a face) — the
  // vertical extent follows the slot's LOCAL storey span (ladder-aware).
  const gx1 = slot.kind === 'Wx' ? gx0 : gx0 + CELL
  const gz1 = slot.kind === 'Wz' ? gz0 : gz0 + CELL
  const gy1 = slot.kind === 'F' ? gy0 : gy0 + storeySpan(slot.s)
  _slotObb.min.set(gx0 - PROBE_MARGIN, gy0 - PROBE_MARGIN, gz0 - PROBE_MARGIN)
  _slotObb.max.set(gx1 + PROBE_MARGIN, gy1 + PROBE_MARGIN, gz1 + PROBE_MARGIN)
  const anchor = getGridAnchor()
  if (anchor.x === 0 && anchor.z === 0 && anchor.yaw === 0) {
    box.copy(_slotObb)
  } else {
    // Rotate the expanded box's four grid XZ corners grid→world (the
    // slotPose OUT math) and wrap them; Y never transforms. This is the
    // exact AABB of the margin-expanded OBB — no AABB-of-OBB inflation.
    const c = Math.cos(anchor.yaw)
    const s = Math.sin(anchor.yaw)
    const x0 = _slotObb.min.x
    const z0 = _slotObb.min.z
    const x1 = _slotObb.max.x
    const z1 = _slotObb.max.z
    const wx00 = anchor.x + x0 * c + z0 * s
    const wz00 = anchor.z - x0 * s + z0 * c
    const wx01 = anchor.x + x0 * c + z1 * s
    const wz01 = anchor.z - x0 * s + z1 * c
    const wx10 = anchor.x + x1 * c + z0 * s
    const wz10 = anchor.z - x1 * s + z0 * c
    const wx11 = anchor.x + x1 * c + z1 * s
    const wz11 = anchor.z - x1 * s + z1 * c
    box.min.set(Math.min(wx00, wx01, wx10, wx11), _slotObb.min.y, Math.min(wz00, wz01, wz10, wz11))
    box.max.set(Math.max(wx00, wx01, wx10, wx11), _slotObb.max.y, Math.max(wz00, wz01, wz10, wz11))
  }
}

/**
 * Scene-support probe for piece-slots.setSceneSupportProbe: true while LIVE
 * STRUCTURAL scene geometry actually touches the slot's volume
 * (SUPPORT-STRICT, phase 9):
 * - ANCHOR ALLOWLIST first: placed-piece colliders are skipped (they
 *   support each other through the graph — counting them here would prop
 *   every orphan), placed items and every non-structural nodeType are
 *   skipped too ("props never anchor").
 * - BROAD PHASE: entry.worldBox vs the slot volume's world AABB — a cheap
 *   pre-filter only, it GRANTS nothing.
 * - NARROW PHASE: entry.bvh.intersectsBox against the margin-expanded slot
 *   OBB taken into mesh-local space (grid frame → anchor → entry.inverse),
 *   so a host roof's huge AABB no longer props the airspace beside it.
 * - Disabled colliders defer to their voxel replica's liveness: at least
 *   one ALIVE voxel center inside the slot OBB (point-in-OBB via the
 *   world→grid seam — a demolished scene wall must drop its dependents).
 * Exported for tests. Answers are cached per slot by piece-slots;
 * destruction hooks invalidate via notifySceneSupportChanged.
 */
export function makeSceneSupportProbe(world: GameWorld): SceneSupportProbe {
  return (id) => {
    const slot = parseSlotId(id)
    if (!slot) return false
    setSlotBox(slot, _probeBox)
    const anchor = getGridAnchor()
    const ac = Math.cos(anchor.yaw)
    const as = Math.sin(anchor.yaw)
    let matrixStale = true
    for (const entry of world.colliders) {
      if (entry.nodeId.startsWith(PIECE_NODE_PREFIX)) continue
      if (entry.nodeId.startsWith(ITEM_NODE_PREFIX)) continue
      if (!SUPPORT_NODE_TYPES.has(entry.nodeType)) continue
      if (!entry.worldBox.intersectsBox(_probeBox)) continue
      if (!entry.disabled) {
        // NARROW PHASE: real triangle contact with the slot OBB. The OBB is
        // axis-aligned in the GRID frame, so its frame→BVH transform is
        // entry.inverse ∘ (anchor grid→world). rotY(yaw) matches the OUT
        // seam: grid +X → world (cos yaw, 0, −sin yaw).
        if (matrixStale) {
          _gridToWorld.makeRotationY(anchor.yaw).setPosition(anchor.x, 0, anchor.z)
          matrixStale = false
        }
        _obbToLocal.multiplyMatrices(entry.inverse, _gridToWorld)
        if (entry.bvh.intersectsBox(_slotObb, _obbToLocal)) return true
        continue
      }
      const targets = useDestruction.getState().targets
      const target = targets.get(entry.nodeId)
      if (target) {
        if (gridSupportsSlotObb(target.grid, anchor.x, anchor.z, ac, as)) return true
        continue
      }
      // Roof shells voxelize into MEMBER targets only (`id#pN` planes +
      // `#residual` — destruction's plane lane) while the DISABLED colliders
      // stay under the bare scene id: a bare-id miss here read a fully-alive
      // roof as zero support and cascaded every roof-anchored build. Walk
      // the family instead.
      const prefix = `${entry.nodeId}#`
      for (const [id, member] of targets) {
        if (!id.startsWith(prefix)) continue
        if (gridSupportsSlotObb(member.grid, anchor.x, anchor.z, ac, as)) return true
      }
    }
    return false
  }
}

/** At least one ALIVE voxel center of `grid` inside the margin-expanded
 * slot OBB (`_slotObb` — set by the enclosing probe call): voxel center
 * world→grid (the IN seam), then point-in-OBB. */
function gridSupportsSlotObb(
  grid: { centers: ArrayLike<number>; alive: ArrayLike<number>; count: number },
  anchorX: number,
  anchorZ: number,
  ac: number,
  as: number,
): boolean {
  const { centers, alive, count } = grid
  for (let v = 0; v < count; v++) {
    if (alive[v] === 0) continue
    const c = v * 3
    const wy = centers[c + 1]!
    if (wy < _slotObb.min.y || wy > _slotObb.max.y) continue
    const dx = centers[c]! - anchorX
    const dz = centers[c + 2]! - anchorZ
    const gx = dx * ac - dz * as
    const gz = dx * as + dz * ac
    if (gx >= _slotObb.min.x && gx <= _slotObb.max.x && gz >= _slotObb.min.z && gz <= _slotObb.max.z) {
      return true
    }
  }
  return false
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
  if (clad > 0) perfEvent('clad-drain')
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
  // Every piece conforms to ITS OWN storey span (stamped at placement from
  // the grid ladder; legacy pieces read as the classic 2.8).
  const span = piece.height ?? WALL_H
  // Corner roofs render/collide as the bilinear patch (roof-corners.ts);
  // the 3×3 mask has no meaning on a patch, so it is ignored for them.
  const geometry =
    piece.piece === 'roof' && piece.corners
      ? cornerRoofGeometry(piece.corners, span)
      : geometryForMask(piece.piece, piece.mask, span)

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
      // FEET SEE THE PLANE (climb feel): stairs planks and roof patches are
      // WALKING surfaces — at the voxelize handover their entry stays
      // capsule-solid as `walkOnly` instead of disabling, so sprinting up a
      // placed ramp rides the smooth plane while bullets carve the voxels.
      // Damage past WALK_ONLY_MAX_DAMAGE demotes it (destruction.ts).
      walkOnClad: piece.piece === 'stairs' || piece.piece === 'roof',
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
  const pose = piecePose(piece.piece, piece.position[1], span)
  // Corner-roof patches carry their heights IN the geometry: base-y
  // position, no plank tilt.
  const cornered = piece.piece === 'roof' && piece.corners !== undefined
  return (
    <mesh
      castShadow
      geometry={geometry}
      position={[piece.position[0], cornered ? piece.position[1] : pose.y, piece.position[2]]}
      ref={meshRef}
      rotation={[cornered ? 0 : pose.tilt, piece.yaw, 0, 'YXZ']}
    >
      <meshStandardMaterial color="#9aa8b5" roughness={0.7} metalness={0.15} />
    </mesh>
  )
}

/**
 * INSTALL THE LATTICE FRAME + PUBLISH ITS FINGERPRINT — the whole grid
 * identity of a session, in the one order that is correct.
 *
 * Extracted from PlacedPieces' session effect because it runs TWICE now: once
 * per collected world (below), and again if the entry snapshot turns out to
 * have been taken before the scene finished arriving (entry-settle.ts — a late
 * joiner whose wall roots were still at identity published a lattice metres
 * off the lot and had every peer's piece refused). Same call, same order,
 * both times: whoever re-derives the frame must re-publish the stamp with it.
 *
 * ORDER IS LOAD-BEARING:
 * - THE DIRT the storeys are measured from goes in before the ladder — its
 *   terrain rung normalizes against this. 0 on a flat lot, so hand-built
 *   worlds and legacy tests are unchanged.
 * - SLOT IDS ARE ADDRESSES IN THIS FRAME, so a peer only means the same thing
 *   by "Wx:1,0,0" if it installed the same one. Publish the fingerprint the
 *   moment the frame exists — a peer whose stamp differs has its
 *   slot-addressed pieces refused rather than landed in the wrong place
 *   (shared-build surfaces that refusal to the player). The call is a RETAINED
 *   FACT, not an event: the caller's effect is a child's and runs BEFORE the
 *   parent effect that attaches the transport, so shared-build holds the frame
 *   and republishes it on attach. It used to no-op in that window, which cost
 *   the whole pieces lane in production — see publishGridStamp.
 * - The terrain rung goes into the preimage: with no ladder the storeys are
 *   measured from it, so two lots at different elevations are genuinely
 *   different grids even when the anchor and the ladder match. The anchor's
 *   YAW counts for the same reason: slotPose carries the lattice across the
 *   seam by rotating about the anchor, so the same slot id under two rotations
 *   is two different places.
 */
export function installGridFrame(anchor: GridAnchor, ladder: number[] | null): void {
  setGridAnchor(anchor)
  setGridTerrainY(groundSurfaceY(anchor.x, anchor.z))
  setStoreyLadder(ladder)
  publishGridStamp(anchor.x, anchor.z, anchor.yaw, [
    gridTerrainY(),
    ...(getStoreyLadder() ?? []),
  ])
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
    // GRID ANCHOR: the build lattice adopts the building's frame for the
    // whole session — same lifecycle as the scene-support probe. Hand-built
    // worlds without one run the legacy identity grid.
    // THE GROUND FIRST, and from THIS effect. The frame's terrain rung is
    // groundSurfaceY under the anchor, and that probe lives in a module
    // closure installed by collectWorld / ActiveGame's session effect — a
    // PARENT effect, which React runs AFTER this child's, and whose cleanup
    // resets the probe. So on any re-run (StrictMode's double invoke, a
    // re-collect) this effect measured the ground with no probe installed and
    // read 0. Measured live 2026-09-01 on a sculpted lot: the stamp went out
    // with terrain rung 0 while the ground under the anchor was 1.39 — two
    // peers agreed only because they were both wrong, and a peer that
    // re-derived the frame correctly would have disagreed with both.
    // installGroundProbes is idempotent (one closure + a scan of the site
    // colliders), so installing it here as well costs nothing and makes this
    // effect independent of effect order.
    installGroundProbes(world)
    // …then the whole sequence, in installGridFrame (above): anchor, the dirt
    // the storeys measure from, the ladder, then the stamp that names all
    // three. The settle watcher (entry-settle.ts) re-runs the same call if the
    // snapshot turns out to predate the scene it snapshotted.
    installGridFrame(world.gridAnchor ?? IDENTITY_ANCHOR, world.storeyLadder ?? null)
    for (const p of useBoots.getState().placed) {
      if (p.slotId) registerPlacement(p.slotId, p.id)
    }
    const off = onCollapse((pieceId) => {
      const piece = useBoots.getState().removePlaced(pieceId)
      if (!piece) return
      const pose = piecePose(piece.piece, piece.position[1], piece.height ?? WALL_H)
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
      resetGridAnchor() // the lattice frame dies with the session — back to identity
      resetStoreyLadder() // …and the storeys fall back to uniform 2.8
      resetGridTerrainY() // …measured from the lot plane again
      forgetGridStamp() // …and the retained fingerprint dies with the frame it names
      resetCladQueue() // pending clads die too (their meshes just unmounted)
      // Span-keyed geometry caches die with the ladder that minted their
      // spans (they'd otherwise grow per building across an editor run).
      disposePieceGeometryCaches()
      disposeOverlayGeometryCaches()
      disposeCornerRoofGeometryCache()
    }
  }, [world])

  // THE SHARED BUILD LANE, in one place. Declared after the grid effect so
  // the lattice frame and its fingerprint exist before the first piece is
  // published, and keyed on `placed` so it runs after every change the store
  // can take: a placement, an F-edit, an exit transform, U, the support
  // cascade, a replica shot to bits. shared-build diffs the store against
  // what it has already published, so ONE listener covers every path in and
  // out — no publish call bolted onto each call site, and nothing at all when
  // sync is off (it returns on its first line).
  useEffect(() => {
    reconcileSharedPieces()
  }, [placed])

  // The lane's player-facing voice. shared-build deliberately does not import
  // session.ts (it would close a cycle through paint-keep), so the HUD is
  // handed to it from here — the one place that is mounted for exactly as long
  // as the pieces are. Without it a lost slot or a refused grid would be
  // silent, which is the failure the election exists to prevent.
  useEffect(() => {
    setBuildSyncNotice((text) => getSession()?.hud.presenceToast(text))
    return () => {
      setBuildSyncNotice(null)
    }
  }, [])

  // QA handle for the multiplayer scripts, alongside __bootsBuilder,
  // __bootsItems and __bootsPaint. Registered UNCONDITIONALLY, like all of
  // them: `import.meta.env` is a bundler-specific global that the host's
  // webpack build does not define, so guarding on `import.meta.env.DEV` threw
  // a TypeError inside this mount effect and took the whole piece tree down
  // with it — the pieces vanished and `__boots` went with them. It was also
  // the only `import.meta.env` reference in the plugin. sharedBuildDebug
  // returns plain copies and holds nothing, so there is nothing to gate.
  useEffect(() => {
    ;(globalThis as Record<string, unknown>).__bootsBuild = sharedBuildDebug
    return () => {
      delete (globalThis as Record<string, unknown>).__bootsBuild
    }
  }, [])

  return (
    <group userData={{ __boots: true }}>
      {placed.map((piece) => (
        <PlacedPieceMesh key={piece.id} piece={piece} world={world} />
      ))}
    </group>
  )
}

/**
 * Is this placed piece another player's work?
 *
 * keep.ts asks THIS rather than shared-build directly: a Save bridge may not
 * import a shared module for anything but `localWork`, and
 * shared-invariant.test.ts enforces exactly that. The build lane already owns
 * the authorship registry, so the bridge asks its own lane and the fence
 * stays green. Always false in single-player.
 */
export function isForeignPlacedPiece(id: number): boolean {
  return isForeignPiece(id)
}

/**
 * Save/Discard resolved the placements: unbind ours WITHOUT tombstoning them.
 * On this screen the game pieces become real scene walls; on every other
 * screen they are still the walls they always were, and killing the records
 * would delete a peer's view of a building that still exists. Called by
 * keep.ts either side of resolvePlaced().
 */
export function releaseSharedPlacedPieces(): void {
  forgetSharedPieces()
}

/**
 * U undoes YOUR last placement, not whatever happens to sit last in the list.
 *
 * With a shared world attached, `placed` interleaves everyone's pieces in
 * arrival order, so the store's own pop would hand the player a stranger's
 * wall — and it would not even stay deleted, since the record is still alive
 * and the next reconcile would put it straight back. So walk backwards to the
 * last piece this client authored. With sync off there is nothing to skip and
 * this is the store's `removeLastPlaced()`, called exactly as before.
 */
function undoLastOwnPlacement(): PlacedPiece | undefined {
  const state = useBoots.getState()
  if (!buildSyncOn()) return state.removeLastPlaced()
  const placed = state.placed
  for (let i = placed.length - 1; i >= 0; i--) {
    const p = placed[i]
    if (!p || isForeignPiece(p.id)) continue
    return state.removePlaced(p.id)
  }
  return undefined
}

/** Direct piece hotkeys while the builder is held — the classic PC row:
 * Z wall · X floor · C stairs · V roof (Q still cycles for one-handed
 * play; undo lives on U). Every code needs an input.ts GAME_KEYS entry.
 * Advertised in-game by the HUD keybind bar while the builder is held
 * (hud.builderKeybarText — keep the two lists in step). These match
 * PHYSICAL positions (e.code): on AZERTY the caps differ (the HUD bar
 * resolves real caps via the Keyboard API where available). */
export const PIECE_KEYS: ReadonlyArray<readonly [string, BuildPiece]> = [
  ['KeyZ', 'wall'],
  ['KeyX', 'floor'],
  ['KeyC', 'stairs'],
  ['KeyV', 'roof'],
]

/** Max distance for entering/holding F edit mode on a placed piece. */
const EDIT_RANGE = 6

type EditState = {
  /** PlacedPiece id under edit. */
  id: number
  /** Mask bit of the cell under the crosshair — or, on a corner roof, the
   * CORNER index (0..3, roof-corners.ts ring order). */
  hover: number
  /** Mirror of the piece's mask (drives overlay re-render on toggle). */
  mask: number
  /** Mirror of a corner roof's heights; null = 3×3 cell editing. */
  corners: RoofCorners | null
  piece: BuildPiece
  /** The piece's storey span (PlacedPiece.height; legacy 2.8) — overlay
   * lattice rows and corner-marker rises follow it. */
  span: number
  x: number
  y: number
  z: number
  yaw: number
}

/** Unified F-edit targeting: corner roofs raycast the bilinear patch and
 * report the nearest CORNER; everything else raycasts its 3×3 cells. */
function raycastEditTarget(
  piece: PlacedPiece,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxT: number,
): { t: number; bit: number } | null {
  if (piece.piece === 'roof' && piece.corners) {
    const hit = raycastRoofCorner(
      piece.corners,
      { x: piece.position[0], y: piece.position[1], z: piece.position[2], yaw: piece.yaw },
      ox,
      oy,
      oz,
      dx,
      dy,
      dz,
      maxT,
      piece.height ?? CORNER_RISE, // aim at the patch the piece renders
    )
    return hit ? { t: hit.t, bit: hit.corner } : null
  }
  return raycastPieceCell(piece, ox, oy, oz, dx, dy, dz, maxT)
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

/** The item catalog and builder share LMB and world-preview space. Once an
 * item ghost is active it owns both, even if the hammer is still selected. */
export function builderPreviewActive(weapon: string, itemPreview: boolean): boolean {
  return weapon === 'builder' && !itemPreview
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
  /** Edge trackers for the Z/X/C/V piece hotkeys (keyed by code). */
  const prevPieceKeys = useRef<Record<string, boolean>>({})
  /** R rotState (0..3) — grid semantics: wall far-edge flip (parity),
   * stairs ascent quarter, roof shape preset. Persists across placements
   * and holsters; resets on piece-TYPE switch ONLY (REVIEW contract). */
  const rotateTurns = useRef(0)
  const rotatePiece = useRef<BuildPiece>('wall')
  const placeCooldown = useRef(0)
  /** Slots already stamped during the CURRENT hold — one attempt per slot
   * per hold (turbo dedupe); cleared on release. */
  const holdAttempted = useRef<Set<string>>(new Set())
  /** Cells already toggled during the CURRENT edit-mode fire hold — swipe
   * carving toggles each NEW cell the crosshair enters, once per hold. */
  const editSwiped = useRef<Set<number>>(new Set())
  /** True while a swipe hold is live — armed by a fresh press edge only
   * (swipeStep), never by a fire hold carried into edit mode. */
  const swipeActive = useRef(false)

  const weapon = useBoots((s) => s.weapon)
  const buildPiece = useBoots((s) => s.buildPiece)
  const buildOpening = useBoots((s) => s.buildOpening)
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

  // HUD mode-hint line: shown while the cell/corner editor is open, cleared
  // on exit/unmount (hud.editHint owns its own element — prompts never
  // clobber it).
  const editing = edit !== null
  const editingCorners = edit?.corners !== null && edit !== null
  useEffect(() => {
    const session = getSession()
    if (!session) return
    session.hud.editHint(
      editing
        ? editingCorners
          ? 'F done · LMB raise/drop corner · RMB slope'
          : 'F done · LMB carve · RMB reset'
        : null,
    )
    return () => {
      getSession()?.hud.editHint(null)
    }
  }, [editing, editingCorners])

  useFrame((_, dt) => {
    const session = getSession()
    if (!session) return
    placeCooldown.current -= dt

    // Catalog placement owns the world preview completely. In particular,
    // moving furniture with L while the builder is the underlying weapon must
    // not leave a wall ghost between the player and the furniture ghost.
    if (!builderPreviewActive(weapon, itemGhostActive())) {
      if (ghost) setGhost(null)
      if (edit) {
        // A weapon switch or catalog placement closes edit mode with the same
        // exit-time confirmation.
        applyEditExitTransform(edit.id)
        setEdit(null)
      }
      session.hud.ghostStatus?.(null, 'builder')
      builderDebug.isEditing = false
      holdAttempted.current.clear()
      editSwiped.current.clear()
      swipeActive.current = false
      prevFire.current = session.input.state.firing || builderDebug.holdFire
      prevAltFire.current = session.input.state.altFiring
      prevEditKey.current = session.input.state.keys.has('KeyF')
      prevRotate.current = session.input.state.keys.has('KeyR')
      prevUndo.current = session.input.state.keys.has('KeyU')
      for (const [code] of PIECE_KEYS) {
        prevPieceKeys.current[code] = session.input.state.keys.has(code)
      }
      return
    }

    const firingNow = session.input.state.firing || builderDebug.holdFire
    const staggered = useBoots.getState().staggered
    // F edge — requires 'KeyF' in input.ts GAME_KEYS to ever be pressed.
    const editKey = session.input.state.keys.has('KeyF')
    const editKeyEdge = editKey && !prevEditKey.current
    prevEditKey.current = editKey

    // Direct piece hotkeys (Z/X/C/V — PIECE_KEYS): fresh edges only, inert
    // while an F edit is open (same gate as Q cycling), trackers kept warm
    // so holding a key across an edit never edge-switches on exit.
    // Z is the WALL FAMILY key: pressed while already on a wall it steps the
    // variant (solid → door → window), so the apertures are one key away
    // without stealing a second letter from the loadout.
    for (const [code, pieceForKey] of PIECE_KEYS) {
      const down = session.input.state.keys.has(code)
      if (down && !prevPieceKeys.current[code] && !edit) {
        const store = useBoots.getState()
        if (pieceForKey === 'wall' && store.buildPiece === 'wall') {
          store.setBuildOpening(nextWallVariant(store.buildOpening))
          sfx.weaponSwitch()
        } else if (store.buildPiece !== pieceForKey) {
          store.setBuildPiece(pieceForKey)
          sfx.weaponSwitch()
        }
      }
      prevPieceKeys.current[code] = down
    }

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
      // U undo is paused while editing, but keep its edge tracker warm so
      // holding U across the exit never fires a stale undo. R's rotState
      // survives an edit (REVIEW: it resets on piece-type switch ONLY);
      // keep its edge tracker warm too.
      prevUndo.current = session.input.state.keys.has('KeyU')
      prevRotate.current = session.input.state.keys.has('KeyR')
      const altFiringNow = session.input.state.altFiring
      const piece = findPlaced(useBoots.getState().placed, edit.id)
      const hit = piece ? raycastEditTarget(piece, aox, aoy, aoz, adx, ady, adz, EDIT_RANGE) : null
      // Exit: F again, the piece is gone, or the aim left it. Exit-time is
      // the confirm: the final mask classifies, exact stair silhouettes
      // fold the wall into a ramp (see wallExitTransform).
      if (!piece || !hit || editKeyEdge) {
        if (piece) applyEditExitTransform(piece.id)
        setEdit(null)
        // The per-hold swipe set dies with the edit — a bit swiped in the
        // LAST edit must not refuse the same cell in the next one.
        editSwiped.current.clear()
        swipeActive.current = false
        builderDebug.isEditing = false
        placeCooldown.current = TURBO_FIRST // a beat before hold-place resumes
        prevFire.current = firingNow
        prevAltFire.current = altFiringNow
        return
      }
      if (piece.piece === 'roof' && piece.corners) {
        // Corner roof: LMB toggles the aimed corner's height, RMB snaps the
        // shape back to the classic slope. An armed item ghost owns the
        // click (itemGhostActive — same gate as the viewmodel's trigger).
        let wrote = false
        if (firingNow && !prevFire.current && !staggered && !itemGhostActive()) {
          useBoots.getState().setPlacedCorners(piece.id, toggleCorner(piece.corners, hit.bit))
          sfx.place()
          wrote = true
        }
        if (altFiringNow && !prevAltFire.current && !cornersEqual(piece.corners, SLOPE_CORNERS)) {
          useBoots.getState().setPlacedCorners(piece.id, SLOPE_CORNERS)
          sfx.place()
          wrote = true
        }
        prevFire.current = firingNow
        prevAltFire.current = altFiringNow
        // Re-read only after a write this frame — `piece` is already fresh.
        const corners = wrote
          ? (findPlaced(useBoots.getState().placed, edit.id)?.corners ?? piece.corners)
          : piece.corners
        if (edit.hover !== hit.bit || !edit.corners || !cornersEqual(edit.corners, corners)) {
          setEdit({ ...edit, hover: hit.bit, corners })
        }
        return
      }
      // SWIPE CARVE: a FRESH press toggles the aimed cell and arms the
      // swipe; while that hold lasts, each NEW cell the crosshair enters
      // toggles once (per-hold dedupe — matches holdAttempted's per-hold
      // contract). A hold carried into the edit never carves (swipeStep),
      // and an armed item ghost owns the click (itemGhostActive).
      const fireForCarve = firingNow && !staggered && !itemGhostActive()
      if (fireForCarve && !swipeActive.current && !prevFire.current) editSwiped.current.clear()
      const step = swipeStep(
        fireForCarve,
        prevFire.current,
        swipeActive.current,
        editSwiped.current.has(hit.bit),
      )
      swipeActive.current = step.active
      let wrote = false
      if (step.carve) {
        editSwiped.current.add(hit.bit)
        useBoots.getState().setPlacedMask(piece.id, piece.mask ^ (1 << hit.bit))
        sfx.place()
        wrote = true
      }
      // RMB resets the edit — the piece snaps back to intact (511). ADS is
      // pistol/rifle-only, so the builder owns RMB freely.
      if (altFiringNow && !prevAltFire.current && piece.mask !== FULL_MASK) {
        useBoots.getState().setPlacedMask(piece.id, FULL_MASK)
        sfx.place()
        wrote = true
      }
      prevFire.current = firingNow
      prevAltFire.current = altFiringNow
      // Re-read only after a write this frame — `piece` is already fresh.
      const mask = wrote
        ? (findPlaced(useBoots.getState().placed, edit.id)?.mask ?? piece.mask)
        : piece.mask
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
        // YOUR pieces — the F-edit carves cells and re-mints the record, which
        // is an authorship claim. A stranger's wall is not editable; it is
        // shootable, which is the answer the genre already gives.
        if (isForeignPiece(p.id)) continue
        const hit = raycastEditTarget(p, aox, aoy, aoz, adx, ady, adz, EDIT_RANGE)
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
          corners: best.piece === 'roof' && best.corners ? best.corners : null,
          piece: best.piece,
          span: best.height ?? WALL_H,
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
    // (parity — beats the ray), stairs = ascent quarter-turn cycle, roof =
    // SHAPE-preset cycle (slope → corner-tip → valley → flat cap; the yaw
    // stays aimed by the facing), floor = no-op (the key is ignored, no
    // detent). rotState persists across placements; it resets when the
    // piece TYPE changes only (a wall's flip shouldn't secretly re-aim
    // your next stairs).
    if (buildPiece !== rotatePiece.current) {
      rotatePiece.current = buildPiece
      rotateTurns.current = 0
    }
    // While an item ghost is armed, R turns the FURNITURE (GameItems strips
    // the action queue, but R here reads the held-keys set — skip the edge,
    // keep the tracker warm).
    const rotateDown = session.input.state.keys.has('KeyR')
    if (rotateDown && !prevRotate.current && buildPiece !== 'floor' && !itemGhostActive()) {
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
    // The slot's LOCAL storey span — the placed piece will conform to it
    // (wall height, stairs rise, roof corner rise; legacy 2.8 off-ladder).
    const span = storeySpan(target.slot.s)
    // Roof ghost previews the R-cycled shape preset (the exact patch the
    // click will place); other pieces carry no corner pattern. The CANONICAL
    // preset reference (read-only here) keeps the change gate an identity
    // compare — placement below still spreads its own copy.
    const ghostCorners =
      buildPiece === 'roof' ? ROOF_PRESETS[((rotateTurns.current % 4) + 4) % 4]! : null
    // The wall family's aperture, previewed: the ghost shows the POCKETED
    // mask, so the hole is visible before the click (owner ask — "before
    // placing … there should be a preview transparent").
    const ghostMask = wallOpeningMask(buildPiece, buildOpening)

    if (
      !ghost ||
      ghost.slotId !== target.slotId ||
      ghost.piece !== buildPiece ||
      ghost.mask !== ghostMask ||
      ghost.yaw !== pose.yaw ||
      ghost.span !== span ||
      ghost.valid !== target.valid ||
      ghost.reason !== target.reason ||
      ghost.corners !== ghostCorners
    ) {
      setGhost({
        slotId: target.slotId,
        x: pose.position[0],
        y: pose.position[1],
        z: pose.position[2],
        yaw: pose.yaw,
        piece: buildPiece,
        mask: ghostMask,
        span,
        corners: ghostCorners,
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
    _debugGhost.mask = ghostMask
    _debugGhost.span = span
    _debugGhost.corners = ghostCorners
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
    // Invalid targets are skipped silently. Staggered hands can't stamp,
    // and an armed item ghost owns the click — the viewmodel's fire gate
    // excludes 'builder', so this loop must gate itself (a single LMB was
    // dropping furniture AND stamping a piece); prevFire still tracks the
    // raw button so recovery doesn't edge-place.
    const firing = session.input.state.firing || builderDebug.holdFire
    if (firing && !useBoots.getState().staggered && !itemGhostActive()) {
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
          // The wall family lands AS its aperture: a door/window is this mask
          // and nothing else (see THE WALL FAMILY above). fittings.tsx reads
          // it back to hang the leaf E operates.
          mask: ghostMask,
          // The piece conforms to its slot's LOCAL storey span for its
          // whole life (render, collide, edit, Keep).
          height: span,
          // Pyramid grammar: a roof lands AS its previewed shape preset;
          // F-edit toggles corners afterwards (2×2 corner heights). Fresh
          // array — the placed piece owns its pattern.
          ...(ghostCorners ? { corners: [...ghostCorners] as RoofCorners } : {}),
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

    // UNDO on KeyU (Z selects the wall piece now, undoLastOwnPlacement below
    // keeps U off other people's walls). onPieceRemoved is the
    // ONE removal entry point: it stamps the died-slot lockout and cascades
    // anything the removal orphaned (the collapse listener in PlacedPieces
    // evicts those pieces through the same store path).
    const undoDown = session.input.state.keys.has('KeyU')
    if (undoDown && !prevUndo.current) {
      const removed = undoLastOwnPlacement()
      if (removed) {
        if (removed.slotId) onPieceRemoved(removed.slotId)
        sfx.weaponSwitch()
      }
    }
    prevUndo.current = undoDown
  })

  if (!active) return null

  // Corner-roof edit overlay (edit-overlay.tsx): hovered hot + pulsing,
  // raised corners cool blue, dropped corners faint red wire.
  if (edit && edit.corners) {
    return (
      <CornerEditOverlay
        corners={edit.corners}
        hover={edit.hover}
        rise={edit.span}
        x={edit.x}
        y={edit.y}
        z={edit.z}
        yaw={edit.yaw}
      />
    )
  }

  // Cell-edit overlay (edit-overlay.tsx): outlined 3×3 lattice floating off
  // both piece faces — live blue, dead outline-only, hovered pulsing.
  if (edit) {
    const pose = piecePose(edit.piece, edit.y, edit.span)
    return (
      <EditOverlay
        piece={edit.piece}
        mask={edit.mask}
        hover={edit.hover}
        span={edit.span}
        x={edit.x}
        y={pose.y}
        z={edit.z}
        yaw={edit.yaw}
        tilt={pose.tilt}
      />
    )
  }

  if (!ghost) return null
  // Roof ghost IS the shape preset's bilinear patch (base-y position, no
  // plank tilt — the placed-mesh convention for cornered roofs). Uniform
  // 1.03 scale mirrors the box ghost's coplanar z-fight inflation.
  if (ghost.piece === 'roof') {
    return (
      <group ref={ghostRef} userData={{ __boots: true }}>
        <mesh
          geometry={cornerRoofGeometry(ghost.corners ?? SLOPE_CORNERS, ghost.span)}
          position={[ghost.x, ghost.y, ghost.z]}
          rotation={[0, ghost.yaw, 0]}
          scale={1.03}
        >
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
  const pose = piecePose(ghost.piece, ghost.y, ghost.span)
  // Inflated 1.03 like the edit overlay above: a ghost hovering over an
  // already-placed piece would otherwise sit exactly coplanar with its
  // faces and z-fight (transparent + no depthWrite still depth-TESTS).
  const ghostDims = pieceDims(ghost.piece, ghost.span)
  // The wall family's door/window previews its POCKET: the same merged-cell
  // geometry the placement will render, so the hole is part of the preview
  // (inflation moves to the transform — the geometry is a shared cache row).
  const maskedGeometry =
    ghost.mask === FULL_MASK ? null : geometryForMask(ghost.piece, ghost.mask, ghost.span)
  return (
    <group ref={ghostRef} userData={{ __boots: true }}>
      <mesh
        position={[ghost.x, pose.y, ghost.z]}
        rotation={[pose.tilt, ghost.yaw, 0, 'YXZ']}
        {...(maskedGeometry ? { geometry: maskedGeometry, scale: 1.03 } : {})}
      >
        {!maskedGeometry && (
          <boxGeometry args={[ghostDims[0] * 1.03, ghostDims[1] * 1.03, ghostDims[2] * 1.03]} />
        )}
        <meshBasicMaterial
          color={ghost.valid ? '#59a7ff' : '#ff5a4d'}
          depthWrite={false}
          opacity={0.38}
          transparent
        />
      </mesh>
      {/* Bright edge outline: a 0.12 m HORIZONTAL plate (floor/stairs) at
       * eye height is a near-invisible sliver edge-on — the translucent
       * fill only reads face-on (walls, roofs). The edges read from any
       * angle (owner report: "no preview when I place floor"). */}
      <lineSegments
        geometry={ghostEdges(ghost.piece, ghost.span, ghost.mask)}
        position={[ghost.x, pose.y, ghost.z]}
        rotation={[pose.tilt, ghost.yaw, 0, 'YXZ']}
        {...(maskedGeometry ? { scale: 1.03 } : {})}
      >
        <lineBasicMaterial
          color={ghost.valid ? '#8ec4ff' : '#ff7a6e'}
          depthWrite={false}
          opacity={0.9}
          transparent
        />
      </lineSegments>
    </group>
  )
}

/** Edge-outline geometry per (piece, span, mask) — module cache: a handful of
 * entries per session (pieces × storey spans × the two aperture masks), never
 * disposed until the plugin unloads, matching pieceDims' cache lifetime. An
 * intact mask outlines the inflated box; a pocketed one outlines the
 * merged-cell shape, so the door/window reads as a hole from any angle (the
 * cell seams come along, which is exactly the 3×3 grammar the player edits
 * in). */
const ghostEdgeCache = new Map<string, EdgesGeometry>()
function ghostEdges(piece: BuildPiece, span: number, mask = FULL_MASK): EdgesGeometry {
  const key = `${piece}:${span}:${mask}`
  let edges = ghostEdgeCache.get(key)
  if (!edges) {
    const masked = mask === FULL_MASK ? null : geometryForMask(piece, mask, span)
    if (masked) {
      edges = new EdgesGeometry(masked)
    } else {
      const d = pieceDims(piece, span)
      const box = new BoxGeometry(d[0] * 1.03, d[1] * 1.03, d[2] * 1.03)
      edges = new EdgesGeometry(box)
      box.dispose()
    }
    ghostEdgeCache.set(key, edges)
  }
  return edges
}
