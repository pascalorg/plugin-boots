'use client'

import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import {
  BufferAttribute,
  BufferGeometry,
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
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { useBoots } from '../store'
import { sfx, type SprayHandle } from './audio'
import * as destructionModule from './destruction'
import { ensureVoxelTarget, raycastVoxelTargets, useDestruction, type VoxelTarget } from './destruction'
import { spawnDust } from './dust'
import { itemGhostActive } from './item-place'
import { playerRig } from './player'
import { primedCellColor } from './skin-tone'
import { getSession } from './session'
import {
  buildSyncOn,
  drainPendingStrokes,
  flushBuildSync,
  isOurRecord,
  publishStroke,
  refoldSharedStrokes,
  setBuildAppliers,
} from './shared-build'
import { localNodeId, wireNodeId } from './shared-damage'
import { foldCoats, strokesByNode } from './shared-derive'
import type { StrokeRec } from './shared-world'
import { aimDirection } from './shooting'
import { rotateByBasis, rotateByBasisInverse, type VoxelBasis } from './voxel'
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
 *
 * ── Round read (phase 10, reworked phase 11) ────────────────────────────
 * Cell tint alone is inherently SQUARE — whole 0.15 m voxels flip color
 * (owner: "it only colors full squares instead of a normal paint circle").
 * So every spray tick that coats a voxelized target ALSO stamps a round
 * splat SPRITE: one InstancedMesh pool (SPLAT_SPRITE_CAP ring — the drip
 * idiom) of textured quads laid flat on the hit face (splatNormalFor: the
 * dominant grid axis of the reversed shot, biased to the FACE on layered
 * wall/slab/roof grids), lifted SPLAT_SPRITE_LIFT off the surface, palette
 * via instanceColor over ONE module-cached SOLID-DISC texture.
 *
 * Phase 11 (owner: "no blobs/splats — a normal spray FULLY colors a round
 * area, tight close, wide far"), softened in the spray-polish round: the
 * stamp is a filled disc — opaque to SPLAT_CORE_FRAC, then an airbrush
 * smoothstep falloff with overspray grain inside the band (no wobble, no
 * satellite droplets, no scale jitter — the quad side IS the
 * 2 × splatRadiusAt(distance) diameter), and
 * a held DRAG paints a continuous swath: the module STROKE anchor bridges
 * this tick's hit to the last one with intermediate stamps spaced ≤
 * radius/2 (swathPoints), each feeding the cell ledger/decal votes exactly
 * like a real tick so paint-keep accounting matches what's on the wall.
 * Held-trigger economy stays: no new stamp within SPLAT_COALESCE_FRAC ×
 * radius of the node's previous same-color stamp.
 * Sprites are purely visual — the cell ledger above still owns persistence
 * and the destroyed-cell look; a node's sprites evict when its target
 * drops or fully collapses (drainPaintTints spots both), and the pool
 * lives for the session like the drips (Esc teardown clears it).
 */

export type PaintColor = { name: string; hex: string }

/** The 12-color R-carousel (owner: "like 8 or 16 colors I just cycle
 * through") — a full game-y spread, one obvious pick per hue family. */
export const PAINT_PALETTE: readonly PaintColor[] = [
  { name: 'WHITE', hex: '#f4f4ef' },
  { name: 'BLACK', hex: '#26282c' },
  { name: 'GRAY', hex: '#8f959d' },
  { name: 'RED', hex: '#e5443b' },
  { name: 'ORANGE', hex: '#f28a2e' },
  { name: 'YELLOW', hex: '#f5c542' },
  { name: 'GREEN', hex: '#52b24c' },
  { name: 'TEAL', hex: '#2fb8a6' },
  { name: 'BLUE', hex: '#3e7fe1' },
  { name: 'PURPLE', hex: '#8f5fd6' },
  { name: 'PINK', hex: '#ef6fa7' },
  { name: 'BROWN', hex: '#8c5a33' },
]

/** Palette hexes in carousel order — the HUD paintCarousel argument (hud.ts
 * can't import this module: paint → session → hud would cycle back). */
export const PAINT_PALETTE_HEXES: readonly string[] = PAINT_PALETTE.map((p) => p.hex)

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
/** Narrow-end radius (m) — spray-polish round (owner: "40% smaller"): the
 * phase-11 anchors scaled by 0.6. A close pass is a true writing stroke
 * against 0.15 m wall cells (one cell wide at the nose). */
export const SPLAT_NEAR_RADIUS = 0.15
/** Beyond this distance (m) the cone is fully open. */
export const SPLAT_FAR_DIST = 8
/** Broad-end radius (m) — 0.6 × the phase-11 fan (1.4 → 0.84). */
export const SPLAT_FAR_RADIUS = 0.84

/** Pure cone curve: hit distance (m) → splat radius (m). Clamped quadratic
 * ease-in between the near/far anchors — flat narrow plateau ≤ 1 m, slow
 * growth through writing range, late bloom to 0.84 m at ≥ 8 m. */
export function splatRadiusAt(distance: number): number {
  const span = SPLAT_FAR_DIST - SPLAT_NEAR_DIST
  const t = Math.min(Math.max((distance - SPLAT_NEAR_DIST) / span, 0), 1)
  return SPLAT_NEAR_RADIUS + (SPLAT_FAR_RADIUS - SPLAT_NEAR_RADIUS) * t * t
}

/** Painting nearer than this (m) is "writing mode" — the HUD says so. */
export const WRITING_DISTANCE = 2

/** Seconds between retries of a stroke waiting for its wall (pendingStrokes).
 * Slow on purpose: the wall it wants is coming over a network, not this frame,
 * and a missed retry costs a quarter second of a coat nobody is looking at. */
const PENDING_STROKE_DRAIN = 0.25

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
/** Bumped by every R cycle — PaintTool's change gate for the HUD carousel
 * flash (equipping the sprayer alone must NOT flash it). */
let cycleSerial = 0

export const currentPaintColor = (): PaintColor => PAINT_PALETTE[colorIndex]!
/** Carousel position of the live coat — the HUD's active-dot index. */
export const currentPaintIndex = (): number => colorIndex
/** How many R cycles ever happened (monotonic; module lifetime). */
export const paintCycleSerial = (): number => cycleSerial

/** R while the sprayer is held — viewmodel routes the action here. */
export function cyclePaintColor(): PaintColor {
  colorIndex = (colorIndex + 1) % PAINT_PALETTE.length
  cycleSerial++
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

/** The strength a coat of `color` BUILDS ON at a cell: same color
 * accumulates; a DIFFERENT color covers the old coat and restarts from
 * zero — carrying the previous color's strength would flip a saturated
 * green cell to blue at FULL strength off one faint rim graze (and inflate
 * its paint-keep vote accordingly). Pure — exported for tests. */
export function coatBaseStrength(prev: number | undefined, color: number): number {
  return prev !== undefined && paintColorOf(prev) === color ? paintStrengthOf(prev) : 0
}

/** nodeId → voxel cell index → packed (color << 8) | strength coat. */
const paintedByNode = new Map<string, Map<number, number>>()
/** Per-node write serial — the renderer-drain's change gate. */
const nodeSerials = new Map<string, number>()

/**
 * WHY A PEER SEES NO PAINT — the four ways a coat can fail to cross, counted.
 *
 * Every one of them is silent from both ends: the sprayer sees its own wall go
 * blue either way, and the peer sees a wall that was never painted, which looks
 * exactly like a quiet wire. The grid stamp taught this lane the lesson
 * (`gridStampPublishes` / `refusedGrid`): when a failure is invisible, a counter
 * is the only thing a harness can read.
 */
const wireCounts = { published: 0, unnamed: 0, folded: 0, foldUnnamed: 0, foldNoTarget: 0 }

/**
 * Records already counted as having WAITED, so a retry is not a second failure.
 *
 * The build lane re-offers a waiting stroke several times a second (see
 * drainPendingStrokes), and a counter that ticked on every attempt would read
 * `foldNoTarget 400` for one stroke that landed fine a second later — the
 * opposite of what these counters are for. One record counts ONCE, under the
 * first reason it waited (a stroke that waits for a name and then for a grid is
 * one waiting stroke, not two). Cleared with the session, and hard-capped
 * because record ids are unbounded.
 */
const foldWaited = new Set<string>()
const FOLD_WAITED_CAP = 4096

/**
 * Stroke records already deposited into the ledger — see the filter in
 * foldRemoteStrokes. Grows with the room's stroke set (which the shared world
 * retains anyway) and is cleared with the ledger.
 */
const foldedStrokes = new Set<string>()

/** Count `recs` as waiting on `counter`, once each however often they retry. */
function countWaited(recs: readonly StrokeRec[], counter: 'foldUnnamed' | 'foldNoTarget'): void {
  for (const rec of recs) {
    if (foldWaited.has(rec.id)) continue
    if (foldWaited.size >= FOLD_WAITED_CAP) foldWaited.clear()
    foldWaited.add(rec.id)
    wireCounts[counter]++
  }
}

/**
 * Cells whose coat came from ANOTHER PLAYER's stroke, per ledger node.
 *
 * One ledger holds everyone's paint, because a wall has one colour and every
 * client must agree on it. But Save writes only what THIS player did, so the
 * two have to be told apart, and the honest granularity is the cell: a remote
 * fold marks the cells it touched, a local spray over one of them takes it
 * back (the last writer owns the cell — the same rule the packed ledger value
 * already follows). Empty whenever sync is off, which is what keeps the Save
 * snapshot byte-identical in single-player.
 */
const remoteCoated = new Map<string, Set<number>>()

export const getPaintedByNode = (): ReadonlyMap<string, ReadonlyMap<number, number>> =>
  paintedByNode

/** Note a cell as this player's own work — a local coat over a remote one. */
function claimCell(nodeId: string, cell: number): void {
  remoteCoated.get(nodeId)?.delete(cell)
}

/**
 * The ledger MINUS every cell another player coated — what Save may write.
 *
 * paint-keep.ts calls this rather than reaching into a shared module: a Save
 * bridge may import `localWork` and nothing else, and
 * shared-invariant.test.ts enforces it. With nothing remote in the ledger it
 * returns the ledger itself, so single-player takes the identical object down
 * the identical path.
 */
export function getOwnPaintedByNode(): ReadonlyMap<string, ReadonlyMap<number, number>> {
  if (remoteCoated.size === 0) return paintedByNode
  const out = new Map<string, Map<number, number>>()
  for (const [nodeId, cells] of paintedByNode) {
    const theirs = remoteCoated.get(nodeId)
    if (!theirs || theirs.size === 0) {
      out.set(nodeId, cells)
      continue
    }
    const mine = new Map<number, number>()
    for (const [cell, value] of cells) {
      if (theirs.has(cell)) continue
      mine.set(cell, value)
    }
    out.set(nodeId, mine)
  }
  return out
}

/** Cells another player painted on this node (QA + tests). */
export function remoteCoatedCells(nodeId: string): ReadonlySet<number> {
  return remoteCoated.get(nodeId) ?? EMPTY_CELLS
}

const EMPTY_CELLS: ReadonlySet<number> = new Set<number>()

/** Mounts of PaintTool on this page — see paintDebug.mounts. */
let paintMounts = 0

/** Fresh session, fresh coats — called from PaintTool's mount effect. */
export function resetPaint(): void {
  paintMounts++
  paintedByNode.clear()
  nodeSerials.clear()
  remoteCoated.clear()
  wireCounts.published = 0
  wireCounts.unnamed = 0
  wireCounts.folded = 0
  wireCounts.foldUnnamed = 0
  wireCounts.foldNoTarget = 0
  foldWaited.clear()
  foldedStrokes.clear()
  lastHitDistance = null
  endPaintStroke()
}

// ── Last hit distance (drives the cone + the writing-mode HUD line) ───────

let lastHitDistance: number | null = null

/** Distance (m) of the most recent spray tick's surface hit; null while
 * spraying at nothing. PaintTool reads it for the writing-mode prompt. */
export const lastSprayHitDistance = (): number | null => lastHitDistance

// ── The spray stroke (drag continuity — phase 11) ─────────────────────────
//
// Spray ticks land at PAINT_RATE (9 Hz); a dragged aim moves the hit point
// farther than the stamp diameter between ticks, which used to leave GAPS in
// the swath. The module stroke anchor remembers the last stamp of the held
// trigger; swathPoints bridges anchor → new hit with intermediate stamps
// spaced ≤ radius × SWATH_SPACING_FRAC, so a drag paints one continuous
// band. The anchor dies on trigger release (PaintTool), on a miss, and on a
// node/color change — a stroke never bridges across air or between nodes.

/** Bridge stamp spacing as a fraction of the disc radius (≤ 1/2 the radius
 * guarantees solid overlap between consecutive full discs). */
export const SWATH_SPACING_FRAC = 0.5
/** Per-tick cap on bridge stamps — covers SWATH_MAX_GAP even at the tight
 * near radius (ceil(2.5 / (0.15 × 0.5)) − 1 = 33), bounds the tick's work. */
export const SWATH_MAX_STEPS = 34
/** A jump longer than this (m) is a new stroke, not a drag — never bridge
 * across a doorway or a wall edge the aim skipped over. */
export const SWATH_MAX_GAP = 2.5

/**
 * Pure bridge math — exported for tests. Intermediate stamp centers evenly
 * spread between the stroke anchor `prev` and this tick's hit (endpoints
 * excluded — the caller stamps the hit itself), enough that consecutive
 * stamps sit ≤ radius × SWATH_SPACING_FRAC apart. Empty when there is no
 * anchor, the hit is already within spacing, or the jump exceeds
 * SWATH_MAX_GAP.
 */
export function swathPoints(
  prev: { x: number; y: number; z: number } | null,
  x: number,
  y: number,
  z: number,
  radius: number,
): { x: number; y: number; z: number }[] {
  if (!prev) return []
  const dx = x - prev.x
  const dy = y - prev.y
  const dz = z - prev.z
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
  const spacing = radius * SWATH_SPACING_FRAC
  if (dist <= spacing || dist > SWATH_MAX_GAP) return []
  const steps = Math.min(Math.ceil(dist / spacing) - 1, SWATH_MAX_STEPS)
  const out: { x: number; y: number; z: number }[] = []
  for (let k = 1; k <= steps; k++) {
    const t = k / (steps + 1)
    out.push({ x: prev.x + dx * t, y: prev.y + dy * t, z: prev.z + dz * t })
  }
  return out
}

/** The held trigger's last stamp — nodeId keys the LEDGER id of that lane
 * (scene id on the decal lane, member id on voxelized roof planes). */
let stroke: { nodeId: string; color: number; x: number; y: number; z: number } | null = null

/** Trigger released / miss / teardown — the next tick starts a new stroke. */
export function endPaintStroke(): void {
  stroke = null
}

/** This tick's bridge points, when the stroke continues on the same node
 * with the same color; [] on a fresh stroke. */
function strokeBridge(nodeId: string, x: number, y: number, z: number, radius: number) {
  const prev = stroke && stroke.nodeId === nodeId && stroke.color === colorIndex ? stroke : null
  return swathPoints(prev, x, y, z, radius)
}

/** Record this tick's stamp as the stroke anchor (record reused in place —
 * one allocation per stroke). */
function advanceStroke(nodeId: string, x: number, y: number, z: number): void {
  if (stroke) {
    stroke.nodeId = nodeId
    stroke.color = colorIndex
    stroke.x = x
    stroke.y = y
    stroke.z = z
  } else {
    stroke = { nodeId, color: colorIndex, x, y, z }
  }
}

// ── Feathered coat math (pure — exported for tests) ───────────────────────
//
// Phase 11 dropped the rim-speckle annulus: overspray flecks tinted WHOLE
// 0.15 m cells past the disc (a square halo around the round stamp — the
// exact blob read the owner rejected). A coat now lands only on cells
// inside the disc radius; the solid sprite covers them.

/** Strength a splat's CENTER adds per tick — saturates in ~2–3 coats. */
export const COAT_ADD = 0.45

/** Fraction of the stamp radius that is fully OPAQUE. Spray-polish round
 * (owner: "the edge reads like a hard sticker"): the airbrush read — solid
 * to ~60% of the radius, then a smoothstep alpha falloff to 0 at the rim
 * with speckle grain inside the band (overspray dust). Shared by the
 * sprite/decal textures and the ledger inset below. */
export const SPLAT_CORE_FRAC = 0.6
/** Half of a 0.15 m wall cell — the farthest a coated cell's square can
 * reach past its own center. */
const COAT_HALF_CELL = 0.075

/** The ledger radius for a disc of `radius`: coated cells hide UNDER the
 * disc's opaque core (cell center + half-cell ≤ core radius) wherever the
 * 0.15 m cell size allows it, floored at half the radius so a coat always
 * lands something. With the 0.6 core the floor rules until r ≥ 0.75 — a
 * cell square can poke into the FALLOFF band there (never past the disc:
 * r/2 + half-cell ≤ r for every r ≥ 0.15), where the grain reads as
 * overspray, not the blocky halo the owner rejected. Applied at the
 * sprayPaint/convertDecals call sites; splatCoat stays the pure rule. */
export const coatRadiusFor = (radius: number): number =>
  Math.max(radius * 0.5, radius * SPLAT_CORE_FRAC - COAT_HALF_CELL)

/** Smoothstep falloff across the splat: 1 at the center (t = 0), 0 at the
 * rim (t = d / radius = 1). Pure — the feathered-edge curve. */
export function splatFalloff(t: number): number {
  if (t <= 0) return 1
  if (t >= 1) return 0
  const u = 1 - t
  return u * u * (3 - 2 * u)
}

/**
 * One splat's strength contributions: every ALIVE cell inside `radius`
 * gains COAT_ADD × smoothstep falloff (full at the hit point, feathering
 * to zero at the rim). Pure — sprayPaint accumulates the adds into the
 * packed ledger.
 */
export function splatCoat(
  grid: { count: number; alive: ArrayLike<number>; centers: ArrayLike<number> },
  x: number,
  y: number,
  z: number,
  radius: number,
): { cell: number; add: number }[] {
  const r2 = radius * radius
  const out: { cell: number; add: number }[] = []
  for (let i = 0; i < grid.count; i++) {
    if (!grid.alive[i]) continue
    const dx = (grid.centers[i * 3] ?? 0) - x
    const dy = (grid.centers[i * 3 + 1] ?? 0) - y
    const dz = (grid.centers[i * 3 + 2] ?? 0) - z
    const d2 = dx * dx + dy * dy + dz * dz
    if (d2 > r2) continue
    const add = COAT_ADD * splatFalloff(Math.sqrt(d2) / radius)
    if (add > 0) out.push({ cell: i, add })
  }
  return out
}

/** The farthest a surface hit can sit from the CENTER of the very cell it
 * touches: half a 0.15 m cell across all three axes is √3 × 0.075 ≈ 0.13
 * (thinner sandwich layers only shrink it). The writing-range rescue reach
 * below. */
export const NEAREST_COAT_REACH = 0.14

/**
 * Nearest alive cell within `reach` of the hit (3D) — the writing-range
 * rescue: the 0.6-scaled near disc (r = 0.15) insets its ledger coat to
 * 0.075 (coatRadiusFor), which MISSES every cell center when the spray
 * lands at a cell corner (lateral half-cell diagonal ≈ 0.106) — the tick
 * used to abort with nothing landed, so nose-range spraying painted
 * NOTHING. The rescue coats the one cell the crosshair actually touches.
 * Pure — exported for tests; −1 when nothing is in reach.
 */
/** The rescue reach for a REAL grid: at least NEAREST_COAT_REACH, opened
 * to the cell half-diagonal (+1 cm slack) on coarser grids — a corner hit
 * must always reach the center of the cell it touches. Pure. */
export function coatReachFor(cell: { cellX: number; cellY: number; cellZ: number }): number {
  return Math.max(NEAREST_COAT_REACH, 0.5 * Math.hypot(cell.cellX, cell.cellY, cell.cellZ) + 0.01)
}

export function nearestCoatCell(
  grid: { count: number; alive: ArrayLike<number>; centers: ArrayLike<number> },
  x: number,
  y: number,
  z: number,
  reach: number = NEAREST_COAT_REACH,
): number {
  let best = -1
  let bestD2 = reach * reach
  for (let i = 0; i < grid.count; i++) {
    if (!grid.alive[i]) continue
    const dx = (grid.centers[i * 3] ?? 0) - x
    const dy = (grid.centers[i * 3 + 1] ?? 0) - y
    const dz = (grid.centers[i * 3 + 2] ?? 0) - z
    const d2 = dx * dx + dy * dy + dz * dz
    if (d2 <= bestD2) {
      best = i
      bestD2 = d2
    }
  }
  return best
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

/** What `paintDebug.census()` reports — every splat this session still owns,
 * split by representation. `decals + bakedDecals` (and `sprites +
 * bakedSprites`) is the count of stamps the player can still see; it must only
 * ever grow while spraying. */
export type PaintCensus = {
  /** Live keyed decal meshes (the ring slots). */
  decals: number
  /** Stamps merged into baked decal chunks — same triangles, fewer draws. */
  bakedDecals: number
  /** Live sprite-quad instances (voxel skins). */
  sprites: number
  /** Stamps merged into baked sprite chunks. */
  bakedSprites: number
  /** Baked chunk meshes (the draw-call cost of all the baked stamps). */
  chunks: number
  /** Geometries awaiting the next frame's disposal (must drain to 0). */
  retired: number
  /** Sprite slots whose matrix zero is deferred one frame (must drain to 0). */
  pendingSplatZeros: number
}

/** One painted node as `paintDebug.coated()` reports it (QA). */
export type CoatedNode = {
  nodeId: string
  /** Ledger cells carrying a coat, whoever put it there. */
  cells: number
  /** How many of those cells came from another player's stroke. */
  remote: number
}

/**
 * Dev-only handle (published as `globalThis.__bootsPaint` while the tool
 * runs — the `__bootsBuilder` pattern): headless E2E can't engage pointer
 * lock, so `holdFire` stands in for the held LMB (it is OR-ed with the real
 * input each frame). `census()` is read-only, for the losslessness proof.
 */
export const paintDebug: {
  holdFire: boolean
  census: (nodeId?: string) => PaintCensus
  coated: () => CoatedNode[]
  wire: () => typeof wireCounts
  mounts: () => number
} = {
  holdFire: false,
  /** The four silent failures, counted (see wireCounts). */
  wire: () => ({ ...wireCounts }),
  /**
   * How many times the tool has mounted this page. Above 1 means the ledger was
   * wiped mid-session (the mount effect resets it) — and since a stroke record
   * is delivered once, a coat that was folded before the wipe is gone for good.
   * A remount is a suspect QA cannot see any other way.
   */
  mounts: () => paintMounts,
  /**
   * THE LEDGER, NOT THE RENDERER — which node holds how much paint, and how
   * much of it came from someone else.
   *
   * `census()` counts stamps in THIS client's chosen representation (a pristine
   * host wears decals, a shot-up one wears sprites), so two clients spraying
   * the same wall can hold the same coat and report different censuses. Cells
   * are the thing both tiers agree on — they are what travels on the wire —
   * which makes this the honest oracle for "every player sees the same sprays":
   * same nodeId, and on the receiving side `remote > 0`.
   */
  coated: () => {
    const out: CoatedNode[] = []
    for (const [nodeId, cells] of paintedByNode) {
      out.push({ cells: cells.size, nodeId, remote: remoteCoatedCells(nodeId).size })
    }
    return out.sort((a, b) => b.cells - a.cells)
  },
  census: (nodeId?: string) => ({
    decals: decalCensus(nodeId),
    bakedDecals: bakedPaintCensus(nodeId, 'decal'),
    sprites: splatSpriteCensus(nodeId),
    bakedSprites: bakedPaintCensus(nodeId, 'sprite'),
    chunks: bakedChunkCensus(nodeId),
    retired: retiredDecalCensus(),
    pendingSplatZeros: pendingSplatZeroCensus(),
  }),
}

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

/** Drip pool size — one InstancedMesh of wall-plane streak quads. Halved
 * in phase 11 (owner: "something simpler" — coverage is the point). */
export const DRIP_CAP = 24
/** A cell must already carry this much strength for a re-coat to run. */
export const DRIP_STRENGTH_GATE = 0.75
/** Chance a qualifying cell sheds a drip (phase 11: halved). */
export const DRIP_P = 0.12
/** Hard cap on drips born per spray tick (phase 11: halved). */
export const DRIP_MAX_PER_TICK = 1
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
/** Wet-coat tint per palette entry — the palette color pushed a touch
 * darker + richer, precomputed once (module lifetime, like the drip
 * texture). stepDrips used to re-parse the hex STRING per growing drip per
 * frame (`Color.set(string)` runs setStyle's regex — a per-frame
 * allocation) for a value that is constant per palette slot. */
const DRIP_TINTS: readonly Color[] = PAINT_PALETTE.map((p) =>
  new Color(p.hex).offsetHSL(0, 0.05, -0.06),
)

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
    // Wet coat: the precomputed darker+richer palette tint (DRIP_TINTS).
    mesh.setColorAt(i, DRIP_TINTS[s.color]!)
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

// ── Splat sprites (phase 10 — the ROUND paint read on voxel surfaces) ─────
//
// The cell-tint ledger colors whole voxels — inherently square. Every spray
// tick that coats a voxelized target also stamps ONE round textured quad
// flat on the hit face, so sprayed paint reads as overlapping aerosol
// circles near AND far. Pool + texture follow the drip idiom exactly: a
// fixed InstancedMesh ring (DynamicDrawUsage, every slot's color primed
// before the first draw), one module-cached white splat texture with an
// irregular rim, palette per instance via instanceColor. Purely visual —
// persistence stays with the ledger + decal votes.

/** Sprite pool size — one InstancedMesh of face-flat splat quads. */
export const SPLAT_SPRITE_CAP = 192
/** Quad lift off the hit surface (m) — clears the voxel skin without
 * reading as floating (6–8 mm band; polygonOffset does the rest). */
export const SPLAT_SPRITE_LIFT = 0.007
/** No new sprite within this × radius of the node's previous same-color
 * sprite — the held-trigger economy rule the decal lane budgets by. Stays
 * under SWATH_SPACING_FRAC, so economy never opens a gap in a swath. */
export const SPLAT_COALESCE_FRAC = 0.3
/** Scale jitter band — collapsed to 1 in phase 11: a solid disc's quad
 * side IS the true 2 × radius diameter (uniform coverage, no ragged
 * swath edges). The splatSpriteSize seam stays for the pinned tests. */
export const SPLAT_SPRITE_JITTER_MIN = 1
export const SPLAT_SPRITE_JITTER_MAX = 1
/** Layered grids (wall/slab/roof): the FACE (thickness axis) wins the
 * quad orientation whenever the spray crosses it by at least this much —
 * a glancing pass down a wall still stamps flat on the drywall. */
export const SPLAT_FACE_BIAS = 0.2

/** Quad side (m): 2 × splat radius, jittered by `rand` ∈ [0, 1] across the
 * SPLAT_SPRITE_JITTER band (rand 0.5 = the exact diameter). Pure. */
export function splatSpriteSize(radius: number, rand: number): number {
  return 2 * radius * (SPLAT_SPRITE_JITTER_MIN + (SPLAT_SPRITE_JITTER_MAX - SPLAT_SPRITE_JITTER_MIN) * rand)
}

/** A new stamp RETIRES older DIFFERENT-color sprites parked within this ×
 * radius of its center on the same node + facing (the blink fix): three
 * sorts transparent render items back-to-front by camera depth with ties
 * broken by object id — coplanar two-color stacks with depthWrite=false
 * have no stable "newer wins", so overlaps flickered between coats as the
 * camera moved (and the 192-ring wrap even put OLD sprites over new ones
 * within the pool's fixed instance draw order). Retiring the covered coat
 * is deterministic: the cell LEDGER keeps the coat truth, the pool sheds
 * dead quads. */
export const SPLAT_COVER_FRAC = 0.6

/**
 * Pure cover scan — exported for tests. Which of the node's live sprites a
 * fresh stamp at (x,y,z) retires: DIFFERENT color, center within
 * SPLAT_COVER_FRAC × radius (3D), and the SAME facing (normal dot > 0.5 —
 * the two faces of a 0.12 m wall share a nodeId and can sit closer than
 * the cover distance; painting one face must never strip the other). */
export function coveredSplatIndices(
  slots: readonly SplatSlot[],
  indices: readonly number[],
  x: number,
  y: number,
  z: number,
  nx: number,
  ny: number,
  nz: number,
  color: number,
  radius: number,
): number[] {
  const max = SPLAT_COVER_FRAC * radius
  const max2 = max * max
  const out: number[] = []
  for (const index of indices) {
    const s = slots[index]
    if (!s || !s.alive || s.color === color) continue
    if (s.nx * nx + s.ny * ny + s.nz * nz <= 0.5) continue
    const dx = s.x - x
    const dy = s.y - y
    const dz = s.z - z
    if (dx * dx + dy * dy + dz * dz <= max2) out.push(index)
  }
  return out
}

/** Pure coalescing rule: stamp unless the node's PREVIOUS sprite has the
 * same color and sits closer than SPLAT_COALESCE_FRAC × radius (3D). */
export function shouldStampSplat(
  prev: { x: number; y: number; z: number; color: number } | undefined,
  x: number,
  y: number,
  z: number,
  color: number,
  radius: number,
): boolean {
  if (!prev || prev.color !== color) return true
  const dx = x - prev.x
  const dy = y - prev.y
  const dz = z - prev.z
  const min = SPLAT_COALESCE_FRAC * radius
  return dx * dx + dy * dy + dz * dz >= min * min
}

/** The grid fields the sprite-normal math reads (VoxelGridData subset). */
type SplatGridFrame = {
  q: VoxelBasis
  nx: number
  ny: number
  nz: number
  cellX: number
  cellY: number
  cellZ: number
}

/** Grid-frame scratch for splatNormalFor (module temp — zero allocs). */
const _splatAxis = { x: 0, y: 0, z: 0 }

/**
 * The face normal a sprite lies flat against. raycastVoxelTargets hands
 * back no face, so derive it: rotate −shotDirection into the GRID frame
 * (voxel faces are axis-aligned there — yawed walls and pitched roof
 * planes included), snap to an axis, rotate back out to world. Layered
 * kinds (wall/slab/roof) bias the pick to the THICKNESS axis — smallest
 * physical extent, destruction's thicknessAxisOf rule — whenever the spray
 * crosses it by SPLAT_FACE_BIAS; plain volumes take the raw dominant axis
 * (the mist-cone idiom). Pure — writes a unit world vector into `out`.
 */
export function splatNormalFor(
  grid: SplatGridFrame,
  kind: string,
  dirX: number,
  dirY: number,
  dirZ: number,
  out: { x: number; y: number; z: number },
): void {
  rotateByBasis(grid.q, -dirX, -dirY, -dirZ, _splatAxis)
  const ax = Math.abs(_splatAxis.x)
  const ay = Math.abs(_splatAxis.y)
  const az = Math.abs(_splatAxis.z)
  let axis: 0 | 1 | 2 = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2
  if (kind !== 'volume') {
    let t: 0 | 1 | 2 = 0
    let extent = grid.nx * grid.cellX
    if (grid.ny * grid.cellY < extent) {
      t = 1
      extent = grid.ny * grid.cellY
    }
    if (grid.nz * grid.cellZ < extent) t = 2
    const along = t === 0 ? ax : t === 1 ? ay : az
    if (along >= SPLAT_FACE_BIAS) axis = t
  }
  const component = axis === 0 ? _splatAxis.x : axis === 1 ? _splatAxis.y : _splatAxis.z
  const sign = component >= 0 ? 1 : -1
  rotateByBasisInverse(grid.q, axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0, out)
}

export type SplatSlot = {
  alive: boolean
  /** Slot changed since the frame writer last uploaded it. */
  dirty: boolean
  nodeId: string
  /** Quad center, already lifted off the surface along the normal. */
  x: number
  y: number
  z: number
  /** Unit face normal (world) — the quad's +Z. */
  nx: number
  ny: number
  nz: number
  /** Roll around the normal (rad) — stamp variety. */
  roll: number
  /** Quad side length (m) — jittered 2 × splat radius. */
  size: number
  color: number
}

const splatSlots: SplatSlot[] = Array.from({ length: SPLAT_SPRITE_CAP }, () => ({
  alive: false,
  dirty: false,
  nodeId: '',
  x: 0,
  y: 0,
  z: 0,
  nx: 0,
  ny: 0,
  nz: 1,
  roll: 0,
  size: 0.3,
  color: 0,
}))
let splatCursor = 0
/** Any slot dirty — the frame writer idles at one boolean. */
let splatsDirty = false
/** nodeId → slot indices in stamp order (drop/collapse eviction). */
const nodeSplats = new Map<string, number[]>()
/** Shared empty list — the cover scan on a node with no sprites yet. */
const _noSplats: number[] = []
/** nodeId → the node's LAST stamped sprite (the coalescing rule).
 * Records are reused in place — one allocation per node per session. */
const lastSplatByNode = new Map<string, { x: number; y: number; z: number; color: number }>()

/** Live sprite counts (QA/tests) — total and for one node. */
export function splatSpriteCensus(nodeId?: string): number {
  if (nodeId !== undefined) return nodeSplats.get(nodeId)?.length ?? 0
  let n = 0
  for (const s of splatSlots) if (s.alive) n++
  return n
}

/** The live slots (tests/debug) — read-only by contract. */
export function splatSpriteSlots(): readonly SplatSlot[] {
  return splatSlots
}

/**
 * Slots freed by a BAKE, waiting for their zero-scale write.
 *
 * A baked quad must never blink out. Freeing the slot zeroes its instance
 * matrix in the very next frame loop, but the chunk mesh that took the quad
 * over only reaches the scene on the uSES commit AFTER this frame's render —
 * so zeroing immediately leaves one frame with neither. The zero is queued
 * instead and drained from PaintTool's frame top (the retired-geometry
 * idiom): worst case a quad is drawn twice for one frame, never zero times.
 */
const pendingSplatZeros: number[] = []

/** Mark queued slots for their zero write — the chunk that replaced them has
 * been in the scene for a frame by now. Slots re-claimed in the meantime are
 * alive again and skipped. */
export function flushPendingSplatZeros(): void {
  if (pendingSplatZeros.length === 0) return
  for (const index of pendingSplatZeros) {
    const s = splatSlots[index]!
    if (s.alive) continue
    s.dirty = true
    splatsDirty = true
  }
  pendingSplatZeros.length = 0
}

/** Queued-but-unzeroed baked slots (QA/tests). */
export function pendingSplatZeroCensus(): number {
  return pendingSplatZeros.length
}

function releaseSplatSlot(index: number, defer = false): void {
  const s = splatSlots[index]!
  if (!s.alive) return
  s.alive = false
  if (defer) {
    pendingSplatZeros.push(index)
  } else {
    s.dirty = true
    splatsDirty = true
  }
  const list = nodeSplats.get(s.nodeId)
  if (list) {
    const at = list.indexOf(index)
    if (at >= 0) list.splice(at, 1)
    if (list.length === 0) nodeSplats.delete(s.nodeId)
  }
}

/** Evict every sprite on `nodeId` — its target dropped (builder Z-undo) or
 * fully collapsed; drainPaintTints spots both states each frame (a no-op
 * once the node's list is gone). Also forgets the coalescing record so a
 * REBUILT node's first tick stamps again. */
export function releaseNodeSplats(nodeId: string): void {
  lastSplatByNode.delete(nodeId)
  // The node's BAKED quads go with the live ones — they were clipped to a
  // surface that no longer exists.
  releaseNodeChunks(nodeId, 'sprite')
  const indices = nodeSplats.get(nodeId)
  if (!indices || indices.length === 0) return
  for (const index of [...indices]) releaseSplatSlot(index)
}

/** Session teardown / SplatsLayer (re)mount — same lifetime as the drips. */
export function resetPaintSplats(): void {
  for (const s of splatSlots) {
    s.alive = false
    s.dirty = false
  }
  splatCursor = 0
  splatsDirty = false
  pendingSplatZeros.length = 0
  nodeSplats.clear()
  lastSplatByNode.clear()
  releaseAllChunks('sprite')
  // Mount/unmount lane: no chunk mesh survives this commit, dispose now.
  flushRetiredDecalGeometries()
}

/**
 * Claim the next ring slot for a round splat on a voxel surface (the
 * 193rd sprite reuses the first). Returns false when the coalescing rule
 * swallowed the stamp — the CELL ledger still took the coat either way.
 * `scaleRand`/`roll` default to Math.random draws; tests pin them.
 */
export function stampSplat(
  nodeId: string,
  x: number,
  y: number,
  z: number,
  nx: number,
  ny: number,
  nz: number,
  radius: number,
  color: number,
  scaleRand: number = Math.random(),
  roll: number = Math.random() * Math.PI * 2,
): boolean {
  const prev = lastSplatByNode.get(nodeId)
  if (!shouldStampSplat(prev, x, y, z, color, radius)) return false
  // BLINK FIX: this stamp covers the node's older different-color sprites
  // at ~the same spot on the same facing — retire them (deterministic
  // "newer coat wins"; the cell ledger keeps the coat truth). Linear over
  // the node's live list, which the 192-ring bounds.
  const covered = coveredSplatIndices(
    splatSlots,
    nodeSplats.get(nodeId) ?? _noSplats,
    x,
    y,
    z,
    nx,
    ny,
    nz,
    color,
    radius,
  )
  for (const old of covered) releaseSplatSlot(old)
  const index = claimSplatSlot()
  const s = splatSlots[index]!
  s.alive = true
  s.dirty = true
  s.nodeId = nodeId
  s.x = x + nx * SPLAT_SPRITE_LIFT
  s.y = y + ny * SPLAT_SPRITE_LIFT
  s.z = z + nz * SPLAT_SPRITE_LIFT
  s.nx = nx
  s.ny = ny
  s.nz = nz
  s.roll = roll
  s.size = splatSpriteSize(radius, scaleRand)
  s.color = color
  let list = nodeSplats.get(nodeId)
  if (!list) {
    list = []
    nodeSplats.set(nodeId, list)
  }
  list.push(index)
  if (prev) {
    prev.x = x
    prev.y = y
    prev.z = z
    prev.color = color
  } else {
    lastSplatByNode.set(nodeId, { x, y, z, color })
  }
  splatsDirty = true
  return true
}

/** ONE cached AIRBRUSH stamp texture — white (instanceColor / the decal
 * material color carries the palette). The games-airbrush read the owner
 * asked for: fully opaque out to SPLAT_CORE_FRAC of the radius, then a
 * SMOOTHSTEP alpha falloff to 0 at the rim, with speckle grain inside the
 * falloff band only (overspray dust — erased pinholes + faint flecks,
 * denser toward the rim, every speck inside the disc). The disc's diameter
 * spans the whole quad, so the stamp truly is 2 × splatRadiusAt(distance)
 * wide. 256², module lifetime (the dust idiom); the decal lane shares it. */
let splatTexture: CanvasTexture | null = null
function getSplatTexture(): CanvasTexture | null {
  if (splatTexture) return splatTexture
  if (typeof document === 'undefined') return null
  const size = 256
  const c = size / 2
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const g = canvas.getContext('2d')
  if (!g) return null
  // Opaque core, then smoothstep-shaped stops across the falloff band —
  // canvas gradients interpolate linearly between stops, so 8 stops trace
  // the curve (no visible banding at 256²).
  const fill = g.createRadialGradient(c, c, 0, c, c, c)
  fill.addColorStop(0, 'rgba(255,255,255,1)')
  fill.addColorStop(SPLAT_CORE_FRAC, 'rgba(255,255,255,1)')
  const stops = 8
  for (let i = 1; i < stops; i++) {
    const t = i / stops
    const a = 1 - t * t * (3 - 2 * t) // 1 − smoothstep(t)
    fill.addColorStop(SPLAT_CORE_FRAC + (1 - SPLAT_CORE_FRAC) * t, `rgba(255,255,255,${a.toFixed(4)})`)
  }
  fill.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = fill
  g.fillRect(0, 0, size, size)
  // Overspray grain, pass 1: pinholes ERASED inside the falloff band,
  // larger + stronger toward the rim (the dusty dissolve).
  g.fillStyle = '#ffffff'
  g.globalCompositeOperation = 'destination-out'
  for (let i = 0; i < 340; i++) {
    const t = Math.sqrt(Math.random()) // bias the dust toward the rim
    const speck = 0.8 + 1.9 * t * Math.random()
    const d = Math.min((SPLAT_CORE_FRAC + (1 - SPLAT_CORE_FRAC) * t) * c, c - speck)
    const angle = Math.random() * Math.PI * 2
    g.globalAlpha = 0.25 + 0.55 * t
    g.beginPath()
    g.arc(c + Math.cos(angle) * d, c + Math.sin(angle) * d, speck, 0, Math.PI * 2)
    g.fill()
  }
  // Pass 2: faint positive flecks over the outer half of the band — dust
  // that LANDED, breaking the gradient's evenness without ever leaving
  // the disc.
  g.globalCompositeOperation = 'source-over'
  for (let i = 0; i < 150; i++) {
    const t = 0.5 + 0.5 * Math.random()
    const speck = 0.6 + 1.0 * Math.random()
    const d = Math.min((SPLAT_CORE_FRAC + (1 - SPLAT_CORE_FRAC) * t) * c, c - speck)
    const angle = Math.random() * Math.PI * 2
    g.globalAlpha = 0.12 + 0.22 * Math.random()
    g.beginPath()
    g.arc(c + Math.cos(angle) * d, c + Math.sin(angle) * d, speck, 0, Math.PI * 2)
    g.fill()
  }
  g.globalAlpha = 1
  splatTexture = new CanvasTexture(canvas)
  return splatTexture
}

const SPLAT_ZERO = new Matrix4().makeScale(0, 0, 0)
const SPLAT_FORWARD = new Vector3(0, 0, 1)
const _splatNormalV = new Vector3()
const _splatQuat = new Quaternion()
const _splatRoll = new Quaternion()
const _splatPos = new Vector3()
const _splatScale = new Vector3()
const _splatMatrix = new Matrix4()
const _splatWhite = new Color('#ffffff')
/** sprayPaint's splatNormalFor out — module temp, zero per-tick allocs. */
const _splatN = { x: 0, y: 0, z: 0 }
/** Flat palette tints for sprites (working color space, precomputed once —
 * the DRIP_TINTS rule: never re-parse a hex string in the frame path). */
const SPLAT_TINTS: readonly Color[] = PAINT_PALETTE.map((p) => new Color(p.hex))

/** Upload changed slots: compose the face-flat quad (align +Z to the
 * normal, roll around it), zero-scale evicted slots. Idles at one boolean;
 * dirty frames touch only dirty slots. Zero allocations. */
function stepSplats(mesh: InstancedMesh): void {
  if (!splatsDirty) return
  splatsDirty = false
  for (let i = 0; i < SPLAT_SPRITE_CAP; i++) {
    const s = splatSlots[i]!
    if (!s.dirty) continue
    s.dirty = false
    if (!s.alive) {
      mesh.setMatrixAt(i, SPLAT_ZERO)
      continue
    }
    _splatNormalV.set(s.nx, s.ny, s.nz)
    _splatQuat.setFromUnitVectors(SPLAT_FORWARD, _splatNormalV)
    _splatRoll.setFromAxisAngle(SPLAT_FORWARD, s.roll)
    _splatQuat.multiply(_splatRoll)
    _splatPos.set(s.x, s.y, s.z)
    _splatScale.set(s.size, s.size, 1)
    _splatMatrix.compose(_splatPos, _splatQuat, _splatScale)
    mesh.setMatrixAt(i, _splatMatrix)
    mesh.setColorAt(i, SPLAT_TINTS[s.color] ?? SPLAT_TINTS[0]!)
  }
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
}

/**
 * The sprite pool renderer — mounted by PaintTool next to DripsLayer. One
 * InstancedMesh of SPLAT_SPRITE_CAP quads over the cached splat texture;
 * every slot's color is primed before the first draw (the debris idiom — a
 * WebGPU pipeline compiled without instanceColor would ignore every later
 * setColorAt). Lit standard material so stamps sit in the wall's light
 * like the decal splats do; polygonOffset −3 layers them over the voxel
 * skin (craters −2, decals −4), depthWrite off so overlaps blend.
 */
function SplatsLayer() {
  const meshRef = useRef<InstancedMesh>(null!)
  const texture = getSplatTexture()
  useLayoutEffect(() => {
    const mesh = meshRef.current
    if (!mesh) return
    mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    mesh.frustumCulled = false
    for (let i = 0; i < SPLAT_SPRITE_CAP; i++) {
      mesh.setMatrixAt(i, SPLAT_ZERO)
      mesh.setColorAt(i, _splatWhite)
    }
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    resetPaintSplats()
    return resetPaintSplats
  }, [])
  useFrame(() => {
    const mesh = meshRef.current
    if (mesh) stepSplats(mesh)
  })
  if (!texture) return null
  return (
    <instancedMesh args={[undefined, undefined, SPLAT_SPRITE_CAP]} ref={meshRef} userData={{ __boots: true }}>
      <planeGeometry />
      <meshStandardMaterial
        depthWrite={false}
        map={texture}
        polygonOffset
        polygonOffsetFactor={-3}
        polygonOffsetUnits={-3}
        roughness={0.55}
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
  /** Monotonic stamp serial → the mesh's renderOrder (the blink fix):
   * three sorts transparent items by renderOrder BEFORE camera depth, and
   * each decal's depth key is its own bounding-sphere center — coplanar
   * two-color overlaps flipped draw order as the camera moved. The serial
   * pins "newer coat draws later" deterministically. */
  order: number
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
  order: 0,
}))
let decalCursor = 0
/** Monotonic decal stamp serial (module lifetime — plain number, never
 * recycled; renderOrder only needs relative order among live decals). */
let decalStampOrder = 0

/** Alive renderOrders for one node in spawn order (tests/QA). */
export function decalRenderOrders(nodeId: string): number[] {
  const indices = nodeDecals.get(nodeId)
  if (!indices) return []
  return indices.filter((i) => decalSlots[i]!.alive).map((i) => decalSlots[i]!.order)
}
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

/** Evicted decal geometries awaiting disposal. releaseSlot runs inside the
 * spray tick while the slot's `<mesh dispose={null}>` is still mounted for
 * THIS frame's render — the uSES re-render only flushes at the microtask
 * boundary, after R3F's same-rAF gl.render. Disposing right there makes
 * three re-register the freed geometry on that last draw (WebGLGeometries
 * .get re-uploads; bindingStates keeps a VAO under the never-reused
 * geometry id with no dispose event left to clear it — a GL leak per
 * eviction). Dispose is DEFERRED to the next PaintTool frame, after the
 * remount has actually dropped the mesh. */
const retiredDecalGeometries: BufferGeometry[] = []

/** Retired-but-undisposed geometries (QA/tests). */
export function retiredDecalCensus(): number {
  return retiredDecalGeometries.length
}

/** Dispose everything the ring evicted since the last flush — called at
 * the top of PaintTool's frame (the evicting render is over by then) and
 * from resetPaintDecals (mount/unmount: no live mesh references remain). */
export function flushRetiredDecalGeometries(): void {
  for (const geometry of retiredDecalGeometries) geometry.dispose()
  retiredDecalGeometries.length = 0
}

function releaseSlot(index: number): void {
  const s = decalSlots[index]!
  if (!s.alive) return
  s.alive = false
  if (s.geometry) retiredDecalGeometries.push(s.geometry)
  s.geometry = null
  const list = nodeDecals.get(s.nodeId)
  if (list) {
    const at = list.indexOf(index)
    if (at >= 0) list.splice(at, 1)
    if (list.length === 0) nodeDecals.delete(s.nodeId)
  }
}

// ── Baked paint: the rings PROMOTE, they never throw paint away ────────────
//
// The owner's report: "when i spray too long it starts to remove older spray".
// Both splat pools are fixed rings — DECAL_CAP/DECAL_NODE_CAP clipped
// DecalGeometry slots on pristine hosts, SPLAT_SPRITE_CAP quads on voxel
// skins — and a ring stays bounded one of exactly two ways: DROP the oldest
// stamp, or PROMOTE it into something that costs O(1) more. It dropped, so the
// 65th splat on a wall deleted that wall's 1st and a long stroke ate its own
// beginning.
//
// Promotion is a MERGE, not a re-render. Under pressure a node's live stamps
// are merged — in same-colour runs, in stamp order — into one permanent
// BufferGeometry per run, and the slots free. The pixels are the same pixels:
// the very same clipped triangles (or the very same quads), the same
// per-colour material over the same airbrush texture, drawn in the same order.
//   · A decal chunk inherits the stamp-serial interval it replaces, so the
//     blink fix ("newer coat draws later") holds across the bake: a chunk's
//     stamps form one contiguous, increasing interval, and consolidation only
//     ever merges into the node's NEWEST chunk.
//   · A sprite chunk draws UNDER the live pool (renderOrder below zero, in
//     bake order among chunks). Every baked quad is older than every live one,
//     which is precisely the layering the live cover-scan used to get by
//     evicting the covered quad.
// What changes is the cost: N stamps on one wall are ⌈N / DECAL_BAKE_MAX⌉ draw
// calls instead of N, the ring stays small and hot, and nothing is ever lost.
//
// Chunks are session-scoped like the rings (resetPaint* frees them, through
// the same deferred-disposal flush) and they carry their stamp geometry
// (x, y, z, radius) forward — so the two consumers that reach past the rings
// still see every stamp: paint-keep's area-weighted votes, and the target-live
// conversion into the cell ledger.

/** Stamps merged into one chunk before a new chunk starts. Bounds the draw
 * calls per node (⌈stamps / this⌉) AND the per-bake merge cost (a bake
 * re-merges at most this many stamps' worth of triangles — a fraction of a
 * millisecond, once per this-many stamps). */
export const DECAL_BAKE_MAX = 512

/** Baked sprite chunks draw before the live sprite pool (renderOrder 0), in
 * bake order among themselves. Far enough below zero that the running chunk
 * serial can never climb out of the band. */
const SPRITE_CHUNK_ORDER = -1e6

type PaintChunkLayer = 'decal' | 'sprite'

type PaintChunk = {
  /** React key — kept when a chunk consolidates in place (no remount). */
  id: number
  layer: PaintChunkLayer
  color: number
  /** Merged world-space geometry; REPLACED, never mutated, on consolidation. */
  geometry: BufferGeometry
  /** Transparent draw order (see the layer notes above). */
  order: number
  /** (x, y, z, radius) per merged stamp — the area votes and the ledger
   * conversion read this, exactly as they read a live slot. Float64 (not the
   * geometry's Float32): these are CPU-only and they must reproduce a live
   * slot's numbers EXACTLY, or a promoted coat could save a different colour
   * than the same stroke left unpromoted. */
  stamps: Float64Array
  count: number
}

/** nodeId → the node's baked chunks, oldest first. */
const nodeChunks = new Map<string, PaintChunk[]>()
let chunkSerial = 0

/** Baked STAMPS — the paint that used to be evicted. Total, per node, and/or
 * per layer (QA + tests). */
export function bakedPaintCensus(nodeId?: string, layer?: PaintChunkLayer): number {
  let n = 0
  if (nodeId !== undefined) {
    const list = nodeChunks.get(nodeId)
    if (list) for (const chunk of list) if (!layer || chunk.layer === layer) n += chunk.count
    return n
  }
  for (const list of nodeChunks.values()) {
    for (const chunk of list) if (!layer || chunk.layer === layer) n += chunk.count
  }
  return n
}

/** Baked chunk MESHES — the draw calls promotion costs (QA + tests). */
export function bakedChunkCensus(nodeId?: string, layer?: PaintChunkLayer): number {
  let n = 0
  if (nodeId !== undefined) {
    const list = nodeChunks.get(nodeId)
    if (list) for (const chunk of list) if (!layer || chunk.layer === layer) n++
    return n
  }
  for (const list of nodeChunks.values()) {
    for (const chunk of list) if (!layer || chunk.layer === layer) n++
  }
  return n
}

/** The baked stamps of one node+layer in bake order (tests/QA — plain copies
 * of the (x, y, z, radius) tuples, never the live buffers). */
export function bakedStamps(
  nodeId: string,
  layer: PaintChunkLayer = 'decal',
): { x: number; y: number; z: number; radius: number; color: number }[] {
  const out: { x: number; y: number; z: number; radius: number; color: number }[] = []
  for (const chunk of nodeChunks.get(nodeId) ?? []) {
    if (chunk.layer !== layer) continue
    for (let i = 0; i < chunk.count; i++) {
      out.push({
        x: chunk.stamps[i * 4]!,
        y: chunk.stamps[i * 4 + 1]!,
        z: chunk.stamps[i * 4 + 2]!,
        radius: chunk.stamps[i * 4 + 3]!,
        color: chunk.color,
      })
    }
  }
  return out
}

/** The draw orders of one node+layer's chunks, in bake order (tests/QA — the
 * blink fix's invariant is that these keep climbing and stay under the live
 * stamps that came after them). */
export function bakedChunkOrders(nodeId: string, layer: PaintChunkLayer = 'decal'): number[] {
  const out: number[] = []
  for (const chunk of nodeChunks.get(nodeId) ?? []) if (chunk.layer === layer) out.push(chunk.order)
  return out
}

/**
 * File a merged run under its node. It joins the node's NEWEST chunk when
 * that chunk shares its layer and colour and still has room — which keeps a
 * single-colour spray at ONE growing mesh per DECAL_BAKE_MAX stamps — and
 * starts a new chunk otherwise. Only ever merging into the newest chunk is
 * what keeps every chunk's stamp interval contiguous, and therefore the draw
 * order exact.
 */
function pushChunk(
  layer: PaintChunkLayer,
  nodeId: string,
  color: number,
  geometry: BufferGeometry,
  order: number,
  stamps: Float64Array,
  count: number,
): void {
  let list = nodeChunks.get(nodeId)
  if (!list) {
    list = []
    nodeChunks.set(nodeId, list)
  }
  const last = list[list.length - 1]
  if (last && last.layer === layer && last.color === color && last.count + count <= DECAL_BAKE_MAX) {
    const merged = mergeGeometries([last.geometry, geometry], false)
    if (merged) {
      // The old chunk's geometry is still mounted for THIS frame's render and
      // the fresh input will never render at all — both go through the
      // deferred flush, never dispose() here (see retiredDecalGeometries).
      retiredDecalGeometries.push(last.geometry, geometry)
      const grown = new Float64Array(last.stamps.length + stamps.length)
      grown.set(last.stamps)
      grown.set(stamps, last.stamps.length)
      last.geometry = merged
      last.stamps = grown
      last.count += count
      if (layer === 'decal') last.order = order
      return
    }
  }
  const id = ++chunkSerial
  list.push({
    id,
    layer,
    color,
    geometry,
    // Sprite chunks live below the live pool; decal chunks keep the serial
    // interval of the stamps they replace.
    order: layer === 'sprite' ? SPRITE_CHUNK_ORDER + id : order,
    stamps,
    count,
  })
}

/** Free a node's chunks (one layer, or all of them) — the surface they were
 * clipped against is gone or has been taken over by the cell ledger. Returns
 * the number of stamps freed. Geometry disposal is deferred like the ring's. */
function releaseNodeChunks(nodeId: string, layer?: PaintChunkLayer): number {
  const list = nodeChunks.get(nodeId)
  if (!list || list.length === 0) return 0
  const kept: PaintChunk[] = []
  let freed = 0
  for (const chunk of list) {
    if (layer && chunk.layer !== layer) {
      kept.push(chunk)
      continue
    }
    retiredDecalGeometries.push(chunk.geometry)
    freed += chunk.count
  }
  if (kept.length === list.length) return 0
  if (kept.length === 0) nodeChunks.delete(nodeId)
  else nodeChunks.set(nodeId, kept)
  return freed
}

/** Free every chunk of a layer (session reset). */
function releaseAllChunks(layer?: PaintChunkLayer): void {
  for (const nodeId of [...nodeChunks.keys()]) releaseNodeChunks(nodeId, layer)
}

/**
 * Promote a node's live decals into permanent chunks: same-colour runs merge
 * in spawn order, then those slots free. Returns how many stamps were baked.
 * Cheap and idempotent on a node with nothing live.
 */
export function bakeNodeDecals(nodeId: string): number {
  const indices = nodeDecals.get(nodeId)
  if (!indices || indices.length === 0) return 0
  const live: number[] = []
  for (const index of indices) if (decalSlots[index]!.alive) live.push(index)
  let baked = 0
  let run: number[] = []
  const flushRun = (): void => {
    if (run.length === 0) return
    // A refused merge (unseen in practice — every DecalGeometry carries the
    // same three attributes) leaves the run LIVE rather than dropping paint.
    if (bakeDecalRun(nodeId, run)) {
      for (const index of run) releaseSlot(index)
      baked += run.length
    }
    run = []
  }
  for (const index of live) {
    if (decalSlots[index]!.color !== decalSlots[run[0] ?? index]!.color) flushRun()
    run.push(index)
  }
  flushRun()
  if (baked > 0) emitDecals()
  return baked
}

/** Merge one same-colour run into a chunk. False = the merge refused and the
 * caller must keep the slots. */
function bakeDecalRun(nodeId: string, run: readonly number[]): boolean {
  const parts: BufferGeometry[] = []
  const stamps = new Float64Array(run.length * 4)
  let order = 0
  for (let k = 0; k < run.length; k++) {
    const slot = decalSlots[run[k]!]!
    if (!slot.geometry) return false
    parts.push(slot.geometry)
    stamps[k * 4] = slot.x
    stamps[k * 4 + 1] = slot.y
    stamps[k * 4 + 2] = slot.z
    stamps[k * 4 + 3] = slot.radius
    if (slot.order > order) order = slot.order
  }
  const geometry = mergeGeometries(parts, false)
  if (!geometry) return false
  pushChunk('decal', nodeId, decalSlots[run[0]!]!.color, geometry, order, stamps, run.length)
  return true
}

/**
 * A free decal ring slot. Under pressure the ring BAKES instead of evicting:
 * a node at its quota promotes its own stamps, and a cursor landing on another
 * node's live stamp promotes THAT node. Either way slots come free and no
 * paint is lost.
 */
function claimDecalSlot(nodeId: string): number {
  const list = nodeDecals.get(nodeId)
  if (list && list.length >= DECAL_NODE_CAP) bakeNodeDecals(nodeId)
  for (let tries = 0; tries < DECAL_CAP; tries++) {
    const index = decalCursor
    decalCursor = (decalCursor + 1) % DECAL_CAP
    if (!decalSlots[index]!.alive) return index
    bakeNodeDecals(decalSlots[index]!.nodeId)
    if (!decalSlots[index]!.alive) return index
  }
  // Unreachable (a bake frees its node's whole quota) — but coat the wall
  // rather than refuse the trigger.
  const index = decalCursor
  decalCursor = (decalCursor + 1) % DECAL_CAP
  releaseSlot(index)
  return index
}

// ── Sprite quads bake the same way (the pool is the same kind of ring) ─────

/** PlaneGeometry(1,1)'s own vertex order, winding (0,2,1 / 2,3,1) and UVs, so
 * a baked quad is the SAME two triangles facing the same way as the instance
 * it replaces. */
const SPRITE_QUAD_TRIS = [0, 2, 1, 2, 3, 1] as const
const SPRITE_QUAD_X = [-0.5, 0.5, -0.5, 0.5] as const
const SPRITE_QUAD_Y = [0.5, 0.5, -0.5, -0.5] as const
const SPRITE_QUAD_U = [0, 1, 0, 1] as const
const SPRITE_QUAD_V = [1, 1, 0, 0] as const
const _bakeQuat = new Quaternion()
const _bakeRoll = new Quaternion()
const _bakeNormal = new Vector3()
const _bakeCorner = new Vector3()

/**
 * A run of sprite slots → one world-space quad soup, composed exactly the way
 * stepSplats composes an instance matrix (align +Z to the face normal, roll
 * around it, scale by the stamp size), so the baked quads land on the same
 * pixels the instances did.
 */
function spriteQuadGeometry(run: readonly number[]): BufferGeometry {
  const position = new Float32Array(run.length * 18)
  const normal = new Float32Array(run.length * 18)
  const uv = new Float32Array(run.length * 12)
  for (let k = 0; k < run.length; k++) {
    const s = splatSlots[run[k]!]!
    _bakeNormal.set(s.nx, s.ny, s.nz)
    _bakeQuat.setFromUnitVectors(SPLAT_FORWARD, _bakeNormal)
    _bakeRoll.setFromAxisAngle(SPLAT_FORWARD, s.roll)
    _bakeQuat.multiply(_bakeRoll)
    for (let t = 0; t < 6; t++) {
      const corner = SPRITE_QUAD_TRIS[t]!
      _bakeCorner.set(SPRITE_QUAD_X[corner]! * s.size, SPRITE_QUAD_Y[corner]! * s.size, 0)
      _bakeCorner.applyQuaternion(_bakeQuat)
      const at = (k * 6 + t) * 3
      position[at] = s.x + _bakeCorner.x
      position[at + 1] = s.y + _bakeCorner.y
      position[at + 2] = s.z + _bakeCorner.z
      normal[at] = s.nx
      normal[at + 1] = s.ny
      normal[at + 2] = s.nz
      const uvAt = (k * 6 + t) * 2
      uv[uvAt] = SPRITE_QUAD_U[corner]!
      uv[uvAt + 1] = SPRITE_QUAD_V[corner]!
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(position, 3))
  geometry.setAttribute('normal', new BufferAttribute(normal, 3))
  geometry.setAttribute('uv', new BufferAttribute(uv, 2))
  return geometry
}

/**
 * Promote a node's live sprite quads into permanent chunks (same-colour runs,
 * stamp order), then free the slots — with the zero-write DEFERRED so the
 * quad is never missing for a frame. Returns how many quads were baked.
 */
export function bakeNodeSplats(nodeId: string): number {
  const indices = nodeSplats.get(nodeId)
  if (!indices || indices.length === 0) return 0
  const live: number[] = []
  for (const index of indices) if (splatSlots[index]!.alive) live.push(index)
  let baked = 0
  let run: number[] = []
  const flushRun = (): void => {
    if (run.length === 0) return
    const stamps = new Float64Array(run.length * 4)
    for (let k = 0; k < run.length; k++) {
      const s = splatSlots[run[k]!]!
      stamps[k * 4] = s.x
      stamps[k * 4 + 1] = s.y
      stamps[k * 4 + 2] = s.z
      stamps[k * 4 + 3] = s.size * 0.5
    }
    pushChunk('sprite', nodeId, splatSlots[run[0]!]!.color, spriteQuadGeometry(run), 0, stamps, run.length)
    for (const index of run) releaseSplatSlot(index, true)
    baked += run.length
    run = []
  }
  for (const index of live) {
    if (splatSlots[index]!.color !== splatSlots[run[0] ?? index]!.color) flushRun()
    run.push(index)
  }
  flushRun()
  // The chunk meshes render through PaintDecals' store — nudge it, exactly as
  // a decal spawn does.
  if (baked > 0) emitDecals()
  return baked
}

/**
 * A free sprite slot. Like the decal ring, the pool bakes the node that owns
 * the slot under the cursor instead of deleting a live quad.
 */
function claimSplatSlot(): number {
  for (let tries = 0; tries < SPLAT_SPRITE_CAP; tries++) {
    const index = splatCursor
    splatCursor = (splatCursor + 1) % SPLAT_SPRITE_CAP
    if (!splatSlots[index]!.alive) return index
    bakeNodeSplats(splatSlots[index]!.nodeId)
    if (!splatSlots[index]!.alive) return index
  }
  // Unreachable, same as the decal ring — stamp rather than swallow the tick.
  const index = splatCursor
  splatCursor = (splatCursor + 1) % SPLAT_SPRITE_CAP
  releaseSplatSlot(index)
  return index
}

export function resetPaintDecals(): void {
  for (let i = 0; i < DECAL_CAP; i++) releaseSlot(i)
  nodeDecals.clear()
  decalCursor = 0
  releaseAllChunks('decal')
  emitDecals()
  // Mount/unmount lane: no slot mesh survives this commit, dispose now.
  flushRetiredDecalGeometries()
}

/**
 * Free every decal on `nodeId`. Splats are WORLD-SPACE DecalGeometry baked
 * at the host's clip-time pose — an operable door/window leaf swinging away
 * (interact.tsx toggleOperable) would leave them floating in the opening,
 * so the toggle releases them instead (the coat was never persisted paint;
 * saveable votes come from Save while the decals are live).
 */
export function releaseNodeDecals(nodeId: string): void {
  // Baked stamps were clipped against the same swinging leaf — they go too.
  const freed = releaseNodeChunks(nodeId, 'decal')
  const indices = nodeDecals.get(nodeId)
  if (!indices || indices.length === 0) {
    if (freed > 0) emitDecals()
    return
  }
  for (const index of [...indices]) releaseSlot(index)
  emitDecals()
}

/** Area-weighted decal votes per node: colorIndex → painted m². paint-keep
 * merges these next to the strength-weighted cell votes.
 *
 * BAKED STAMPS VOTE TOO, with the identical π r² arithmetic — promotion moves
 * a splat between representations, it must never move it off the ballot, or a
 * long spray would save the colour of its last few seconds. */
export function getDecalVotesByNode(): Map<string, Map<number, number>> {
  const out = new Map<string, Map<number, number>>()
  const voteFor = (nodeId: string): Map<number, number> => {
    let votes = out.get(nodeId)
    if (!votes) {
      votes = new Map()
      out.set(nodeId, votes)
    }
    return votes
  }
  for (const s of decalSlots) {
    if (!s.alive) continue
    const votes = voteFor(s.nodeId)
    const area = Math.PI * s.radius * s.radius
    votes.set(s.color, (votes.get(s.color) ?? 0) + area)
  }
  for (const [nodeId, chunks] of nodeChunks) {
    for (const chunk of chunks) {
      if (chunk.layer !== 'decal') continue // sprites are visual; cells persist them
      const votes = voteFor(nodeId)
      for (let i = 0; i < chunk.count; i++) {
        const radius = chunk.stamps[i * 4 + 3]!
        votes.set(chunk.color, (votes.get(chunk.color) ?? 0) + Math.PI * radius * radius)
      }
    }
  }
  return out
}

/** The decal lane wears the SAME airbrush stamp as the sprite pool (one
 * cached texture: opaque core, smoothstep rim, overspray grain) — white,
 * tinted by the per-color material. */
function getDecalTexture(): CanvasTexture | null {
  return getSplatTexture()
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

/** Baked SPRITE chunk materials (module lifetime, ≤ the palette). The live
 * sprite pool tints one white airbrush map per instance through
 * instanceColor; a baked chunk gets the same map with the palette colour on
 * the material — identical pixels — and keeps the pool's own polygonOffset
 * −3 so it layers over the voxel skin exactly where the instances did. */
const splatChunkMaterials = new Map<number, MeshStandardMaterial>()

function chunkMaterialFor(layer: PaintChunkLayer, color: number): MeshStandardMaterial | null {
  if (layer === 'decal') return decalMaterialFor(color)
  const swatch = PAINT_PALETTE[color]
  if (!swatch) return null
  const cached = splatChunkMaterials.get(color)
  if (cached) return cached
  const material = new MeshStandardMaterial({
    color: swatch.hex,
    depthWrite: false,
    map: getSplatTexture(),
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
    roughness: 0.55,
    transparent: true,
  })
  splatChunkMaterials.set(color, material)
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
  // Slot claim: the ring PROMOTES under pressure (claimDecalSlot bakes the
  // node at its quota, or the node owning the slot under the cursor) — it
  // never evicts a stamp, so a long stroke keeps every splat it laid down.
  const index = claimDecalSlot(nodeId)
  let list = nodeDecals.get(nodeId)
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
  s.order = ++decalStampOrder // newer coat always draws later (blink fix)
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
  const chunks = nodeChunks.get(nodeId)
  const baked = chunks?.some((chunk) => chunk.layer === 'decal') ?? false
  if ((!indices || indices.length === 0) && !baked) return
  const targets = useDestruction.getState().targets
  const prefix = `${nodeId}#`
  for (const target of targets.values()) {
    if (target.dormant) continue
    if (target.nodeId !== nodeId && !target.nodeId.startsWith(prefix)) continue
    const ledgerId = target.nodeId
    const serial = nodeSerials.get(ledgerId) ?? 0
    let wrote = false
    /** One stamp → cell coats. Same arithmetic for a live slot and a baked
     * one, applied in the same chronological order, so a node that baked
     * mid-spray converts to the identical ledger an unbaked one would. */
    const coat = (x: number, y: number, z: number, radius: number, color: number): void => {
      const coats = splatCoat(target.grid, x, y, z, coatRadiusFor(radius))
      if (coats.length === 0) return
      let painted = paintedByNode.get(ledgerId)
      if (!painted) {
        painted = new Map()
        paintedByNode.set(ledgerId, painted)
      }
      for (const { cell, add } of coats) {
        const strength = Math.min(1, add / COAT_ADD)
        const before = coatBaseStrength(painted.get(cell), color)
        painted.set(cell, paintValue(color, Math.min(1, before + strength)))
        claimCell(ledgerId, cell) // a decal is always this player's own spray
      }
      wrote = true
    }
    // BAKED STAMPS FIRST, in bake order: they are the older coats, and
    // coatBaseStrength's accumulate-or-restart rule is order-dependent.
    if (chunks) {
      for (const chunk of chunks) {
        if (chunk.layer !== 'decal') continue
        for (let i = 0; i < chunk.count; i++) {
          coat(
            chunk.stamps[i * 4]!,
            chunk.stamps[i * 4 + 1]!,
            chunk.stamps[i * 4 + 2]!,
            chunk.stamps[i * 4 + 3]!,
            chunk.color,
          )
        }
      }
    }
    if (indices) {
      for (const index of indices) {
        const s = decalSlots[index]!
        if (!s.alive) continue
        coat(s.x, s.y, s.z, s.radius, s.color)
      }
    }
    if (wrote) nodeSerials.set(ledgerId, serial + 1)
  }
  // Free the node's slots AND chunks whether or not a live grid caught them —
  // the host surface they were clipped against is hidden now.
  if (indices) for (const index of [...indices]) releaseSlot(index)
  releaseNodeChunks(nodeId, 'decal')
  emitDecals()
}

/**
 * Fold another player's strokes into this client's coat ledger.
 *
 * FOLDED, NOT REPLAYED. `foldCoats` walks the strokes in canonical (lamport,
 * id) order and applies the same accumulate-or-restart arithmetic the local
 * spray uses — with the REAL `paintValue` and `coatBaseStrength` passed in as
 * the ops, not a second copy of them, so there is exactly one definition of
 * what a coat is. That is what makes a late joiner who folds forty strokes at
 * once land on the ledger a client who watched them arrive one at a time
 * already has.
 *
 * A stroke carries the BALL, not the cells: `splatCoat` is pure, so it expands
 * against whatever grid THIS client has, at whatever tier. That is also why a
 * node with no live replica is voxelized first — a dormant prebuild is woken
 * (ensureVoxelTarget does it) rather than the paint being dropped on the floor.
 *
 * Colours outside the local palette are refused. The drain indexes
 * PAINT_PALETTE with no bounds check, and every remote input is hostile.
 */
export function foldRemoteStrokes(world: GameWorld, strokes: readonly StrokeRec[]): StrokeRec[] {
  // Strokes whose SURFACE is not here (yet): handed back so the build lane can
  // re-offer them when a piece installs. A stroke refused for its COLOUR is not
  // in here — that one is permanently invalid, not early.
  const unplaced: StrokeRec[] = []
  for (const [wireId, list] of strokesByNode(strokes)) {
    // The inverse of publishStrokes' translation: a room-wide piece name back
    // to THIS client's number for the same wall. null means there is nothing
    // here to paint — the piece has not arrived yet, or the name is a peer's
    // own counter, which is refused rather than resolved (shared-damage's
    // localNodeId owns that rule for both lanes).
    const nodeId = localNodeId(wireId)
    if (nodeId === null) {
      countWaited(list, 'foldUnnamed')
      unplaced.push(...list)
      continue
    }
    // ONCE PER RECORD, EVER. `foldCoats` accumulates into the ledger, so the
    // same stroke applied twice deposits two coats' worth of strength — and a
    // record can be offered again by a rebuild, by a relay that hands us what we
    // already have, or by the waiting list. This set is what makes "folded" mean
    // "deposited", and it is cleared with the ledger it describes.
    const usable = list.filter(
      (rec) => rec.color < PAINT_PALETTE.length && !foldedStrokes.has(rec.id),
    )
    if (usable.length === 0) continue
    // Force the target into existence BEFORE anything grid-dependent runs:
    // dormant prebuilds and shell-pending nodes have no grid to expand into
    // until they are woken.
    const target = useDestruction.getState().targets.get(nodeId) ?? ensureVoxelTarget(world, nodeId)
    if (!target || target.dormant) {
      countWaited(usable, 'foldNoTarget')
      unplaced.push(...usable)
      continue
    }
    wireCounts.folded += usable.length
    for (const rec of usable) foldedStrokes.add(rec.id)
    let painted = paintedByNode.get(nodeId)
    if (!painted) {
      painted = new Map()
      paintedByNode.set(nodeId, painted)
    }
    let theirs = remoteCoated.get(nodeId)
    if (!theirs) {
      theirs = new Set()
      remoteCoated.set(nodeId, theirs)
    }
    const mark = theirs
    // The expand hook is also where the cells get attributed — folding in
    // place is what keeps the arithmetic right (a scratch map would start
    // every cell from zero and then overwrite the local coat underneath).
    foldCoats(
      usable,
      (rec) => {
        let splats = splatCoat(target.grid, rec.x, rec.y, rec.z, rec.radius)
        if (splats.length === 0) {
          // THE SAME WRITING-RANGE RESCUE THE LOCAL SPRAY GETS — and the reason
          // this section of the two-client harness read all-zeros with the wire
          // counters saying the stroke had been folded (2026-09-01). Up close
          // the cone is a writing stroke a few centimetres wide, so its ball
          // clears every cell CENTER; sprayPaint coats the one cell under the
          // crosshair instead. Without the same rescue here, the peer folded the
          // record and deposited nothing: a coat the sprayer could see and
          // nobody else could. A ball that misses by more than the cell's own
          // reach still deposits nothing, exactly as it does locally.
          const cell = nearestCoatCell(
            target.grid,
            rec.x,
            rec.y,
            rec.z,
            coatReachFor(target.grid),
          )
          if (cell < 0) return splats
          splats = [{ cell, add: COAT_ADD }]
        }
        // ATTRIBUTED BY AUTHOR, not by the path the record came down: a rebuild
        // (refoldSharedStrokes) re-folds OUR OWN strokes through here too, and
        // marking those as somebody else's would quietly drop the player's own
        // paint from their Save. Last writer owns the cell, which is the rule
        // the packed ledger value already follows.
        if (isOurRecord(rec.id)) for (const splat of splats) claimCell(nodeId, splat.cell)
        else for (const splat of splats) mark.add(splat.cell)
        return splats
      },
      { pack: paintValue, base: coatBaseStrength },
      painted,
    )
    // Nudge the drain's change gate so the new coats reach the mesh. No
    // sprite stamps: a stroke carries no surface normal to clip a disc
    // against, so remote paint reads as cell tint — which is the durable
    // outcome anyway, and exactly what Save would have written.
    nodeSerials.set(nodeId, (nodeSerials.get(nodeId) ?? 0) + 1)
  }
  return unplaced
}

/** Feature-detected registration — destruction.ts gains
 * setTargetLiveListener via the manager diff; until then decals simply
 * persist unconverted (they still render over the replica). */
function targetLiveRegistrar(): ((cb: ((nodeId: string) => void) | null) => void) | undefined {
  return (destructionModule as { setTargetLiveListener?: (cb: ((nodeId: string) => void) | null) => void })
    .setTargetLiveListener
}

/** The session's splats — mounted by PaintTool: the live crater-style keyed
 * ring slots, plus every BAKED chunk (both layers). A chunk mesh keeps its key
 * across consolidation, so a growing coat swaps geometry on one mounted mesh
 * instead of remounting. */
function PaintDecals() {
  useSyncExternalStore(subscribeDecals, getDecalVersion, getDecalVersion)
  return (
    <group userData={{ __boots: true }}>
      {Array.from(nodeChunks.values(), (chunks) =>
        chunks.map((chunk) => {
          const material = chunkMaterialFor(chunk.layer, chunk.color)
          if (!material) return null
          // Geometry lifetime is the chunk's (retired + flushed on release,
          // replaced on consolidation), the material is module-cached — R3F
          // must dispose neither.
          return (
            <mesh
              dispose={null}
              geometry={chunk.geometry}
              key={`baked:${chunk.id}`}
              material={material}
              renderOrder={chunk.order}
            />
          )
        }),
      )}
      {decalSlots.map((slot, i) => {
        if (!slot.alive || !slot.geometry) return null
        const material = decalMaterialFor(slot.color)
        if (!material) return null
        return (
          // Geometry lifetime is the ring's (disposed on reuse/reset), the
          // materials are module-cached — R3F must dispose neither.
          // renderOrder = the monotonic stamp serial: transparent sorting
          // takes renderOrder before depth, so a newer coat of another
          // color draws OVER the old one on every frame (no camera-angle
          // z-sort flips between coplanar decals — the blink fix).
          <mesh
            dispose={null}
            geometry={slot.geometry}
            key={`${i}:${slot.gen}`}
            material={material}
            renderOrder={slot.order}
          />
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
/** Bridge-stamp scratch (spawnPaintDecal wants a Vector3). */
const _bridge = new Vector3()
/** Every-other-tick gate on the nozzle/air mist (phase 11: less mist —
 * coverage is the point, the hiss + bounce puff still sell the spray). */
let mistParity = false

/**
 * One trigger tick: resolve the crosshair ray (voxel skins beat solid
 * colliders on a near-tie, same priority shooting uses), voxelize a
 * pristine paintable node, then ledger the splat cells — sized by the
 * spray cone at the HIT DISTANCE (close = writing stroke, far = wall
 * coat). Returns true when any cell took paint.
 */
/**
 * Publish this tick's stamps: the bridge points first, then the hit — the same
 * order the local ledger writes them in. Each addLocalStroke takes the next
 * lamport, and the fold on the far side walks canonical (lamport, id) order,
 * so a peer reproduces this client's swath in this client's sequence.
 *
 * The whole swath goes out, not just the hit: the spray samples at 9 Hz and the
 * bridge is what fills the gaps between samples, so publishing the hit alone
 * would leave every peer looking at a dotted line where this player sees a
 * continuous band.
 */
function publishStrokes(
  nodeId: string,
  bridge: readonly { x: number; y: number; z: number }[],
  coatRadius: number,
): void {
  if (!buildSyncOn()) return
  // THE NAME THE SURFACE TRAVELS UNDER (shared-damage's wireNodeId — one
  // definition for both lanes). A host wall passes through: its id comes from
  // the document and means the same thing in every browser. A player-built
  // wall does NOT — store.ts numbers pieces from a counter that restarts each
  // page load, so my second wall and yours are both `__boots-piece-2` — so it
  // travels under its shared RECORD id instead. null means this surface has no
  // room-wide name (an unpublished piece, or a per-client spawn fixture): keep
  // the paint local rather than coat a stranger's different wall.
  const wire = wireNodeId(nodeId)
  if (wire === null) {
    wireCounts.unnamed++
    return
  }
  // OUR OWN STROKE IS ALREADY IN THE LEDGER — the spray put it there before it
  // was ever a record. Marking it deposited is what keeps a rebuild
  // (refoldSharedStrokes) from folding this coat a second time on top of itself.
  for (const p of bridge) {
    const id = publishStroke(wire, colorIndex, p.x, p.y, p.z, coatRadius)
    if (id) foldedStrokes.add(id)
  }
  const id = publishStroke(wire, colorIndex, _point.x, _point.y, _point.z, coatRadius)
  if (id) foldedStrokes.add(id)
  wireCounts.published += bridge.length + 1
  flushBuildSync()
}

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
  // Mist (P1, thinned in phase 11): the nozzle cone puffs every OTHER tick
  // (mistParity); on a surface hit a softer bounce puff marks the contact,
  // a clean miss hangs a parity-gated puff in the air downrange instead.
  refreshMistTint()
  _mistDir.copy(_direction)
  const nozzle = nozzleAt(_origin, _direction)
  mistParity = !mistParity
  if (mistParity) spawnDust(nozzle, 0.4, _mistOpts)
  if (!nodeId) {
    if (mistParity) {
      _mistAt.copy(_nozzle).addScaledVector(_direction, 1.1)
      spawnDust(_mistAt, 0.28, _mistOpts)
    }
    lastHitDistance = null
    endPaintStroke() // never bridge a drag across air
    return false
  }
  _bounce.copy(_direction).negate()
  spawnDust(_point, 0.4, _bounceOpts)
  lastHitDistance = bestDist
  let ensured: VoxelTarget | null = null
  if (needsVoxelize) {
    if (!solidType || !PAINTABLE.has(solidType)) {
      endPaintStroke()
      return false
    }
    // P5: a PRISTINE host wears solid-disc DecalGeometry stamps — painting
    // no longer voxelizes it. The node keeps its host meshes and colliders
    // until real damage arrives; destruction's target-live hook then
    // converts these stamps into the cell ledger and frees the slots.
    if (decalMesh) {
      const radius = splatRadiusAt(bestDist)
      // Held-trigger economy (the sprite lane's coalescing rule): parked
      // on one spot, the solid disc already covers it — no new clip, no
      // ring churn, and the area votes stay honest.
      if (
        stroke &&
        stroke.nodeId === nodeId &&
        !shouldStampSplat(stroke, _point.x, _point.y, _point.z, colorIndex, radius)
      ) {
        return true
      }
      // Drag continuity (phase 11): bridge stamps between the stroke
      // anchor and this hit — each clips its own decal and votes its area.
      const decalBridge = strokeBridge(nodeId, _point.x, _point.y, _point.z, radius)
      for (const p of decalBridge) {
        spawnPaintDecal(decalMesh, nodeId, _bridge.set(p.x, p.y, p.z), _decalNormal, radius)
      }
      if (spawnPaintDecal(decalMesh, nodeId, _point, _decalNormal, radius)) {
        // A DECAL ON A PRISTINE HOST STILL PUBLISHES A COAT. The tier is a
        // local rendering choice — this client kept its host meshes, a peer
        // that has already shot the wall holds a voxel replica — so the
        // stroke travels as the coat geometry both tiers agree on
        // (coatRadiusFor is what convertDecalsForNode would use here too).
        publishStrokes(nodeId, decalBridge, coatRadiusFor(radius))
        advanceStroke(nodeId, _point.x, _point.y, _point.z)
        return true
      }
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
  const radius = splatRadiusAt(bestDist)
  // Drag continuity (phase 11): bridge coats between the stroke anchor and
  // this hit — the swath the player SEES is exactly what the ledger holds,
  // so paint-keep's strength-weighted votes track the whole band.
  const bridge = strokeBridge(nodeId, _point.x, _point.y, _point.z, radius)
  const coatRadius = coatRadiusFor(radius) // cells stay under the disc
  let coats = splatCoat(target.grid, _point.x, _point.y, _point.z, coatRadius)
  const bridgeCoats = bridge.map((p) => splatCoat(target.grid, p.x, p.y, p.z, coatRadius))
  let landed = coats.length
  for (const c of bridgeCoats) landed += c.length
  if (landed === 0) {
    // Writing-range rescue (see nearestCoatCell): the tiny inset missed
    // every cell center — coat the one cell under the crosshair so the
    // stamp still lands (and the sprite below still draws). A true grid
    // miss (wrong roof member) finds nothing in reach and aborts as before.
    const cell = nearestCoatCell(target.grid, _point.x, _point.y, _point.z, coatReachFor(target.grid))
    if (cell < 0) return false
    coats = [{ cell, add: COAT_ADD }]
    landed = 1
  }
  let painted = paintedByNode.get(nodeId)
  if (!painted) {
    painted = new Map()
    paintedByNode.set(nodeId, painted)
  }
  // Bridge cells coat first, drip-free (drips belong to the tick's own
  // stamp) — the hit's coat below then wins any shared cells.
  for (const c of bridgeCoats) {
    for (const { cell, add } of c) {
      const before = coatBaseStrength(painted.get(cell), colorIndex)
      painted.set(cell, paintValue(colorIndex, Math.min(1, before + add)))
      claimCell(nodeId, cell) // painting over a stranger's coat makes it yours
    }
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
    const before = coatBaseStrength(painted.get(cell), colorIndex)
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
    claimCell(nodeId, cell)
  }
  nodeSerials.set(nodeId, serial + 1)
  publishStrokes(nodeId, bridge, coatRadius)
  // ROUND READ (phase 10/11): the cell tint above is square by
  // construction — stamp solid-disc sprites flat on the hit face (bridge
  // points first, then the hit) so the pass reads as one continuous filled
  // band. Coalescing may swallow the hit's stamp (held-trigger economy);
  // the ledger coat already landed either way.
  splatNormalFor(target.grid, target.kind, _direction.x, _direction.y, _direction.z, _splatN)
  for (const p of bridge) {
    stampSplat(nodeId, p.x, p.y, p.z, _splatN.x, _splatN.y, _splatN.z, radius, colorIndex)
  }
  stampSplat(nodeId, _point.x, _point.y, _point.z, _splatN.x, _splatN.y, _splatN.z, radius, colorIndex)
  advanceStroke(nodeId, _point.x, _point.y, _point.z)
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
  /** Cached fingerprint probe cell (matchesTarget). Any ALIVE cell works —
   * the cache only saves the first-alive scan, which is O(grid.count) on a
   * heavily-carved grid and used to run per painted node per frame. */
  __bootsPaintProbe?: number
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
  // First-alive probe, cached on the mesh: the linear scan re-ran per
  // painted node per FRAME (cache hits revalidate through here), and a big
  // carved grid can have thousands of dead cells before the first live one.
  // Any alive cell fingerprints equally well, so reuse the last probe until
  // that cell dies (or the userData gates reset with a re-prime).
  const ud = mesh.userData as PaintedUserData
  let probe = ud.__bootsPaintProbe ?? -1
  if (probe < 0 || probe >= grid.count || !grid.alive[probe]) {
    probe = -1
    for (let i = 0; i < grid.count; i++) {
      if (grid.alive[i]) {
        probe = i
        break
      }
    }
    if (probe === -1) return false
    ud.__bootsPaintProbe = probe
  }
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
    if (!target) {
      // Target DROPPED (builder Z-undo unmounted the piece): the surface
      // its sprites floated on is gone — evict them. Every sprite node has
      // ledger entries (stampSplat only follows a successful coat), so this
      // drain sees every drop; a repeat call is a Map-miss no-op.
      releaseNodeSplats(nodeId)
      continue
    }
    // FULLY-dead grid (island crumble / collapse): there is nothing left to
    // tint AND matchesTarget can never fingerprint it (no alive probe), so
    // resolving would full-scene-traverse every drain forever. Skip it —
    // the LEDGER stays (capturePaint's "every painted cell died" full-ledger
    // vote still counts the node on Save); only the mesh ref drops, and the
    // node's splat sprites evict with the collapsed surface.
    if (target.grid.aliveCount === 0) {
      meshCache.delete(nodeId)
      releaseNodeSplats(nodeId)
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
  // 2× the old resolution — the print is SMALLER now (spray-polish round:
  // "smaller and easier to read"), so the texels have to be crisper.
  canvas.width = 1024
  canvas.height = 256
  const g = canvas.getContext('2d')
  if (!g) return null
  g.fillStyle = hex
  g.fillRect(0, 0, 1024, 256)
  // Contrast pill: dark plate on light coats / light plate on dark coats,
  // print in the opposite ink — readable on every palette entry (the old
  // hairline box + 44px type read as a smudge). Centered at u=0.5 — the
  // band mesh spins π so this faces the camera (cylinder UVs put u=0 at
  // +Z, which is also the seam).
  const plate = paintLabelInk(hex)
  const ink = plate === INK_DARK ? INK_LIGHT : INK_DARK
  const w = 300
  const h = 104
  const x = (1024 - w) / 2
  const y = (256 - h) / 2
  const r = 30
  g.fillStyle = plate
  g.beginPath()
  g.moveTo(x + r, y)
  g.arcTo(x + w, y, x + w, y + h, r)
  g.arcTo(x + w, y + h, x, y + h, r)
  g.arcTo(x, y + h, x, y, r)
  g.arcTo(x, y, x + w, y, r)
  g.closePath()
  g.fill()
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillStyle = ink
  // Half the old physical type size (44/128 → 40/256), clean 600 weight.
  g.font = '600 40px system-ui, sans-serif'
  g.fillText('PRESS R', 512, 256 / 2 - 14)
  // The small second line says what R does.
  g.globalAlpha = 0.78
  g.font = '500 21px system-ui, sans-serif'
  g.fillText('NEXT COLOR', 512, 256 / 2 + 22)
  g.globalAlpha = 1
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
  /** Last R-cycle serial seen — the carousel flashes only on a real cycle,
   * never on equip (module serial survives weapon switches and sessions). */
  const lastCycle = useRef(paintCycleSerial())
  /** Countdown to the next retry of strokes waiting for their wall (seconds). */
  const strokeDrain = useRef(0)

  useEffect(() => {
    resetPaint()
    resetPaintDecals()
    resetPaintSplats()
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
      endPaintStroke()
      // Never hold host meshes (or their clipped decals/sprites) across
      // sessions.
      meshCache.clear()
      resetPaintDecals()
      resetPaintSplats()
    }
  }, [])

  // REMOTE STROKES. Registered against THIS world (folding may have to wake a
  // dormant prebuild to have a grid to expand into), so it re-registers on a
  // world swap and is gone on unmount. Mounted for the whole session, not just
  // while the can is held — a peer's paint must land whatever this player is
  // holding. Never called with no world attached.
  useEffect(() => {
    setBuildAppliers({ foldStrokes: (strokes) => foldRemoteStrokes(world, strokes) })
    // THE LEDGER IS DERIVED, THE RECORDS ARE THE TRUTH. The mount effect above
    // just emptied it, and a stroke is delivered once — so every coat the room
    // had already handed us would be gone for the session (QA: `paintMounts 2`
    // on a joiner). Ask the record set to rebuild it; folding is idempotent, so
    // this is a no-op on a ledger that is already right.
    refoldSharedStrokes()
    return () => {
      setBuildAppliers({ foldStrokes: undefined })
    }
  }, [world])

  useFrame((_, rawDt) => {
    // The render that last drew any retired decal geometry is over — safe to
    // dispose now (see retiredDecalGeometries). Same reasoning frees the baked
    // sprite slots' instance matrices: their chunk has been in the scene for a
    // frame, so zeroing them can no longer leave a gap.
    flushRetiredDecalGeometries()
    flushPendingSplatZeros()
    const session = getSession()
    if (!session) return
    const dt = Math.min(rawDt, 1 / 30)

    // A peer's coat can arrive before the wall it landed on, and that wall is
    // paintable a frame or two AFTER it installs — so the waiting list needs a
    // heartbeat and not just the install event. Runs whatever this player is
    // holding: somebody else's paint must land while we carry a rifle.
    strokeDrain.current -= dt
    if (strokeDrain.current <= 0) {
      strokeDrain.current = PENDING_STROKE_DRAIN
      drainPendingStrokes()
    }

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

    // Color carousel flash: every R cycle (a paintCycleSerial edge — never
    // a mere equip) shows the palette strip near the paint chip for ~2 s.
    // Feature-detected like paintSwatch until hud.ts ships it.
    const cycled = paintCycleSerial()
    if (cycled !== lastCycle.current) {
      lastCycle.current = cycled
      const hudCarousel = session.hud as typeof session.hud & {
        paintCarousel?: (hexes: readonly string[], active: number) => void
      }
      hudCarousel.paintCarousel?.(PAINT_PALETTE_HEXES, currentPaintIndex())
    }

    if (wants !== spraying.current) {
      spraying.current = wants
      if (wants) {
        if (!spray.current) spray.current = sfx.spray()
        spray.current.start()
      } else {
        spray.current?.stop()
        endPaintStroke() // trigger up — the next press starts a new stroke
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
  // The drip + sprite + decal pools ride the tool's lifetime — reused slots
  // persist, exit resets the rings with the ledger.
  return (
    <>
      <DripsLayer />
      <SplatsLayer />
      <PaintDecals />
    </>
  )
}
