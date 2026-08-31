'use client'

import { useFrame } from '@react-three/fiber'
import { useLayoutEffect, useMemo, useRef } from 'react'
import {
  Box3,
  CanvasTexture,
  Color,
  DynamicDrawUsage,
  Euler,
  type InstancedMesh,
  Matrix4,
  type Mesh,
  Quaternion,
  Ray,
  Vector3,
} from 'three'
import { create } from 'zustand'
import { sfx } from './audio'
import { groundSurfaceY } from './ground'
import { getSession, hideForGame } from './session'
import { bvhFor, type GameWorld, type GlassPane } from './world'

/**
 * Two-stage glass: bullet hits pin a radial crack sprite to the pane; the
 * third hit shatters it — the host mesh hides (session ledger restores it)
 * and the pane breaks into FLAT PLATE SHARDS (owner round 5: the old cube
 * chunks off the shared debris ring read as "glass breaking into voxels").
 * Shards live in this module's own small instanced pool: thin translucent
 * plates cut from the pane's plane, launched off both faces, falling under
 * full gravity with a fast tumble — glass, not paper. Crack texture is
 * drawn once on a small canvas at runtime; no assets.
 */

export type CrackDecal = {
  id: number
  position: [number, number, number]
  quaternion: [number, number, number, number]
}

type GlassState = {
  hits: Map<Mesh, number>
  cracks: CrackDecal[]
  shattered: Set<Mesh>
  version: number
}

export const useGlass = create<GlassState>(() => ({
  hits: new Map(),
  cracks: [],
  shattered: new Set(),
  version: 0,
}))

export function resetGlass(): void {
  useGlass.setState({ hits: new Map(), cracks: [], shattered: new Set(), version: 0 })
  clearGlassShards()
}

let crackId = 1
const _ray = new Ray()
const _worldRay = new Ray()
const _worldBox = new Box3()
const _boxHit = new Vector3()
const _inverse = new Matrix4()
const _normalMat = new Vector3()

export type GlassHit = { pane: GlassPane; distance: number; point: Vector3; normal: Vector3 }

export function raycastGlass(
  world: GameWorld,
  origin: Vector3,
  direction: Vector3,
  maxDist: number,
): GlassHit | null {
  const shattered = useGlass.getState().shattered
  let best: GlassHit | null = null
  _worldRay.origin.copy(origin)
  _worldRay.direction.copy(direction)
  for (const pane of world.glass) {
    if (shattered.has(pane.mesh)) continue
    // Broadphase, for the same reason the bullet lane has one (shooting.ts):
    // `bvhFor` BUILDS the pane's MeshBVH on a miss exactly as readily as on a
    // hit, so without this cull the first shot fired anywhere in the house paid
    // a synchronous build for EVERY pane in it. Panes are not colliders, so the
    // background prime queue never covers them — this lane is the only one that
    // ever builds them.
    //
    // The box comes off the live matrixWorld rather than a cached one: an
    // operation window's panes swing with their root, and a stale box would cull
    // a pane the round really passes through.
    const geometry = pane.mesh.geometry
    if (!geometry.boundingBox) geometry.computeBoundingBox()
    _worldBox.copy(geometry.boundingBox!).applyMatrix4(pane.mesh.matrixWorld)
    // A box entry beyond maxDist can never beat it either (entry ≤ true hit).
    const entry = _worldRay.intersectBox(_worldBox, _boxHit)
    if (entry === null || (entry.distanceTo(origin) > maxDist && !_worldBox.containsPoint(origin))) continue
    _inverse.copy(pane.mesh.matrixWorld).invert()
    _ray.origin.copy(origin).applyMatrix4(_inverse)
    _ray.direction.copy(direction).transformDirection(_inverse)
    const hit = bvhFor(pane.mesh).raycastFirst(_ray, 2)
    if (!hit) continue
    const point = hit.point.clone().applyMatrix4(pane.mesh.matrixWorld)
    const distance = point.distanceTo(origin)
    if (distance > maxDist) continue
    if (!best || distance < best.distance) {
      const normal = (hit.face?.normal
        ? _normalMat.copy(hit.face.normal).transformDirection(pane.mesh.matrixWorld).clone()
        : direction.clone().negate()) as Vector3
      best = { pane, distance, point, normal }
    }
  }
  return best
}

// ── Flat plate shards (owner round 5: no more cubic glass) ──────────────────

/** Shard plate thickness (m) — real pane glass, one sliver axis ~8 mm. */
export const GLASS_SHARD_THICKNESS = 0.008
/** Shard plate face band (m): each in-plane edge draws MIN..MIN+SPAN. */
export const GLASS_SHARD_FACE_MIN = 0.06
export const GLASS_SHARD_FACE_SPAN = 0.16
/** Shards per m² of pane face, clamped to the count band below. */
export const GLASS_SHARDS_PER_M2 = 20
export const GLASS_SHARD_COUNT_MIN = 10
export const GLASS_SHARD_COUNT_MAX = 34
/** Pool cap — a grenade's multi-pane wave recycles the oldest slot. */
const SHARD_CAP = 96
/** Rest half-height on the floor — a settled tilted plate, not a cube. */
const SHARD_REST = 0.02
const SHARD_GRAVITY = 14

/** Pure: how many plate shards one pane throws, from its face area (m²). */
export function glassShardCount(area: number): number {
  if (!(area > 0)) return GLASS_SHARD_COUNT_MIN
  return Math.min(
    GLASS_SHARD_COUNT_MAX,
    Math.max(GLASS_SHARD_COUNT_MIN, Math.round(area * GLASS_SHARDS_PER_M2)),
  )
}

/** Pure: one shard's in-plane face size from two 0..1 rolls — always a
 * PLATE (each face edge is many times GLASS_SHARD_THICKNESS). */
export function glassShardFace(r1: number, r2: number): { w: number; h: number } {
  return {
    w: GLASS_SHARD_FACE_MIN + r1 * GLASS_SHARD_FACE_SPAN,
    h: GLASS_SHARD_FACE_MIN + r2 * GLASS_SHARD_FACE_SPAN,
  }
}

/** Landing-plane probe, mirroring debris.tsx setDebrisGroundProbe — injected
 * per session by game-root so shattered upstairs panes drop shards onto
 * their own storey's floor, not the terrain plane. Probed once PER PANE
 * SIDE at shatter time (2 calls), never per shard, never per frame. */
export type GlassFloorProbe = (x: number, y: number, z: number) => number
let floorProbe: GlassFloorProbe | null = null
export function setGlassFloorProbe(probe: GlassFloorProbe | null): void {
  floorProbe = probe
}

type ShardSlot = {
  alive: boolean
  px: number
  py: number
  pz: number
  vx: number
  vy: number
  vz: number
  rx: number
  ry: number
  rz: number
  wx: number
  wy: number
  wz: number
  sx: number
  sy: number
  sz: number
  /** World Y the plate settles at (probed floor + SHARD_REST). */
  ground: number
  ttl: number
  ttl0: number
  landed: boolean
}

const shardSlots: ShardSlot[] = Array.from({ length: SHARD_CAP }, () => ({
  alive: false,
  px: 0,
  py: 0,
  pz: 0,
  vx: 0,
  vy: 0,
  vz: 0,
  rx: 0,
  ry: 0,
  rz: 0,
  wx: 0,
  wy: 0,
  wz: 0,
  sx: 0.1,
  sy: 0.1,
  sz: GLASS_SHARD_THICKNESS,
  ground: SHARD_REST,
  ttl: 0,
  ttl0: 1,
  landed: false,
}))
let shardCursor = 0
let liveShards = 0

export function clearGlassShards(): void {
  for (const slot of shardSlots) slot.alive = false
  liveShards = 0
}

/** Frames the shard loop has stepped since module load — QA reads deltas to
 * assert the pool is actually being driven (a frozen count means the loop
 * is not mounted / not ticking, not that shards are immortal). */
let shardFrameTicks = 0

/** Headless QA probe — live plate count, mean vertical velocity, ttl range,
 * landed count + the constant sliver thickness (asserting plates, not
 * cubes, numerically). */
export function glassShardCensus(): {
  live: number
  meanVy: number
  thickness: number
  minTtl: number
  maxTtl: number
  landed: number
  ticks: number
} {
  let live = 0
  let vy = 0
  let landed = 0
  let minTtl = Number.POSITIVE_INFINITY
  let maxTtl = Number.NEGATIVE_INFINITY
  for (const slot of shardSlots) {
    if (!slot.alive) continue
    live++
    vy += slot.vy
    if (slot.landed) landed++
    if (slot.ttl < minTtl) minTtl = slot.ttl
    if (slot.ttl > maxTtl) maxTtl = slot.ttl
  }
  return {
    live,
    meanVy: live > 0 ? vy / live : 0,
    thickness: GLASS_SHARD_THICKNESS,
    minTtl: live > 0 ? minTtl : 0,
    maxTtl: live > 0 ? maxTtl : 0,
    landed,
    ticks: shardFrameTicks,
  }
}

// Static align quaternions: rotate shard local +Z (the sliver axis of the
// unit-box instance) onto the pane's LOCAL thin axis.
const ALIGN_X = new Quaternion().setFromEuler(new Euler(0, Math.PI / 2, 0))
const ALIGN_Y = new Quaternion().setFromEuler(new Euler(Math.PI / 2, 0, 0))
const ALIGN_Z = new Quaternion()

const _paneQuat = new Quaternion()
const _tilt = new Quaternion()
const _spawnEuler = new Euler()
const _thinDir = new Vector3()
const _worldScale = new Vector3()
const _spawnPoint = new Vector3()
const _paneCenter = new Vector3()

/** Break one pane into plate shards riding this module's pool. */
function spawnPaneShards(pane: GlassPane): void {
  const mesh = pane.mesh
  if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
  const box = mesh.geometry.boundingBox!
  mesh.getWorldScale(_worldScale)
  const ex = (box.max.x - box.min.x) * Math.abs(_worldScale.x)
  const ey = (box.max.y - box.min.y) * Math.abs(_worldScale.y)
  const ez = (box.max.z - box.min.z) * Math.abs(_worldScale.z)
  // Thin axis = smallest world extent; the two larger extents span the face.
  let align = ALIGN_Z
  let thin = ez
  if (ex <= ey && ex <= ez) {
    align = ALIGN_X
    thin = ex
  } else if (ey <= ex && ey <= ez) {
    align = ALIGN_Y
    thin = ey
  }
  const area = (ex * ey * ez) / Math.max(thin, 1e-4)
  mesh.getWorldQuaternion(_paneQuat).multiply(align)
  _thinDir.set(0, 0, 1).applyQuaternion(_paneQuat)
  // One floor probe per pane FACE (never per shard): sample ~0.45 m out
  // along each face normal so shards land on the storey they fall into.
  box.getCenter(_paneCenter).applyMatrix4(mesh.matrixWorld)
  // No probe installed (tests, headless) falls back to the GROUND at the
  // sample XZ — y = 0 on a flat lot, the terrain height on a sculpted site.
  const negX = _paneCenter.x - _thinDir.x * 0.45
  const negZ = _paneCenter.z - _thinDir.z * 0.45
  const posX = _paneCenter.x + _thinDir.x * 0.45
  const posZ = _paneCenter.z + _thinDir.z * 0.45
  const floorNeg = floorProbe
    ? floorProbe(negX, _paneCenter.y, negZ)
    : groundSurfaceY(negX, negZ)
  const floorPos = floorProbe
    ? floorProbe(posX, _paneCenter.y, posZ)
    : groundSurfaceY(posX, posZ)
  const count = glassShardCount(area)
  for (let i = 0; i < count; i++) {
    const slot = shardSlots[shardCursor]!
    shardCursor = (shardCursor + 1) % SHARD_CAP
    if (!slot.alive) liveShards++
    slot.alive = true
    _spawnPoint
      .set(
        box.min.x + Math.random() * (box.max.x - box.min.x),
        box.min.y + Math.random() * (box.max.y - box.min.y),
        box.min.z + Math.random() * (box.max.z - box.min.z),
      )
      .applyMatrix4(mesh.matrixWorld)
    slot.px = _spawnPoint.x
    slot.py = _spawnPoint.y
    slot.pz = _spawnPoint.z
    // Both faces spray: gentle pop along ±normal, gravity does the rest.
    const side = Math.random() < 0.5 ? -1 : 1
    const pop = 0.5 + Math.random() * 1.1
    slot.vx = _thinDir.x * side * pop + (Math.random() - 0.5) * 0.6
    slot.vy = _thinDir.y * side * pop - (0.2 + Math.random() * 0.7)
    slot.vz = _thinDir.z * side * pop + (Math.random() - 0.5) * 0.6
    // Start IN the pane's plane (small tilt, free in-plane spin), then
    // tumble fast — glass, not paper.
    _tilt.setFromEuler(
      _spawnEuler.set(
        (Math.random() - 0.5) * 0.5,
        (Math.random() - 0.5) * 0.5,
        Math.random() * Math.PI * 2,
      ),
    )
    _q.copy(_paneQuat).multiply(_tilt)
    _spawnEuler.setFromQuaternion(_q)
    slot.rx = _spawnEuler.x
    slot.ry = _spawnEuler.y
    slot.rz = _spawnEuler.z
    slot.wx = (Math.random() - 0.5) * 8
    slot.wy = (Math.random() - 0.5) * 8
    slot.wz = (Math.random() - 0.5) * 8
    const face = glassShardFace(Math.random(), Math.random())
    slot.sx = face.w
    slot.sy = face.h
    slot.sz = GLASS_SHARD_THICKNESS
    slot.ground = (side < 0 ? floorNeg : floorPos) + SHARD_REST
    slot.ttl = 1.5 + Math.random() * 1.0
    slot.ttl0 = slot.ttl
    slot.landed = false
  }
}

export function shatterPane(pane: GlassPane): void {
  // A grenade's deferred glass waves (40/80 ms setTimeout in explodeAt) can
  // outlive the session — Esc inside that window runs resetGlass first, and
  // a late shatter would then mark the STILL-RENDERING pane in the fresh
  // store (an unbreakable window all next session), spray shards into the
  // cleared pool, and play the voice in the editor. No session → no-op.
  if (!getSession()) return
  const state = useGlass.getState()
  if (state.shattered.has(pane.mesh)) return
  hideForGame(pane.mesh)
  spawnPaneShards(pane)
  const shattered = new Set(state.shattered)
  shattered.add(pane.mesh)
  useGlass.setState({
    shattered,
    cracks: state.cracks, // pane cracks keep floating in the frame — reads as broken edge bits
    version: state.version + 1,
  })
  sfx.glassShatter()
}

export function hitGlass(hit: GlassHit): void {
  const state = useGlass.getState()
  const count = (state.hits.get(hit.pane.mesh) ?? 0) + 1
  state.hits.set(hit.pane.mesh, count)
  if (count >= 3) {
    shatterPane(hit.pane)
    return
  }
  const quaternion = crackQuaternion(hit.normal)
  useGlass.setState({
    cracks: [
      ...state.cracks,
      {
        id: crackId++,
        position: [
          hit.point.x + hit.normal.x * 0.006,
          hit.point.y + hit.normal.y * 0.006,
          hit.point.z + hit.normal.z * 0.006,
        ],
        quaternion,
      },
    ],
    version: state.version + 1,
  })
  sfx.glassCrack()
}

const _z = new Vector3(0, 0, 1)
const _q = new Quaternion()

function crackQuaternion(normal: Vector3): [number, number, number, number] {
  _q.setFromUnitVectors(_z, normal.clone().normalize())
  return [_q.x, _q.y, _q.z, _q.w]
}

let crackTexture: CanvasTexture | null = null

function getCrackTexture(): CanvasTexture | null {
  if (crackTexture) return crackTexture
  if (typeof document === 'undefined') return null
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const g = canvas.getContext('2d')!
  g.clearRect(0, 0, size, size)
  g.strokeStyle = 'rgba(235,245,250,0.9)'
  const cx = size / 2
  for (let i = 0; i < 9; i++) {
    const angle = (i / 9) * Math.PI * 2 + Math.random() * 0.5
    g.lineWidth = 1.5
    g.beginPath()
    g.moveTo(cx, cx)
    let r = 8
    let x = cx
    let y = cx
    while (r < size / 2 - 4) {
      r += 8 + Math.random() * 10
      x = cx + Math.cos(angle + (Math.random() - 0.5) * 0.4) * r
      y = cx + Math.sin(angle + (Math.random() - 0.5) * 0.4) * r
      g.lineTo(x, y)
    }
    g.stroke()
  }
  for (const radius of [10, 22, 36]) {
    g.lineWidth = 1
    g.beginPath()
    g.arc(cx, cx, radius + Math.random() * 5, 0, Math.PI * 2)
    g.stroke()
  }
  crackTexture = new CanvasTexture(canvas)
  return crackTexture
}

const GLASS_SHARD_COLOR = '#bcd8e2'
const _shardMatrix = new Matrix4()
const _shardQuat = new Quaternion()
const _shardEuler = new Euler()
const _shardPos = new Vector3()
const _shardScale = new Vector3()
const SHARD_ZERO = new Matrix4().makeScale(0, 0, 0)

/** Crack decals + the plate-shard pool — one component so game-root's
 * existing <GlassCracks /> mount carries both. */
export function GlassCracks() {
  const version = useGlass((s) => s.version)
  const cracks = useMemo(() => {
    void version
    return useGlass.getState().cracks
  }, [version])
  const texture = getCrackTexture()
  const shardsRef = useRef<InstancedMesh>(null!)

  useLayoutEffect(() => {
    const mesh = shardsRef.current
    if (!mesh) return
    mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    for (let i = 0; i < SHARD_CAP; i++) mesh.setMatrixAt(i, SHARD_ZERO)
    mesh.instanceMatrix.needsUpdate = true
    mesh.frustumCulled = false
    return clearGlassShards
  }, [])

  useFrame((_, rawDt) => {
    const mesh = shardsRef.current
    if (!mesh || liveShards === 0) return
    shardFrameTicks++
    const dt = Math.min(rawDt, 1 / 30)
    for (let i = 0; i < SHARD_CAP; i++) {
      const s = shardSlots[i]!
      if (!s.alive) continue
      s.ttl -= dt
      if (s.ttl <= 0) {
        s.alive = false
        liveShards--
        mesh.setMatrixAt(i, SHARD_ZERO)
        continue
      }
      // Full gravity — glass drops, it never flutters like drywall paper.
      s.vy -= SHARD_GRAVITY * dt
      s.px += s.vx * dt
      s.py += s.vy * dt
      s.pz += s.vz * dt
      s.rx += s.wx * dt
      s.ry += s.wy * dt
      s.rz += s.wz * dt
      if (s.py < s.ground && s.vy < 0) {
        s.py = s.ground
        if (s.landed) {
          s.vy = 0
          const settle = 1 / (1 + 10 * dt)
          s.vx *= settle
          s.vz *= settle
          s.wx *= settle
          s.wy *= settle
          s.wz *= settle
        } else {
          // Glass barely bounces: one dead hop, tumble mostly killed.
          s.vy = -s.vy * 0.15
          s.vx *= 0.5
          s.vz *= 0.5
          s.wx *= 0.3
          s.wy *= 0.3
          s.wz *= 0.3
          s.landed = true
        }
      }
      const fade = Math.min(1, s.ttl / (s.ttl0 * 0.25))
      _shardEuler.set(s.rx, s.ry, s.rz)
      _shardQuat.setFromEuler(_shardEuler)
      _shardPos.set(s.px, s.py, s.pz)
      _shardScale.set(s.sx * fade, s.sy * fade, s.sz)
      _shardMatrix.compose(_shardPos, _shardQuat, _shardScale)
      mesh.setMatrixAt(i, _shardMatrix)
    }
    mesh.instanceMatrix.needsUpdate = true
  })

  return (
    <group userData={{ __boots: true }}>
      {texture
        ? cracks.map((crack) => (
            <mesh key={crack.id} position={crack.position} quaternion={crack.quaternion}>
              <planeGeometry args={[0.34, 0.34]} />
              <meshBasicMaterial depthWrite={false} map={texture} transparent />
            </mesh>
          ))
        : null}
      <instancedMesh args={[undefined, undefined, SHARD_CAP]} ref={shardsRef}>
        <boxGeometry />
        <meshStandardMaterial
          color={GLASS_SHARD_COLOR}
          depthWrite={false}
          metalness={0}
          opacity={0.55}
          roughness={0.15}
          transparent
        />
      </instancedMesh>
    </group>
  )
}
