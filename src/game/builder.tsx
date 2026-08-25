'use client'

import { useFrame } from '@react-three/fiber'
import { useEffect, useRef, useState } from 'react'
import { BoxGeometry, Matrix4, type Group, type Mesh } from 'three'
import { type BuildPiece, type PlacedPiece, useBoots } from '../store'
import { sfx } from './audio'
import { EYE_HEIGHT } from './collision'
import { dropTarget } from './destruction'
import { playerRig } from './player'
import { getSession } from './session'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

/**
 * Build mode, battle-builder grammar: wall / floor / ramp (Q cycles), ghost
 * in front of you, LMB stamps it in. Placements are game-only state — the
 * panel's Keep converts walls into real scene nodes afterwards, Discard
 * forgets everything. G undoes (piece + collider + any voxel replica).
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
 *   floors — tile edge-to-edge on the neighbor's plane (4 sides), and roof a
 *            wall's top (py + WALL_H) when your aim ray passes the same 3/4
 *            gate as wall stacking: two candidates, one each side of the
 *            wall plane, floor edge flush with the wall line — a level gaze
 *            at ground level keeps tiling flat, never teleports up.
 *   ramps  — low edge snaps to a floor edge (rising away from the floor) or
 *            to a wall base (high edge kisses the wall top: WALL_H rise).
 * HOLD-TO-PLACE: holding LMB stamps a piece whenever the (possibly snapped)
 * ghost pose changes, min PLACE_INTERVAL between stamps — sweep a wall run.
 * VALIDITY: an identical pose (piece + position + yaw up to the piece's own
 * symmetry) is never placed twice — the ghost tints red over an occupied
 * pose, blue when free; occupied stamps are skipped silently.
 *
 * ── API (exported for tests / other systems) ──────────────────────────────
 *   PIECE_DIMS / piecePose      piece geometry + pose from base elevation.
 *   resolveSnap(piece, placed, raw, aimYAt)   pure snap resolver → snapped
 *       pose or null. `aimYAt(x, z)` = aim-ray height over that XZ point
 *       (gates wall stacking at 3/4 of the neighbor's height). RETURNS A
 *       REUSED MODULE OBJECT — copy fields before the next call if you
 *       keep them.
 *   isOccupied(placed, piece, x, y, z, yaw)   identical-pose test, yaw
 *       compared modulo the piece's symmetry (wall π, floor π/2, ramp 2π).
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
  ramp: [3, 0.12, 4.1],
}

/** Horizontal footprint of a piece along its snap axis. The ramp's 4.1 m
 * plank covers a 3 m run + WALL_H rise, so every piece tiles on 3 m. */
const SPAN = 3
const RAMP_HALF_RUN = SPAN / 2
/** Floor-center offset from the wall plane when roofing a wall top — half
 * the floor's span, so the floor's edge sits flush on the wall line. */
const ROOF_OFFSET = SPAN / 2

const RAMP_TILT = -Math.atan2(WALL_H, 3)

export function piecePose(piece: BuildPiece, baseY: number): { y: number; tilt: number } {
  if (piece === 'wall') return { y: baseY + WALL_H / 2, tilt: 0 }
  if (piece === 'floor') return { y: baseY + 0.06, tilt: 0 }
  return { y: baseY + WALL_H / 2, tilt: RAMP_TILT }
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

// --- Pose equality --------------------------------------------------------

const TWO_PI = Math.PI * 2
/** Yaw period under which the piece's box is self-identical. */
const YAW_SYMMETRY: Record<BuildPiece, number> = {
  wall: Math.PI,
  floor: Math.PI / 2,
  ramp: TWO_PI,
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
        consider(px + nx * ROOF_OFFSET, topY, pz + nz * ROOF_OFFSET, p.yaw)
        consider(px - nx * ROOF_OFFSET, topY, pz - nz * ROOF_OFFSET, p.yaw)
      }
    } else if (piece === 'ramp' && p.piece === 'floor') {
      // Low edge on a floor edge, rising away from the floor. With the ramp's
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
    } else if (piece === 'ramp' && p.piece === 'wall') {
      // Low edge at the wall base, high edge kissing the wall (the ramp
      // rises exactly WALL_H, so it tops out at the wall top). For face
      // normal n: center = wall + 1.5n, low-edge dir L = n →
      // yaw = atan2(-n.x, -n.z).
      const nx = Math.sin(p.yaw)
      const nz = Math.cos(p.yaw)
      consider(px + nx * RAMP_HALF_RUN, py, pz + nz * RAMP_HALF_RUN, Math.atan2(-nx, -nz))
      consider(px - nx * RAMP_HALF_RUN, py, pz - nz * RAMP_HALF_RUN, Math.atan2(nx, nz))
    }
  }

  return _best.found ? _best : null
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

/** One placed piece: the RENDERED mesh doubles as its collider, so when the
 * piece voxelizes the destruction manager ledger-hides the mesh the player
 * sees and the voxel replica takes over. Pieces are immutable once placed —
 * register on mount, remove on unmount (undo). Placed entries are always
 * APPENDED after the world's build-time colliders, so splicing them out
 * never shifts the door colliderIndices. */
function PlacedPieceMesh({ piece, world }: { piece: PlacedPiece; world: GameWorld }) {
  const meshRef = useRef<Mesh>(null)

  useEffect(() => {
    const mesh = meshRef.current
    if (!mesh) return
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
      // If the piece had voxelized, drop the replica too (G-undo would
      // otherwise leave carved voxels floating until exit).
      dropTarget(entry.nodeId)
    }
  }, [world, piece])

  const pose = piecePose(piece.piece, piece.position[1])
  return (
    <mesh
      castShadow
      geometry={geometryFor(piece.piece)}
      position={[piece.position[0], pose.y, piece.position[2]]}
      ref={meshRef}
      rotation={[piece.piece === 'ramp' ? pose.tilt : 0, piece.yaw, 0, 'YXZ']}
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

export function Builder() {
  const ghostRef = useRef<Group>(null)
  const [ghost, setGhost] = useState<GhostState | null>(null)
  const prevFire = useRef(false)
  const prevUndo = useRef(false)
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

  useFrame((_, dt) => {
    const session = getSession()
    if (!session) return
    placeCooldown.current -= dt

    if (!active) {
      if (ghost) setGhost(null)
      lastPlaced.current.has = false
      prevFire.current = session.input.state.firing || builderDebug.holdFire
      return
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

  if (!active || !ghost) return null
  const pose = piecePose(ghost.piece, ghost.y)
  return (
    <group ref={ghostRef} userData={{ __boots: true }}>
      <mesh
        position={[ghost.x, pose.y, ghost.z]}
        rotation={[ghost.piece === 'ramp' ? pose.tilt : 0, ghost.yaw, 0, 'YXZ']}
      >
        <boxGeometry args={PIECE_DIMS[ghost.piece]} />
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
