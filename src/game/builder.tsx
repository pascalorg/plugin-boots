'use client'

import { useFrame } from '@react-three/fiber'
import { useEffect, useRef, useState } from 'react'
import { BoxGeometry, type BufferGeometry, Matrix4, type Group, type Mesh } from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { type BuildPiece, FULL_MASK, type PlacedPiece, useBoots } from '../store'
import { sfx } from './audio'
import { EYE_HEIGHT } from './collision'
import { dropTarget } from './destruction'
import { playerRig } from './player'
import { getSession } from './session'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

/**
 * Build mode, battle-builder grammar: wall / floor / roof (Q cycles), ghost
 * in front of you, LMB stamps it in. Placements are game-only state — the
 * panel's Keep converts walls (and, best-effort, roofs) into real scene
 * nodes afterwards, Discard forgets everything. G undoes (piece + collider
 * + any voxel replica).
 *
 * ── PLACEMENT GRAMMAR (phase 2) ───────────────────────────────────────────
 * ADJACENCY SNAP: the raw ghost (1.5 m grid + 90° yaw, reach shortens with
 * pitch so it tracks your aim) snaps to the nearest candidate generated from
 * placed pieces within reach when that candidate is ≤ SNAP_RANGE (1.1 m,
 * XZ) of the raw ghost; otherwise the plain grid pose is used.
 *   walls  — chain end-to-end along the neighbor's axis (only when your
 *            snapped yaw is parallel to it), and stack on top when your aim
 *            ray passes above 3/4 of the neighbor's height (a real upward
 *            tilt — level gaze never stacks).
 *   floors — tile edge-to-edge on the neighbor's plane (4 sides), and cap a
 *            wall's top (py + WALL_H) when your aim ray passes the same 3/4
 *            gate as wall stacking: two candidates, one each side of the
 *            wall plane, floor edge flush with the wall line — a level gaze
 *            at ground level keeps tiling flat, never teleports up.
 *   roofs  — the inclined piece (everything inclined is a ROOF): low edge
 *            snaps to a floor edge (rising away from the floor) or to a
 *            wall base (high edge kisses the wall top: WALL_H rise).
 * HOLD-TO-PLACE: holding LMB stamps a piece whenever the (possibly snapped)
 * ghost pose changes, min PLACE_INTERVAL between stamps — sweep a wall run.
 * VALIDITY: an identical pose (piece + position + yaw up to the piece's own
 * symmetry) is never placed twice — the ghost tints red over an occupied
 * pose, blue when free; occupied stamps are skipped silently.
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
 * wall). F again — or aiming off the piece — exits. Placement, and the
 * placement ghost, pause while editing; Q piece-cycling stays live.
 * NOTE: needs 'KeyF' in input.ts GAME_KEYS to receive the key.
 *
 * ── API (exported for tests / other systems) ──────────────────────────────
 *   PIECE_DIMS / piecePose      piece geometry + pose from base elevation.
 *   CELLS / maskBit / cellDims / cellCenter    3×3 cell math (local frame).
 *   raycastPieceCell(piece, ox, oy, oz, dx, dy, dz, maxDist)   ray vs the
 *       FULL piece box (mask-independent so dead cells can be re-added) →
 *       { t, col, row, bit } | null. RETURNS A REUSED MODULE OBJECT.
 *   resolveSnap(piece, placed, raw, aimYAt)   pure snap resolver → snapped
 *       pose or null. `aimYAt(x, z)` = aim-ray height over that XZ point
 *       (gates wall stacking at 3/4 of the neighbor's height). RETURNS A
 *       REUSED MODULE OBJECT — copy fields before the next call if you
 *       keep them.
 *   isOccupied(placed, piece, x, y, z, yaw)   identical-pose test, yaw
 *       compared modulo the piece's symmetry (wall π, floor π/2, roof 2π).
 *   builderDebug (dev, `globalThis.__bootsBuilder` in-game)   holdFire
 *       stands in for the held LMB in headless E2E; ghost() snapshots the
 *       resolved ghost pose.
 * ──────────────────────────────────────────────────────────────────────────
 */

const GRID = 1.5
const WALL_H = 2.8
const LEVEL_STEP = 1.4
/** Raw-ghost distance from the eye when looking level (shortens with pitch). */
const REACH = 3.2
/** Raw ghost must land this close (XZ) to a candidate for the snap to win. */
const SNAP_RANGE = 1.1
/** Min seconds between hold-to-place stamps. */
const PLACE_INTERVAL = 0.18
/** Wall stacking wants the aim ray above this fraction of the neighbor's
 * height at its XZ — a real upward tilt (a level gaze at eye height 1.58
 * already clears a ground wall's midpoint, so 0.5 auto-towered). */
const STACK_GATE = 0.75

export const PIECE_DIMS: Record<BuildPiece, [number, number, number]> = {
  wall: [3, WALL_H, 0.12],
  floor: [3, 0.12, 3],
  roof: [3, 0.12, 4.1],
}

/** Horizontal footprint of a piece along its snap axis. The roof's 4.1 m
 * plank covers a 3 m run + WALL_H rise, so every piece tiles on 3 m. */
const SPAN = 3
const ROOF_HALF_RUN = SPAN / 2
/** Floor-center offset from the wall plane when capping a wall top — half
 * the floor's span, so the floor's edge sits flush on the wall line. */
const CAP_OFFSET = SPAN / 2

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

// --- Adjacency snap -------------------------------------------------------

export type RawGhost = { x: number; y: number; z: number; yaw: number }
type SnapPose = { x: number; y: number; z: number; yaw: number }

// Module temps — the snap resolver runs every frame (rule: no per-frame
// allocations). _best is the object resolveSnap returns; copy to keep.
const _best: SnapPose & { d2: number; found: boolean } = {
  x: 0,
  y: 0,
  z: 0,
  yaw: 0,
  d2: Infinity,
  found: false,
}
let _rawX = 0
let _rawY = 0
let _rawZ = 0

function consider(x: number, y: number, z: number, yaw: number): void {
  const dx = x - _rawX
  const dz = z - _rawZ
  const dxz2 = dx * dx + dz * dz
  if (dxz2 > SNAP_RANGE * SNAP_RANGE) return
  // Mild Y weight: same-level candidates win ties against stacked ones.
  const dy = y - _rawY
  const d2 = dxz2 + dy * dy * 0.1
  if (d2 >= _best.d2) return
  _best.x = x
  _best.y = y
  _best.z = z
  _best.yaw = yaw
  _best.d2 = d2
  _best.found = true
}

/**
 * Candidate poses from nearby placed pieces; nearest one within SNAP_RANGE
 * of the raw ghost wins, null means "use the plain grid". Pure — pass
 * `aimYAt(x, z)` = height of the aim ray above that XZ point (gates wall
 * stacking at 3/4 of the neighbor's height). Returned object is REUSED.
 */
export function resolveSnap(
  piece: BuildPiece,
  placed: readonly PlacedPiece[],
  raw: RawGhost,
  aimYAt: (x: number, z: number) => number,
): SnapPose | null {
  _rawX = raw.x
  _rawY = raw.y
  _rawZ = raw.z
  _best.d2 = Infinity
  _best.found = false

  for (const p of placed) {
    const px = p.position[0]
    const py = p.position[1]
    const pz = p.position[2]
    // Cheap cull: candidates sit ≤ SPAN from the neighbor center, plus the
    // snap window.
    if (Math.abs(px - _rawX) > SPAN + SNAP_RANGE || Math.abs(pz - _rawZ) > SPAN + SNAP_RANGE) {
      continue
    }

    if (piece === 'wall' && p.piece === 'wall') {
      // Chain end-to-end along the neighbor's axis — only when the player's
      // snapped yaw is parallel, so corner walls stay on the plain grid.
      const ax = Math.cos(p.yaw)
      const az = -Math.sin(p.yaw)
      if (sameYaw(raw.yaw, p.yaw, Math.PI)) {
        consider(px + ax * SPAN, py, pz + az * SPAN, p.yaw)
        consider(px - ax * SPAN, py, pz - az * SPAN, p.yaw)
      }
      // Stack on top when the aim ray passes above 3/4 of the neighbor's
      // height. Mid-height was too lenient: a LEVEL gaze (eye 1.58) already
      // clears a ground wall's midpoint (1.4), so holding fire auto-towered
      // without ever looking up (live QA find). 0.75·H (2.1) demands a real
      // upward tilt while staying reachable for 3-high stacks from the
      // ground (see builder.test.ts stacking-reach cases).
      if (aimYAt(px, pz) > py + WALL_H * STACK_GATE) consider(px, py + WALL_H, pz, p.yaw)
    } else if (piece === 'floor' && p.piece === 'floor') {
      // Tile edge-to-edge on the same plane, 4 sides, neighbor's yaw.
      const ax = Math.cos(p.yaw)
      const az = -Math.sin(p.yaw)
      consider(px + ax * SPAN, py, pz + az * SPAN, p.yaw)
      consider(px - ax * SPAN, py, pz - az * SPAN, p.yaw)
      const nx = Math.sin(p.yaw)
      const nz = Math.cos(p.yaw)
      consider(px + nx * SPAN, py, pz + nz * SPAN, p.yaw)
      consider(px - nx * SPAN, py, pz - nz * SPAN, p.yaw)
    } else if (piece === 'floor' && p.piece === 'wall') {
      // Roof a wall: the floor lands at the wall's top (py + WALL_H) with
      // its edge flush on the wall line — center offset half a floor along
      // the wall normal, one candidate each side of the wall plane. The
      // floor adopts the wall's yaw (its π/2 symmetry makes parallel and
      // perpendicular identical anyway). Gated by the same 3/4-height aim
      // test as wall stacking, evaluated at the wall's XZ, so ground-level
      // floor tiling beside a wall never teleports to the roof.
      if (aimYAt(px, pz) > py + WALL_H * STACK_GATE) {
        const nx = Math.sin(p.yaw)
        const nz = Math.cos(p.yaw)
        const topY = py + WALL_H
        consider(px + nx * CAP_OFFSET, topY, pz + nz * CAP_OFFSET, p.yaw)
        consider(px - nx * CAP_OFFSET, topY, pz - nz * CAP_OFFSET, p.yaw)
      }
    } else if (piece === 'roof' && p.piece === 'floor') {
      // Low edge on a floor edge, rising away from the floor. With the roof's
      // low-edge direction L = (-sin yaw, -cos yaw), edge direction d needs
      // L = -d and center = floor + 3d → yaw = atan2(d.x, d.z).
      const ax = Math.cos(p.yaw)
      const az = -Math.sin(p.yaw)
      const nx = Math.sin(p.yaw)
      const nz = Math.cos(p.yaw)
      consider(px + ax * SPAN, py, pz + az * SPAN, Math.atan2(ax, az))
      consider(px - ax * SPAN, py, pz - az * SPAN, Math.atan2(-ax, -az))
      consider(px + nx * SPAN, py, pz + nz * SPAN, Math.atan2(nx, nz))
      consider(px - nx * SPAN, py, pz - nz * SPAN, Math.atan2(-nx, -nz))
    } else if (piece === 'roof' && p.piece === 'wall') {
      // Low edge at the wall base, high edge kissing the wall (the roof
      // rises exactly WALL_H, so it tops out at the wall top). For face
      // normal n: center = wall + 1.5n, low-edge dir L = n →
      // yaw = atan2(-n.x, -n.z).
      const nx = Math.sin(p.yaw)
      const nz = Math.cos(p.yaw)
      consider(px + nx * ROOF_HALF_RUN, py, pz + nz * ROOF_HALF_RUN, Math.atan2(-nx, -nz))
      consider(px - nx * ROOF_HALF_RUN, py, pz - nz * ROOF_HALF_RUN, Math.atan2(nx, nz))
    }
  }

  return _best.found ? _best : null
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
      pocket: WallPocket
      /** False when the mask holds detail the node mapping approximates
       * away (interior holes that are neither window nor door pockets). */
      exact: boolean
    }

const CENTER_BIT = 1 << maskBit(1, 1) // bit 4
const BOTTOM_CENTER_BIT = 1 << maskBit(1, 0) // bit 1

/** All three bits of column `col` (rows 0..2). */
function columnBits(col: number): number {
  return (1 << maskBit(col, 0)) | (1 << maskBit(col, 1)) | (1 << maskBit(col, 2))
}

/**
 * Pure wall-mask → node plan for Keep: 511 → plain wall; center pocket
 * with the ring alive → window; bottom-center (± center) pocket → door;
 * fully-dead END columns trim the span; anything else is a best-effort
 * trimmed wall flagged `exact: false`; all-dead → skip.
 */
export function planWallMask(rawMask: number): WallMaskPlan {
  const mask = rawMask & FULL_MASK
  if (mask === 0) return { kind: 'skip' }
  if (mask === FULL_MASK) {
    return { kind: 'wall', trimStartCols: 0, trimEndCols: 0, pocket: 'none', exact: true }
  }
  if (mask === (FULL_MASK & ~CENTER_BIT)) {
    return { kind: 'wall', trimStartCols: 0, trimEndCols: 0, pocket: 'window', exact: true }
  }
  if (
    mask === (FULL_MASK & ~BOTTOM_CENTER_BIT) ||
    mask === (FULL_MASK & ~(BOTTOM_CENTER_BIT | CENTER_BIT))
  ) {
    return { kind: 'wall', trimStartCols: 0, trimEndCols: 0, pocket: 'door', exact: true }
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
  return { kind: 'wall', trimStartCols, trimEndCols, pocket: 'none', exact }
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

// --- Ghost ----------------------------------------------------------------

type GhostState = {
  x: number
  y: number
  z: number
  yaw: number
  piece: BuildPiece
  occupied: boolean
}

/** Per-frame mirror of the resolved ghost for the dev handle (no allocs). */
const _debugGhost: GhostState = { x: 0, y: 0, z: 0, yaw: 0, piece: 'wall', occupied: false }

/**
 * Dev-only handle (published as `globalThis.__bootsBuilder` while the game
 * runs — same pattern as `__bootsPlayer`): headless E2E can't engage pointer
 * lock, so `holdFire` stands in for the held LMB (it is OR-ed with the real
 * input each frame). `ghost()` snapshots the currently resolved ghost pose.
 */
export const builderDebug: { holdFire: boolean; ghost: () => GhostState } = {
  holdFire: false,
  ghost: () => ({ ..._debugGhost }),
}

const _raw: RawGhost = { x: 0, y: 0, z: 0, yaw: 0 }

/** Raw grid ghost: reach shortens as you pitch away from level so the ghost
 * tracks your aim (stacking a wall means looking UP at it). */
function rawGhost(): RawGhost {
  const reach = REACH * Math.max(0.35, Math.cos(playerRig.pitch))
  const tx = playerRig.position.x - Math.sin(playerRig.yaw) * reach
  const tz = playerRig.position.z - Math.cos(playerRig.yaw) * reach
  const feetY = playerRig.position.y - EYE_HEIGHT
  _raw.x = Math.round(tx / GRID) * GRID
  _raw.y = Math.max(0, Math.round(feetY / LEVEL_STEP) * LEVEL_STEP)
  _raw.z = Math.round(tz / GRID) * GRID
  _raw.yaw = (Math.round(playerRig.yaw / (Math.PI / 2)) * Math.PI) / 2
  return _raw
}

/** Height of the aim ray above (x, z) — flat-distance projection. */
function aimHeightAt(x: number, z: number): number {
  const hd = Math.hypot(x - playerRig.position.x, z - playerRig.position.z)
  return playerRig.position.y + Math.tan(playerRig.pitch) * hd
}

/** One placed piece: the RENDERED merged-cell mesh doubles as its collider,
 * so when the piece voxelizes the destruction manager ledger-hides the mesh
 * the player sees and the voxel replica takes over. A mask edit swaps the
 * piece OBJECT in the store, so this effect re-runs: the old collider entry
 * is spliced out (and any voxel replica of the old shape dropped) and a
 * fresh entry with the new merged-cell BVH goes in. Placed entries are
 * always APPENDED after the world's build-time colliders, so splicing them
 * out never shifts the door colliderIndices. */
function PlacedPieceMesh({ piece, world }: { piece: PlacedPiece; world: GameWorld }) {
  const meshRef = useRef<Mesh>(null)
  const geometry = geometryForMask(piece.piece, piece.mask)

  useEffect(() => {
    const mesh = meshRef.current
    if (!mesh || !geometry) return
    // A mask edit on a voxelized piece re-registers this SAME mesh object,
    // but ensureVoxelTarget had ledger-hidden it — bring it back (the piece
    // "heals" into its new mask shape; the old replica is dropped below).
    mesh.visible = true
    mesh.updateWorldMatrix(true, false)
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
    const entry: ColliderEntry = {
      mesh,
      bvh: bvhFor(mesh),
      inverse: new Matrix4().copy(mesh.matrixWorld).invert(),
      worldBox: mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld),
      root: mesh,
      nodeId: `__boots-piece-${piece.id}`,
      nodeType: 'block',
    }
    world.colliders.push(entry)
    return () => {
      entry.disabled = true
      const index = world.colliders.indexOf(entry)
      if (index !== -1) world.colliders.splice(index, 1)
      // If the piece had voxelized, drop the replica too (G-undo or a mask
      // edit would otherwise leave carved voxels of the old shape floating).
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

/** Solid, collidable render of everything placed this session. */
export function PlacedPieces({ world }: { world: GameWorld }) {
  const placed = useBoots((s) => s.placed)
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

export function Builder() {
  const ghostRef = useRef<Group>(null)
  const [ghost, setGhost] = useState<GhostState | null>(null)
  const [edit, setEdit] = useState<EditState | null>(null)
  const prevFire = useRef(false)
  const prevUndo = useRef(false)
  const prevEditKey = useRef(false)
  const placeCooldown = useRef(0)
  /** Pose of the last stamp — hold-to-place fires again once it changes. */
  const lastPlaced = useRef({ has: false, piece: 'wall' as BuildPiece, x: 0, y: 0, z: 0, yaw: 0 })

  const weapon = useBoots((s) => s.weapon)
  const buildPiece = useBoots((s) => s.buildPiece)
  const active = weapon === 'builder'

  useEffect(() => {
    ;(globalThis as Record<string, unknown>).__bootsBuilder = builderDebug
    return () => {
      builderDebug.holdFire = false
      delete (globalThis as Record<string, unknown>).__bootsBuilder
    }
  }, [])

  // HUD mode-hint line: shown while the 3x3 cell editor is open, cleared on
  // exit/unmount (hud.editHint owns its own element — prompts never clobber it).
  const editing = edit !== null
  useEffect(() => {
    const session = getSession()
    if (!session) return
    session.hud.editHint(editing ? 'F exit · click toggles cell' : null)
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
      if (edit) setEdit(null)
      lastPlaced.current.has = false
      prevFire.current = session.input.state.firing || builderDebug.holdFire
      prevEditKey.current = session.input.state.keys.has('KeyF')
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
      if (ghost) setGhost(null)
      // G undo is paused while editing, but keep its edge tracker warm so
      // holding G across the exit never fires a stale undo.
      prevUndo.current = session.input.state.keys.has('KeyG')
      const piece = useBoots.getState().placed.find((p) => p.id === edit.id)
      const hit = piece ? raycastPieceCell(piece, aox, aoy, aoz, adx, ady, adz, EDIT_RANGE) : null
      // Exit: F again, the piece is gone, or the aim left it.
      if (!piece || !hit || editKeyEdge) {
        setEdit(null)
        placeCooldown.current = PLACE_INTERVAL // a beat before hold-place resumes
        prevFire.current = firingNow
        return
      }
      if (firingNow && !prevFire.current && !staggered) {
        useBoots.getState().setPlacedMask(piece.id, piece.mask ^ (1 << hit.bit))
        sfx.place()
      }
      prevFire.current = firingNow
      const mask = useBoots.getState().placed.find((p) => p.id === edit.id)?.mask ?? piece.mask
      if (edit.hover !== hit.bit || edit.mask !== mask) {
        setEdit({ ...edit, hover: hit.bit, mask })
      }
      return
    }
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
        if (ghost) setGhost(null)
        prevFire.current = firingNow
        return
      }
    }

    // Resolve this frame's ghost: raw grid pose, then adjacency snap.
    const placed = useBoots.getState().placed
    const raw = rawGhost()
    const snap = resolveSnap(buildPiece, placed, raw, aimHeightAt)
    const gx = snap ? snap.x : raw.x
    const gy = snap ? snap.y : raw.y
    const gz = snap ? snap.z : raw.z
    const gyaw = snap ? snap.yaw : raw.yaw
    const occupied = isOccupied(placed, buildPiece, gx, gy, gz, gyaw)

    if (
      !ghost ||
      ghost.x !== gx ||
      ghost.y !== gy ||
      ghost.z !== gz ||
      ghost.yaw !== gyaw ||
      ghost.piece !== buildPiece ||
      ghost.occupied !== occupied
    ) {
      setGhost({ x: gx, y: gy, z: gz, yaw: gyaw, piece: buildPiece, occupied })
    }
    _debugGhost.x = gx
    _debugGhost.y = gy
    _debugGhost.z = gz
    _debugGhost.yaw = gyaw
    _debugGhost.piece = buildPiece
    _debugGhost.occupied = occupied

    // Place: on press, and while held whenever the ghost pose changes
    // (min PLACE_INTERVAL apart). Occupied poses are skipped, no sound.
    // Staggered hands can't stamp (matches the viewmodel's fire block);
    // prevFire still tracks the raw button so recovery doesn't edge-place.
    const firing = session.input.state.firing || builderDebug.holdFire
    if (firing && !useBoots.getState().staggered && placeCooldown.current <= 0) {
      const last = lastPlaced.current
      const moved =
        !last.has ||
        last.piece !== buildPiece ||
        last.x !== gx ||
        last.y !== gy ||
        last.z !== gz ||
        last.yaw !== gyaw
      if ((!prevFire.current || moved) && !occupied) {
        placeCooldown.current = PLACE_INTERVAL
        useBoots.getState().addPlaced({ piece: buildPiece, position: [gx, gy, gz], yaw: gyaw })
        sfx.place()
        last.has = true
        last.piece = buildPiece
        last.x = gx
        last.y = gy
        last.z = gz
        last.yaw = gyaw
      }
    }
    prevFire.current = firing

    const undoDown = session.input.state.keys.has('KeyG')
    if (undoDown && !prevUndo.current) {
      const removed = useBoots.getState().removeLastPlaced()
      if (removed) sfx.weaponSwitch()
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
          color={ghost.occupied ? '#ff5a4d' : '#59a7ff'}
          depthWrite={false}
          opacity={0.38}
          transparent
        />
      </mesh>
    </group>
  )
}
