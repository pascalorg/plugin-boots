'use client'

import { useFrame, useThree } from '@react-three/fiber'
import { memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import {
  BoxGeometry,
  BufferAttribute,
  CanvasTexture,
  Color,
  type Group,
  type InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  type Object3D,
  PlaneGeometry,
  Quaternion,
  RepeatWrapping,
  Sphere,
  Vector3,
} from 'three'
import {
  passageGeneration,
  passageHidesCell,
  passageHidesSegment,
  passagesTouchSphere,
} from './collision'
import { useDestruction, type VoxelTarget } from './destruction'
import { perfSection } from './perf-monitor'
import {
  CEILING_FACE_TINT,
  FLOOR_CORE_HEX,
  primedCellColor,
  setSkinToneRenderer,
  shellCoreCellColor,
  type SkinToneRenderer,
} from './skin-tone'

/**
 * Renders every voxelized target as the phase-3 WALL SANDWICH, one
 * InstancedMesh (= one draw call) per layer per target:
 *
 *   1. SKINS — the two drywall voxel shells, cube voxels with per-instance
 *      shade jitter and a 1.5% cell inset so faces never merge visually.
 *      This is the DEFAULT look of every wall from session start (targets
 *      are pre-voxelized on enter), so it has to read clean and cozy at a
 *      glance. Voxel removal writes a zero-scale matrix at the voxel's
 *      index on revision bumps — indices stay stable, uploads stay small.
 *      SLAB sandwiches (kind 'slab' — horizontal, thickness axis Y) wear
 *      two tones: top skin keeps the host floor tone, bottom skin (the
 *      ceiling face) lightens toward drywall white.
 *   2. BOARDS — flat drywall plates behind the voxels (#e8e4dc, faint
 *      per-plate shade jitter, ~1% per-plate inset for the hairline seam
 *      read). Torn plates hide via zero-scale.
 *   3. SEGMENTS — the framing lumber as charcoal-stick segments (real
 *      skinny cross-section from the member's own size, #b08d57 with
 *      jitter, ~1% inset so the break points articulate). Broken segments
 *      hide via zero-scale; chipped ones tint darker and pinch their
 *      cross-section (the dent).
 *
 * Boards/segments sync from a per-frame allocation-free checksum over the
 * member arrays (hp + broken/torn), NOT the removedQueue — chip damage
 * never bumps the target revision, and a wholesale matrix re-upload of a
 * ≤ ~100-instance layer is cheaper than bookkeeping. The skin layer keeps
 * the classic queue-drain on revision bumps.
 *
 * Until destruction-core lands `boards`/`segments` on VoxelTarget this
 * file reads them as OPTIONAL fields (structural `SandwichMember` shape,
 * a superset of StudMember) and falls back to rendering `studs` as the
 * segments layer — which also replaces the old ≤40-meshes-per-wall stud
 * rendering with a single instanced draw.
 *
 * CONTRACT for destruction-core: layer arrays must be fixed-length after
 * voxelize (breaking marks members `broken`/`torn`; never push/splice),
 * members carry { id, center, size, yaw, hp?, broken?/torn? }, and any
 * member state change bumps `revision` OR just mutates hp/flags (both are
 * picked up — the checksum runs every frame).
 */

// ── Dormant pre-mount + budgeted prime (perf 2026-08-27 night 3) ────────────
// The 391 ms mass-wake fix. Dormant prebuilds used to be FILTERED out of the
// render list, so the first mid-house grenade woke ~15 targets in one frame
// and each wake mounted a fresh InstancedMesh + ran a full primeSkin inside
// the blast frame. Now every target — dormant included — mounts its replica
// at PREVOXELIZE time (already spread across session-start frames by the
// Prevoxelize budget) but keeps it `visible = false` while the HOST still
// renders; priming is spread further through this small queue at
// DORMANT_PRIME_PER_FRAME per frame. A wake is then just a visibility flip
// (plus an immediate prime for the rare target the queue hadn't reached).
// No InstancedMesh creation, no primeSkin, no pipeline compile in the blast
// frame — the material/geometry combo is identical to the awake walls
// rendering from session start, so the GPU pipeline is warm too.

/** One pending dormant prime. `primed` doubles as the unmount tombstone.
 * `prime` may return `true` to signal it armed a WARM DRAW (a GPU upload of
 * the replica's instance buffers lands next frame) — the drain stops there
 * so at most ONE replica uploads per frame instead of the whole budget's
 * worth stacking on the same entry frame. */
export type DormantPrimeEntry = { primed: boolean; prime: () => boolean | void }

/** Dormant replica primes executed per frame (VoxelWalls' drain). */
export const DORMANT_PRIME_PER_FRAME = 2

const primeQueue: DormantPrimeEntry[] = []

/** Enqueue a dormant replica's prime for the budgeted drain. */
export function queueDormantPrime(entry: DormantPrimeEntry): void {
  primeQueue.push(entry)
}

/** Prime immediately (wake path) — idempotent, tombstone-safe. */
export function primeDormantNow(entry: DormantPrimeEntry): void {
  if (entry.primed) return
  entry.primed = true
  const t0 = performance.now()
  entry.prime()
  perfSection('prime-wake', performance.now() - t0)
}

/** Run up to `budget` queued primes; returns how many actually primed.
 * Tombstoned/woken entries drop for free (never counted against budget).
 * A prime that ARMS A WARM DRAW (returns true) ends the drain early: its
 * GPU buffer upload lands next frame, and serializing the uploads keeps
 * two replicas' first uploads from stacking on one session-entry frame —
 * the queue only exists during gear-up, so the extra frames are absorbed
 * there. */
export function drainDormantPrimes(budget = DORMANT_PRIME_PER_FRAME): number {
  let primed = 0
  while (primeQueue.length > 0 && primed < budget) {
    const entry = primeQueue.shift()!
    if (entry.primed) continue
    entry.primed = true
    const armedWarmDraw = entry.prime() === true
    primed++
    if (armedWarmDraw) break
  }
  return primed
}

/** Unprimed entries still waiting (tests + QA introspection). */
export function dormantPrimeQueueSize(): number {
  let n = 0
  for (const entry of primeQueue) {
    if (!entry.primed) n++
  }
  return n
}

/**
 * Per-frame dormant sync for one wall replica — the WAKE-IS-A-VISIBILITY-
 * FLIP contract, pure so tests can pin it: while the target is dormant the
 * replica group stays hidden (the host renders); the frame the target's
 * `dormant` flag drops, the group flips visible and the replica primes on
 * the spot if the budgeted queue hadn't reached it yet. Returns awake.
 */
export function syncDormantWallFrame(
  group: { visible: boolean },
  wall: { dormant?: boolean },
  entry: DormantPrimeEntry,
): boolean {
  const awake = wall.dormant !== true
  if (group.visible !== awake) group.visible = awake
  if (awake) primeDormantNow(entry)
  return awake
}

// ── Static-scene discipline (idle perf 2026-08-29) ─────────────────────────
// A standing-still frame used to spend ~13% in writeBuffer and ~15% in
// updateMatrixWorld with NOTHING changing. Three root causes, all fixed at
// the replica level:
//
//   1. IDLE GPU RE-UPLOADS. The WebGPU renderer re-uploads an InstancedMesh's
//      instanceMatrix EVERY FRAME on both of its default paths: small meshes
//      (count ≤ ~1024 — uniformBufferLimit/64) ride a uniform buffer whose
//      binding has no dirty check (NodeUniformBuffer inherits
//      Buffer.update() { return true }), and bigger meshes rode our old
//      DynamicDrawUsage flag, which Attributes.update re-uploads
//      unconditionally. Walls cap at MAX_VOXELS=1600 cells, so EVERY wall
//      sat on one of the two always-upload paths — megabytes per idle
//      frame. Fix: flag instanceMatrix as a STORAGE attribute
//      (markStorageInstanced) — the storage path is version-gated
//      (Attributes.update compares attribute.version), so uploads happen on
//      needsUpdate = actual mutation, exactly the shell-render discipline.
//      instanceColor already rides the version-gated attribute path.
//   2. MATRIX CHURN. Three recomposes matrix + matrixWorld for every
//      auto-updating object every frame (the scene root marks itself dirty
//      each updateMatrix(), force-cascading multiplyMatrices down the whole
//      graph). Replicas never move after mount, so freezeStaticSubtree
//      turns off BOTH auto flags for the replica subtree after settling
//      world matrices once. The warm draw is the single post-mount move and
//      refreshes world matrices by hand (shiftFrozenSubtreeY).
//   3. NO CULLING. frustumCulled was globally off (the shared unit-box
//      geometry's bounding sphere is one cell, not the wall). The spread is
//      known per target, so each replica now carries a correct
//      mesh.boundingSphere (gridBoundingSphere / membersBoundingSphere) and
//      culls — off-screen walls skip _renderObjectDirect AND their
//      per-object binding updates. Culling stays OFF until the warm draw
//      finished (a culled warm draw would never upload its buffers).

/** Flag the mesh's instanceMatrix as a WebGPU STORAGE attribute so instance
 * uploads become version-gated (needsUpdate-on-mutation) instead of
 * every-frame. The renderer duck-types the flag (StorageBufferNode sets the
 * very same one on plain attributes), so no webgpu-build import is needed.
 * No-op off WebGPU: the WebGL fallback has no storage-buffer vertex path.
 * Mount-time only — the flag must be set before the mesh first renders. */
export function markStorageInstanced(mesh: InstancedMesh, renderer: unknown): boolean {
  const backend = (renderer as { backend?: { isWebGPUBackend?: boolean } } | null)?.backend
  if (backend?.isWebGPUBackend !== true) return false
  ;(
    mesh.instanceMatrix as unknown as { isStorageInstancedBufferAttribute?: boolean }
  ).isStorageInstancedBufferAttribute = true
  return true
}

/** Conservative world-space bounding sphere over a voxel grid: min/max of
 * the (world-space) cell centers plus a half-cell diagonal margin. Covers
 * dead cells too — kills only shrink the live set, so the sphere never goes
 * stale. O(count), runs once per prime. */
export function gridBoundingSphere(
  grid: { count: number; centers: Float32Array; cellX: number; cellY: number; cellZ: number },
  out = new Sphere(),
): Sphere {
  if (grid.count === 0) {
    out.center.set(0, 0, 0)
    out.radius = -1 // three's empty-sphere convention — always culled
    return out
  }
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  for (let i = 0; i < grid.count; i++) {
    const x = grid.centers[i * 3]!
    const y = grid.centers[i * 3 + 1]!
    const z = grid.centers[i * 3 + 2]!
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }
  out.center.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2)
  out.radius =
    Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2 +
    Math.hypot(grid.cellX, grid.cellY, grid.cellZ) / 2
  return out
}

/** Bounding sphere over a member layer: min/max of the member centers plus
 * half the largest member diagonal (yaw/pitch-proof — a rotated box never
 * leaves its center's half-diagonal ball). Members are fixed-length after
 * voxelize and never move, so this is mount-time only. */
export function membersBoundingSphere(
  members: Array<{ center: [number, number, number]; size: [number, number, number] }>,
  out = new Sphere(),
): Sphere {
  if (members.length === 0) {
    out.center.set(0, 0, 0)
    out.radius = -1
    return out
  }
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  let margin = 0
  for (const m of members) {
    const [x, y, z] = m.center
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
    const half = Math.hypot(m.size[0], m.size[1], m.size[2]) / 2
    if (half > margin) margin = half
  }
  out.center.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2)
  out.radius = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2 + margin
  return out
}

/** Settle world matrices once (live ancestors included), then freeze the
 * whole subtree out of three's per-frame matrix churn: no recompose, no
 * multiplyMatrices, immune to the scene root's force cascade. Mount-time,
 * after every child is attached. */
export function freezeStaticSubtree(root: Object3D): void {
  root.updateWorldMatrix(true, true)
  root.traverse((obj) => {
    obj.matrixAutoUpdate = false
    obj.matrixWorldAutoUpdate = false
  })
}

/** Move a FROZEN subtree vertically and refresh its world matrices by hand
 * (auto-update is off, so nobody else will) — the warm draw's drop/restore
 * is the only post-mount move a replica ever makes. */
export function shiftFrozenSubtreeY(root: Object3D, deltaY: number): void {
  root.position.y += deltaY
  root.updateMatrix()
  root.matrixWorldNeedsUpdate = false // updateMatrix marks it; we do the work here
  if (root.parent === null) root.matrixWorld.copy(root.matrix)
  else root.matrixWorld.multiplyMatrices(root.parent.matrixWorld, root.matrix)
  refreshFrozenChildren(root)
}

function refreshFrozenChildren(parent: Object3D): void {
  for (const child of parent.children) {
    child.matrixWorld.multiplyMatrices(parent.matrixWorld, child.matrix)
    refreshFrozenChildren(child)
  }
}

const _matrix = new Matrix4()
const _pos = new Vector3()
const _scale = new Vector3()
/** A member's centre-line half-vector (memberStandsInPassage). */
const _axis = new Vector3()
const _quat = new Quaternion()
const _color = new Color()
const ZERO = new Matrix4().makeScale(0, 0, 0)
const UP = new Vector3(0, 1, 0)
const Z_AXIS = new Vector3(0, 0, 1)
const _qz = new Quaternion()

/** Structural superset of destruction.ts's StudMember — boards may use
 * `torn`, wood uses `broken`; hp is optional for binary members. Pitched
 * roof members carry `pitch` and render Ry(−yaw)·Rz(pitch)
 * (roof-framing.ts conventions); absent/0 keeps the yaw-only path. */
type SandwichMember = {
  id: number
  center: [number, number, number]
  size: [number, number, number]
  yaw: number
  pitch?: number
  hp?: number
  broken?: boolean
  torn?: boolean
}

/** VoxelTarget with the (soon-canonical) phase-3 layer fields. */
type SandwichTarget = VoxelTarget & {
  boards?: SandwichMember[]
  segments?: SandwichMember[]
}

const BOARD_BASE = new Color('#e8e4dc')
const BOARD_DAMAGED = new Color('#d8d1c2')
const WOOD_BASE = new Color('#b08d57')
const WOOD_DAMAGED = new Color('#8f6f45')

// ── Dirt underlay (owner wave 5: "dirt when broken, not white/grass") ───────
// A hole carved THROUGH a ground-floor slab used to reveal the host's ground
// pad (near-white) or lawn — inside a house the reveal must read as EARTH.
// Terrain-borne floor slabs (floorCore + base near grade) mount one flat
// dirt-toned plane just under the sandwich: fully occluded while the floor
// is intact, and whatever hole opens shows soil. Game-layer visual only
// (unmounts with the session, never a scene write); plain BufferGeometry +
// standard material (WebGPU-safe), one extra draw call per ground slab.

/** A floor slab whose grid base sits at/below this height is terrain-borne
 * — upper-storey floors never get an underlay (their holes must show the
 * room below). Generous vs destruction's SLAB_GROUND_Y so raised ground
 * slabs still read dirt. */
export const UNDERLAY_MAX_BASE_Y = 0.35

/** How far below the slab's grid base the underlay plane sits — under the
 * bottom skin, above the host pad (which hugs the slab within ~0.15 m). */
export const UNDERLAY_DROP = 0.004

/** Pure: the dirt underlay's placement for a floor slab grid, or null when
 * the target must not carry one (not a floor sandwich / not terrain-borne).
 * Slab grids are world-aligned AABB grids (no yaw/basis), so the layout is
 * a centered XZ rectangle over the grid's full footprint. */
export function floorUnderlayLayout(wall: {
  floorCore?: boolean
  kind: VoxelTarget['kind']
  grid: {
    origin: { x: number; y: number; z: number }
    nx: number
    nz: number
    cellX: number
    cellZ: number
  }
}): { x: number; y: number; z: number; width: number; depth: number } | null {
  if (wall.floorCore !== true || wall.kind !== 'slab') return null
  const { origin, nx, nz, cellX, cellZ } = wall.grid
  if (origin.y > UNDERLAY_MAX_BASE_Y) return null
  const width = nx * cellX
  const depth = nz * cellZ
  if (width <= 0 || depth <= 0) return null
  return {
    x: origin.x + width / 2,
    y: origin.y - UNDERLAY_DROP,
    z: origin.z + depth / 2,
    width,
    depth,
  }
}

// Shared render resources — every layer of every replica is configuration-
// identical per layer type (all per-instance variation rides instanceMatrix
// + instanceColor; paint gates ride mesh.userData), so one geometry and one
// material per layer serve the whole house instead of 3N fresh objects.
// Passed via `args`, so R3F never auto-disposes them on unmount; they live
// for the module (the dust-texture idiom).
const VOXEL_GEOMETRY = new BoxGeometry()
const SKIN_MATERIAL = new MeshStandardMaterial({ roughness: 0.92 })
/** Ceiling-plate skin: the SAME unit box, with the attic-side mute baked
 * into VERTEX colors (three multiplies vertexColor × instanceColor). Live
 * host ceilings voxelize as ONE cell layer, so the cell tone can't carry
 * the split: the bottom face (the room ceiling, seen from below) keeps
 * vertex color 1 — bit-exact interior read — while the TOP and the four
 * rim faces wear CEILING_FACE_TINT, the structural mute that kills the
 * light sawtooth the eave slit used to frame (round-5 QA; skin-tone.ts).
 * Module-lifetime constants like every other layer resource — one extra
 * material variant total, zero per-frame work. */
export const CEILING_GEOMETRY = (() => {
  const geometry = new BoxGeometry()
  const normal = geometry.getAttribute('normal')
  const colors = new Float32Array(normal.count * 3)
  for (let v = 0; v < normal.count; v++) {
    const down = normal.getY(v) < -0.5
    colors[v * 3] = down ? 1 : CEILING_FACE_TINT[0]
    colors[v * 3 + 1] = down ? 1 : CEILING_FACE_TINT[1]
    colors[v * 3 + 2] = down ? 1 : CEILING_FACE_TINT[2]
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3))
  return geometry
})()
const CEILING_SKIN_MATERIAL = new MeshStandardMaterial({ roughness: 0.92, vertexColors: true })
const BOARD_MATERIAL = new MeshStandardMaterial({ roughness: 0.95 })
const WOOD_MATERIAL = new MeshStandardMaterial({ roughness: 0.85 })
/** Deterministic RNG for the dirt canvas (nature.tsx's generator). */
function mulberry32(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Procedural dirt for the underlay: the FLOOR_CORE brown speckled with
 * darker clods, lighter dry patches, and a few desaturated pebble flecks —
 * the nature.tsx groundTexture idiom (2D canvas → CanvasTexture,
 * RepeatWrapping). ONE module-level canvas + texture for every slab (the
 * shared-resource contract above); null headless (bun tests import this
 * module with no DOM), where the material's flat FLOOR_CORE color stands
 * in. The underlay plane's UVs span the whole slab and slab sizes vary per
 * node, so a SHARED texture can't hit an exact world repeat — the fixed
 * UNDERLAY_REPEAT lands ~1 repeat / 1.2 m on a typical ~10 m ground slab
 * (grain size, not alignment, is what reads through a hole). */
const UNDERLAY_REPEAT = 8
function dirtTexture(): CanvasTexture | null {
  if (typeof document === 'undefined') return null
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const g = canvas.getContext('2d')!
  g.fillStyle = FLOOR_CORE_HEX // #6b4a2f — rgb(107, 74, 47)
  g.fillRect(0, 0, size, size)
  const rand = mulberry32(13)
  g.globalAlpha = 0.32
  for (let i = 0; i < 2200; i++) {
    // Clods run darker, dry dirt lighter — the same ±spread the voxel
    // cells wear (skin-tone.ts FLOOR_CLOD_SPREAD), so hole walls and hole
    // floor keep reading as one material.
    const shade = 0.72 + rand() * 0.6
    g.fillStyle = `rgb(${Math.round(107 * shade)}, ${Math.round(74 * shade)}, ${Math.round(47 * shade)})`
    const r = 1 + rand() * 3.5
    g.beginPath()
    g.arc(rand() * size, rand() * size, r, 0, Math.PI * 2)
    g.fill()
  }
  // Sparse gray pebbles — rubble bits, not a pattern.
  g.globalAlpha = 0.4
  for (let i = 0; i < 90; i++) {
    const v = Math.round(96 + rand() * 60)
    g.fillStyle = `rgb(${v}, ${v - 6}, ${v - 12})`
    const r = 0.8 + rand() * 1.6
    g.beginPath()
    g.arc(rand() * size, rand() * size, r, 0, Math.PI * 2)
    g.fill()
  }
  g.globalAlpha = 1
  const texture = new CanvasTexture(canvas)
  texture.wrapS = RepeatWrapping
  texture.wrapT = RepeatWrapping
  texture.repeat.set(UNDERLAY_REPEAT, UNDERLAY_REPEAT)
  return texture
}

/** Dirt underlay resources — one unit plane scaled per slab, one matte
 * earth material in the FLOOR_CORE family (the under-layer voxels above it
 * jitter around the same tone, so hole walls and hole floor read as one
 * material). Textured (dirtTexture) so a breached floor shows GROUND, not
 * a flat untextured brown; the map multiplies against white — the tones
 * live in the canvas — while headless keeps the legacy flat color. */
const UNDERLAY_GEOMETRY = new PlaneGeometry(1, 1)
const UNDERLAY_TEXTURE = dirtTexture()
const UNDERLAY_MATERIAL = new MeshStandardMaterial({
  color: UNDERLAY_TEXTURE ? '#ffffff' : new Color(FLOOR_CORE_HEX).offsetHSL(0, 0, -0.012),
  map: UNDERLAY_TEXTURE,
  roughness: 1,
})

function isGone(m: SandwichMember): boolean {
  return m.broken === true || m.torn === true
}

/**
 * Load `_quat` with member `m`'s local→world rotation and hand it back. Factored
 * out for the same reason `beginCellTransform` was: TWO readers now need it — the
 * matrix writer and the open-doorway test — and the axis we test a stick along
 * has to be the axis we draw it along, or a door would hide the wrong sticks.
 *
 * Pitched roof members are Ry(−yaw)·Rz(pitch) (roof-framing.ts conventions);
 * absent/0 pitch keeps the yaw-only path, yaw 0 keeps identity.
 */
function beginMemberRotation(m: SandwichMember): Quaternion {
  if (m.pitch) {
    _quat.setFromAxisAngle(UP, -m.yaw).multiply(_qz.setFromAxisAngle(Z_AXIS, m.pitch))
  } else if (m.yaw === 0) _quat.identity()
  else _quat.setFromAxisAngle(UP, -m.yaw)
  return _quat
}

/**
 * Does this member stand in an OPEN DOORWAY? (collision.ts::passageHidesSegment.)
 *
 * The second half of the owner's "i see voxels when it's open through it": hiding
 * the skin cubes in the aperture (98a8fe3) is what EXPOSED these. Framing lives
 * in the cavity between the two drywall skins, invisible while the skins are
 * intact — so the moment the crossing wall's cells stopped drawing in the
 * doorway, the sticks that were behind them became the thing standing in the
 * open door. The browser census measured 8-16 of them per doorway on the flat QA
 * house and 20 across 11 doors on the sculpted lot.
 *
 * A member is its CENTRE LINE here, not its centre point — see the predicate's
 * header for why the cell lane's point test does not transfer to a 1.2 m stick,
 * and for what the unpadded prism buys (the door's own jambs and header sit
 * 0.02 m clear of the aperture, so they are the first thing a pad would eat).
 */
export function memberStandsInPassage(m: SandwichMember): boolean {
  const rot = beginMemberRotation(m)
  const [sx, sy, sz] = m.size
  // The longest LOCAL axis is the stick's length; the other two are its
  // cross-section, deliberately ignored (the predicate's under-relief bound).
  _axis.set(0, 0, 0)
  if (sx >= sy && sx >= sz) _axis.x = sx / 2
  else if (sy >= sz) _axis.y = sy / 2
  else _axis.z = sz / 2
  _axis.applyQuaternion(rot)
  const cx = m.center[0]
  const cy = m.center[1]
  const cz = m.center[2]
  return passageHidesSegment(
    cx - _axis.x,
    cy - _axis.y,
    cz - _axis.z,
    cx + _axis.x,
    cy + _axis.y,
    cz + _axis.z,
  )
}

/** Could any open doorway reach this member layer at all? The cheap bail-out —
 * a door opening across the lot must not walk every wall's framing. The layer's
 * bounding sphere is mount-time and members never move, so this is one
 * sphere-vs-prism test per layer per door toggle. */
function passagesReachLayer(mesh: InstancedMesh): boolean {
  const sphere = mesh.boundingSphere
  if (sphere === null || sphere.radius < 0) return false
  return passagesTouchSphere(sphere.center.x, sphere.center.y, sphere.center.z, sphere.radius)
}

/** One member layer's look. Module constants (below), so the component's call
 * site and the tests' can never drift apart on inset, jitter or pinch. */
type MemberStyle = {
  base: Color
  damaged: Color
  jitter: number
  inset: number
  pinch: boolean
  material: MeshStandardMaterial
}

/** Cheap dirty signal over a member layer — plain arithmetic, no allocs.
 * Changes whenever any member's hp moves or its broken/torn flag flips. */
function layerChecksum(members: SandwichMember[]): number {
  let h = members.length
  for (let i = 0; i < members.length; i++) {
    const m = members[i]!
    h += isGone(m) ? 1013 * (i + 1) : (m.hp ?? 1) * 3 + i
  }
  return h
}

/**
 * Write every member's matrix + color. Gone members get the zero matrix, and so
 * do members standing in an OPEN DOORWAY — the same "hidden, never killed"
 * mechanism the skin lane uses, on the same registry.
 *
 * Returns whether a doorway is hiding anything here as of this write. The caller
 * keeps that as a LATCH: once the door closes its prism is gone, so
 * `passagesReachLayer` goes false and the sweep that has to put the sticks BACK
 * would never run without it.
 *
 * The passage gate is computed HERE rather than passed in on purpose. Three call
 * sites re-upload this layer — mount, a chip changing the checksum, and a door
 * toggle — and if any one of them wrote matrices without consulting the registry,
 * a single chip anywhere in the wall would put the doorway's sticks back on
 * screen. Deriving it inside the one writer makes that class of bug unreachable.
 */
function uploadMemberLayer(
  mesh: InstancedMesh,
  members: SandwichMember[],
  style: MemberStyle,
  maxHp: number,
): boolean {
  const { base, damaged, jitter, inset, pinch } = style
  const hidePassages = passagesReachLayer(mesh)
  let holes = false
  for (let i = 0; i < members.length; i++) {
    const m = members[i]!
    if (isGone(m)) {
      mesh.setMatrixAt(i, ZERO)
      continue
    }
    if (hidePassages && memberStandsInPassage(m)) {
      mesh.setMatrixAt(i, ZERO)
      holes = true
      continue
    }
    const [sx, sy, sz] = m.size
    _scale.set(sx * inset, sy * inset, sz * inset)
    const hp = m.hp ?? maxHp
    const isDamaged = hp < maxHp
    if (pinch && isDamaged) {
      // The dent: pinch the cross-section, keep the long axis full length
      // (plates lie sideways, so pick axes by size instead of assuming Y).
      const p = 0.6 + (0.4 * Math.max(0, hp)) / maxHp
      if (sx >= sy && sx >= sz) {
        _scale.y *= p
        _scale.z *= p
      } else if (sy >= sx && sy >= sz) {
        _scale.x *= p
        _scale.z *= p
      } else {
        _scale.x *= p
        _scale.y *= p
      }
    }
    // Same composition `memberStandsInPassage` tested the stick's axis with.
    beginMemberRotation(m)
    _pos.set(m.center[0], m.center[1], m.center[2])
    _matrix.compose(_pos, _quat, _scale)
    mesh.setMatrixAt(i, _matrix)
    if (isDamaged) {
      _color.copy(damaged)
    } else {
      const j = ((i * 2654435761) % 97) / 97
      _color.copy(base).offsetHSL(0, 0, (j - 0.5) * jitter)
    }
    mesh.setColorAt(i, _color)
  }
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  return holes
}

/** Drywall PLATES: flat sheets behind the voxels, faint per-plate jitter, ~1%
 * inset for the hairline seam read. destruction.ts does not populate `boards`
 * today — the layer mounts only if it ever does. */
const BOARD_STYLE: MemberStyle = {
  base: BOARD_BASE,
  damaged: BOARD_DAMAGED,
  jitter: 0.05,
  inset: 0.99,
  pinch: false,
  material: BOARD_MATERIAL,
}

/** FRAMING lumber: charcoal sticks at true section, ~1% inset so break points
 * articulate, cross-section pinched when chipped (the dent). */
const SEGMENT_STYLE: MemberStyle = {
  base: WOOD_BASE,
  damaged: WOOD_DAMAGED,
  jitter: 0.1,
  inset: 0.99,
  pinch: true,
  material: WOOD_MATERIAL,
}

/**
 * Write a FRAMING layer's matrices, open doorways included — the member lane's
 * counterpart to the skin lane's `syncPassageHoles`, and the same reason it
 * exists: the regression suite has to drive the REAL writer. A test that
 * re-implemented the sweep would pin its own copy, and the copy is exactly the
 * thing that drifts. Returns the caller's restore latch (see `uploadMemberLayer`).
 */
export function syncMemberLayer(
  mesh: InstancedMesh,
  members: SandwichMember[],
  maxHp = 1,
): boolean {
  return uploadMemberLayer(mesh, members, SEGMENT_STYLE, maxHp)
}

/** One sandwich layer (boards or segments) as a single InstancedMesh. `layer`
 * is the QA census tag — the browser probe counts drawn instances per doorway
 * and has to be able to name which layer each one belongs to. */
function MemberLayer({
  members,
  style,
  layer,
}: {
  members: SandwichMember[]
  style: MemberStyle
  layer: string
}) {
  const meshRef = useRef<InstancedMesh>(null!)
  const checksum = useRef(Number.NaN)
  const maxHp = useRef(1)
  /** Last passage generation these matrices reflect. -1 so the first frame always
   * reconciles (a door may already have been standing open at mount). */
  const passageGen = useRef(-1)
  /** Whether an open doorway is hiding members here — the latch that makes a door
   * CLOSING put the sticks back, since by then no prism reaches this layer and
   * the cheap sphere test would skip the restore. */
  const passageHoles = useRef(false)
  const gl = useThree((s) => s.gl)

  useLayoutEffect(() => {
    const mesh = meshRef.current
    // Version-gated uploads (no DynamicDrawUsage, no uniform-buffer path):
    // member layers only re-upload when the checksum below actually moves.
    markStorageInstanced(mesh, gl)
    // Members never move — one correct sphere at mount and the layer culls.
    // (A dormant replica's warm draw renders underground, where this layer
    // culls away and skips its first upload — at ≤ ~100 instances that's a
    // few KB on the wake frame, not worth plumbing the warm-draw latch in.)
    // The sphere is also the passage early-out's input, so it must be set
    // BEFORE the first upload consults the registry.
    mesh.boundingSphere = membersBoundingSphere(members, mesh.boundingSphere ?? undefined)
    mesh.frustumCulled = true
    // Full hp = the healthiest member at voxelize time (fresh members are
    // all at max; robust even if we mount mid-fight).
    let max = 1
    for (const m of members) if ((m.hp ?? 1) > max) max = m.hp ?? 1
    maxHp.current = max
    passageHoles.current = uploadMemberLayer(mesh, members, style, max)
    passageGen.current = passageGeneration()
    checksum.current = layerChecksum(members)
  }, [members, style, gl])

  useFrame(() => {
    const mesh = meshRef.current
    if (!mesh) return
    // Dormant replica (parent group hidden — the wake IS the visibility
    // flip, done by the parent's earlier-registered useFrame in this same
    // frame): members BY CONTRACT can't change while dormant (damage paths
    // always wake first), so skip the O(members) checksum entirely.
    if (mesh.parent && mesh.parent.visible === false) return
    // Two things dirty this layer, and ONE full re-upload answers both — the
    // layer is ≤ a few hundred instances, so folding them together is cheaper
    // than tracking which members each one touched, and it guarantees a chip
    // can never re-draw a stick a doorway is hiding.
    //   - a CHIP: hp loss without a break never bumps revision, so poll the
    //     cheap allocation-free checksum every frame.
    //   - a DOOR TOGGLE: the registry stamps a generation on every change, so
    //     the steady state is one integer compare, and the sweep only touches
    //     layers a prism actually reaches (or ones still holding sticks hidden,
    //     which have to restore them).
    const h = layerChecksum(members)
    const gen = passageGeneration()
    let passageDirty = false
    if (passageGen.current !== gen) {
      passageGen.current = gen
      passageDirty = passageHoles.current || passagesReachLayer(mesh)
    }
    if (h === checksum.current && !passageDirty) return
    checksum.current = h
    const t0 = performance.now()
    passageHoles.current = uploadMemberLayer(mesh, members, style, maxHp.current)
    if (passageDirty) perfSection('passage-members', performance.now() - t0)
  })

  return (
    <instancedMesh
      args={[VOXEL_GEOMETRY, style.material, members.length]}
      ref={meshRef}
      userData={{ __boots: true, __bootsLayer: layer }}
    />
  )
}

/** CORE MODE inset: the fraction of the thickness-axis cell size shaved
 * off EACH side of a shelled target's skin voxels (×2 for both directions),
 * so the core column sits strictly INSIDE the conforming shell surface —
 * no coplanar fighting between core faces and shell triangles. */
export const CORE_INSET_FRAC = 0.2

/** The grid axis with the smallest PHYSICAL extent (span·cell) — the
 * thickness axis of a layered wall/slab grid, resolved exactly the way
 * dropInteriorCells (voxel.ts) picks its skin axis: raw spans can't be
 * trusted on anisotropic grids (the thin axis gets as many cells as the
 * others), so compare metres. Pure; exported for tests. */
export function coreThicknessAxis(grid: {
  nx: number
  ny: number
  nz: number
  cellX: number
  cellY: number
  cellZ: number
}): 0 | 1 | 2 {
  let axis: 0 | 1 | 2 = 0
  let extent = grid.nx * grid.cellX
  if (grid.ny * grid.cellY < extent) {
    axis = 1
    extent = grid.ny * grid.cellY
  }
  if (grid.nz * grid.cellZ < extent) axis = 2
  return axis
}

/**
 * Load `_scale` and `_quat` with this target's per-cell transform and report
 * whether it draws in CORE mode. Factored out because TWO writers now compose
 * instance matrices from it — `primeSkin` and `syncPassageHoles` — and a cell
 * has to land in exactly the same place whichever one wrote it, or opening a
 * door would visibly nudge every cube in the wall.
 */
function beginCellTransform(wall: VoxelTarget): boolean {
  const { grid } = wall
  // Per-axis scale with a 1.5% inset: anisotropic wall grids have thin
  // skin cells along the thickness axis (a uniform grid.cell cube would
  // visually fill the cavity), and the inset keeps each cube's face from
  // merging with its neighbors — the clean "block" read walls now wear
  // from session start.
  _scale.set(grid.cellX * 0.985, grid.cellY * 0.985, grid.cellZ * 0.985)
  // CORE MODE (conforming-shell targets): the skin voxels are the wall's
  // structural CORE now — the shell mesh carries the facade. Inset the
  // thickness axis by CORE_INSET_FRAC of its cell on BOTH sides (a pure
  // symmetric scale-down, so positions stay put) and prime with the
  // darkened structural tone instead of the facade pattern colors.
  // Zero effect without target.shell.
  const core = wall.shell !== undefined
  if (core) {
    const axis = coreThicknessAxis(grid)
    const inset = 1 - 2 * CORE_INSET_FRAC
    if (axis === 0) _scale.x *= inset
    else if (axis === 1) _scale.y *= inset
    else _scale.z *= inset
  }
  // Rotated grids: cells are axis-aligned in the grid's own frame —
  // rotate each instance out to world. Yaw-local grids (diagonal walls)
  // keep the legacy Y axis-angle; FULL-basis grids (pitched roof planes,
  // Phase C2 — grid.yaw parks at 0 there) use the quaternion conjugate
  // (grid → world), which is what fixes the stair-stepped roof
  // silhouette: the cubes lie IN the slope plane instead of climbing it
  // in axis-aligned steps. World-aligned grids keep identity.
  if (grid.q.x !== 0 || grid.q.z !== 0) {
    _quat.set(-grid.q.x, -grid.q.y, -grid.q.z, grid.q.w)
  } else if (grid.yaw === 0) _quat.identity()
  else _quat.setFromAxisAngle(UP, -grid.yaw)
  return core
}

/**
 * Write cell `i`'s instance matrix — its composed transform, or ZERO (hidden)
 * when the cell is dead, or when it stands inside an OPEN DOORWAY. Returns
 * whether a doorway is what hid it.
 *
 * THE VOXELS IN THE OPEN DOOR (owner report 2026-08-30: "i see voxels when it's
 * open through it"). A voxel grid carves its OWN target's openings and nothing
 * else, so scene geometry authored across a neighbour's doorway — on the QA
 * house the east wall's end stands inside the front opening — renders as a wall
 * of cubes straight through the aperture the moment that wall wakes. Both
 * collision lanes already treat those cells as absent; this is the picture
 * agreeing with the physics, which is the visible half of the reported bug.
 *
 * `beginCellTransform(wall)` must have run for this target first (`_scale` and
 * `_quat` are its output). `hidePassages` is the caller's per-target early-out:
 * false means no open doorway is anywhere near this grid, so skip the test
 * entirely rather than ask about every cell in the level on every door toggle.
 */
function writeCellMatrix(
  mesh: InstancedMesh,
  grid: VoxelTarget['grid'],
  i: number,
  hidePassages: boolean,
): boolean {
  if (!grid.alive[i]) {
    mesh.setMatrixAt(i, ZERO)
    return false
  }
  const x = grid.centers[i * 3]!
  const y = grid.centers[i * 3 + 1]!
  const z = grid.centers[i * 3 + 2]!
  if (hidePassages && passageHidesCell(x, y, z)) {
    mesh.setMatrixAt(i, ZERO)
    return true
  }
  _pos.set(x, y, z)
  _matrix.compose(_pos, _quat, _scale)
  mesh.setMatrixAt(i, _matrix)
  return false
}

/** Sphere cache keyed by the grid's OWN centers buffer: cell centers are frozen
 * at bake time, and a re-bake (MAX_VOXELS overflow) allocates a new buffer with
 * a new count — so a stale entry is impossible, and the O(count) sweep runs once
 * per grid instead of once per door toggle. */
const _gridSpheres = new WeakMap<Float32Array, { sphere: Sphere; count: number }>()

/** Every mounted skin layer, by node id — QA surface only (replicaDrawAudit).
 * Written in the mount effect, deleted on unmount. */
const _liveReplicas = new Map<string, InstancedMesh>()

const _auditM = new Matrix4()

/**
 * DO THE DRAWN CUBES STAND ON THEIR CELLS?
 *
 * Per awake replica, the worst distance in metres between a VISIBLE instance's
 * matrix translation and its cell's centre. Zero to float noise whenever the
 * render lane and the query lanes (collision, rays, structure) agree, because
 * both compose from `grid.centers` — and the direct numeric measure of the
 * ghost class of bug, since a bullet stopping in mid-air short of a visible
 * cube is exactly this number going positive.
 *
 * Reads only, allocates one row per replica, and is the only way to confirm
 * from the browser that a re-posed grid (destruction.ts poseRevision) really
 * did re-prime its matrices — nothing else can see inside an InstancedMesh.
 * Hidden instances are skipped: a carved cell and a cell inside an open doorway
 * both carry a zero matrix BY DESIGN, which is what `hidden` counts.
 */
export function replicaDrawAudit(nodeId?: string): Array<{
  nodeId: string
  /** Cells the grid says are alive. */
  alive: number
  /** Alive cells actually drawing (alive − hidden). */
  drawn: number
  /** Alive cells carrying a zero matrix — carved is impossible here, so this is
   * open-doorway passage relief (voxel-walls passageHidesCell). */
  hidden: number
  /** Dead cells that are still drawing. Any nonzero value is a bug: a carved
   * hole the player shot is still solid-looking. */
  drawnDead: number
  /** Worst |drawn position − cell centre|, metres. */
  worstDrift: number
  poseRevision: number
}> {
  const out: ReturnType<typeof replicaDrawAudit> = []
  for (const [id, mesh] of _liveReplicas) {
    if (nodeId !== undefined && id !== nodeId) continue
    const target = useDestruction.getState().targets.get(id)
    if (!target || target.dormant === true) continue
    const grid = target.grid
    let drawn = 0
    let hidden = 0
    let drawnDead = 0
    let worstDrift = 0
    for (let i = 0; i < grid.count && i < mesh.count; i++) {
      mesh.getMatrixAt(i, _auditM)
      const e = _auditM.elements
      // Read the basis columns rather than decomposing: three's
      // Matrix4.decompose GUARDS a zero determinant by reporting scale
      // (1, 1, 1), so a hidden instance would come back as drawn full size.
      const visible =
        Math.hypot(e[0]!, e[1]!, e[2]!) > 1e-9 &&
        Math.hypot(e[4]!, e[5]!, e[6]!) > 1e-9 &&
        Math.hypot(e[8]!, e[9]!, e[10]!) > 1e-9
      if (!grid.alive[i]) {
        if (visible) drawnDead++
        continue
      }
      if (!visible) {
        hidden++
        continue
      }
      drawn++
      const drift = Math.hypot(
        e[12]! - grid.centers[i * 3]!,
        e[13]! - grid.centers[i * 3 + 1]!,
        e[14]! - grid.centers[i * 3 + 2]!,
      )
      if (drift > worstDrift) worstDrift = drift
    }
    out.push({
      nodeId: id,
      alive: grid.aliveCount,
      drawn,
      hidden,
      drawnDead,
      worstDrift: +worstDrift.toFixed(5),
      poseRevision: target.poseRevision ?? 0,
    })
  }
  return out
}

/** Could any open doorway reach this target at all? One sphere-vs-prism test per
 * target keeps a door on the far side of the lot from walking every wall's
 * cells. Conservative: `gridBoundingSphere` covers dead cells too. */
function passagesReachGrid(wall: VoxelTarget): boolean {
  const { grid } = wall
  let hit = _gridSpheres.get(grid.centers)
  if (hit === undefined || hit.count !== grid.count) {
    hit = { sphere: gridBoundingSphere(grid), count: grid.count }
    _gridSpheres.set(grid.centers, hit)
  }
  const { center, radius } = hit.sphere
  if (radius < 0) return false
  return passagesTouchSphere(center.x, center.y, center.z, radius)
}

/**
 * Re-write every cell's matrix against the CURRENT passage registry — the
 * per-frame half of the open-doorway hole. Colors are untouched, so paint coats
 * and the async skin tone survive a door being opened and closed.
 *
 * Returns whether any cell is hidden by a doorway right now. The caller keeps
 * that: once a door CLOSES its prism is gone, so `passagesReachGrid` goes false
 * and the sweep that has to put the cubes BACK would never run without it.
 */
export function syncPassageHoles(mesh: InstancedMesh, wall: VoxelTarget): boolean {
  const { grid } = wall
  beginCellTransform(wall)
  const hide = passagesReachGrid(wall)
  let holes = false
  for (let i = 0; i < grid.count; i++) {
    if (writeCellMatrix(mesh, grid, i, hide)) holes = true
  }
  mesh.instanceMatrix.needsUpdate = true
  return holes
}

/** Prime (or re-prime) the skin layer's matrices + colors from the grid.
 * Runs on mount and again whenever `skinRevision` bumps (async roof tone).
 * Clears the mesh's paint gates afterwards so drainPaintTints re-applies
 * any painted cells on top — the paint LEDGER's serials never move.
 * Returns whether an open doorway is hiding cells as of this prime. */
export function primeSkin(mesh: InstancedMesh, wall: VoxelTarget): boolean {
  const { grid } = wall
  const core = beginCellTransform(wall)
  // A door can already be standing open when a target primes — a wall woken
  // mid-session, or a dormant replica reached by the budgeted prime queue while
  // the player is in the doorway — so the prime has to come out with the hole
  // already punched, not wait for the next door toggle to bump the generation.
  const hide = passagesReachGrid(wall)
  let holes = false
  for (let i = 0; i < grid.count; i++) {
    if (writeCellMatrix(mesh, grid, i, hide)) holes = true
    // Shared per-cell prime tone (skin-tone.ts) — paint.tsx feathers coats
    // up from exactly this color, so the two must never drift. Shelled
    // targets prime the CORE tone instead (the facade is the shell's);
    // shellCoreCellColor keeps floorCore under-layers on the dirt-subfloor
    // read so a breached shelled floor still reveals earth (S1b).
    mesh.setColorAt(
      i,
      core ? shellCoreCellColor(_color, wall, i) : primedCellColor(_color, wall, i),
    )
  }
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  // Paint gate reset (paint.tsx drainPaintTints): the wholesale color prime
  // just overwrote any painted cells — dropping the mesh-side gates makes
  // the next drain re-coat them from the ledger (serials stay intact).
  mesh.userData.__bootsPaintSerial = undefined
  mesh.userData.__bootsPaintTarget = undefined
  return holes
}

/** How far below the lot a freshly primed dormant replica renders for its
 * one warm-up frame — deep enough that nothing (terrain, basements, blast
 * craters) ever reveals it. */
const WARM_DRAW_DROP = 600

/** memo: a destruction-store bump re-renders VoxelWalls (membership may
 * have changed) but every EXISTING wall object is stable — all its updates
 * are mutations drained in useFrame (dormant flag, revision, skinRevision),
 * so a shallow prop compare keeps wake/glass/crumble bumps from
 * re-reconciling N unchanged wall subtrees in the hot blast window. */
const VoxelWallMesh = memo(function VoxelWallMesh({ wall }: { wall: VoxelTarget }) {
  const meshRef = useRef<InstancedMesh>(null!)
  const groupRef = useRef<Group>(null!)
  const revision = useRef(-1)
  const skinRevision = useRef(0)
  /** Last grid FRAME this replica's instance matrices reflect (destruction.ts
   * poseRevision — the rigid re-pose that walks a shot door's holes along with
   * its swinging leaf). Every drawn cube's matrix is composed from grid.centers
   * and grid.q, so a frame move invalidates all of them at once. */
  const poseRevision = useRef(0)
  const warmDraw = useRef(0)
  /** Last passage generation this replica's instance matrices reflect. -1 so the
   * first awake frame always reconciles (a door may already be open). */
  const passageGen = useRef(-1)
  /** Whether an open doorway is currently hiding cells here — the latch that
   * makes a door CLOSING put its cubes back (by then no prism reaches the grid,
   * so the cheap sphere early-out would otherwise skip the restore). */
  const passageHoles = useRef(false)
  const primeEntry = useRef<DormantPrimeEntry>(null!)
  const sandwich = wall as SandwichTarget
  const boards = sandwich.boards
  // Until destruction-core lands `segments`, the studs render as the wood
  // layer — same member shape, same single-draw-call path.
  const segments =
    sandwich.segments && sandwich.segments.length > 0 ? sandwich.segments : wall.studs
  // Dirt underlay for terrain-borne floor slabs (see header above): a hole
  // carved through the floor reveals earth, not the host's white pad/lawn.
  const underlay = useMemo(() => floorUnderlayLayout(wall), [wall])
  const gl = useThree((s) => s.gl)

  useLayoutEffect(() => {
    const mesh = meshRef.current
    // QA surface only (replicaDrawAudit) — a plain reference, dropped on
    // unmount, so a session leaves nothing behind.
    _liveReplicas.set(wall.nodeId, mesh)
    // Version-gated instance uploads (see the static-scene discipline block):
    // the skin only re-uploads on revision/skinRevision mutations now.
    markStorageInstanced(mesh, gl)
    // Culling stays OFF until this replica primed (and, for dormant
    // prebuilds, until the warm draw ran) — a culled warm draw would never
    // reach the GPU and the wake frame would pay the upload again.
    mesh.frustumCulled = false
    // Awake targets prime here, at mount, like always. DORMANT prebuilds
    // stay hidden with identity matrices and prime through the budgeted
    // queue (or on their wake, whichever comes first) — the mount itself is
    // already spread across session-start frames by the Prevoxelize budget.
    const entry: DormantPrimeEntry = {
      primed: false,
      prime: () => {
        passageHoles.current = primeSkin(mesh, wall)
        passageGen.current = passageGeneration()
        // primeSkin reads grid.alive directly, so removals queued while the
        // prime waited are already baked in — sync counters, drop the queue.
        revision.current = wall.revision
        skinRevision.current = wall.skinRevision ?? 0
        poseRevision.current = wall.poseRevision ?? 0
        wall.removedQueue.length = 0
        // The buffers are real now — give the mesh its true bounding sphere
        // (grid AABB + half-cell margin; kills only shrink, never grow).
        mesh.boundingSphere = gridBoundingSphere(wall.grid, mesh.boundingSphere ?? undefined)
        // WARM DRAW (first-blast decomposition, QA 2026-08-28): priming a
        // HIDDEN replica fills CPU-side buffers only — the GPU upload of
        // ~thousands of instance matrices (per layer) happens on the first
        // frame the mesh actually DRAWS. A mid-house blast waking ~15
        // replicas paid all of those first uploads in one frame (~100 ms
        // unaccounted next to a 13 ms carve). So render the replica ONCE
        // right now, far underground: same budgeted cadence as the primes
        // (2/frame), buffers land on the GPU, and the wake frame is back
        // to a visibility flip. Wake-path primes skip it — the replica is
        // becoming visible this very frame anyway.
        if (wall.dormant) {
          const group = groupRef.current
          if (group) {
            group.visible = true
            // The subtree froze at mount — move + refresh matrices by hand.
            shiftFrozenSubtreeY(group, -WARM_DRAW_DROP)
            // 2, not 1: the drain (parent useFrame) may run BEFORE this
            // replica's own useFrame in the same frame — a 1-frame latch
            // would restore + re-hide before anything ever drew.
            warmDraw.current = 2
            perfSection('warm-draw-armed', 0)
            // Tell the drain an upload is in flight — it stops for this
            // frame so warm draws serialize (one first-upload per frame).
            return true
          }
        }
        // Awake (mount or wake-path) prime: the mesh draws in place from
        // here on — safe to start culling against the sphere set above.
        mesh.frustumCulled = true
        return false
      },
    }
    primeEntry.current = entry
    revision.current = wall.revision
    skinRevision.current = wall.skinRevision ?? 0
    poseRevision.current = wall.poseRevision ?? 0
    if (wall.dormant) queueDormantPrime(entry)
    else primeDormantNow(entry)
    // Replicas never move: settle world matrices once, then opt the whole
    // subtree (group + skin + underlay + member layers — child effects ran
    // before this one) out of three's per-frame matrix churn. The warm
    // draw's drop/restore goes through shiftFrozenSubtreeY.
    freezeStaticSubtree(groupRef.current)
    return () => {
      entry.primed = true // tombstone — the drain skips unmounted replicas
      if (_liveReplicas.get(wall.nodeId) === mesh) _liveReplicas.delete(wall.nodeId)
    }
  }, [wall, gl])

  useFrame(() => {
    const mesh = meshRef.current
    const group = groupRef.current
    if (!mesh || !group) return
    // Post-prime warm draw in flight: keep the replica rendering
    // underground (skip the dormant re-hide) until the countdown lands,
    // then put the group back — syncDormantWallFrame re-hides it below.
    if (warmDraw.current > 0) {
      // Woken mid-warm (a blast within 2 frames of the prime): abort the
      // warm NOW — the wall must render in place this frame, not blink
      // out by drawing its one warm frame underground.
      if (wall.dormant !== true) warmDraw.current = 1
      warmDraw.current--
      if (warmDraw.current > 0) return
      shiftFrozenSubtreeY(group, WARM_DRAW_DROP)
      // Warm frames done — the buffers are on the GPU, culling is safe.
      mesh.frustumCulled = true
      perfSection('warm-draw-done', 0)
    }
    // Wake = visibility flip (+ an on-the-spot prime if the budgeted queue
    // hadn't reached this target). While dormant nothing below can change:
    // damage paths always wake first, so revision/skin drains wait here.
    if (!syncDormantWallFrame(group, wall, primeEntry.current)) return
    if (revision.current !== wall.revision) {
      revision.current = wall.revision
      const drainT0 = performance.now()
      const queue = wall.removedQueue
      for (let i = 0; i < queue.length; i++) mesh.setMatrixAt(queue[i]!, ZERO)
      queue.length = 0
      mesh.instanceMatrix.needsUpdate = true
      perfSection('skin-drain', performance.now() - drainT0)
    }
    // THE GRID FRAME MOVED (destruction.ts reposePosedTarget): a door that was
    // shot mid-swing has had its grid rigidly re-posed onto the leaf, so the
    // player's holes ride the door instead of healing. Every cube's matrix is
    // composed from grid.centers + grid.q, so all of them are stale at once —
    // one full sweep, on an integer compare, so an unmoved grid pays nothing.
    if (poseRevision.current !== (wall.poseRevision ?? 0)) {
      poseRevision.current = wall.poseRevision ?? 0
      // The sweep writes every cell against the LIVE passage registry, so it
      // doubles as a passage sync — bank the generation, or the branch below
      // would immediately sweep the same grid a second time.
      passageHoles.current = syncPassageHoles(mesh, wall)
      passageGen.current = passageGeneration()
      // NOTHING ELSE recomputes this. It is set once at prime, and a re-posed
      // door whose sphere still sits at the old pose gets frustum-culled at a
      // location it no longer occupies — invisible from most angles, while
      // bullets and bodies still hit it. That is the ghost, inverted.
      mesh.boundingSphere = gridBoundingSphere(wall.grid, mesh.boundingSphere ?? undefined)
    }
    // OPEN DOORWAY HOLES (collision.ts::passageHidesCell): opening or closing a
    // door changes which of this replica's cells may draw. The registry stamps a
    // generation on every change, so the steady state costs one integer compare
    // per target per frame — and the sweep itself only touches replicas a prism
    // actually reaches (or ones still holding a hole open, which must restore).
    const gen = passageGeneration()
    if (passageGen.current !== gen) {
      passageGen.current = gen
      if (passageHoles.current || passagesReachGrid(wall)) {
        const holeT0 = performance.now()
        passageHoles.current = syncPassageHoles(mesh, wall)
        perfSection('passage-holes', performance.now() - holeT0)
      }
    }
    // Async skin tone landed (roof shingle GPU readback — destruction.ts
    // bumps skinRevision after retinting baseColor): re-prime the whole
    // layer once. Idles at one number compare per target per frame.
    if (skinRevision.current !== (wall.skinRevision ?? 0)) {
      skinRevision.current = wall.skinRevision ?? 0
      const reprimeT0 = performance.now()
      // The re-prime is itself a full matrix write against the live registry, so
      // it doubles as a passage sweep — bank it, or the latch would think a hole
      // is still owed and sweep the whole grid again next door toggle.
      passageHoles.current = primeSkin(mesh, wall)
      passageGen.current = passageGeneration()
      perfSection('skin-reprime', performance.now() - reprimeT0)
    }
  })

  return (
    <group ref={groupRef} userData={{ __boots: true }} visible={!wall.dormant}>
      <instancedMesh
        args={
          // Ceiling plates swap in the face-tinted box + vertex-color
          // material (see CEILING_GEOMETRY); ceilingTop is fixed for a
          // target's lifetime, so the args never change post-mount.
          wall.ceilingTop === true
            ? [CEILING_GEOMETRY, CEILING_SKIN_MATERIAL, wall.grid.count]
            : [VOXEL_GEOMETRY, SKIN_MATERIAL, wall.grid.count]
        }
        ref={meshRef}
        userData={{ __boots: true, __bootsLayer: 'skin' }}
      />
      {underlay && (
        <mesh
          args={[UNDERLAY_GEOMETRY, UNDERLAY_MATERIAL]}
          position={[underlay.x, underlay.y, underlay.z]}
          rotation={[-Math.PI / 2, 0, 0]}
          scale={[underlay.width, underlay.depth, 1]}
        />
      )}
      {boards && boards.length > 0 && (
        <MemberLayer layer="boards" members={boards} style={BOARD_STYLE} />
      )}
      {segments.length > 0 && (
        <MemberLayer layer="segments" members={segments} style={SEGMENT_STYLE} />
      )}
    </group>
  )
})

export function VoxelWalls() {
  const version = useDestruction((s) => s.version)
  // Skin tone rig (skin-tone.ts): the async compressed-texture readback
  // (shingles, tiled floors) needs the LIVE renderer — register it for the
  // session, clear on unmount.
  const gl = useThree((s) => s.gl)
  useEffect(() => {
    setSkinToneRenderer(gl as unknown as SkinToneRenderer)
    return () => {
      setSkinToneRenderer(null)
      // Session exit: every entry is a tombstone by now (mesh unmounts
      // ran first) — drop them so their mesh/grid closures free with the
      // session instead of lingering until next session's first drains.
      primeQueue.length = 0
    }
  }, [gl])
  const walls = useMemo(() => {
    void version
    // DORMANT prebuilds mount too — hidden (`visible = false`) while the
    // HOST keeps rendering — so a wake is a visibility flip on an already
    // mounted, already primed replica instead of a blast-frame mount storm.
    return Array.from(useDestruction.getState().targets.values())
  }, [version])
  // Spread the dormant replicas' skin primes a couple per frame — an empty
  // queue costs one length check.
  useFrame(() => {
    drainDormantPrimes()
  })
  return (
    <>
      {walls.map((wall) => (
        <VoxelWallMesh key={wall.nodeId} wall={wall} />
      ))}
    </>
  )
}
