'use client'

import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import {
  type BufferGeometry,
  CanvasTexture,
  Color,
  DynamicDrawUsage,
  type InstancedMesh,
  Matrix4,
  type Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Ray,
  Vector3,
} from 'three'
import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js'
import { useBoots } from '../store'
import { sfx, type SprayHandle } from './audio'
import * as destructionModule from './destruction'
import { ensureVoxelTarget, raycastVoxelTargets, useDestruction, type VoxelTarget } from './destruction'
import { spawnDust } from './dust'
import { itemGhostActive } from './item-place'
import { playerRig } from './player'
import { primedCellColor } from './skin-tone'
import { getSession } from './session'
import { aimDirection } from './shooting'
import type { GameWorld } from './world'

/**
 * The paint sprayer — slot 7. Fire tints whatever the crosshair touches:
 * host walls' voxel/cladding replicas, floors/slabs/roofs, placed builder
 * pieces (their voxel clads), all through ONE lane — a splat marks the
 * alive grid cells within the spray cone's radius at the hit distance
 * (splatRadiusAt: close = pencil-thin writing strokes, far = a broad
 * wall-coating fan) and the renderer's
 * EXISTING per-instance color attribute wears the tint (no new meshes,
 * no shaders — CPU setColorAt + needsUpdate, WebGPU-safe). A pristine
 * paintable node voxelizes on first coat exactly like first blood does.
 *
 * R cycles the palette while the sprayer is held (viewmodel consumes the
 * action — it is the single input-queue consumer); the HUD shows the color
 * through the feature-detected `hud.paintSwatch?.()` with the shared
 * prompt() line as the fallback until hud.ts ships it.
 *
 * ── Rendering contract (voxel-walls.tsx untouched) ─────────────────────
 * voxel-walls primes instanceColor per voxel in a [wall]-keyed layout
 * effect and its frame loop only ever zeroes MATRICES — colors are never
 * re-written between primes. PaintTool's frame drain re-applies painted
 * cells directly on the skin InstancedMesh, resolved from the scene by a
 * count + alive-cell-center fingerprint (matrices compose the grid's
 * world-space centers verbatim, so one probe identifies the mesh beyond
 * doubt) and cached per node. Two userData gates — the per-node paint
 * serial and the TARGET IDENTITY — make the drain idle-free and survive
 * both re-voxelize re-primes (new target object) and mesh remounts.
 *
 * ── Persistence ─────────────────────────────────────────────────────────
 * NOTHING here writes the scene store (standing rule). Splats accumulate
 * in a module ledger (nodeId → cell → packed (color << 8) | strength) that
 * paint-keep.ts aggregates into per-node dominant colors on exit (votes
 * weighted by strength); the explicit sidebar
 * Save button is the only path that patches real nodes. The ledger resets
 * on PaintTool mount — the same session lifetime destruction state has.
 */

export type PaintColor = { name: string; hex: string }

/** Building-appropriate coats — muted architectural tones, not crayons. */
export const PAINT_PALETTE: readonly PaintColor[] = [
  { name: 'CHALK WHITE', hex: '#f2efe6' },
  { name: 'GREIGE', hex: '#c9c1b2' },
  { name: 'SAGE', hex: '#9cab8b' },
  { name: 'TERRACOTTA', hex: '#c07a5b' },
  { name: 'NAVY', hex: '#3b4a63' },
  { name: 'CHARCOAL', hex: '#44464a' },
  { name: 'OCHRE', hex: '#d3a55f' },
]

/** Splats per second while the trigger is held. */
const PAINT_RATE = 9
/** Sprayer reach (m) — long enough to stand back and coat a whole wall
 * at the broad end of the cone, still well under gun range. */
const PAINT_RANGE = 9

// ── The spray cone (distance-driven splat radius) ─────────────────────────
//
// Real aerosol widens with distance; we EXAGGERATE it (owner call): nose
// against the wall the splat is a one-cell-wide stroke you can WRITE with,
// eight meters back one splat blankets over a meter. Quadratic ease keeps
// the radius tight through the whole writing range and blooms late.

/** Inside this distance (m) the splat stays at its narrowest. */
export const SPLAT_NEAR_DIST = 1
/** Narrow-end radius (m) — one 0.15 m wall cell wide: legible strokes. */
export const SPLAT_NEAR_RADIUS = 0.12
/** Beyond this distance (m) the cone is fully open. */
export const SPLAT_FAR_DIST = 8
/** Broad-end radius (m) — one splat covers most of a wall face. */
export const SPLAT_FAR_RADIUS = 1.4

/** Pure cone curve: hit distance (m) → splat radius (m). Clamped quadratic
 * ease-in between the near/far anchors — flat narrow plateau ≤ 1 m, slow
 * growth through writing range, late bloom to 1.4 m at ≥ 8 m. */
export function splatRadiusAt(distance: number): number {
  const span = SPLAT_FAR_DIST - SPLAT_NEAR_DIST
  const t = Math.min(Math.max((distance - SPLAT_NEAR_DIST) / span, 0), 1)
  return SPLAT_NEAR_RADIUS + (SPLAT_FAR_RADIUS - SPLAT_NEAR_RADIUS) * t * t
}

/** Painting nearer than this (m) is "writing mode" — the HUD says so. */
export const WRITING_DISTANCE = 2

/** Node types a coat can voxelize (mirrors shooting's destructible lane —
 * paintable ⊆ destructible, so painting never voxelizes what bullets
 * couldn't). Placed builder pieces register as 'block'. */
const PAINTABLE = new Set([
  'wall',
  'door',
  'window',
  'slab',
  'floor',
  'ceiling',
  'roof',
  'roof-segment',
  'block',
  'column',
  'stair',
  'stair-segment',
])

// ── Palette selection (module state — survives weapon switches) ──────────

let colorIndex = 0

export const currentPaintColor = (): PaintColor => PAINT_PALETTE[colorIndex]!

/** R while the sprayer is held — viewmodel routes the action here. */
export function cyclePaintColor(): PaintColor {
  colorIndex = (colorIndex + 1) % PAINT_PALETTE.length
  return PAINT_PALETTE[colorIndex]!
}

/** The HUD line copy — writing mode (spraying inside WRITING_DISTANCE)
 * vs the plain paint prompt. Pure; exported for tests. */
export function paintPrompt(writing: boolean, colorName: string): string {
  return writing ? 'WRITING MODE — R next color' : `PAINT · ${colorName} — R next color`
}

// ── The splat ledger (read by paint-keep on exit) ─────────────────────────
//
// FEATHERED ACCUMULATION (phase 9): ledger values pack (colorIndex << 8) |
// strengthByte. Every splat ADDS smoothstep-falloff weight — the center of
// a pass saturates in ~2 ticks, the feathered edge takes repeated coats —
// so held spray builds up like real aerosol instead of stamping hard-edged
// discs. The drain lerps each cell from its PRIMED base tone (skin-tone.ts)
// by strength; paint-keep votes (value >> 8) weighted by the strength byte.

/** Pack a coat: palette index + strength 0..1 → (color << 8) | byte. */
export const paintValue = (color: number, strength: number): number =>
  (color << 8) | Math.max(0, Math.min(255, Math.round(strength * 255)))
/** Palette index half of a packed ledger value. */
export const paintColorOf = (value: number): number => value >> 8
/** Strength half of a packed ledger value, back in 0..1. */
export const paintStrengthOf = (value: number): number => (value & 0xff) / 255

/** nodeId → voxel cell index → packed (color << 8) | strength coat. */
const paintedByNode = new Map<string, Map<number, number>>()
/** Per-node write serial — the renderer-drain's change gate (also the
 * deterministic seed for the rim speckle hash). */
const nodeSerials = new Map<string, number>()

export const getPaintedByNode = (): ReadonlyMap<string, ReadonlyMap<number, number>> =>
  paintedByNode

/** Fresh session, fresh coats — called from PaintTool's mount effect. */
export function resetPaint(): void {
  paintedByNode.clear()
  nodeSerials.clear()
  lastHitDistance = null
}

// ── Last hit distance (drives the cone + the writing-mode HUD line) ───────

let lastHitDistance: number | null = null

/** Distance (m) of the most recent spray tick's surface hit; null while
 * spraying at nothing. PaintTool reads it for the writing-mode prompt. */
export const lastSprayHitDistance = (): number | null => lastHitDistance

// ── Feathered coat math (pure — exported for tests) ───────────────────────

/** Rim speckle band: overspray flecks land between 1.0 r and this × r. */
export const SPLAT_RIM_OUTER = 1.25
/** Strength a splat's CENTER adds per tick — saturates in ~2–3 coats. */
export const COAT_ADD = 0.45
/** Fraction of annulus cells that catch an overspray fleck. */
export const RIM_SPECKLE_P = 0.18
/** Strength one rim fleck adds — faint, builds only under repeated passes. */
export const RIM_SPECKLE_ADD = 0.16

/** Smoothstep falloff across the splat: 1 at the center (t = 0), 0 at the
 * rim (t = d / radius = 1). Pure — the feathered-edge curve. */
export function splatFalloff(t: number): number {
  if (t <= 0) return 1
  if (t >= 1) return 0
  const u = 1 - t
  return u * u * (3 - 2 * u)
}

/** Deterministic per-(cell, serial) hash in [0, 1) — the rim speckle
 * lottery. Same (cell, serial) always draws the same number, so a splat's
 * overspray pattern is reproducible (tests pin it). */
export function speckleHash(cell: number, serial: number): number {
  let h = (Math.imul(cell + 1, 2654435761) ^ Math.imul(serial + 1, 1597334677)) >>> 0
  h = Math.imul(h ^ (h >>> 13), 1 | h) >>> 0
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/**
 * One splat's strength contributions: every ALIVE cell inside `radius`
 * gains COAT_ADD × smoothstep falloff (full at the hit point, feathering
 * to zero at the rim); cells in the 1.0–1.25 r annulus catch faint
 * overspray flecks by the deterministic (cell, serial) lottery. Pure —
 * sprayPaint accumulates the adds into the packed ledger.
 */
export function splatCoat(
  grid: { count: number; alive: ArrayLike<number>; centers: ArrayLike<number> },
  x: number,
  y: number,
  z: number,
  radius: number,
  serial: number,
): { cell: number; add: number }[] {
  const r2 = radius * radius
  const outer2 = r2 * SPLAT_RIM_OUTER * SPLAT_RIM_OUTER
  const out: { cell: number; add: number }[] = []
  for (let i = 0; i < grid.count; i++) {
    if (!grid.alive[i]) continue
    const dx = (grid.centers[i * 3] ?? 0) - x
    const dy = (grid.centers[i * 3 + 1] ?? 0) - y
    const dz = (grid.centers[i * 3 + 2] ?? 0) - z
    const d2 = dx * dx + dy * dy + dz * dz
    if (d2 > outer2) continue
    if (d2 <= r2) {
      const add = COAT_ADD * splatFalloff(Math.sqrt(d2) / radius)
      if (add > 0) out.push({ cell: i, add })
    } else if (speckleHash(i, serial) < RIM_SPECKLE_P) {
      out.push({ cell: i, add: RIM_SPECKLE_ADD })
    }
  }
  return out
}

/**
 * Pure splat-cell selection: every ALIVE cell whose world center sits
 * within `radius` of the hit point (3D distance, inclusive). Exported for
 * tests — the shape is the VoxelGridData subset the math touches.
 */
export function selectSplatCells(
  grid: { count: number; alive: ArrayLike<number>; centers: ArrayLike<number> },
  x: number,
  y: number,
  z: number,
  radius: number,
): number[] {
  const r2 = radius * radius
  const cells: number[] = []
  for (let i = 0; i < grid.count; i++) {
    if (!grid.alive[i]) continue
    const dx = (grid.centers[i * 3] ?? 0) - x
    const dy = (grid.centers[i * 3 + 1] ?? 0) - y
    const dz = (grid.centers[i * 3 + 2] ?? 0) - z
    if (dx * dx + dy * dy + dz * dz <= r2) cells.push(i)
  }
  return cells
}

/**
 * Dev-only handle (published as `globalThis.__bootsPaint` while the tool
 * runs — the `__bootsBuilder` pattern): headless E2E can't engage pointer
 * lock, so `holdFire` stands in for the held LMB (it is OR-ed with the real
 * input each frame).
 */
export const paintDebug: { holdFire: boolean } = { holdFire: false }

// ── Aerosol mist (dust.tsx kind 'paint' — tinted cone off the nozzle) ─────

/** Nozzle offset from the eye, matching the viewmodel carry pose (the can
 * rides low-right with the spout converging on the crosshair). */
export const NOZZLE_FORWARD = 0.35
export const NOZZLE_RIGHT = 0.28
export const NOZZLE_DOWN = 0.28

const _up = new Vector3(0, 1, 0)
const _nozzleRight = new Vector3()
const _nozzle = new Vector3()
const _mistAt = new Vector3()
const _mistDir = new Vector3()
const _bounce = new Vector3()
const _tintScratch = new Color()
/** Reused DustOpts — zero allocations per spray tick (module temps). */
const _mistTint = { r: 0, g: 0, b: 0 }
const _mistOpts = { kind: 'paint', direction: _mistDir, tint: _mistTint } as const
const _bounceOpts = { kind: 'paint', normal: _bounce, tint: _mistTint } as const

/** Refresh the shared mist tint from the live coat (working color space). */
function refreshMistTint(): void {
  _tintScratch.set(currentPaintColor().hex)
  _mistTint.r = _tintScratch.r
  _mistTint.g = _tintScratch.g
  _mistTint.b = _tintScratch.b
}

/** World nozzle position: eye + aim·forward + right·0.28 + down·0.28 —
 * where the can's spout sits in the carry pose. Writes the module temp. */
function nozzleAt(origin: Vector3, aim: Vector3): Vector3 {
  _nozzleRight.crossVectors(aim, _up)
  if (_nozzleRight.lengthSq() < 1e-6) _nozzleRight.set(1, 0, 0)
  else _nozzleRight.normalize()
  return _nozzle
    .copy(origin)
    .addScaledVector(aim, NOZZLE_FORWARD)
    .addScaledVector(_nozzleRight, NOZZLE_RIGHT)
    .addScaledVector(_up, -NOZZLE_DOWN)
}

// ── Drips (P4 — heavy coats on walls shed runs) ───────────────────────────

/** Drip pool size — one InstancedMesh of wall-plane streak quads. */
export const DRIP_CAP = 48
/** A cell must already carry this much strength for a re-coat to run. */
export const DRIP_STRENGTH_GATE = 0.75
/** Chance a qualifying cell sheds a drip. */
export const DRIP_P = 0.25
/** Hard cap on drips born per spray tick. */
export const DRIP_MAX_PER_TICK = 2
/** Seconds a fresh drip takes to run down to full length. */
const DRIP_GROW_TIME = 1.1
/** Streak quad width (m) and final run length range (m). */
const DRIP_WIDTH = 0.05
const DRIP_LEN_MIN = 0.18
const DRIP_LEN_MAX = 0.38

/**
 * Pure spawn decision — exported for tests. Only near-vertical surfaces
 * (the wall sandwich) drip; the cell must ALREADY be saturated past the
 * gate (drips come from over-coating, not the first pass); at most
 * DRIP_MAX_PER_TICK per tick; then the DRIP_P lottery.
 */
export function shouldDrip(
  kind: string,
  prevStrength: number,
  spawnedThisTick: number,
  rand: number,
): boolean {
  return (
    kind === 'wall' &&
    prevStrength > DRIP_STRENGTH_GATE &&
    spawnedThisTick < DRIP_MAX_PER_TICK &&
    rand < DRIP_P
  )
}

type DripSlot = {
  alive: boolean
  /** Top anchor — the run grows DOWN from here. */
  x: number
  y: number
  z: number
  /** Wall-plane yaw: the quad's +Z faces back along the spray. */
  yaw: number
  color: number
  age: number
  /** Final run length (m). */
  len: number
  /** Fully grown — the matrix is final, the step loop skips it. */
  done: boolean
}

const dripSlots: DripSlot[] = Array.from({ length: DRIP_CAP }, () => ({
  alive: false,
  x: 0,
  y: 0,
  z: 0,
  yaw: 0,
  color: 0,
  age: 0,
  len: 0.2,
  done: false,
}))
let dripCursor = 0
/** Slots still growing — the step loop idles at a number check. */
let dripsGrowing = 0

/** Live/growing counts — QA + tests introspection. */
export function dripCensus(): { live: number; growing: number } {
  let live = 0
  for (const s of dripSlots) if (s.alive) live++
  return { live, growing: dripsGrowing }
}

export function resetDrips(): void {
  for (const s of dripSlots) {
    s.alive = false
    s.done = false
  }
  dripCursor = 0
  dripsGrowing = 0
}

/** Claim the next ring slot (the debris-ring idiom — the 49th drip reuses
 * the first; runs persist until reused). */
function spawnDrip(x: number, y: number, z: number, yaw: number, color: number): void {
  const s = dripSlots[dripCursor]!
  dripCursor = (dripCursor + 1) % DRIP_CAP
  if (!s.alive || s.done) dripsGrowing++
  s.alive = true
  s.done = false
  s.x = x
  s.y = y
  s.z = z
  s.yaw = yaw
  s.color = color
  s.age = 0
  s.len = DRIP_LEN_MIN + Math.random() * (DRIP_LEN_MAX - DRIP_LEN_MIN)
}

/** One cached white streak texture — tinted per instance, built once for
 * the module lifetime (the dust-texture idiom). */
let dripTexture: CanvasTexture | null = null
function getDripTexture(): CanvasTexture | null {
  if (dripTexture) return dripTexture
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = 32
  canvas.height = 128
  const g = canvas.getContext('2d')
  if (!g) return null
  // A tapering run with a fat bead at the bottom — white so the instance
  // color carries the coat.
  const run = g.createLinearGradient(0, 0, 0, 128)
  run.addColorStop(0, 'rgba(255,255,255,0.55)')
  run.addColorStop(0.15, 'rgba(255,255,255,0.85)')
  run.addColorStop(0.8, 'rgba(255,255,255,0.9)')
  run.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = run
  g.beginPath()
  g.moveTo(13, 0)
  g.lineTo(19, 0)
  g.lineTo(18, 96)
  g.lineTo(14, 96)
  g.closePath()
  g.fill()
  const bead = g.createRadialGradient(16, 100, 0, 16, 100, 9)
  bead.addColorStop(0, 'rgba(255,255,255,0.95)')
  bead.addColorStop(0.7, 'rgba(255,255,255,0.8)')
  bead.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = bead
  g.beginPath()
  g.arc(16, 100, 9, 0, Math.PI * 2)
  g.fill()
  dripTexture = new CanvasTexture(canvas)
  return dripTexture
}

const DRIP_ZERO = new Matrix4().makeScale(0, 0, 0)
const DRIP_UP = new Vector3(0, 1, 0)
const _dripQuat = new Quaternion()
const _dripPos = new Vector3()
const _dripScale = new Vector3()
const _dripMatrix = new Matrix4()
const _dripTint = new Color()

/** Advance growing drips: ease-out length growth, top edge anchored so the
 * run translates DOWN as it grows; fully grown runs freeze (persist until
 * their slot is reused). Zero allocations; idles at a number check. */
function stepDrips(mesh: InstancedMesh, dt: number): void {
  if (dripsGrowing === 0) return
  for (let i = 0; i < DRIP_CAP; i++) {
    const s = dripSlots[i]!
    if (!s.alive || s.done) continue
    s.age += dt
    const k = Math.min(1, s.age / DRIP_GROW_TIME)
    const grow = k * (2 - k) // ease-out: the run slows as it dries
    const len = Math.max(0.02, s.len * grow)
    _dripQuat.setFromAxisAngle(DRIP_UP, s.yaw)
    _dripPos.set(s.x, s.y - len / 2, s.z)
    _dripScale.set(DRIP_WIDTH, len, 1)
    _dripMatrix.compose(_dripPos, _dripQuat, _dripScale)
    mesh.setMatrixAt(i, _dripMatrix)
    // Wet coat: the palette color pushed a touch darker + richer.
    _dripTint.set(PAINT_PALETTE[s.color]!.hex).offsetHSL(0, 0.05, -0.06)
    mesh.setColorAt(i, _dripTint)
    if (k >= 1) {
      s.done = true
      dripsGrowing--
    }
  }
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
}

/**
 * The drip pool renderer — mounted by PaintTool. One InstancedMesh of
 * DRIP_CAP streak quads over one cached CanvasTexture; instanceColor is
 * primed before the first draw (the debris idiom — a WebGPU pipeline
 * compiled without it would ignore every later setColorAt).
 */
function DripsLayer() {
  const meshRef = useRef<InstancedMesh>(null!)
  const texture = getDripTexture()
  useLayoutEffect(() => {
    const mesh = meshRef.current
    if (!mesh) return
    mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    mesh.frustumCulled = false
    _dripTint.set('#ffffff')
    for (let i = 0; i < DRIP_CAP; i++) {
      mesh.setMatrixAt(i, DRIP_ZERO)
      mesh.setColorAt(i, _dripTint)
    }
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    resetDrips()
    return resetDrips
  }, [])
  useFrame((_, rawDt) => {
    const mesh = meshRef.current
    if (mesh) stepDrips(mesh, Math.min(rawDt, 1 / 30))
  })
  if (!texture) return null
  return (
    <instancedMesh args={[undefined, undefined, DRIP_CAP]} ref={meshRef} userData={{ __boots: true }}>
      <planeGeometry />
      <meshBasicMaterial
        depthWrite={false}
        map={texture}
        polygonOffset
        polygonOffsetFactor={-2}
        polygonOffsetUnits={-2}
        toneMapped={false}
        transparent
      />
    </instancedMesh>
  )
}

// ── Decals (P5 — pristine hosts wear splats, painting no longer voxelizes) ─
//
// A spray tick that lands on a PRISTINE host surface (a dormant prebuild or
// a never-voxelized node) projects a DecalGeometry splat onto the host mesh
// instead of voxelizing it: plain BufferGeometry + shared standard material
// (polygonOffset −4, depthWrite false — the craters read), one cached splat
// alpha texture + ≤ PAINT_PALETTE.length cached materials. Slots live in a
// crater-style ring (cap DECAL_CAP, per-node DECAL_NODE_CAP, geometry
// disposed on reuse/reset). Heavy meshes (> DECAL_MAX_TRIS) and failed
// projections fall back to the classic voxelize path. When the node later
// voxelizes for real (damage), destruction's target-live hook converts the
// node's decals into the cell ledger and frees the slots; paint-keep votes
// live decals area-weighted next to the cell ledger.

export const DECAL_CAP = 256
export const DECAL_NODE_CAP = 64
/** Hosts above this triangle count skip the decal clip (fallback = voxels). */
export const DECAL_MAX_TRIS = 5000

/** Pure guard — exported for tests. */
export function decalEligibleTris(triangles: number): boolean {
  return triangles <= DECAL_MAX_TRIS
}

type DecalSlot = {
  alive: boolean
  /** Bumped on every (re)use — the React key, so a reused slot remounts. */
  gen: number
  nodeId: string
  /** Built eagerly at spawn (world-space vertices); disposed on reuse. */
  geometry: BufferGeometry | null
  color: number
  /** Splat center + radius — the ledger conversion + area votes. */
  x: number
  y: number
  z: number
  radius: number
}

const decalSlots: DecalSlot[] = Array.from({ length: DECAL_CAP }, () => ({
  alive: false,
  gen: 0,
  nodeId: '',
  geometry: null,
  color: 0,
  x: 0,
  y: 0,
  z: 0,
  radius: 0.1,
}))
let decalCursor = 0
/** nodeId → slot indices in spawn order (per-node cap + conversion). */
const nodeDecals = new Map<string, number[]>()
let decalVersion = 0
const decalListeners = new Set<() => void>()

function emitDecals(): void {
  decalVersion++
  for (const listener of decalListeners) listener()
}
const subscribeDecals = (listener: () => void): (() => void) => {
  decalListeners.add(listener)
  return () => decalListeners.delete(listener)
}
const getDecalVersion = (): number => decalVersion

/** Live decal counts (QA/tests) — total and for one node. */
export function decalCensus(nodeId?: string): number {
  if (nodeId !== undefined) return nodeDecals.get(nodeId)?.length ?? 0
  let n = 0
  for (const s of decalSlots) if (s.alive) n++
  return n
}

function releaseSlot(index: number): void {
  const s = decalSlots[index]!
  if (!s.alive) return
  s.alive = false
  s.geometry?.dispose()
  s.geometry = null
  const list = nodeDecals.get(s.nodeId)
  if (list) {
    const at = list.indexOf(index)
    if (at >= 0) list.splice(at, 1)
    if (list.length === 0) nodeDecals.delete(s.nodeId)
  }
}

export function resetPaintDecals(): void {
  for (let i = 0; i < DECAL_CAP; i++) releaseSlot(i)
  nodeDecals.clear()
  decalCursor = 0
  emitDecals()
}

/** Area-weighted live-decal votes per node: colorIndex → painted m².
 * paint-keep merges these next to the strength-weighted cell votes. */
export function getDecalVotesByNode(): Map<string, Map<number, number>> {
  const out = new Map<string, Map<number, number>>()
  for (const s of decalSlots) {
    if (!s.alive) continue
    let votes = out.get(s.nodeId)
    if (!votes) {
      votes = new Map()
      out.set(s.nodeId, votes)
    }
    const area = Math.PI * s.radius * s.radius
    votes.set(s.color, (votes.get(s.color) ?? 0) + area)
  }
  return out
}

/** One cached soft-splat alpha texture — white, tinted by the material. */
let decalTexture: CanvasTexture | null = null
function getDecalTexture(): CanvasTexture | null {
  if (decalTexture) return decalTexture
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 128
  const g = canvas.getContext('2d')
  if (!g) return null
  // Dense core feathering out, with a few overspray blobs off the rim.
  const core = g.createRadialGradient(64, 64, 0, 64, 64, 58)
  core.addColorStop(0, 'rgba(255,255,255,0.96)')
  core.addColorStop(0.62, 'rgba(255,255,255,0.9)')
  core.addColorStop(0.85, 'rgba(255,255,255,0.4)')
  core.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = core
  g.fillRect(0, 0, 128, 128)
  for (let i = 0; i < 9; i++) {
    const angle = (i / 9) * Math.PI * 2 + (i % 3) * 0.41
    const dist = 44 + (i % 4) * 5
    const bx = 64 + Math.cos(angle) * dist
    const by = 64 + Math.sin(angle) * dist
    const r = 4 + (i % 3) * 3
    const blob = g.createRadialGradient(bx, by, 0, bx, by, r)
    blob.addColorStop(0, 'rgba(255,255,255,0.55)')
    blob.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = blob
    g.beginPath()
    g.arc(bx, by, r, 0, Math.PI * 2)
    g.fill()
  }
  decalTexture = new CanvasTexture(canvas)
  return decalTexture
}

/** Palette-index → shared decal material (≤ PAINT_PALETTE.length, module
 * lifetime — the label-texture idiom; R3F never disposes prop materials). */
const decalMaterials = new Map<number, MeshStandardMaterial>()
export function decalMaterialFor(color: number): MeshStandardMaterial | null {
  const swatch = PAINT_PALETTE[color]
  if (!swatch) return null
  const cached = decalMaterials.get(color)
  if (cached) return cached
  const material = new MeshStandardMaterial({
    color: swatch.hex,
    depthWrite: false,
    map: getDecalTexture(),
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
    roughness: 0.55,
    transparent: true,
  })
  decalMaterials.set(color, material)
  return material
}

const _decalHelper = new Object3D()
const _decalLook = new Vector3()
const _decalSize = new Vector3()

/**
 * Project one splat onto a pristine host mesh and claim a ring slot.
 * Returns false when the mesh is too heavy or the clip produced nothing —
 * sprayPaint then falls back to the voxelize path. Per-node overflow reuses
 * the NODE's oldest decal (a wall being over-sprayed churns its own splats,
 * never the rest of the scene's).
 */
export function spawnPaintDecal(
  mesh: Mesh,
  nodeId: string,
  point: Vector3,
  normal: Vector3,
  radius: number,
  color: number = colorIndex,
): boolean {
  const geometryHost = mesh.geometry
  if (!geometryHost) return false
  const position = geometryHost.getAttribute('position')
  if (!position) return false
  const triangles = (geometryHost.index ? geometryHost.index.count : position.count) / 3
  if (!decalEligibleTris(triangles)) return false
  // Projector frame: look back along the surface normal, random roll so
  // repeated splats never stamp identical.
  _decalHelper.position.copy(point)
  _decalLook.copy(point).add(normal)
  _decalHelper.lookAt(_decalLook)
  _decalHelper.rotation.z = Math.random() * Math.PI * 2
  const d = radius * 2
  _decalSize.set(d, d, Math.max(0.12, d * 0.5))
  const geometry = new DecalGeometry(mesh, point, _decalHelper.rotation, _decalSize)
  if (!geometry.getAttribute('position') || geometry.getAttribute('position').count === 0) {
    geometry.dispose()
    return false
  }
  // Slot claim: the node at its cap recycles ITS oldest; otherwise the
  // global ring advances (evicting whatever lived there).
  let list = nodeDecals.get(nodeId)
  let index: number
  if (list && list.length >= DECAL_NODE_CAP) {
    index = list[0]!
    releaseSlot(index)
  } else {
    index = decalCursor
    decalCursor = (decalCursor + 1) % DECAL_CAP
    releaseSlot(index)
  }
  list = nodeDecals.get(nodeId)
  if (!list) {
    list = []
    nodeDecals.set(nodeId, list)
  }
  list.push(index)
  const s = decalSlots[index]!
  s.alive = true
  s.gen++
  s.nodeId = nodeId
  s.geometry = geometry
  s.color = color
  s.x = point.x
  s.y = point.y
  s.z = point.z
  s.radius = radius
  emitDecals()
  return true
}

/**
 * The target-live hook body (destruction calls it whenever a node's replica
 * goes live — fresh voxelize or dormant wake): every decal on the node
 * converts into the CELL ledger as a full falloff coat (splatCoat's adds
 * normalized back out of COAT_ADD), then the slots free — from that frame
 * on the voxel drain owns the paint. Roof nodes decompose into `id#pN`
 * member targets; each live member takes the cells inside its own grid.
 */
export function convertDecalsForNode(nodeId: string): void {
  const indices = nodeDecals.get(nodeId)
  if (!indices || indices.length === 0) return
  const targets = useDestruction.getState().targets
  const prefix = `${nodeId}#`
  for (const target of targets.values()) {
    if (target.dormant) continue
    if (target.nodeId !== nodeId && !target.nodeId.startsWith(prefix)) continue
    const ledgerId = target.nodeId
    let painted = paintedByNode.get(ledgerId)
    const serial = nodeSerials.get(ledgerId) ?? 0
    let wrote = false
    for (const index of indices) {
      const s = decalSlots[index]!
      if (!s.alive) continue
      const coats = splatCoat(target.grid, s.x, s.y, s.z, s.radius, serial)
      if (coats.length === 0) continue
      if (!painted) {
        painted = new Map()
        paintedByNode.set(ledgerId, painted)
      }
      for (const { cell, add } of coats) {
        const strength = Math.min(1, add / COAT_ADD)
        const prev = painted.get(cell)
        const before = prev === undefined ? 0 : paintStrengthOf(prev)
        painted.set(cell, paintValue(s.color, Math.min(1, before + strength)))
      }
      wrote = true
    }
    if (wrote) nodeSerials.set(ledgerId, serial + 1)
  }
  // Free the node's slots whether or not a live grid caught them — the
  // host surface they were clipped against is hidden now.
  for (const index of [...indices]) releaseSlot(index)
  emitDecals()
}

/** Feature-detected registration — destruction.ts gains
 * setTargetLiveListener via the manager diff; until then decals simply
 * persist unconverted (they still render over the replica). */
function targetLiveRegistrar(): ((cb: ((nodeId: string) => void) | null) => void) | undefined {
  return (destructionModule as { setTargetLiveListener?: (cb: ((nodeId: string) => void) | null) => void })
    .setTargetLiveListener
}

/** The session's splats — mounted by PaintTool, crater-style keyed slots. */
function PaintDecals() {
  useSyncExternalStore(subscribeDecals, getDecalVersion, getDecalVersion)
  return (
    <group userData={{ __boots: true }}>
      {decalSlots.map((slot, i) => {
        if (!slot.alive || !slot.geometry) return null
        const material = decalMaterialFor(slot.color)
        if (!material) return null
        return (
          // Geometry lifetime is the ring's (disposed on reuse/reset), the
          // materials are module-cached — R3F must dispose neither.
          <mesh dispose={null} geometry={slot.geometry} key={`${i}:${slot.gen}`} material={material} />
        )
      })}
    </group>
  )
}

// ── Spray resolution (raycast scratch — module temps, no per-shot allocs) ──

const _origin = new Vector3()
const _direction = new Vector3()
const _ray = new Ray()
const _worldRay = new Ray()
const _boxHit = new Vector3()
const _inverse = new Matrix4()
const _point = new Vector3()
const _decalNormal = new Vector3()

/**
 * One trigger tick: resolve the crosshair ray (voxel skins beat solid
 * colliders on a near-tie, same priority shooting uses), voxelize a
 * pristine paintable node, then ledger the splat cells — sized by the
 * spray cone at the HIT DISTANCE (close = writing stroke, far = wall
 * coat). Returns true when any cell took paint.
 */
export function sprayPaint(world: GameWorld): boolean {
  _origin.copy(playerRig.position)
  aimDirection(_direction, 0)

  // Solid host meshes first (lowest priority) — the fire() collider walk.
  let bestDist = PAINT_RANGE
  let nodeId: string | null = null
  let solidType: string | null = null
  let needsVoxelize = false
  let decalMesh: Mesh | null = null
  // Broadphase before the BVH (the shooting.ts idiom): a ray-vs-AABB test
  // costs nanoseconds, culls almost every collider per spray tick, and —
  // critically — keeps the lazy `.bvh` getter from BUILDING BVHs for
  // distant untouched colliders inside the tick. An AABB entry point
  // farther than the current winner can never beat it (entry ≤ true hit).
  _worldRay.origin.copy(_origin)
  _worldRay.direction.copy(_direction)
  for (const collider of world.colliders) {
    // walkOnly planks are capsule-only — the spray lands on their voxels.
    if (collider.disabled || collider.walkOnly) continue
    const entry = _worldRay.intersectBox(collider.worldBox, _boxHit)
    if (entry === null || entry.distanceTo(_origin) > bestDist) continue
    _inverse.copy(collider.inverse)
    _ray.origin.copy(_origin).applyMatrix4(_inverse)
    _ray.direction.copy(_direction).transformDirection(_inverse)
    const hit = collider.bvh.raycastFirst(_ray, 2)
    if (!hit) continue
    const world_ = hit.point.applyMatrix4(collider.mesh.matrixWorld)
    const distance = world_.distanceTo(_origin)
    if (distance < bestDist) {
      bestDist = distance
      nodeId = collider.nodeId
      solidType = collider.nodeType
      needsVoxelize = true
      decalMesh = collider.mesh
      // Decal projector axis: the true face normal when the BVH hands one
      // back, the reversed aim otherwise.
      if (hit.face) _decalNormal.copy(hit.face.normal).transformDirection(collider.mesh.matrixWorld)
      else _decalNormal.copy(_direction).negate()
      _point.copy(world_)
    }
  }

  // Already-voxelized skins win near-ties — paint lands on what renders.
  const voxelHit = raycastVoxelTargets(_origin, _direction, bestDist + 0.01)
  if (voxelHit) {
    nodeId = voxelHit.nodeId
    needsVoxelize = false
    _point.copy(voxelHit.point)
    bestDist = voxelHit.distance
  }
  // Mist (P1): a tinted cone puffs off the nozzle every tick; on a surface
  // hit the spray bounces back off the wall at the hit point, a clean miss
  // hangs a puff in the air downrange instead.
  refreshMistTint()
  _mistDir.copy(_direction)
  spawnDust(nozzleAt(_origin, _direction), 0.4, _mistOpts)
  if (!nodeId) {
    _mistAt.copy(_nozzle).addScaledVector(_direction, 1.1)
    spawnDust(_mistAt, 0.28, _mistOpts)
    lastHitDistance = null
    return false
  }
  _bounce.copy(_direction).negate()
  spawnDust(_point, 0.55, _bounceOpts)
  lastHitDistance = bestDist
  let ensured: VoxelTarget | null = null
  if (needsVoxelize) {
    if (!solidType || !PAINTABLE.has(solidType)) return false
    // P5: a PRISTINE host wears a DecalGeometry splat — painting no longer
    // voxelizes it. The node keeps its host meshes and colliders until
    // real damage arrives; destruction's target-live hook then converts
    // these splats into the cell ledger and frees the slots.
    if (decalMesh && spawnPaintDecal(decalMesh, nodeId, _point, _decalNormal, splatRadiusAt(bestDist))) {
      return true
    }
    // Fallback (heavy mesh / degenerate clip): the classic voxelize lane.
    ensured = ensureVoxelTarget(world, nodeId)
    if (!ensured) return false // degenerate grid
  }
  // Roof groups voxelize into per-plane targets keyed `nodeId#pN` — the
  // bare-id lookup misses them on the very first tick (QA r2v finding 2),
  // so fall back to the member ensureVoxelTarget just returned. If it is
  // not the aimed plane, selectSplatCells finds nothing and the next tick
  // resolves through the voxel-skin raycast as usual.
  const target = useDestruction.getState().targets.get(nodeId) ?? ensured
  if (!target) return false

  const serial = nodeSerials.get(nodeId) ?? 0
  const coats = splatCoat(target.grid, _point.x, _point.y, _point.z, splatRadiusAt(bestDist), serial)
  if (coats.length === 0) return false
  let painted = paintedByNode.get(nodeId)
  if (!painted) {
    painted = new Map()
    paintedByNode.set(nodeId, painted)
  }
  // Drip frame (P4): the streak quad faces back along the spray, pushed
  // just off the voxel face; over-coated wall cells shed runs below.
  let nx = -_direction.x
  let nz = -_direction.z
  const nl = Math.hypot(nx, nz)
  if (nl > 1e-4) {
    nx /= nl
    nz /= nl
  } else {
    nx = 0
    nz = 1
  }
  const dripYaw = Math.atan2(nx, nz)
  let drips = 0
  for (const { cell, add } of coats) {
    const prev = painted.get(cell)
    const before = prev === undefined ? 0 : paintStrengthOf(prev)
    if (shouldDrip(target.kind, before, drips, Math.random())) {
      drips++
      spawnDrip(
        target.grid.centers[cell * 3]! + nx * 0.06,
        target.grid.centers[cell * 3 + 1]! - target.grid.cellY * 0.5,
        target.grid.centers[cell * 3 + 2]! + nz * 0.06,
        dripYaw,
        colorIndex,
      )
    }
    painted.set(cell, paintValue(colorIndex, Math.min(1, before + add)))
  }
  nodeSerials.set(nodeId, serial + 1)
  return true
}

// ── Tint drain (renderer side — writes ONLY instanceColor) ────────────────

const _tint = new Color()
const _base = new Color()
const _probeMatrix = new Matrix4()
/** nodeId → resolved skin mesh (revalidated by fingerprint every drain). */
const meshCache = new Map<string, InstancedMesh>()

/** Paint bookkeeping parked on the mesh (userData survives our module,
 * dies with the mesh — exactly the lifetime the gates need). */
type PaintedUserData = {
  __bootsPaintSerial?: number
  __bootsPaintTarget?: VoxelTarget
}

/**
 * Fingerprint: the skin InstancedMesh composes the grid's WORLD-space
 * centers verbatim into its instance matrices, so instance count + one
 * alive cell's translation identify it beyond doubt (member layers share
 * the parent group but never those centers). A fully-dead grid matches
 * nothing — there is nothing left to tint.
 */
function matchesTarget(mesh: InstancedMesh, target: VoxelTarget): boolean {
  const grid = target.grid
  if (mesh.count !== grid.count) return false
  let probe = -1
  for (let i = 0; i < grid.count; i++) {
    if (grid.alive[i]) {
      probe = i
      break
    }
  }
  if (probe === -1) return false
  mesh.getMatrixAt(probe, _probeMatrix)
  const e = _probeMatrix.elements
  return (
    Math.abs(e[12]! - grid.centers[probe * 3]!) < 1e-3 &&
    Math.abs(e[13]! - grid.centers[probe * 3 + 1]!) < 1e-3 &&
    Math.abs(e[14]! - grid.centers[probe * 3 + 2]!) < 1e-3
  )
}

/** Full-scene resolveMesh traversals left this drain — a cache miss walks
 * the WHOLE host scene, so at most one node pays that per frame (the rest
 * retry next drain; splats are 9 Hz, a one-frame tint delay is invisible). */
let traverseBudget = 0

function resolveMesh(scene: Object3D, nodeId: string, target: VoxelTarget): InstancedMesh | null {
  const cached = meshCache.get(nodeId)
  if (cached && cached.parent && matchesTarget(cached, target)) return cached
  meshCache.delete(nodeId)
  if (traverseBudget <= 0) return null
  traverseBudget--
  let found: InstancedMesh | null = null
  scene.traverse((object) => {
    if (found) return
    const mesh = object as InstancedMesh
    if (!mesh.isInstancedMesh || !mesh.parent?.userData.__boots) return
    if (matchesTarget(mesh, target)) found = mesh
  })
  if (found) meshCache.set(nodeId, found)
  return found
}

/**
 * Re-apply painted cells whose mesh is out of date. Idles at one serial
 * compare per painted node; a splat, a re-voxelize (new target object —
 * voxel-walls' layout effect just re-primed every color) or a mesh
 * remount re-writes that node's coats wholesale (painted sets stay small).
 * Dead cells skip — their matrices are zero anyway.
 */
export function drainPaintTints(scene: Object3D): void {
  if (paintedByNode.size === 0) return
  traverseBudget = 1
  const targets = useDestruction.getState().targets
  for (const [nodeId, cells] of paintedByNode) {
    const target = targets.get(nodeId)
    if (!target) continue
    // FULLY-dead grid (island crumble / collapse): there is nothing left to
    // tint AND matchesTarget can never fingerprint it (no alive probe), so
    // resolving would full-scene-traverse every drain forever. Skip it —
    // the LEDGER stays (capturePaint's "every painted cell died" full-ledger
    // vote still counts the node on Save); only the mesh ref drops.
    if (target.grid.aliveCount === 0) {
      meshCache.delete(nodeId)
      continue
    }
    const serial = nodeSerials.get(nodeId) ?? 0
    const mesh = resolveMesh(scene, nodeId, target)
    if (!mesh) continue
    const gates = mesh.userData as PaintedUserData
    if (gates.__bootsPaintSerial === serial && gates.__bootsPaintTarget === target) continue
    for (const [cell, value] of cells) {
      if (!target.grid.alive[cell]) continue
      // Same hash the priming jitter uses, gentler spread — painted runs
      // keep the per-voxel "block" read instead of banding flat.
      const j = ((cell * 2654435761) % 97) / 97
      _tint.set(PAINT_PALETTE[paintColorOf(value)]!.hex).offsetHSL(0, 0, (j - 0.5) * 0.06)
      // Feathered accumulation: the coat lerps up from the cell's PRIMED
      // base tone by strength — thin edges show the wall through, full
      // coats cover it (skin-tone.ts is the shared prime-color math).
      primedCellColor(_base, target, cell)
      mesh.setColorAt(cell, _base.lerp(_tint, paintStrengthOf(value)))
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    gates.__bootsPaintSerial = serial
    gates.__bootsPaintTarget = target
  }
}

// ── Viewmodel prop ────────────────────────────────────────────────────────

const CAN_BODY = '#b6b9be'
const CAN_DARK = '#7f838a'
const NOZZLE = '#2b2e33'
/** Label ink pair — picked per palette entry by paintLabelInk(). */
const INK_DARK = '#1c1e22'
const INK_LIGHT = '#f4f2ea'

/** Pure contrast pick: dark ink on light coats, light ink on dark coats
 * (rec-601 luma on the palette hex). Exported for tests. */
export function paintLabelInk(hex: string): string {
  const r = Number.parseInt(hex.slice(1, 3), 16)
  const g = Number.parseInt(hex.slice(3, 5), 16)
  const b = Number.parseInt(hex.slice(5, 7), 16)
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luma > 0.55 ? INK_DARK : INK_LIGHT
}

/** hex → "PRESS R" band texture. Module cache — built once per PALETTE
 * entry (membership-gated, so the map is bounded to the 7 coats), shared
 * by every SprayerModel mount and NEVER rebuilt per frame. Textures live
 * for the module lifetime (the dust-texture idiom); R3F only disposes the
 * JSX materials, never these maps. */
const labelTextures = new Map<string, CanvasTexture>()

export function paintLabelTexture(hex: string): CanvasTexture | null {
  // Bound the cache: only real palette coats mint a texture.
  if (!PAINT_PALETTE.some((swatch) => swatch.hex === hex)) return null
  const cached = labelTextures.get(hex)
  if (cached) return cached
  if (typeof document === 'undefined') return null // SSR/tests: color-only band
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 128
  const g = canvas.getContext('2d')
  if (!g) return null
  g.fillStyle = hex
  g.fillRect(0, 0, 512, 128)
  const ink = paintLabelInk(hex)
  g.strokeStyle = ink
  g.lineWidth = 4
  g.strokeRect(150, 20, 212, 88)
  g.fillStyle = ink
  g.font = 'bold 44px system-ui, sans-serif'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  // Centered at u=0.5 — the band mesh spins π so this faces the camera
  // (cylinder UVs put u=0 at +Z, which is also the seam).
  g.fillText('PRESS R', 256, 66)
  const texture = new CanvasTexture(canvas)
  labelTextures.set(hex, texture)
  return texture
}

/**
 * Compact aerosol can for the viewmodel (weapon-models conventions: grip at
 * the origin, -Z forward). The label band wears the LIVE palette color with
 * "PRESS R" printed on it (module-cached CanvasTexture per coat) and the
 * cap ring under the nozzle wears the same color — one change-gated
 * material write per cycle, no new materials, no per-frame texture work.
 */
export function SprayerModel() {
  const bandRef = useRef<Mesh>(null)
  const capRef = useRef<Mesh>(null)
  useFrame(() => {
    const band = bandRef.current
    const cap = capRef.current
    if (!band || !cap) return
    const material = band.material as MeshStandardMaterial
    const hex = currentPaintColor().hex
    if (material.userData.hex !== hex) {
      material.userData.hex = hex
      const label = paintLabelTexture(hex)
      if (label) material.map = label // texture swap only — same shader
      else material.color.set(hex)
      ;(cap.material as MeshStandardMaterial).color.set(hex)
    }
  })
  // Module state survives weapon switches — mount with the CURRENT coat.
  const initial = currentPaintColor()
  const initialLabel = paintLabelTexture(initial.hex)
  return (
    <group>
      {/* Can body — squat cylinder resting in the fist. */}
      <mesh position={[0, 0.02, 0]}>
        <cylinderGeometry args={[0.042, 0.042, 0.15, 12]} />
        <meshStandardMaterial color={CAN_BODY} metalness={0.35} roughness={0.45} />
      </mesh>
      {/* Label band — the live paint color wearing "PRESS R" (frame loop
       * above swaps the cached texture per cycle). π turn: the print sits
       * at u=0.5, the face toward the camera. */}
      <mesh position={[0, 0.018, 0]} ref={bandRef} rotation={[0, Math.PI, 0]}>
        <cylinderGeometry args={[0.0445, 0.0445, 0.1, 16]} />
        {initialLabel ? (
          <meshStandardMaterial map={initialLabel} roughness={0.6} />
        ) : (
          <meshStandardMaterial color={initial.hex} roughness={0.6} />
        )}
      </mesh>
      {/* Valve collar — the color-cap dot you read at a glance (sits on
       * the neck's 0.02 top rim, wrapping the nozzle button's base). */}
      <mesh position={[0, 0.113, 0]} ref={capRef}>
        <cylinderGeometry args={[0.021, 0.024, 0.014, 12]} />
        <meshStandardMaterial color={initial.hex} roughness={0.55} />
      </mesh>
      {/* Crimped base rim. */}
      <mesh position={[0, -0.052, 0]}>
        <cylinderGeometry args={[0.038, 0.042, 0.012, 12]} />
        <meshStandardMaterial color={CAN_DARK} metalness={0.4} roughness={0.5} />
      </mesh>
      {/* Neck taper up to the valve. */}
      <mesh position={[0, 0.1, 0]}>
        <cylinderGeometry args={[0.02, 0.038, 0.02, 12]} />
        <meshStandardMaterial color={CAN_DARK} metalness={0.4} roughness={0.5} />
      </mesh>
      {/* Nozzle button — dark cap with the spout aimed down -Z. */}
      <mesh position={[0, 0.118, 0]}>
        <cylinderGeometry args={[0.013, 0.013, 0.022, 10]} />
        <meshStandardMaterial color={NOZZLE} roughness={0.7} />
      </mesh>
      <mesh position={[0, 0.122, -0.016]}>
        <boxGeometry args={[0.008, 0.008, 0.018]} />
        <meshStandardMaterial color={NOZZLE} roughness={0.7} />
      </mesh>
    </group>
  )
}

// ── The tool runtime ──────────────────────────────────────────────────────

/**
 * Mounted by ActiveGame (game-root). Owns the held-trigger loop (viewmodel
 * stays the single input-QUEUE consumer; `firing` is non-consuming state),
 * the aerosol hiss handle, the HUD color line and the per-frame tint drain.
 */
export function PaintTool({ world }: { world: GameWorld }) {
  const scene = useThree((s) => s.scene)
  const cooldown = useRef(0)
  const spray = useRef<SprayHandle | null>(null)
  const spraying = useRef(false)
  /** Last HUD write ('' = hidden) — change gate, per-frame calls are free. */
  const hudKey = useRef('')

  useEffect(() => {
    resetPaint()
    resetPaintDecals()
    ;(globalThis as Record<string, unknown>).__bootsPaint = paintDebug
    // Decal → ledger conversion the frame a node's replica goes live
    // (feature-detected until destruction.ts ships the hook).
    const register = targetLiveRegistrar()
    register?.(convertDecalsForNode)
    return () => {
      register?.(null)
      paintDebug.holdFire = false
      spray.current?.stop()
      spray.current = null
      spraying.current = false
      // Never hold host meshes (or their clipped decals) across sessions.
      meshCache.clear()
      resetPaintDecals()
    }
  }, [])

  useFrame((_, rawDt) => {
    const session = getSession()
    if (!session) return
    const dt = Math.min(rawDt, 1 / 30)
    const state = useBoots.getState()
    const active = (state.weapon as string) === 'paint'

    // Held trigger: soft hiss while spraying, splats at PAINT_RATE. An
    // armed item ghost owns the click (itemGhostActive — the viewmodel's
    // fire gate excludes 'paint', so this loop gates itself).
    const wants =
      active &&
      (session.input.state.firing || paintDebug.holdFire) &&
      !state.staggered &&
      !itemGhostActive()

    // HUD color line: paintSwatch once hud.ts ships it (manager wiring),
    // the owner-keyed shared prompt line until then. Spraying a surface
    // inside WRITING_DISTANCE flips the line to the writing-mode hint.
    const color = currentPaintColor()
    const distance = lastSprayHitDistance()
    const writing = wants && distance !== null && distance < WRITING_DISTANCE
    const key = active ? (writing ? `w${color.hex}` : color.hex) : ''
    if (key !== hudKey.current) {
      hudKey.current = key
      const hud = session.hud as typeof session.hud & {
        paintSwatch?: (hex: string | null, label?: string) => void
      }
      if (hud.paintSwatch) hud.paintSwatch(active ? color.hex : null, color.name)
      if (typeof hud.prompt === 'function') {
        if (!active) hud.prompt(null, 'paint')
        else if (writing || !hud.paintSwatch) hud.prompt(paintPrompt(writing, color.name), 'paint')
        else hud.prompt(null, 'paint') // swatch shows the coat; free the line
      }
    }

    if (wants !== spraying.current) {
      spraying.current = wants
      if (wants) {
        if (!spray.current) spray.current = sfx.spray()
        spray.current.start()
      } else {
        spray.current?.stop()
      }
    }
    cooldown.current -= dt
    if (wants && cooldown.current <= 0) {
      // Same frame-grid remainder carry the gun trigger loop uses.
      cooldown.current = Math.max(cooldown.current, -1 / PAINT_RATE) + 1 / PAINT_RATE
      sprayPaint(world)
    }

    drainPaintTints(scene)
  })
  // The drip + decal pools ride the tool's lifetime — reused slots persist,
  // exit resets the rings with the ledger.
  return (
    <>
      <DripsLayer />
      <PaintDecals />
    </>
  )
}
