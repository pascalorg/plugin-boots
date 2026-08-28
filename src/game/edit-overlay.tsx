'use client'

import { useFrame } from '@react-three/fiber'
import { useEffect } from 'react'
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  LineBasicMaterial,
  MeshBasicMaterial,
  PlaneGeometry,
} from 'three'
import type { BuildPiece } from '../store'
import { CELLS, cellCenter, cellDims, WALL_H } from './builder'
import { CORNER_RISE, CORNER_XZ, type RoofCorners } from './roof-corners'

/**
 * F-edit overlays — the 3×3 lattice template (creative-mode catalog look).
 *
 * EditOverlay renders the cell editor as a crisp outlined lattice floating
 * FACE_LIFT off BOTH faces of the piece (the wall plane for walls, the slab
 * plane for floors/stairs/legacy corner-less roofs): nine tiles inset
 * TILE_INSET per side so the gaps read as grout. Live cells fill translucent
 * blue, dead cells go nearly invisible but KEEP their outline (the grid
 * always reads as a 3×3 template — a dead tile is a click-to-resurrect
 * target, so its fill keeps the faint red cast). The hovered tile swaps to
 * dedicated hover materials (brighter fill, double-rect outline standing in
 * for line width — ignored by GPUs) and idles on a gentle opacity pulse.
 *
 * CornerEditOverlay is the corner-roof editor: one marker cube per corner AT
 * its current height (raised cool blue, dropped faint red with a visible
 * wire, hovered hot + pulsing) — same palette and outline language as the
 * lattice.
 *
 * WebGPU-safe: plain BufferGeometry + LineSegments + basic materials, no
 * shaders. Geometries live in module caches keyed by piece type and
 * materials are module singletons — zero per-frame allocation, zero
 * per-render geometry builds. The ONLY per-frame write is the hover pulse
 * mutating the hover materials' opacity (they are exclusive to the hovered
 * tile/marker; the shared live/dead materials are never touched per frame).
 * Both overlay groups carry userData.__boots like every game object.
 *
 * ── API (pure exports for tests) ──────────────────────────────────────────
 *   TILE_INSET / FACE_LIFT            lattice tuning constants.
 *   tileSize(piece)                   in-plane tile [w, h] after the inset.
 *   faceLift(piece)                   piece-center → floating-face distance.
 *   rectSegments(w, h)                4-segment rect outline (24 floats).
 *   hoverRectSegments(w, h)           double rect, 8 segments (48 floats).
 *   boxEdgeSegments(size)             cube wireframe, 12 edges (72 floats).
 * ──────────────────────────────────────────────────────────────────────────
 */

/** Per-side tile inset as a fraction of the cell span — the grout gap that
 * separates the nine tiles. */
export const TILE_INSET = 0.06
/** Lattice float distance off the piece face (m) — must clear the piece's
 * own BRICK CLADDING, not just the naked box: placed pieces voxel-clad the
 * moment they land (builder.tsx INSTANT BRICKS → destruction.ts's isotropic
 * 0.15 m volume grid, cells laid from the box MIN corner), so a 0.12 m
 * thickness is ONE 0.15 m cell whose layer overshoots the MAX face by up to
 * 0.03 m. A smaller lift buries the lattice INSIDE the bricks on that face —
 * it reads as faint broken dashes through the mortar seams (owner report,
 * wave 3; the transforms were exact, the tiles were simply occluded). 0.05
 * clears the worst brick face by 2 cm and still depth-clears the plain
 * fallback mesh while a turbo-deferred piece waits for its cladding. */
export const FACE_LIFT = 0.05

/** In-plane tile size after the grout inset: walls tile col × row on the
 * wall plane (local X × Y), slabs on their plane (local X × Z). `span` is
 * the piece's storey span (legacy WALL_H) — wall tiles are span/3 tall. */
export function tileSize(piece: BuildPiece, span = WALL_H): [number, number] {
  const [w, h, d] = cellDims(piece, span)
  const scale = 1 - 2 * TILE_INSET
  if (piece === 'wall') return [w * scale, h * scale]
  return [w * scale, d * scale]
}

/** Piece-center → floating-lattice-face distance: half the piece thickness
 * (local Z for walls, local Y for slabs) plus FACE_LIFT. */
export function faceLift(piece: BuildPiece, span = WALL_H): number {
  const dims = cellDims(piece, span)
  return (piece === 'wall' ? dims[2] : dims[1]) / 2 + FACE_LIFT
}

/** Rectangle outline centered on the origin in the XY plane, as LineSegments
 * vertex pairs — 4 segments, 8 vertices, 24 floats. */
export function rectSegments(w: number, h: number): Float32Array {
  const x = w / 2
  const y = h / 2
  // biome-ignore format: one segment (two xyz vertices) per row
  return new Float32Array([
    -x, -y, 0, x, -y, 0,
    x, -y, 0, x, y, 0,
    x, y, 0, -x, y, 0,
    -x, y, 0, -x, -y, 0,
  ])
}

/** Inner rect scale of the hovered tile's double outline. */
const HOVER_INNER = 0.92

/** Hovered-tile outline: two concentric rects (8 segments, 48 floats) —
 * reads as a thick border without linewidth (GPUs clamp lines to 1px). */
export function hoverRectSegments(w: number, h: number): Float32Array {
  const outer = rectSegments(w, h)
  const inner = rectSegments(w * HOVER_INNER, h * HOVER_INNER)
  const points = new Float32Array(outer.length + inner.length)
  points.set(outer, 0)
  points.set(inner, outer.length)
  return points
}

/** Cube wireframe centered on the origin, as LineSegments vertex pairs —
 * 12 edges, 24 vertices, 72 floats. */
export function boxEdgeSegments(size: number): Float32Array {
  const s = size / 2
  const ring: ReadonlyArray<readonly [number, number]> = [
    [-s, -s],
    [s, -s],
    [s, s],
    [-s, s],
  ]
  const points = new Float32Array(12 * 2 * 3)
  let at = 0
  for (let i = 0; i < 4; i++) {
    const a = ring[i]!
    const b = ring[(i + 1) % 4]!
    // bottom edge, top edge, vertical — 3 of the 12 per ring corner
    points.set([a[0], -s, a[1], b[0], -s, b[1]], at)
    points.set([a[0], s, a[1], b[0], s, b[1]], at + 6)
    points.set([a[0], -s, a[1], a[0], s, a[1]], at + 12)
    at += 18
  }
  return points
}

// --- Module geometry caches (built lazily, once per piece type) -------------

function segmentsGeometry(points: Float32Array, slab: boolean): BufferGeometry {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(points, 3))
  if (slab) geometry.rotateX(-Math.PI / 2) // XY plane → slab (XZ) plane
  return geometry
}

// Geometry caches key on (piece, span): tiles on a 2.5 m wall are shorter
// than on a legacy 2.8 one. One span per building level — the maps stay tiny.
const fillCache = new Map<string, BufferGeometry>()
function fillGeometry(piece: BuildPiece, span: number): BufferGeometry {
  const key = `${piece}|${span}`
  let geometry = fillCache.get(key)
  if (!geometry) {
    const [w, h] = tileSize(piece, span)
    geometry = new PlaneGeometry(w, h)
    if (piece !== 'wall') geometry.rotateX(-Math.PI / 2)
    fillCache.set(key, geometry)
  }
  return geometry
}

const outlineCache = new Map<string, BufferGeometry>()
function outlineGeometry(piece: BuildPiece, span: number): BufferGeometry {
  const key = `${piece}|${span}`
  let geometry = outlineCache.get(key)
  if (!geometry) {
    const [w, h] = tileSize(piece, span)
    geometry = segmentsGeometry(rectSegments(w, h), piece !== 'wall')
    outlineCache.set(key, geometry)
  }
  return geometry
}

const hoverOutlineCache = new Map<string, BufferGeometry>()
function hoverOutlineGeometry(piece: BuildPiece, span: number): BufferGeometry {
  const key = `${piece}|${span}`
  let geometry = hoverOutlineCache.get(key)
  if (!geometry) {
    const [w, h] = tileSize(piece, span)
    geometry = segmentsGeometry(hoverRectSegments(w, h), piece !== 'wall')
    hoverOutlineCache.set(key, geometry)
  }
  return geometry
}

/** Session teardown (builder.tsx calls it next to resetStoreyLadder): the
 * three caches above key on the raw float span — one family per building
 * level height, unbounded across an editor run's Jump-ins. The fixed-size
 * corner-marker singletons stay: they never grow. */
export function disposeOverlayGeometryCaches(): void {
  for (const cache of [fillCache, outlineCache, hoverOutlineCache]) {
    for (const geometry of cache.values()) geometry.dispose()
    cache.clear()
  }
}

/** Corner-marker cube size — matches the pre-restyle 0.5 m marker. */
const CORNER_MARKER = 0.5
/** Marker float above its corner's patch height (pre-restyle convention). */
const CORNER_MARKER_LIFT = 0.35

let cornerFillGeo: BoxGeometry | null = null
function cornerFillGeometry(): BoxGeometry {
  if (!cornerFillGeo) cornerFillGeo = new BoxGeometry(CORNER_MARKER, CORNER_MARKER, CORNER_MARKER)
  return cornerFillGeo
}

let cornerEdgeGeo: BufferGeometry | null = null
function cornerEdgeGeometry(): BufferGeometry {
  if (!cornerEdgeGeo) cornerEdgeGeo = segmentsGeometry(boxEdgeSegments(CORNER_MARKER), false)
  return cornerEdgeGeo
}

// --- Module material singletons ---------------------------------------------
// The hovered tile SWAPS to the HOVER_* pair; only those two ever mutate
// (HoverPulse writes HOVER_FILL.opacity) — the shared ones are immutable.

const TILE_LINE = new LineBasicMaterial({
  color: '#9fd4ff',
  depthWrite: false,
  opacity: 0.85,
  transparent: true,
})
const HOVER_LINE = new LineBasicMaterial({
  color: '#ffe08a',
  depthWrite: false,
  transparent: true,
})
const LIVE_FILL = new MeshBasicMaterial({
  color: '#59a7ff',
  depthWrite: false,
  opacity: 0.22,
  side: DoubleSide,
  transparent: true,
})
const DEAD_FILL = new MeshBasicMaterial({
  color: '#ff5a4d',
  depthWrite: false,
  opacity: 0.06,
  side: DoubleSide,
  transparent: true,
})
/** Hover fill's resting opacity — the pulse oscillates ±HOVER_PULSE around it. */
export const HOVER_FILL_BASE = 0.5
const HOVER_PULSE = 0.06
const HOVER_FILL = new MeshBasicMaterial({
  color: '#ffd34d',
  depthWrite: false,
  opacity: HOVER_FILL_BASE,
  side: DoubleSide,
  transparent: true,
})
const RAISED_FILL = new MeshBasicMaterial({
  color: '#59a7ff',
  depthWrite: false,
  opacity: 0.3,
  side: DoubleSide,
  transparent: true,
})
const DROPPED_FILL = new MeshBasicMaterial({
  color: '#ff5a4d',
  depthWrite: false,
  opacity: 0.08,
  side: DoubleSide,
  transparent: true,
})

/** Idle pulse on the hovered tile/marker: one sin per frame into the hover
 * fill's opacity (a material exclusive to the hovered element), write gated
 * on actual change, zero allocations. Restores the base opacity on unmount. */
function HoverPulse() {
  useFrame((state) => {
    const opacity = HOVER_FILL_BASE + Math.sin(state.clock.elapsedTime * 5) * HOVER_PULSE
    if (Math.abs(HOVER_FILL.opacity - opacity) > 0.004) HOVER_FILL.opacity = opacity
  })
  useEffect(
    () => () => {
      HOVER_FILL.opacity = HOVER_FILL_BASE
    },
    [],
  )
  return null
}

/** Stable bit list for the nine tiles (no per-render allocs). */
const TILE_BITS = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const
/** The lattice floats off BOTH faces so it reads from either side of the
 * piece (dead cells have no geometry to occlude the far one anyway). */
const FACE_SIDES = [1, -1] as const

/** 3×3 cell-editor overlay. Props mirror EditState: x/z the piece position,
 * y/tilt its RENDERED pose (piecePose output), mask the live-cell bits,
 * hover the bit under the crosshair, span the piece's storey span (legacy
 * WALL_H when omitted). 'roof' here is the legacy corner-less slab — it
 * lattices like a floor. */
export function EditOverlay({
  piece,
  mask,
  hover,
  span = WALL_H,
  x,
  y,
  z,
  yaw,
  tilt,
}: {
  piece: BuildPiece
  mask: number
  hover: number
  span?: number
  x: number
  y: number
  z: number
  yaw: number
  tilt: number
}) {
  const lift = faceLift(piece, span)
  const fill = fillGeometry(piece, span)
  const outline = outlineGeometry(piece, span)
  const hoverOutline = hoverOutlineGeometry(piece, span)
  const wall = piece === 'wall'
  return (
    <group position={[x, y, z]} rotation={[tilt, yaw, 0, 'YXZ']} userData={{ __boots: true }}>
      <HoverPulse />
      {FACE_SIDES.map((side) =>
        TILE_BITS.map((bit) => {
          const [cx, cy, cz] = cellCenter(piece, bit % CELLS, Math.floor(bit / CELLS), span)
          const hovered = hover === bit
          const alive = (mask & (1 << bit)) !== 0
          return (
            <group
              key={`${side}:${bit}`}
              position={[cx, wall ? cy : side * lift, wall ? side * lift : cz]}
            >
              <mesh
                geometry={fill}
                material={hovered ? HOVER_FILL : alive ? LIVE_FILL : DEAD_FILL}
              />
              <lineSegments
                geometry={hovered ? hoverOutline : outline}
                material={hovered ? HOVER_LINE : TILE_LINE}
              />
            </group>
          )
        }),
      )}
    </group>
  )
}

/** Corner-roof editor overlay: one marker per corner AT its current patch
 * height — hovered hot + pulsing, raised cool blue, dropped faint red (the
 * wire keeps it clickable-looking, same as a dead lattice tile). `rise` is
 * the piece's high-corner elevation (its storey span; legacy CORNER_RISE
 * when omitted) — markers must sit on the rendered patch. */
export function CornerEditOverlay({
  corners,
  hover,
  rise = CORNER_RISE,
  x,
  y,
  z,
  yaw,
}: {
  corners: RoofCorners
  hover: number
  rise?: number
  x: number
  y: number
  z: number
  yaw: number
}) {
  return (
    <group position={[x, y, z]} rotation={[0, yaw, 0]} userData={{ __boots: true }}>
      <HoverPulse />
      {corners.map((height, index) => {
        const [cx, cz] = CORNER_XZ[index]!
        const hovered = hover === index
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: corners are positional
          <group key={index} position={[cx, height * rise + CORNER_MARKER_LIFT, cz]}>
            <mesh
              geometry={cornerFillGeometry()}
              material={hovered ? HOVER_FILL : height ? RAISED_FILL : DROPPED_FILL}
            />
            <lineSegments
              geometry={cornerEdgeGeometry()}
              material={hovered ? HOVER_LINE : TILE_LINE}
            />
          </group>
        )
      })}
    </group>
  )
}
