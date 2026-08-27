'use client'

import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import {
  CanvasTexture,
  Color,
  type InstancedMesh,
  Matrix4,
  type Mesh,
  type MeshStandardMaterial,
  type Object3D,
  Ray,
  Vector3,
} from 'three'
import { useBoots } from '../store'
import { sfx, type SprayHandle } from './audio'
import { ensureVoxelTarget, raycastVoxelTargets, useDestruction, type VoxelTarget } from './destruction'
import { itemGhostActive } from './item-place'
import { playerRig } from './player'
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
 * in a module ledger (nodeId → cell → palette index) that paint-keep.ts
 * aggregates into per-node dominant colors on exit; the explicit sidebar
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

/** nodeId → voxel cell index → palette index. Later coats overwrite. */
const paintedByNode = new Map<string, Map<number, number>>()
/** Per-node write serial — the renderer-drain's change gate. */
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

// ── Spray resolution (raycast scratch — module temps, no per-shot allocs) ──

const _origin = new Vector3()
const _direction = new Vector3()
const _ray = new Ray()
const _inverse = new Matrix4()
const _point = new Vector3()

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
  for (const collider of world.colliders) {
    if (collider.disabled) continue
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
  if (!nodeId) {
    lastHitDistance = null
    return false
  }
  lastHitDistance = bestDist
  if (needsVoxelize) {
    if (!solidType || !PAINTABLE.has(solidType)) return false
    if (!ensureVoxelTarget(world, nodeId)) return false // degenerate grid
  }
  const target = useDestruction.getState().targets.get(nodeId)
  if (!target) return false

  const cells = selectSplatCells(target.grid, _point.x, _point.y, _point.z, splatRadiusAt(bestDist))
  if (cells.length === 0) return false
  let painted = paintedByNode.get(nodeId)
  if (!painted) {
    painted = new Map()
    paintedByNode.set(nodeId, painted)
  }
  for (const cell of cells) painted.set(cell, colorIndex)
  nodeSerials.set(nodeId, (nodeSerials.get(nodeId) ?? 0) + 1)
  return true
}

// ── Tint drain (renderer side — writes ONLY instanceColor) ────────────────

const _tint = new Color()
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

function resolveMesh(scene: Object3D, nodeId: string, target: VoxelTarget): InstancedMesh | null {
  const cached = meshCache.get(nodeId)
  if (cached && cached.parent && matchesTarget(cached, target)) return cached
  meshCache.delete(nodeId)
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
  const targets = useDestruction.getState().targets
  for (const [nodeId, cells] of paintedByNode) {
    const target = targets.get(nodeId)
    if (!target) continue
    const serial = nodeSerials.get(nodeId) ?? 0
    const mesh = resolveMesh(scene, nodeId, target)
    if (!mesh) continue
    const gates = mesh.userData as PaintedUserData
    if (gates.__bootsPaintSerial === serial && gates.__bootsPaintTarget === target) continue
    for (const [cell, color] of cells) {
      if (!target.grid.alive[cell]) continue
      // Same hash the priming jitter uses, gentler spread — painted runs
      // keep the per-voxel "block" read instead of banding flat.
      const j = ((cell * 2654435761) % 97) / 97
      _tint.set(PAINT_PALETTE[color]!.hex).offsetHSL(0, 0, (j - 0.5) * 0.06)
      mesh.setColorAt(cell, _tint)
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
    ;(globalThis as Record<string, unknown>).__bootsPaint = paintDebug
    return () => {
      paintDebug.holdFire = false
      spray.current?.stop()
      spray.current = null
      spraying.current = false
      // Never hold host meshes across sessions.
      meshCache.clear()
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
  return null
}
