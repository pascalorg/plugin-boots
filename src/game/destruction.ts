import { Box3, Color, Matrix4, type Mesh, Vector3 } from 'three'
import { create } from 'zustand'
import { useBoots } from '../store'
import { sfx } from './audio'
import { spawnDebris, spawnFlatDebris } from './debris'
import { spawnDust, spawnHaze } from './dust'
import { notifySceneSupportChanged, onPieceRemoved, slotOf } from './piece-slots'
import { hideForGameKeepingRoots } from './session'
import {
  dropStructureTarget,
  noteStructureCarve,
  registerStructureTarget,
  resetStructure,
  wireStructureDriver,
} from './structure'
import {
  buildVoxelGrid,
  dropInteriorCells,
  findUnsupportedIslands,
  raycastVoxels,
  raycastYawObb,
  removeSphere,
  type SkinLimit,
  type VoxelGridData,
  type VoxelSource,
} from './voxel'
import { bvhFor, type GameWorld } from './world'

/**
 * Voxel destruction manager — "everything should be able to break apart".
 *
 * A target stays the host's pristine mesh until the first hit lands; then
 * the mesh is hidden (session ledger — the editor gets it back untouched)
 * and a voxel replica takes over rendering, collision, and bullet
 * interception.
 *
 * WALL ANATOMY: walls voxelize ANISOTROPICALLY — the thickness axis is
 * pinned to thickness/3 cells (≥ 3 layers even on a 0.10 m wall) while
 * length/height keep ~0.15 m cells — then interior layers are dropped
 * (`dropInteriorCells`), leaving TWO thin drywall skins with the stud
 * cavity between them, and the studs are first-class breakable members
 * with their own hp. DIAGONAL walls (no thin world axis) get the same
 * anatomy from a grid built in the wall's yaw-local frame (grid.yaw —
 * centers stay world-space); only degenerate segments fall back to the
 * plain isotropic volume.
 *
 * SLAB SANDWICH (MULTILEVEL-PLAN Phase B): horizontal slab/ceiling/floor
 * nodes get the SAME anatomy rotated onto its side — thickness axis is
 * world Y (identity basis, `{ y: thickness/layers }` cell override), so
 * dropInteriorCells leaves a TOP skin (floor sheathing tone) and a BOTTOM
 * skin (ceiling drywall tone — voxel-walls.tsx lightens it), with JOISTS
 * (16" o.c. sticks spanning the SHORT plan direction, tops 0.04 m below
 * the slab top) breakable in the cavity. Sheets tile BOTH faces — a
 * ceiling board torn from below flies off DOWNWARD in one piece — and
 * kind-'slab' targets ride the whole wall lane: tearRadius carves,
 * skin-respecting pierce gate, sheet fly-offs, framing splash-chips.
 * Island support for slabs can't use the grid base row (iy 0 IS the
 * ceiling skin), so unsupported regions are found by probing live
 * colliders / voxel targets beneath each cell column (slabSeedPredicate).
 *
 * ── API (build against this) ──────────────────────────────────────────
 * State
 *   useDestruction            zustand store. `targets` (and its legacy
 *                             alias `walls` — the SAME Map instance) maps
 *                             nodeId → VoxelTarget. `version` bumps on any
 *                             change; re-read the map when it does.
 *   VoxelTarget               { nodeId, kind: 'wall' | 'slab' | 'volume', grid,
 *                             baseColor, segments: SegmentMember[],
 *                             studs (legacy — SAME array as segments),
 *                             sheets: SheetMember[], sheetByCell,
 *                             removedQueue, revision }
 *   SegmentMember             { id, center, size, yaw, hp, broken } — one
 *                             charcoal-stick length of framing lumber at
 *                             the real ~0.038 × 0.089 m cross-section;
 *                             stud lines split into 2-3 sticks, plates
 *                             into ~1.2 m runs. Renderers skip `broken`
 *                             members (fixed-length array, never spliced).
 *                             StudMember is a legacy alias of this type.
 *   SheetMember               LOGICAL drywall sheet — a ~1.2 × 2.4 m group
 *                             of EXISTING skin voxels on one wall face (no
 *                             rendered board plane of its own, so nothing
 *                             can ever sit coplanar with the skin). Carves
 *                             count `hits` + `torn` cells; past the
 *                             SHEET_FLY_* gates the WHOLE sheet flies off
 *                             (flownOff, shreds + plume, cells removed).
 * Voxelize / damage
 *   ensureVoxelTarget(world, nodeId)   voxelize ANY collider group (walls,
 *                             doors, slabs, roofs, items…). Walls get the
 *                             skins + studs anatomy, horizontal slabs the
 *                             sandwich (skins + joists); everything else is
 *                             a plain adaptive volume (≤ 1600 voxels).
 *                             `ensureVoxelWall` is a legacy alias.
 *   prevoxelizeTick(world, budgetMs?)   voxelize the scene's remaining
 *                             walls a few per tick (host meshes hide in the
 *                             SAME tick, via the ensureVoxelTarget path).
 *                             Returns true once every wall is done — drive
 *                             it from a useFrame until then.
 *   damageTarget(world, nodeId, point, radius, direction?)   carve a sphere
 *                             at a world point (voxelizes on first hit);
 *                             direction aims the tear dust plume. Wall
 *                             carves under WALL_PIERCE_RADIUS respect the
 *                             SKIN the shot entered (resolved from the hit
 *                             point) — the far face falls to the next shot
 *                             through the hole, or to a heavy weapon past
 *                             the gate. Wall carves also SPLASH-CHIP the
 *                             framing standing inside the sphere (hp-1
 *                             floor, never snaps — see chipSegmentSplash).
 *                             Returns the number of voxels removed.
 *                             `damageWall` is a legacy alias.
 *   damageSegment(world, nodeId, segmentId, damage, point)   chip a framing
 *                             stick (wood splinters); at hp ≤ 0 it snaps
 *                             like charcoal — 2-3 tumbling pieces along its
 *                             long axis + snap sfx. Returns true if damage
 *                             applied. `damageStud` is a legacy alias.
 *   damageExplosion(world, center, radius)   one blast: every destructible
 *                             collider group whose bounds touch the radius
 *                             takes the full-depth center carve plus ragged
 *                             rim nibbles, and framing segments inside the
 *                             radius snap (cap 48). Returns total voxels
 *                             removed. grenade.tsx's detonation routes here.
 * Structural rules (automatic — no caller wiring)
 *   30%-support: when under 30% of a wall's stud CHAINS still connect the
 *                             wall to the floor, everything above the
 *                             support ceiling avalanches (staggered voxel
 *                             layers, sheets fly, sticks snap). Checked
 *                             (debounced 160 ms) after every segment break.
 *   skeleton snap: a wall whose cladding hits ZERO live voxels can't keep
 *                             its bare frame standing — every remaining
 *                             segment snaps top-down across ~1.5 s.
 * Queries
 *   raycastVoxelTargets(origin, direction, maxDist)   first live voxel of
 *                             any target along the ray → { nodeId,
 *                             distance, point } | null.
 *                             `raycastVoxelWalls` is a legacy alias.
 *   raycastSegments(origin, direction, maxDist)   analytic ray-vs-OBB over
 *                             all live segments → { nodeId, segmentId,
 *                             studId (alias), distance, point } | null.
 *                             Shooting should test this alongside voxels
 *                             and keep the nearest. `raycastStuds` is a
 *                             legacy alias.
 *   collideVoxelTargets(pos, vel, radius, height)   capsule push-out
 *                             against live voxels; returns grounded.
 *                             `collideVoxelWalls` is a legacy alias.
 * Lifecycle
 *   resetDestruction()        clear all targets + pending island timers
 *                             (session exit path).
 * ──────────────────────────────────────────────────────────────────────
 */

/**
 * One breakable framing SEGMENT — a charcoal-stick length of lumber at the
 * REAL cross-section (~0.038 × 0.089 m, far skinnier than a voxel cell).
 * Vertical stud lines split into 2-3 stacked sticks, plates into ~1.2 m
 * runs, so a wall's framing snaps piece by piece instead of whole studs
 * vanishing. Matches voxel-walls.tsx's SandwichMember contract: the array
 * is fixed-length after voxelize, breaking only flips `broken`.
 */
export type SegmentMember = {
  id: number
  center: [number, number, number]
  size: [number, number, number]
  yaw: number
  hp: number
  broken: boolean
}

/** Legacy alias — `target.studs` IS the segments array now (same objects);
 * the old whole-stud members were replaced by the stick segments. */
export type StudMember = SegmentMember

/** Legacy alias — studs now carry id/hp/broken on top of the old shape. */
export type StudBox = StudMember

/**
 * One LOGICAL drywall sheet: a per-face, ~1.2 × 2.4 m tile of existing skin
 * voxel indices. Sheets never render anything themselves — the skin voxels
 * ARE the sheet — so no plane can ever z-fight the wall face. Carving cells
 * out of a sheet bumps `torn` (cells) and `hits` (carves); once a sheet has
 * lost SHEET_FLY_TORN of its cells — or taken SHEET_FLY_HITS carves while
 * at least SHEET_FLY_MIN_TORN open — the rest of it tears off the wall in
 * one go (`flownOff`): every remaining cell dies, shreds fly, one big plume
 * erupts.
 */
export type SheetMember = {
  id: number
  /** Mean world-space position of the sheet's cells. */
  center: [number, number, number]
  /** Grid-local extents (metres) of the sheet's cell block. */
  size: [number, number, number]
  yaw: number
  /** 0 = min-face skin, 1 = max-face skin (along the thickness axis). */
  side: number
  /** Outward face normal, world-space — aims the fly-off plume. */
  normal: [number, number, number]
  /** Carves that removed at least one of this sheet's cells. */
  hits: number
  /** Cells torn out so far (carves, crumbles, and the final fly-off). */
  torn: number
  cellCount: number
  flownOff: boolean
  /** Voxel indices into the target grid (internal bookkeeping). */
  cells: number[]
}

export type VoxelTarget = {
  nodeId: string
  /** 'wall' and 'slab' targets carry the skins + framing anatomy ('slab' =
   * the horizontal sandwich: thickness axis Y, joists in the cavity);
   * 'volume' is plain. */
  kind: 'wall' | 'slab' | 'volume'
  grid: VoxelGridData
  baseColor: Color
  /** Breakable framing sticks (walls only). voxel-walls.tsx renders these
   * as the SEGMENTS layer; shooting.ts routes raycastSegments/damageSegment
   * over them. */
  segments: SegmentMember[]
  /** Legacy alias — the SAME array instance as `segments`. */
  studs: StudMember[]
  /** Logical drywall sheets (walls only; empty for plain volumes). */
  sheets: SheetMember[]
  /** Voxel index → sheet id (−1 / out of range = no sheet). */
  sheetByCell: Int32Array
  /** Voxel indices removed since the renderer last drained the queue. */
  removedQueue: number[]
  /** Bumped on every change so the renderer knows to re-upload. */
  revision: number
}

/** Legacy alias — every voxelized target uses the same shape. */
export type VoxelWall = VoxelTarget

type DestructionState = {
  /** nodeId → voxelized target (walls, doors, slabs, items…). */
  targets: Map<string, VoxelTarget>
  /** Legacy alias — the SAME Map instance as `targets`. */
  walls: Map<string, VoxelTarget>
  version: number
  bump: () => void
  reset: () => void
}

export const useDestruction = create<DestructionState>((set) => {
  const initial = new Map<string, VoxelTarget>()
  return {
    targets: initial,
    walls: initial,
    version: 0,
    bump: () => set((s) => ({ version: s.version + 1 })),
    reset: () => {
      const next = new Map<string, VoxelTarget>()
      set({ targets: next, walls: next, version: 0 })
    },
  }
})

const _bounds = new Box3()
/** Scratch for damageTarget's dust direction (dust.tsx reads it at spawn). */
const _plumeDir = new Vector3()
const _size = new Vector3()
const _localBounds = new Box3()
const _meshBox = new Box3()
const _toLocal = new Matrix4()
const _meshToLocal = new Matrix4()

/** Above this world-axis thickness the node is not a thin axis-aligned wall
 * (diagonal walls, piers) — no skin/cavity layering, legacy grid instead. */
const MAX_ANATOMY_THICKNESS = 0.35

const STUD_SPACING = 0.4064 // 16" o.c.
const STUD_WIDTH = 0.038
const STUD_HP = 3
const WOOD = new Color('#8a6a43')

/** Stud depth that fits STRICTLY inside the cavity between the two drywall
 * skins. Anatomy grids pin the thickness axis to a thinner cell than the
 * 0.15 m length/height cells, and that cell IS the skin thickness
 * (extent/layers) — so the cavity spans cell × (layers − 2), minus a hair
 * of clearance so intact outer faces never show wood. Isotropic grids
 * (diagonal walls — no skins, full volume) keep the legacy near-full depth. */
function studDepth(grid: VoxelGridData, thickness: number): number {
  if (grid.cellX !== grid.cellZ) {
    const skinCell = Math.min(grid.cellX, grid.cellZ)
    const layers = grid.cellX < grid.cellZ ? grid.nx : grid.nz
    return Math.max(0.02, skinCell * (layers - 2) - 0.004)
  }
  return Math.max(0.06, thickness - 0.05)
}

type WallEntry = GameWorld['walls'] extends Map<string, infer V> ? V : never

/**
 * Anatomy grid for DIAGONAL walls — walls with no thin WORLD axis, the
 * common case when rooms are drawn in the rotated 3D view. Their world AABB
 * is metres deep on both plan axes, so the axis-aligned skinning path can't
 * see the thickness; instead the grid is built in the wall's yaw-local
 * frame (segment yaw, same convention as the studs), where the thickness
 * axis is thin again and the usual pinned-cell + dropInteriorCells anatomy
 * applies. Centers stay world-space so rendering, debris, and collision
 * push-out are untouched. Returns null when the segment is degenerate or
 * the local extent still isn't wall-like — callers keep the legacy
 * isotropic volume then.
 */
function buildDiagonalWallGrid(wall: WallEntry, sources: VoxelSource[]): VoxelGridData | null {
  const { start, end } = wall.node
  const dx = end[0] - start[0]
  const dz = end[1] - start[1]
  if (Math.hypot(dx, dz) < 0.3) return null
  const yaw = Math.atan2(dz, dx)
  _toLocal.makeRotationY(yaw)
  _localBounds.makeEmpty()
  for (const mesh of wall.meshes) {
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
    _meshBox
      .copy(mesh.geometry.boundingBox!)
      .applyMatrix4(_meshToLocal.multiplyMatrices(_toLocal, mesh.matrixWorld))
    _localBounds.union(_meshBox)
  }
  if (_localBounds.isEmpty()) return null
  _localBounds.getSize(_size)
  // In the yaw frame the segment runs along local X, thickness along local Z.
  const extent = _size.z
  if (extent <= 0.001 || extent > MAX_ANATOMY_THICKNESS || extent > _size.x) return null
  const layers = Math.max(3, Math.ceil(extent / 0.15 - 1e-6))
  const grid = dropInteriorCells(
    buildVoxelGrid(sources, _localBounds.clone(), 0.15, false, { z: extent / layers }, yaw),
    MAX_ANATOMY_THICKNESS,
  )
  return grid.count > 0 ? grid : null
}

function buildStuds(
  wall: GameWorld['walls'] extends Map<string, infer V> ? V : never,
  grid: VoxelGridData,
): StudMember[] {
  const { start, end } = wall.node
  const thickness = wall.node.thickness ?? 0.15
  if (thickness < 0.09) return []
  const height = wall.node.height ?? 2.7
  const dx = end[0] - start[0]
  const dz = end[1] - start[1]
  const length = Math.hypot(dx, dz)
  if (length < 0.3) return []
  const yaw = Math.atan2(dz, dx)
  const depth = studDepth(grid, thickness)
  // The wall's meshes live in a level whose Y offset we take from their
  // world bounds (start/end are level-local XZ but match world XZ in the
  // common single-transform case; the voxel grid corrects any drift).
  _bounds.makeEmpty()
  for (const mesh of wall.meshes) {
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
    _bounds.expandByPoint(
      mesh.geometry.boundingBox!.min.clone().applyMatrix4(mesh.matrixWorld),
    )
    _bounds.expandByPoint(
      mesh.geometry.boundingBox!.max.clone().applyMatrix4(mesh.matrixWorld),
    )
  }
  const baseY = _bounds.min.y
  const midX = (start[0] + end[0]) / 2
  const midZ = (start[1] + end[1]) / 2
  const centerX = _bounds.getCenter(_size).x
  const centerZ = _size.z
  // Shift start/end into world XZ using the delta between node midpoint and
  // the mesh bounds center (levels can offset their children).
  const offX = centerX - midX
  const offZ = centerZ - midZ

  const studs: StudMember[] = []
  const count = Math.max(2, Math.floor(length / STUD_SPACING) + 1)
  for (let i = 0; i < count; i++) {
    const t = Math.min(1, (i * STUD_SPACING) / length)
    const x = start[0] + dx * t + offX
    const z = start[1] + dz * t + offZ
    studs.push({
      id: studs.length,
      center: [x, baseY + height / 2, z],
      size: [STUD_WIDTH, height - 0.1, depth],
      yaw,
      hp: STUD_HP,
      broken: false,
    })
  }
  // Top & bottom plates.
  for (const [cy, plateH] of [
    [baseY + 0.045, 0.09],
    [baseY + height - 0.045, 0.09],
  ] as const) {
    studs.push({
      id: studs.length,
      center: [midX + offX, cy, midZ + offZ],
      size: [length, plateH, depth],
      yaw,
      hp: STUD_HP,
      broken: false,
    })
  }
  return studs
}

/** Real 2×4 lumber cross-section: 1.5" face along the run, 3.5" across the
 * cavity — the "skinnier than a voxel" read. Depth clamps just inside the
 * wall so lumber never pokes proud of the outer faces. */
const SEGMENT_W = 0.038
const SEGMENT_D = 0.089
/** Sticks snap FAST — knife whittles twice, any gun snaps in one. */
const SEGMENT_HP = 2
/** Plates split into runs about this long. */
const SEGMENT_RUN = 1.2

/**
 * Split the stud-line layout into charcoal-stick SEGMENTS: vertical lines
 * become 2-3 stacked sticks, plates become ~1.2 m runs, all at the real
 * lumber cross-section. The result is BOTH `target.segments` and (same
 * array) the legacy `target.studs` — one fixed-length member layer that
 * voxel-walls.tsx draws and shooting.ts snipes at, stick by stick.
 */
function buildSegments(wall: WallEntry, layout: StudMember[]): SegmentMember[] {
  const thickness = wall.node.thickness ?? 0.15
  const depth = Math.min(SEGMENT_D, Math.max(0.04, thickness - 0.02))
  const segments: SegmentMember[] = []
  for (const stud of layout) {
    const [sx, sy] = stud.size
    if (sy >= sx) {
      // Vertical stud line → stacked sticks.
      const pieces = sy > 1.6 ? 3 : sy > 0.8 ? 2 : 1
      const len = sy / pieces
      const bottom = stud.center[1] - sy / 2
      for (let i = 0; i < pieces; i++) {
        segments.push({
          id: segments.length,
          center: [stud.center[0], bottom + len * (i + 0.5), stud.center[2]],
          size: [SEGMENT_W, len - 0.012, depth],
          yaw: stud.yaw,
          hp: SEGMENT_HP,
          broken: false,
        })
      }
    } else {
      // Plate → flat sticks laid along the run (local +x is (cos yaw, sin yaw)).
      const pieces = Math.max(1, Math.round(sx / SEGMENT_RUN))
      const len = sx / pieces
      const cos = Math.cos(stud.yaw)
      const sin = Math.sin(stud.yaw)
      for (let i = 0; i < pieces; i++) {
        const t = (i + 0.5) * len - sx / 2
        segments.push({
          id: segments.length,
          center: [stud.center[0] + cos * t, stud.center[1], stud.center[2] + sin * t],
          size: [len - 0.012, SEGMENT_W, depth],
          yaw: stud.yaw,
          hp: SEGMENT_HP,
          broken: false,
        })
      }
    }
  }
  return segments
}

// ── Slab sandwich (MULTILEVEL-PLAN Phase B) ─────────────────────────────────

/** Node kinds that voxelize as the horizontal sandwich (thin axis = world
 * Y). 'floor' is defensive — hosts register floors as slabs today. */
const SLAB_KINDS = new Set(['slab', 'ceiling', 'floor'])

/** Synthesized plate thickness for ZERO-extent horizontals. Host ceiling
 * planes are 0 m thick; gridded isotropically they produce ~0.15 m cells
 * that interpenetrate the base row of any wall standing ON the plane, and
 * the structure probe's min-drop gate then rejects those hits as same-row
 * contact — upper walls "lose" their only underpinning the moment the
 * ceiling voxelizes anywhere and crumble (QA round 2, 2026-08-26). A
 * nominal plate hugging the plane from below keeps cell tops within a
 * couple cm of the surface, so walls bearing on the plane stay supported. */
const PLATE_SYNTH_T = 0.05
/** Toppings thinner than this carry no EMBEDDED framing (mirrors thin
 * walls)… */
const JOIST_EMBED_MIN = 0.12
/** …but a thin slab whose underside sits this far above the lot plane is a
 * real inter-storey floor — something must hold it up, so its joists HANG
 * below the topping (subfloor-over-joists). This makes the framing reveal
 * work on host-default 0.05 m slabs, which the slab inspector cannot
 * thicken today. Ceiling planes never frame (the floor above owns the
 * assembly's lumber). */
const ELEVATED_FLOOR_MIN_BASE = 1.0

/** Real joist lumber: 2×10 section (38 × 235 mm), 16" o.c. like the studs. */
const JOIST_W = 0.038
const JOIST_D = 0.235
const JOIST_SPACING = 0.4064
/** Joist tops sit this far below the slab's top surface (sheathing gap). */
const JOIST_TOP_DROP = 0.04

/**
 * Generate the slab's joist layer from its world AABB — 16" o.c. members
 * spanning the SHORT plan direction (real framing runs the short way), at
 * the real 38 × 235 mm section with tops at slabTop − 0.04. Long runs split
 * into ~1.2 m charcoal sticks exactly like wall plates, hp 2, so they chip,
 * snap, and splash-chip through the same segment machinery as studs. Thin
 * toppings (< JOIST_EMBED_MIN) carry no EMBEDDED framing, mirroring thin
 * walls — but with `hungBelow` (elevated inter-storey floors) the joists
 * frame at full depth with their TOPS at the slab underside instead, the
 * subfloor-over-joists picture a real thin floor deck presents from below.
 */
function buildJoists(bounds: Box3, thickness: number, hungBelow = false): SegmentMember[] {
  if (thickness < JOIST_EMBED_MIN && !hungBelow) return []
  bounds.getSize(_size)
  const alongX = _size.x <= _size.z // joists RUN along the short plan axis
  const runLength = (alongX ? _size.x : _size.z) - 0.04
  const spread = alongX ? _size.z : _size.x
  if (runLength < 0.3 || spread < 0.1) return []
  // Depth clamps just inside the sandwich (same spirit as wall segments) so
  // lumber never pokes proud of the ceiling skin on thin slabs; hung joists
  // frame at full depth below the deck.
  const depth = hungBelow
    ? JOIST_D
    : Math.min(JOIST_D, Math.max(0.06, thickness - JOIST_TOP_DROP - 0.01))
  const centerY = hungBelow
    ? bounds.min.y - depth / 2
    : bounds.max.y - JOIST_TOP_DROP - depth / 2
  const yaw = alongX ? 0 : Math.PI / 2 // local +x maps to (cos yaw, sin yaw)
  const midRun = alongX ? (bounds.min.x + bounds.max.x) / 2 : (bounds.min.z + bounds.max.z) / 2
  const segments: SegmentMember[] = []
  const count = Math.max(2, Math.floor(spread / JOIST_SPACING) + 1)
  const pieces = Math.max(1, Math.round(runLength / SEGMENT_RUN))
  const len = runLength / pieces
  for (let i = 0; i < count; i++) {
    const t = Math.min(1, (i * JOIST_SPACING) / spread)
    const s = (alongX ? bounds.min.z : bounds.min.x) + spread * t
    for (let p = 0; p < pieces; p++) {
      const run = midRun + ((p + 0.5) / pieces - 0.5) * runLength
      segments.push({
        id: segments.length,
        center: alongX ? [run, centerY, s] : [s, centerY, run],
        size: [len - 0.012, depth, JOIST_W],
        yaw,
        hp: SEGMENT_HP,
        broken: false,
      })
    }
  }
  return segments
}

/** Real-world drywall board footprint the logical sheets tile at. */
const SHEET_W = 1.2
const SHEET_H = 2.4
/** A sheet flies off once this fraction of its cells is torn out… */
const SHEET_FLY_TORN = 0.25
/** …or on its SHEET_FLY_HITS'th carve once the board is genuinely opened
 * (SHEET_FLY_MIN_TORN). Tuned against the headless battery: one pistol
 * tear is ~16-20% of a board, and follow-up shots mostly slip through the
 * hole they made — so a board that's already open dies on its very next
 * hit (drywall dies FAST), while a long shallow line cut across many
 * sheets (~11% each) still crumbles via the island pass instead of
 * shedding every board it nicked. */
const SHEET_FLY_HITS = 2
const SHEET_FLY_MIN_TORN = 0.15

const EMPTY_SHEET_MAP = new Int32Array(0)

/** Thickness axis of a layered grid: the axis with the smallest PHYSICAL
 * extent (span × cell) — the same rule dropInteriorCells skins by, shared
 * by the sheet builder and the entry-skin resolver so they can never
 * disagree about which way a wall is thin. */
function thicknessAxisOf(grid: VoxelGridData): 0 | 1 | 2 {
  let t: 0 | 1 | 2 = 0
  let extent = grid.nx * grid.cellX
  if (grid.ny * grid.cellY < extent) {
    t = 1
    extent = grid.ny * grid.cellY
  }
  if (grid.nz * grid.cellZ < extent) t = 2
  return t
}

/**
 * Group a wall grid's skin voxels into logical drywall sheets: split by
 * face (side of the thickness axis — the axis with the smallest physical
 * extent, same rule as dropInteriorCells), then tile ~1.2 m along the wall
 * run and ~2.4 m up. Remainder tiles merge into their neighbor so no sliver
 * sheets exist. Works on yaw-local grids too — tiling runs on grid coords,
 * centers/normals come out world-space.
 */
function buildSheets(grid: VoxelGridData): { sheets: SheetMember[]; sheetByCell: Int32Array } {
  const sheets: SheetMember[] = []
  const sheetByCell = new Int32Array(grid.count).fill(-1)
  if (grid.count === 0) return { sheets, sheetByCell }
  const spans = [grid.nx, grid.ny, grid.nz]
  const cells = [grid.cellX, grid.cellY, grid.cellZ]
  // Thickness axis: smallest physical extent. Run axis: the other plan
  // axis; vertical axis: y (unless the target lies flat — then z stands in).
  const t = thicknessAxisOf(grid)
  const u = t === 0 ? 2 : 0
  const v = t === 1 ? 2 : 1
  const tileU = Math.max(1, Math.round(SHEET_W / cells[u]!))
  const tileV = Math.max(1, Math.round(SHEET_H / cells[v]!))
  const nTilesU = Math.max(1, Math.round(spans[u]! / tileU))
  const nTilesV = Math.max(1, Math.round(spans[v]! / tileV))

  const groups = new Map<number, number[]>()
  for (let i = 0; i < grid.count; i++) {
    const side = grid.coords[i * 3 + t]! * 2 < spans[t]! - 1 ? 0 : 1
    const tu = Math.min(nTilesU - 1, Math.floor(grid.coords[i * 3 + u]! / tileU))
    const tv = Math.min(nTilesV - 1, Math.floor(grid.coords[i * 3 + v]! / tileV))
    const key = (side * nTilesV + tv) * nTilesU + tu
    let list = groups.get(key)
    if (!list) groups.set(key, (list = []))
    list.push(i)
  }

  const cos = Math.cos(grid.yaw)
  const sin = Math.sin(grid.yaw)
  for (const [key, list] of groups) {
    const side = Math.floor(key / (nTilesU * nTilesV))
    let cx = 0
    let cy = 0
    let cz = 0
    const min = [Infinity, Infinity, Infinity]
    const max = [-Infinity, -Infinity, -Infinity]
    for (const i of list) {
      cx += grid.centers[i * 3]!
      cy += grid.centers[i * 3 + 1]!
      cz += grid.centers[i * 3 + 2]!
      for (let a = 0; a < 3; a++) {
        const c = grid.coords[i * 3 + a]!
        if (c < min[a]!) min[a] = c
        if (c > max[a]!) max[a] = c
      }
    }
    // Outward face normal: the ± thickness axis in the grid's local frame,
    // rotated out to world (same local→world convention as grid centers).
    const sign = side === 0 ? -1 : 1
    let nX = 0
    let nY = 0
    let nZ = 0
    if (t === 0) {
      nX = cos * sign
      nZ = sin * sign
    } else if (t === 1) {
      nY = sign
    } else {
      nX = -sin * sign
      nZ = cos * sign
    }
    const id = sheets.length
    for (const i of list) sheetByCell[i] = id
    sheets.push({
      id,
      center: [cx / list.length, cy / list.length, cz / list.length],
      size: [
        (max[0]! - min[0]! + 1) * cells[0]!,
        (max[1]! - min[1]! + 1) * cells[1]!,
        (max[2]! - min[2]! + 1) * cells[2]!,
      ],
      yaw: grid.yaw,
      side,
      normal: [nX, nY, nZ],
      hits: 0,
      torn: 0,
      cellCount: list.length,
      flownOff: false,
      cells: list,
    })
  }
  return { sheets, sheetByCell }
}

function targetBaseColor(meshes: Mesh[]): Color {
  for (const mesh of meshes) {
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    const color = (material as { color?: Color } | undefined)?.color
    if (color) return color.clone()
  }
  return new Color('#d8d2c7')
}

/**
 * Voxelize ANY collider group on first damage; hides the host meshes via
 * the session ledger. Walls (world.walls) become two drywall skins with
 * breakable studs in the cavity; every other node type (doors, slabs,
 * roofs, items…) becomes a plain adaptive volume capped at 1600 voxels.
 */
export function ensureVoxelTarget(world: GameWorld, nodeId: string): VoxelTarget | null {
  const state = useDestruction.getState()
  const existing = state.targets.get(nodeId)
  if (existing) return existing

  const wall = world.walls.get(nodeId)
  const meshes: Mesh[] = []
  let nodeType: string | null = null
  if (wall) {
    meshes.push(...wall.meshes)
  } else {
    for (const collider of world.colliders) {
      if (collider.nodeId !== nodeId) continue
      nodeType ??= collider.nodeType
      if (!meshes.includes(collider.mesh)) meshes.push(collider.mesh)
    }
  }
  if (meshes.length === 0) return null

  _bounds.makeEmpty()
  const sources = meshes.map((mesh) => {
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
    const box = mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld)
    _bounds.union(box)
    return { bvh: bvhFor(mesh), matrixWorld: mesh.matrixWorld }
  })
  if (_bounds.isEmpty()) return null

  let grid: ReturnType<typeof buildVoxelGrid>
  let kind: VoxelTarget['kind'] = wall ? 'wall' : 'volume'
  let slabThickness = 0
  let slabJoistsHang = false
  if (wall) {
    // Wall anatomy needs ≥ 3 layers across the thickness so the two drywall
    // skins survive dropInteriorCells with a real cavity between them —
    // typical walls (0.10–0.15 m) are ONE 0.15 m cell thick otherwise. Pin
    // the thickness axis (the thin horizontal world extent) to thickness/3
    // cells: 0.03–0.05 m skins, ~0.15 m cells along length/height. Diagonal
    // walls have no thin world axis and keep the legacy isotropic grid.
    _bounds.getSize(_size)
    const thicknessAxis = _size.x <= _size.z ? 'x' : 'z'
    const extent = thicknessAxis === 'x' ? _size.x : _size.z
    if (extent > 0.001 && extent <= MAX_ANATOMY_THICKNESS) {
      const layers = Math.max(3, Math.ceil(extent / 0.15 - 1e-6))
      const thicknessCell = extent / layers
      grid = dropInteriorCells(
        buildVoxelGrid(
          sources,
          _bounds.clone(),
          0.15,
          false,
          thicknessAxis === 'x' ? { x: thicknessCell } : { z: thicknessCell },
        ),
        MAX_ANATOMY_THICKNESS,
      )
    } else {
      // Diagonal walls have no thin world axis: their AABB is metres deep on
      // both plan axes, so the min-extent axis dropInteriorCells would pick
      // is the wall HEIGHT — skinning the world grid deletes the whole wall
      // body. Build the same anatomy in the wall's yaw-local frame instead;
      // degenerate segments keep the full isotropic volume.
      grid = buildDiagonalWallGrid(wall, sources) ?? buildVoxelGrid(sources, _bounds.clone(), 0.15, false)
    }
  } else if (nodeType !== null && SLAB_KINDS.has(nodeType)) {
    // SLAB SANDWICH — the wall anatomy rotated onto its side: the thickness
    // axis is world Y (slabs are horizontal, thickness grows DOWNWARD from
    // the level elevation), pinned to thickness/layers cells so
    // dropInteriorCells leaves the top (sheathing) and bottom (ceiling)
    // skins with the joist cavity between. Plan cells stay ~0.3 m. Thick or
    // non-plate shapes (piers, ramps mis-kinded as slabs) keep the volume.
    _bounds.getSize(_size)
    let extent = _size.y
    if (extent <= 0.001 && Math.min(_size.x, _size.z) > PLATE_SYNTH_T * 2) {
      // Zero-extent plate (host ceiling planes): synthesize a nominal plate
      // hugging the surface from BELOW so it takes the sandwich lane — see
      // PLATE_SYNTH_T for why the isotropic volume grid must not win here.
      // max.y nudges up 5 mm so the surface sits strictly inside the top
      // cell layer (a face exactly on a cell boundary voxelizes flakily).
      _bounds.max.y += 0.005
      _bounds.min.y = _bounds.max.y - PLATE_SYNTH_T
      extent = PLATE_SYNTH_T
    }
    if (
      extent > 0.001 &&
      extent <= MAX_ANATOMY_THICKNESS &&
      extent < Math.min(_size.x, _size.z)
    ) {
      const layers = Math.max(3, Math.ceil(extent / 0.15 - 1e-6))
      const thicknessCell = Math.max(0.025, extent / layers)
      grid = dropInteriorCells(
        buildVoxelGrid(sources, _bounds.clone(), 0.3, false, { y: thicknessCell }),
        MAX_ANATOMY_THICKNESS,
      )
      if (grid.count > 0) {
        kind = 'slab'
        slabThickness = extent
        slabJoistsHang =
          nodeType !== 'ceiling' &&
          extent < JOIST_EMBED_MIN &&
          _bounds.min.y > ELEVATED_FLOOR_MIN_BASE
      } else {
        grid = buildVoxelGrid(sources, _bounds.clone(), 0.15, true)
      }
    } else {
      grid = buildVoxelGrid(sources, _bounds.clone(), 0.15, true)
    }
  } else {
    grid = buildVoxelGrid(sources, _bounds.clone(), 0.15, true)
  }
  if (grid.count === 0) return null

  const sheetInfo = kind !== 'volume' ? buildSheets(grid) : null
  // The stud-line layout is scaffolding only — the real members are the
  // stick segments split from it. `studs` aliases the SAME array. Slabs
  // frame with joists generated from their world box (mirror of the studs).
  const segments = wall
    ? buildSegments(wall, buildStuds(wall, grid))
    : kind === 'slab'
      ? buildJoists(_bounds, slabThickness, slabJoistsHang)
      : []
  const target: VoxelTarget = {
    nodeId,
    kind,
    grid,
    baseColor: targetBaseColor(meshes),
    segments,
    studs: segments,
    sheets: sheetInfo?.sheets ?? [],
    sheetByCell: sheetInfo?.sheetByCell ?? EMPTY_SHEET_MAP,
    removedQueue: [],
    revision: 0,
  }

  // Hide the host meshes through the keep-aware path: a wall's render mesh
  // is the scene-graph PARENT of its hosted door/window/item roots (the
  // host's WallRenderer nests them), so a plain `visible = false` would
  // cull live doors and windows along with the wall. Masking keeps them
  // rendering; every other node's own root is fenced the same way the
  // collect-time mesh sweep fences (world.solidRoots). The node's OWN root
  // must not fence its own hide.
  const keepRoots = new Set(world.solidRoots ?? [])
  if (wall) keepRoots.delete(wall.root)
  for (const collider of world.colliders) {
    if (collider.nodeId === nodeId) keepRoots.delete(collider.root)
  }
  for (const mesh of meshes) hideForGameKeepingRoots(mesh, keepRoots)
  for (const collider of world.colliders) {
    if (collider.nodeId === nodeId) collider.disabled = true
  }

  state.targets.set(nodeId, target)
  state.bump()
  // Cross-target support (Phase B3): record the target's world AABB so
  // carving it can wake the walls resting on it (structure.ts).
  registerStructureTarget(target, kind)
  return target
}

/** Legacy alias — works for any node kind now, not just walls. */
export const ensureVoxelWall = ensureVoxelTarget

const now: () => number =
  typeof performance !== 'undefined' ? () => performance.now() : () => Date.now()

/**
 * Pre-clad the scene's walls in voxels a few per tick, so the building
 * already reads voxel at session start instead of walls flipping on first
 * hit. Every wall goes through ensureVoxelTarget — host meshes hide and
 * colliders hand over IN THE SAME TICK a wall voxelizes, never later.
 * Returns true once every wall in the snapshot has a target; drive it from
 * a per-frame loop until then (game-root's Prevoxelize does).
 */
export function prevoxelizeTick(world: GameWorld, budgetMs = 4): boolean {
  const deadline = now() + budgetMs
  const targets = useDestruction.getState().targets
  for (const nodeId of world.walls.keys()) {
    if (targets.has(nodeId) || prevoxelizeSkip.has(nodeId)) continue
    if (now() >= deadline) return false
    if (!ensureVoxelTarget(world, nodeId)) {
      // Degenerate wall (no meshes / empty grid) — it can never voxelize,
      // so don't let it wedge the driver in a forever-false loop.
      prevoxelizeSkip.add(nodeId)
    }
  }
  return true
}

/** Walls ensureVoxelTarget refused (degenerate) — skipped on later ticks. */
const prevoxelizeSkip = new Set<string>()

const islandTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Scratch for the crumble remainder dust burst. */
const _crumbleDust = new Vector3()

/** Ground height under which a slab counts as terrain-borne (every cell
 * seeded — a patio slab never crumbles from carving its neighbors). */
const SLAB_GROUND_Y = 0.08
/** Lateral tolerance for the under-slab support probe: a cell column is
 * held up while a live collider top / live voxel cell sits within this XZ
 * distance just beneath the slab's underside. */
const SLAB_PROBE_XZ = 0.3
/** How far below the slab underside the probe looks for a bearing top. */
const SLAB_PROBE_DROP = 0.4

/** Debris pieces sampled per crumble EVENT — a slab region collapse can be
 * 700+ voxels, which would evict the whole 768-slot debris ring in one
 * frame. The rest of the material reads through one extra dust burst. */
const CRUMBLE_DEBRIS_CAP = 120

/**
 * Island support seeds for a HORIZONTAL sandwich: the grid's own base row
 * is the entire ceiling skin (thickness axis = Y), so "connected to iy 0"
 * would hold a slab up forever. Instead a cell is seeded while something
 * live stands just beneath its column: a non-disabled collider whose
 * worldBox top reaches the slab underside (within SLAB_PROBE_XZ laterally),
 * or a live voxel cell of another target up there (voxelized walls hand
 * their colliders over disabled — their alive cells ARE the wall). Ground
 * slabs are terrain-borne and fully seeded. Carve every wall away under a
 * slab region and that region's columns lose their seeds → the island
 * flood marks the region unsupported → it crumbles.
 */
export function slabSeedPredicate(world: GameWorld, target: VoxelTarget): (i: number) => boolean {
  const grid = target.grid
  const bottomY = grid.origin.y
  if (bottomY <= SLAB_GROUND_Y) return () => true

  // Live collider tops that reach the slab underside, XZ-expanded by the
  // probe tolerance.
  const boxes: Array<{ minX: number; maxX: number; minZ: number; maxZ: number }> = []
  for (const collider of world.colliders) {
    if (collider.disabled || collider.nodeId === target.nodeId) continue
    const top = collider.worldBox.max.y
    if (top < bottomY - SLAB_PROBE_DROP || top > bottomY + SLAB_PROBE_XZ) continue
    if (collider.worldBox.min.y > bottomY) continue
    boxes.push({
      minX: collider.worldBox.min.x - SLAB_PROBE_XZ,
      maxX: collider.worldBox.max.x + SLAB_PROBE_XZ,
      minZ: collider.worldBox.min.z - SLAB_PROBE_XZ,
      maxZ: collider.worldBox.max.z + SLAB_PROBE_XZ,
    })
  }

  // Live voxel cells of OTHER targets near the underside → coarse XZ hash.
  const supportCells = new Set<number>()
  const h = SLAB_PROBE_XZ
  const hashOf = (x: number, z: number) =>
    Math.round(x / h) * 73856093 + Math.round(z / h) * 19349663
  for (const other of useDestruction.getState().targets.values()) {
    if (other === target || other.grid.aliveCount === 0) continue
    const og = other.grid
    for (let j = 0; j < og.count; j++) {
      if (!og.alive[j]) continue
      const cy = og.centers[j * 3 + 1]!
      if (cy < bottomY - SLAB_PROBE_DROP || cy > bottomY + 0.05) continue
      supportCells.add(hashOf(og.centers[j * 3]!, og.centers[j * 3 + 2]!))
    }
  }

  return (i: number) => {
    const x = grid.centers[i * 3]!
    const z = grid.centers[i * 3 + 2]!
    for (const box of boxes) {
      if (x >= box.minX && x <= box.maxX && z >= box.minZ && z <= box.maxZ) return true
    }
    if (supportCells.size === 0) return false
    // 3×3 hash neighborhood ≈ "within SLAB_PROBE_XZ of a live cell".
    const bx = Math.round(x / h)
    const bz = Math.round(z / h)
    for (let ax = -1; ax <= 1; ax++) {
      for (let az = -1; az <= 1; az++) {
        if (supportCells.has((bx + ax) * 73856093 + (bz + az) * 19349663)) return true
      }
    }
    return false
  }
}

function crumbleIslands(world: GameWorld, target: VoxelTarget): void {
  const islands = findUnsupportedIslands(
    target.grid,
    target.kind === 'slab' ? slabSeedPredicate(world, target) : undefined,
  )
  if (islands.length === 0) return
  let total = 0
  const fallen: number[] = []
  for (const island of islands) {
    for (const idx of island) {
      if (!target.grid.alive[idx]) continue
      total++
      target.grid.alive[idx] = 0
      target.grid.aliveCount--
      target.removedQueue.push(idx)
      fallen.push(idx)
      // Sheet bookkeeping only (torn cells) — crumbles never count as hits
      // and never trigger a fly-off; the cells are already gone.
      const sheetId = target.sheetByCell[idx]
      if (sheetId !== undefined && sheetId >= 0) target.sheets[sheetId]!.torn++
    }
  }
  // Debris SAMPLING (Phase B): a big region collapse must not flood the
  // global ring 1-per-voxel — spawn at most CRUMBLE_DEBRIS_CAP pieces
  // sampled uniformly across the fallen cells; the unsampled remainder
  // reads through one extra dust burst below.
  const spawnCount = Math.min(fallen.length, CRUMBLE_DEBRIS_CAP)
  for (let n = 0; n < spawnCount; n++) {
    const idx =
      fallen.length <= CRUMBLE_DEBRIS_CAP
        ? fallen[n]!
        : fallen[Math.floor(Math.random() * fallen.length)]!
    spawnDebris(
      target.grid.centers[idx * 3]!,
      target.grid.centers[idx * 3 + 1]!,
      target.grid.centers[idx * 3 + 2]!,
      target.grid.cell,
      target.baseColor,
      1.6,
    )
  }
  if (fallen.length > spawnCount) {
    const mid = fallen[Math.floor(fallen.length / 2)]!
    _crumbleDust.set(
      target.grid.centers[mid * 3]!,
      target.grid.centers[mid * 3 + 1]!,
      target.grid.centers[mid * 3 + 2]!,
    )
    spawnDust(_crumbleDust, 1, { kind: target.kind === 'volume' ? 'concrete' : 'drywall' })
  }
  target.revision++
  useDestruction.getState().bump()
  // One lingering haze plume per collapse, rising from the first lost voxel.
  const first = islands[0]?.[0]
  if (first !== undefined) {
    spawnHaze(
      target.grid.centers[first * 3]!,
      target.grid.centers[first * 3 + 1]!,
      target.grid.centers[first * 3 + 2]!,
    )
  }
  // Broken framing in the collapse → wood-laced rubble; pure drywall otherwise.
  let framingGone = false
  for (const stud of target.studs) {
    if (stud.broken) {
      framingGone = true
      break
    }
  }
  if (framingGone) sfx.woodCrumble(total)
  else sfx.crumble(total)
  // An island crumble can take the LAST cladding cells with it.
  maybeSkeletonSnap(target)
  // Material left the world — walls resting on this target must re-probe.
  noteStructureCarve(world, target.nodeId)
}

// ── Cross-target support collapse (MULTILEVEL-PLAN Phase B3) ────────────────
// structure.ts owns the "what rests on what" bookkeeping and the staggered
// cascade tick; this module supplies its two runtime needs — the live target
// map and the whole-target crumble below — via the injected driver (keeps
// structure.ts free of runtime imports from here).

/**
 * Structural collapse of an ENTIRE target — the support cascade's crumble
 * path ("destroying what holds a thing up drops it"): every live cell dies
 * through the same bookkeeping as an island crumble, debris SAMPLED
 * (≤ CRUMBLE_DEBRIS_CAP, never 1:1), one haze plume, and the bare frame
 * rains down via maybeSkeletonSnap. settleSupportAfterRemoval then tells
 * the builder piece graph (piece-slots.notifySceneSupportChanged →
 * SupportGraph.probeExternal re-check), so placed pieces standing on the
 * crumbled host wall fall too. Returns how many cells fell.
 */
export function collapseWholeTarget(nodeId: string): number {
  const target = useDestruction.getState().targets.get(nodeId)
  if (!target || target.grid.aliveCount === 0) return 0
  const { grid } = target
  const total = grid.aliveCount
  const debrisChance = Math.min(1, CRUMBLE_DEBRIS_CAP / total)
  let first = -1
  for (let idx = 0; idx < grid.count; idx++) {
    if (!grid.alive[idx]) continue
    grid.alive[idx] = 0
    grid.aliveCount--
    target.removedQueue.push(idx)
    if (first < 0) first = idx
    // Sheet bookkeeping only (torn cells) — same rule as island crumbles.
    const sheetId = target.sheetByCell[idx]
    if (sheetId !== undefined && sheetId >= 0) target.sheets[sheetId]!.torn++
    if (Math.random() < debrisChance) {
      spawnDebris(
        grid.centers[idx * 3]!,
        grid.centers[idx * 3 + 1]!,
        grid.centers[idx * 3 + 2]!,
        grid.cell,
        target.baseColor,
        1.6,
      )
    }
  }
  target.revision++
  useDestruction.getState().bump()
  // Nothing is left for a pending island pass to find.
  const timer = islandTimers.get(nodeId)
  if (timer !== undefined) {
    clearTimeout(timer)
    islandTimers.delete(nodeId)
  }
  if (first >= 0) {
    spawnHaze(grid.centers[first * 3]!, grid.centers[first * 3 + 1]!, grid.centers[first * 3 + 2]!)
  }
  let framingGone = false
  for (const stud of target.studs) {
    if (stud.broken) {
      framingGone = true
      break
    }
  }
  if (framingGone) sfx.woodCrumble(total)
  else sfx.crumble(total)
  maybeSkeletonSnap(target) // the whole frame rains down top-first
  settleSupportAfterRemoval(target) // piece-graph notification (goal 3)
  return total
}

// Inject the structure ticker's runtime needs (see structure.StructureDriver).
wireStructureDriver({
  targets: () => useDestruction.getState().targets,
  collapse: collapseWholeTarget,
})

const _sheetCenter = new Vector3()
/** Scratch launch direction for fly-off shards (the sheet's outward normal). */
const _shardDir = { x: 0, y: 0, z: 0 }
const _sheetNormal = new Vector3()

/**
 * The WHOLE remaining sheet tears off the wall in one go: every live cell
 * dies (queued for the renderer like any removal), shreds fly, one massive
 * plume erupts out of the face, paper-tear + crumble voice it. Caller bumps
 * happen here so a fly-off inside a carve still uploads this frame.
 */
function flySheetOff(target: VoxelTarget, sheet: SheetMember, direction?: Vector3): void {
  sheet.flownOff = true
  let freed = 0
  for (const idx of sheet.cells) {
    if (!target.grid.alive[idx]) continue
    target.grid.alive[idx] = 0
    target.grid.aliveCount--
    target.removedQueue.push(idx)
    sheet.torn++
    freed++
  }
  target.revision++
  useDestruction.getState().bump()
  // Shreds — torn-edge PLATES (debris.tsx's flat flutter path) sampled
  // across the sheet's own cells: the board leaves as ragged paper, not
  // cubes. A couple of cube crumbs keep some weight in the fall. Shards
  // launch along the sheet's OUTWARD normal — a ceiling board torn from
  // below rains DOWN through the hole instead of popping up (Phase B).
  if (sheet.cells.length > 0) {
    _shardDir.x = sheet.normal[0]
    _shardDir.y = sheet.normal[1]
    _shardDir.z = sheet.normal[2]
    const plates = Math.min(12, 5 + Math.round(freed / 10))
    for (let n = 0; n < plates; n++) {
      const idx = sheet.cells[Math.floor(Math.random() * sheet.cells.length)]!
      spawnFlatDebris(
        target.grid.centers[idx * 3]!,
        target.grid.centers[idx * 3 + 1]!,
        target.grid.centers[idx * 3 + 2]!,
        0.18 + Math.random() * 0.3,
        0.22 + Math.random() * 0.34,
        target.baseColor,
        _shardDir,
      )
    }
    for (let n = 0; n < 3; n++) {
      const idx = sheet.cells[Math.floor(Math.random() * sheet.cells.length)]!
      spawnDebris(
        target.grid.centers[idx * 3]!,
        target.grid.centers[idx * 3 + 1]!,
        target.grid.centers[idx * 3 + 2]!,
        target.grid.cell * (0.7 + Math.random() * 0.6),
        target.baseColor,
        2.2,
        3.2,
        _shardDir,
      )
    }
  }
  _sheetCenter.set(sheet.center[0], sheet.center[1], sheet.center[2])
  _sheetNormal.set(sheet.normal[0], sheet.normal[1], sheet.normal[2])
  spawnDust(_sheetCenter, 1, {
    // Material tag (phase 4): a whole board leaving IS the heavy-drywall
    // case — dust.tsx upgrades intensity-1 drywall to a plume + auto haze.
    kind: 'drywall',
    normal: _sheetNormal,
    direction: direction ? _plumeDir.copy(direction) : undefined,
  })
  sfx.paperTear()
  sfx.crumble(freed)
  // A whole board leaving can take the LAST cladding cells with it.
  maybeSkeletonSnap(target)
}

/**
 * Per-carve sheet accounting: every removed cell bumps its sheet's `torn`,
 * every sheet the carve touched takes one `hit`, and any sheet past the
 * fly-off thresholds (see SHEET_FLY_*) tears off wholesale. This is what
 * makes drywall die FAST: two pistol rounds into one board and the entire
 * board leaves the wall.
 */
function noteSheetCarve(target: VoxelTarget, removed: number[], direction?: Vector3): void {
  if (target.sheets.length === 0) return
  const touched = new Set<SheetMember>()
  for (const idx of removed) {
    const sheetId = target.sheetByCell[idx]
    if (sheetId === undefined || sheetId < 0) continue
    const sheet = target.sheets[sheetId]!
    sheet.torn++
    touched.add(sheet)
  }
  for (const sheet of touched) {
    if (sheet.flownOff) continue
    sheet.hits++
    const tornFrac = sheet.torn / sheet.cellCount
    if (
      tornFrac >= SHEET_FLY_TORN ||
      (sheet.hits >= SHEET_FLY_HITS && tornFrac >= SHEET_FLY_MIN_TORN)
    ) {
      flySheetOff(target, sheet, direction)
    }
  }
}

/** Heavy-weapon gate for the skin-respecting carve: tears at least this
 * wide punch BOTH drywall skins in one hit. Every current weapon's wall
 * tearRadius (weapons.ts, ≤ 0.55) stays under it, so the far skin always
 * survives the first shot and only falls to a follow-up through the hole —
 * a future heavy (tearRadius ≥ 0.6) blows straight through. */
const WALL_PIERCE_RADIUS = 0.6

/**
 * Which drywall skin a carve entered — the pierce-through fix. The hit
 * point sits ON the face the shot struck (mesh surface on first blood, DDA
 * voxel face afterwards), so its continuous coordinate along the thickness
 * axis lands in that skin's half of the grid. Only layered anatomy grids
 * (anisotropic — a pinned thickness cell: cellX ≠ cellZ for walls, cellY
 * pinned for slab sandwiches) have skins; isotropic fallbacks return null
 * and carve the full volume as before.
 */
const _skin: SkinLimit = { axis: 0, side: 0 }

function entrySkin(grid: VoxelGridData, x: number, y: number, z: number): SkinLimit | null {
  if (grid.cellX === grid.cellZ && grid.cellY === grid.cellX) return null
  const axis = thicknessAxisOf(grid)
  // Yaw grids index in their local frame — rotate the query point in.
  let px = x
  let pz = z
  if (grid.yaw !== 0) {
    const cos = Math.cos(grid.yaw)
    const sin = Math.sin(grid.yaw)
    px = x * cos + z * sin
    pz = -x * sin + z * cos
  }
  const p = axis === 0 ? px : axis === 1 ? y : pz
  const origin = axis === 0 ? grid.origin.x : axis === 1 ? grid.origin.y : grid.origin.z
  const cell = axis === 0 ? grid.cellX : axis === 1 ? grid.cellY : grid.cellZ
  const span = axis === 0 ? grid.nx : axis === 1 ? grid.ny : grid.nz
  const c = (p - origin) / cell
  _skin.axis = axis
  _skin.side = c * 2 < span ? 0 : 1
  return _skin
}

/**
 * Carve splash → framing chips. A gunshot that tears drywall also scuffs
 * the lumber standing inside the tear: every unbroken stick whose long
 * axis passes within the carve sphere loses 1 hp — but NEVER snaps (the
 * hp-1 floor). Snapping stays a direct privilege: ray crossings
 * (damageSegment at weapon damage) and blasts (explosionSegments). With
 * 16" o.c. spacing and rifle/pistol tear radii (0.55/0.45 m), opening a
 * bay from mid-span chips the flanking stick each side while the next
 * studs over stay clean.
 */
function chipSegmentSplash(target: VoxelTarget, point: Vector3, radius: number): void {
  if (target.segments.length === 0) return
  const r2 = radius * radius
  let voiced = false
  for (const segment of target.segments) {
    if (segment.broken || segment.hp <= 1) continue
    const [sx, sy, sz] = segment.size
    const long = Math.max(sx, sy, sz)
    // Long-axis direction: verticals point up, plates run along their yaw.
    let ax = 0
    let ay = 1
    let az = 0
    if (sy < long) {
      ax = Math.cos(segment.yaw)
      ay = 0
      az = Math.sin(segment.yaw)
    }
    // Distance from the carve point to the stick's axis segment.
    const dx = point.x - segment.center[0]
    const dy = point.y - segment.center[1]
    const dz = point.z - segment.center[2]
    const half = long / 2
    let t = dx * ax + dy * ay + dz * az
    if (t > half) t = half
    else if (t < -half) t = -half
    const ox = dx - ax * t
    const oy = dy - ay * t
    const oz = dz - az * t
    if (ox * ox + oy * oy + oz * oz > r2) continue
    segment.hp -= 1 // floor is 1 — the hp<=1 guard above keeps splash sub-lethal
    // A couple of splinters flick off the scuffed edge (closest point on
    // the stick), so the chip reads without any dust (wood contract).
    for (let i = 0; i < 2; i++) {
      spawnDebris(
        segment.center[0] + ax * t,
        segment.center[1] + ay * t,
        segment.center[2] + az * t,
        0.015 + Math.random() * 0.02,
        WOOD,
        1.8,
        0.8,
      )
    }
    voiced = true
  }
  // One knock per carve no matter how many sticks scuffed.
  if (voiced) sfx.studHit()
}

// ── Build-grammar v2 slot wiring (phase 5) ──────────────────────────────────
// Destruction is the third door pieces leave through (undo Z and the support
// cascade are the other two) and the only event that changes what the SCENE
// can prop up. Every voxel-removal path funnels through
// settleSupportAfterRemoval:
//   placed piece (nodeId `__boots-piece-*`) fully dead → the SAME cleanup
//     as undo: store removal (unmount splices the collider + dropTarget)
//     then piece-slots.onPieceRemoved (died-slot lockout + orphan cascade);
//   scene geometry → debounced piece-slots.notifySceneSupportChanged(), so
//     pieces propped by a demolished scene wall re-check and fall.

/** Collider nodeId prefix builder.tsx gives placed pieces (kept in sync). */
const PLACED_PIECE_PREFIX = '__boots-piece-'
/** Debounce for the scene-support sweep — matches the island/structure
 * settle rhythm so one burst of carves pays for one re-probe. */
const SCENE_SUPPORT_SETTLE_MS = 160
let sceneSupportTimer: ReturnType<typeof setTimeout> | null = null

function settleSupportAfterRemoval(target: VoxelTarget): void {
  if (target.nodeId.startsWith(PLACED_PIECE_PREFIX)) {
    if (target.grid.aliveCount > 0) return
    const pieceId = Number(target.nodeId.slice(PLACED_PIECE_PREFIX.length))
    if (!Number.isFinite(pieceId)) return
    // Store removal first (undo-ordering contract): unmounting the mesh
    // splices its collider entry and drops this voxel replica. No debris
    // burst here — the carve that killed it already threw its own.
    useBoots.getState().removePlaced(pieceId)
    const slotId = slotOf(pieceId)
    if (slotId) onPieceRemoved(slotId) // lockout stamp + BFS-ring cascade
    return
  }
  if (sceneSupportTimer !== null) return
  sceneSupportTimer = setTimeout(() => {
    sceneSupportTimer = null
    notifySceneSupportChanged()
  }, SCENE_SUPPORT_SETTLE_MS)
}

/** Carve a sphere out of any target at a world point (voxelizes on first
 * hit); spawns debris, queues the island check. Returns how many voxels
 * were removed. `direction` (optional, phase 3) is the shot direction —
 * it aims the wall-tear dust plume through the hole.
 *
 * Walls AND slabs carve SKIN-RESPECTING: below WALL_PIERCE_RADIUS the
 * sphere only removes cells of the face the shot entered (resolved from the
 * hit point), so a 0.12 m wall never loses both skins to one rifle round —
 * and shooting a ceiling from below never deletes the floor sheathing
 * above it. The far face falls to the next shot through the hole, or to a
 * heavy weapon whose tearRadius clears the pierce gate. */
export function damageTarget(
  world: GameWorld,
  nodeId: string,
  point: Vector3,
  radius: number,
  direction?: Vector3,
): number {
  const target = ensureVoxelTarget(world, nodeId)
  if (!target) return 0
  // Slabs ride the whole wall lane: skin-respecting pierce gate, drywall
  // dust + paper shards, sheet fly-offs, framing splash-chips.
  const layered = target.kind !== 'volume'
  const skin =
    layered && radius < WALL_PIERCE_RADIUS
      ? entrySkin(target.grid, point.x, point.y, point.z)
      : null
  const removed = removeSphere(
    target.grid,
    point.x,
    point.y,
    point.z,
    radius,
    skin ?? undefined,
  )
  if (removed.length === 0) return 0
  target.removedQueue.push(...removed)
  target.revision++
  useDestruction.getState().bump()
  const debrisCount = Math.min(removed.length, 10)
  for (let i = 0; i < debrisCount; i++) {
    const idx = removed[Math.floor(Math.random() * removed.length)]!
    spawnDebris(
      target.grid.centers[idx * 3]!,
      target.grid.centers[idx * 3 + 1]!,
      target.grid.centers[idx * 3 + 2]!,
      target.grid.cell * (0.6 + Math.random() * 0.5),
      target.baseColor,
      2.6,
    )
  }
  // Dust (single-emission policy: this module owns ALL wall carve dust —
  // shooting.ts is deliberately silent for walls). Drywall tears throw a
  // MASSIVE billowing plume coned through the hole; plain volumes keep a
  // modest puff scaled by how much material the carve took out.
  if (layered) {
    // Material tag (phase 4): 'drywall' puffs on light grazes and upgrades
    // to the full plume (+ auto haze) once the carve is heavy (≥ ~5 cells).
    // Slabs voice the same way — the shot face is drywall (ceiling) or
    // sheathing, both papery.
    spawnDust(point, Math.min(1, 0.45 + removed.length / 18), {
      kind: 'drywall',
      direction: direction ? _plumeDir.copy(direction) : undefined,
    })
    // A few small torn-edge paper shards flutter off the hole's rim —
    // drywall reads as tearing plates, not popping cubes.
    const shards = Math.min(3, 1 + (removed.length >> 3))
    for (let n = 0; n < shards; n++) {
      const idx = removed[Math.floor(Math.random() * removed.length)]!
      spawnFlatDebris(
        target.grid.centers[idx * 3]!,
        target.grid.centers[idx * 3 + 1]!,
        target.grid.centers[idx * 3 + 2]!,
        0.1 + Math.random() * 0.16,
        0.12 + Math.random() * 0.2,
        target.baseColor,
      )
    }
    // Sheet accounting (hits + torn cells) — may fly whole sheets off.
    noteSheetCarve(target, removed, direction)
    // Splash chips the framing standing in the tear (hp-1 floor — see
    // chipSegmentSplash; only direct hits and blasts snap sticks).
    chipSegmentSplash(target, point, radius)
  } else {
    // Material tag (phase 4): plain volumes voice as CONCRETE — small,
    // short-lived, grayer puffs (dust.tsx owns the styling).
    spawnDust(point, Math.min(1, 0.25 + removed.length / 30), {
      kind: 'concrete',
      direction: direction ? _plumeDir.copy(direction) : undefined,
    })
  }
  // Walls/slabs get the papery drywallCrunch from shooting.ts; only plain
  // volumes voice their own crunch here (avoids the two sounds layering).
  if (!layered) sfx.voxelCrunch(Math.min(1, removed.length / 12))

  const prior = islandTimers.get(nodeId)
  if (prior) clearTimeout(prior)
  islandTimers.set(
    nodeId,
    setTimeout(() => {
      islandTimers.delete(nodeId)
      crumbleIslands(world, target)
      settleSupportAfterRemoval(target) // island crumble can zero a piece
    }, 140),
  )
  // Cladding all gone? The bare frame can't stand — skeleton snap.
  maybeSkeletonSnap(target)
  settleSupportAfterRemoval(target)
  // Cross-target support (Phase B3): whatever rested on this target must
  // re-probe its footing once the carve settles.
  noteStructureCarve(world, nodeId)
  return removed.length
}

/** Legacy alias. */
export const damageWall = damageTarget

/** True when a node carves through the WALL/SLAB tear lane — shooting.ts
 * resolves `weapon.tearRadius` (and voices the drywall crunch) off this:
 * an existing layered target, a scene wall, or a not-yet-voxelized
 * slab-kind collider (first shot must already tear at full width). */
export function isTearLaneNode(world: GameWorld, nodeId: string): boolean {
  const target = useDestruction.getState().targets.get(nodeId)
  if (target) return target.kind !== 'volume'
  if (world.walls.has(nodeId)) return true
  for (const collider of world.colliders) {
    if (collider.nodeId === nodeId) return SLAB_KINDS.has(collider.nodeType)
  }
  return false
}

/**
 * One-shot landing-plane resolve for debris/dust ("floors for things",
 * MULTILEVEL-PLAN Phase B polish): the HIGHEST live surface at or below
 * (x, y, z) — a live (non-disabled) collider top, a live voxel cell of any
 * target (downward DDA), else the lot's terrain plane at y = 0. Colliders
 * whose top is above the probe point are skipped (a probe from inside a
 * wall's box must not "land" on that wall's top), and voxelized nodes are
 * covered by their grids since voxelization disables the host collider.
 * Called once per debris piece (at apex) / dust burst — never per frame.
 */
export function probeLandingY(world: GameWorld, x: number, y: number, z: number): number {
  let best = 0
  for (const collider of world.colliders) {
    if (collider.disabled) continue
    const box = collider.worldBox
    const top = box.max.y
    if (top <= best || top > y + 0.02) continue
    if (x < box.min.x - 0.02 || x > box.max.x + 0.02) continue
    if (z < box.min.z - 0.02 || z > box.max.z + 0.02) continue
    best = top
  }
  for (const target of useDestruction.getState().targets.values()) {
    const grid = target.grid
    if (grid.aliveCount === 0) continue
    const reach = y + 0.01 - best
    if (reach <= 0) break
    const hit = raycastVoxels(grid, x, y + 0.01, z, 0, -1, 0, reach)
    // distance ≥ 0.02 rejects "probe point already inside a live cell"
    // (a piece would otherwise freeze at its own apex height).
    if (hit && hit.distance >= 0.02) {
      const top = y + 0.01 - hit.distance
      if (top > best) best = top
    }
  }
  return best
}

export type SegmentRayHit = {
  nodeId: string
  segmentId: number
  /** Legacy alias of segmentId — old stud-lane callers read this. */
  studId: number
  distance: number
  point: Vector3
}
/** Legacy alias. */
export type StudRayHit = SegmentRayHit

/** Nearest live (unbroken) framing segment any voxelized wall exposes along
 * the ray — analytic ray-vs-OBB, no meshes involved. */
export function raycastSegments(
  origin: Vector3,
  direction: Vector3,
  maxDist: number,
): SegmentRayHit | null {
  let bestDist = maxDist
  let bestNode: string | null = null
  let bestSegment = -1
  for (const target of useDestruction.getState().targets.values()) {
    for (const segment of target.segments) {
      if (segment.broken) continue
      const t = raycastYawObb(
        origin.x,
        origin.y,
        origin.z,
        direction.x,
        direction.y,
        direction.z,
        segment.center[0],
        segment.center[1],
        segment.center[2],
        segment.size[0] / 2,
        segment.size[1] / 2,
        segment.size[2] / 2,
        segment.yaw,
        bestDist,
      )
      if (t === null || t >= bestDist) continue
      bestDist = t
      bestNode = target.nodeId
      bestSegment = segment.id
    }
  }
  if (bestNode === null) return null
  return {
    nodeId: bestNode,
    segmentId: bestSegment,
    studId: bestSegment,
    distance: bestDist,
    point: origin.clone().addScaledVector(direction, bestDist),
  }
}

/** Legacy alias — the stud lane and the segment lane are one layer now. */
export const raycastStuds = raycastSegments

/** Chip a framing segment. Splinters fly at the hit point; at hp ≤ 0 the
 * stick SNAPS like charcoal — it breaks into 2-3 tumbling pieces spread
 * along its long axis, more splinters, a snap voice. Returns true when
 * damage applied (false: unknown/already broken). */
// ── Structural collapse (owner rule 2026-08-25) ─────────────────────────────
// "The wall's top must collapse when less than 30% of the supports (wood
// frame) still connect it to the floor" — plus its little sibling: a stick
// hanging above its own chain's break falls immediately.
//
// Vertical segments bucket into CHAINS by their XZ column (one chain per
// stud line). A chain supports the wall up to the BOTTOM of its lowest
// broken segment (unbroken chain → supports to the top). When fewer than
// STRUCT_RATIO of the chains support a given height, everything above the
// 30%-support ceiling comes down: voxels layer by layer (staggered for the
// avalanche read), remaining sheets fly, remaining segments snap.

const STRUCT_RATIO = 0.3
const structTimers = new Map<string, ReturnType<typeof setTimeout>>()

function scheduleStructureCheck(world: GameWorld, nodeId: string): void {
  const prior = structTimers.get(nodeId)
  if (prior) clearTimeout(prior)
  structTimers.set(
    nodeId,
    setTimeout(() => {
      structTimers.delete(nodeId)
      const target = useDestruction.getState().targets.get(nodeId)
      if (target) checkStructuralCollapse(world, target)
    }, 160),
  )
}

function breakSegmentQuiet(target: VoxelTarget, segment: SegmentMember): void {
  segment.hp = 0
  segment.broken = true
  const pieces = 2
  for (let i = 0; i < pieces; i++) {
    const t = ((i + 0.5) / pieces - 0.5) * segment.size[1]
    spawnDebris(segment.center[0], segment.center[1] + t, segment.center[2], 0.06, WOOD, 1.1, 3)
  }
}

function checkStructuralCollapse(world: GameWorld, target: VoxelTarget): void {
  if (target.kind !== 'wall' || target.segments.length === 0) return
  // Bucket vertical segments into stud chains by XZ column (5 cm quantize).
  const chains = new Map<string, SegmentMember[]>()
  for (const segment of target.segments) {
    const [sx, sy, sz] = segment.size
    if (sy < Math.max(sx, sz)) continue // plates are horizontal chains
    const key = `${Math.round(segment.center[0] * 20)},${Math.round(segment.center[2] * 20)}`
    const arr = chains.get(key)
    if (arr) arr.push(segment)
    else chains.set(key, [segment])
  }
  if (chains.size === 0) return

  let wallTop = -Infinity
  let changed = false
  const supportTops: number[] = []
  for (const arr of chains.values()) {
    arr.sort((a, b) => a.center[1] - b.center[1])
    let top = Infinity
    let below = false
    for (const segment of arr) {
      wallTop = Math.max(wallTop, segment.center[1] + segment.size[1] / 2)
      if (segment.broken) {
        top = Math.min(top, segment.center[1] - segment.size[1] / 2)
        below = true
      } else if (below) {
        // Hanging stick above its chain's break — it falls now.
        breakSegmentQuiet(target, segment)
        changed = true
      }
    }
    supportTops.push(top)
  }

  // 30%-support ceiling: the height the need-th sturdiest chain still holds.
  const total = supportTops.length
  const need = Math.max(1, Math.ceil(total * STRUCT_RATIO))
  const sorted = supportTops.slice().sort((a, b) => a - b)
  const ceiling = sorted[total - need]!
  if (ceiling !== Infinity && ceiling < wallTop - 0.05) {
    // Everything above the ceiling comes down: voxels in staggered layers…
    const { grid } = target
    const layers = new Map<number, number[]>()
    for (let i = 0; i < grid.count; i++) {
      if (!grid.alive[i]) continue
      const y = grid.centers[i * 3 + 1]!
      if (y <= ceiling) continue
      const band = Math.floor((y - ceiling) / 0.4)
      const arr = layers.get(band)
      if (arr) arr.push(i)
      else layers.set(band, [i])
    }
    const bands = Array.from(layers.keys()).sort((a, b) => a - b)
    for (const band of bands) {
      const indices = layers.get(band)!
      setTimeout(() => {
        const live = useDestruction.getState().targets.get(target.nodeId)
        if (!live) return
        let removed = 0
        for (const idx of indices) {
          if (!live.grid.alive[idx]) continue
          live.grid.alive[idx] = 0
          live.grid.aliveCount--
          live.removedQueue.push(idx)
          removed++
          if (removed <= 8) {
            spawnDebris(
              live.grid.centers[idx * 3]!,
              live.grid.centers[idx * 3 + 1]!,
              live.grid.centers[idx * 3 + 2]!,
              live.grid.cell,
              live.baseColor,
              1.6,
            )
          }
        }
        live.revision++
        useDestruction.getState().bump()
        // The avalanche can strip the LAST cladding cells — skeleton snap.
        maybeSkeletonSnap(live)
        settleSupportAfterRemoval(live) // avalanche layers change scene support
      }, 60 * band)
    }
    // …remaining sheets above fly, remaining segments above snap.
    for (const sheet of target.sheets ?? []) {
      if (!sheet.flownOff && sheet.center[1] > ceiling) flySheetOff(target, sheet)
    }
    for (const segment of target.segments) {
      if (!segment.broken && segment.center[1] > ceiling - 0.05) {
        breakSegmentQuiet(target, segment)
      }
    }
    changed = true
    sfx.woodCrumble(24)
  }

  if (changed) {
    target.revision++
    useDestruction.getState().bump()
    settleSupportAfterRemoval(target) // fly-offs strip scene-support voxels
  }
}

// ── Skeleton snap (QA p4r1 gate f) ──────────────────────────────────────────
// A wall whose cladding is entirely gone (grid.aliveCount 0) cannot keep its
// bare frame standing — the leftover charcoal sticks snap top-down across
// ~1.5 s instead of floating in midair forever.

const SKELETON_SNAP_SPAN_MS = 1500
/** Walls whose skeleton snap already fired (never re-armed per session). */
const skeletonSnapped = new Set<string>()
const skeletonTimers: ReturnType<typeof setTimeout>[] = []

function maybeSkeletonSnap(target: VoxelTarget): void {
  if (target.grid.aliveCount > 0 || skeletonSnapped.has(target.nodeId)) return
  const remaining: SegmentMember[] = []
  for (const segment of target.segments) if (!segment.broken) remaining.push(segment)
  if (remaining.length === 0) return
  skeletonSnapped.add(target.nodeId)
  // Top plates first — the frame reads as raining down, not popping at once.
  remaining.sort((a, b) => b.center[1] - a.center[1])
  const count = remaining.length
  sfx.woodCrumble(Math.min(24, count))
  for (let i = 0; i < count; i++) {
    const segment = remaining[i]!
    skeletonTimers.push(
      setTimeout(
        () => {
          const live = useDestruction.getState().targets.get(target.nodeId)
          if (!live || segment.broken) return
          breakSegmentQuiet(live, segment)
          if (i % 4 === 0) sfx.studSnap() // voice every few snaps, not all 60
          live.revision++
          useDestruction.getState().bump()
        },
        Math.round((i / count) * SKELETON_SNAP_SPAN_MS),
      ),
    )
  }
}

// ── Explosion carve (grenade detonation) ─────────────────────────────────────

/** Node types a blast will voxelize + carve — mirror of shooting.ts's
 * DESTRUCTIBLE routing set (terrain/fixtures just take the dust). */
const EXPLODABLE = new Set([
  'wall',
  'door',
  'window',
  'slab',
  'floor',
  'ceiling',
  'roof',
  'roof-segment',
  'item',
  'shelf',
  'cabinet',
  'cabinet-module',
  'block',
  'column',
  'stair',
  'stair-segment',
  'counter',
  'kitchen-unit',
])

/** Ragged-edge nibble carves per node around the main sphere. */
const EXPLOSION_NIBBLES = 5
/** Cap on framing segments snapped per blast. */
const EXPLOSION_SEGMENT_CAP = 48

const _boomPoint = new Vector3()
const _boomSeg = new Vector3()

/**
 * One explosion: every destructible collider group whose bounds touch the
 * radius takes the full-depth center carve (radius ≥ WALL_PIERCE_RADIUS, so
 * both drywall skins go in one hit) plus EXPLOSION_NIBBLES ragged rim
 * nibbles, then framing segments inside the radius snap (which arms the
 * 30%-support check). Returns the total voxels removed.
 */
/** One expanding ring of the blast: carve every explodable node whose
 * bounds sit within `ring`; nibbles only on the outermost pass. removeSphere
 * is idempotent, so each ring only pays for its own shell. */
function explosionRing(
  world: GameWorld,
  center: Vector3,
  ring: number,
  withNibbles: boolean,
): number {
  let total = 0
  const seen = new Set<string>()
  for (const collider of world.colliders) {
    if (seen.has(collider.nodeId)) continue
    if (!EXPLODABLE.has(collider.nodeType)) continue
    if (collider.worldBox.distanceToPoint(center) > ring) continue
    seen.add(collider.nodeId)
    total += damageTarget(world, collider.nodeId, center, ring)
    if (!withNibbles) continue
    for (let i = 0; i < EXPLOSION_NIBBLES; i++) {
      _boomPoint
        .set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
        .normalize()
        .multiplyScalar(ring * (0.75 + Math.random() * 0.3))
        .add(center)
      total += damageTarget(world, collider.nodeId, _boomPoint, 0.3 + Math.random() * 0.2)
    }
  }
  return total
}

function explosionSegments(world: GameWorld, center: Vector3, radius: number): void {
  const radiusSq = radius * radius
  let snapped = 0
  outer: for (const target of useDestruction.getState().targets.values()) {
    for (const segment of target.segments) {
      if (segment.broken) continue
      _boomSeg.set(segment.center[0], segment.center[1], segment.center[2])
      if (_boomSeg.distanceToSquared(center) > radiusSq) continue
      damageSegment(world, target.nodeId, segment.id, 999, _boomSeg)
      if (++snapped >= EXPLOSION_SEGMENT_CAP) break outer
    }
  }
}

/**
 * STAGGERED detonation (the "short lag when they detonate" fix): the frame
 * of the boom only carves the inner core — instant feedback — and the outer
 * rings land 30/70 ms later, which spreads the carve + voxelize-on-first-hit
 * cost across frames AND reads as a shockwave expanding outward. Framing
 * snaps with the last ring. Returns the core count (rings add later).
 */
export function damageExplosion(
  world: GameWorld,
  center: Vector3,
  radius: number,
  opts?: { immediate?: boolean },
): number {
  if (opts?.immediate) {
    let total = explosionRing(world, center, radius, true)
    explosionSegments(world, center, radius)
    return total
  }
  const total = explosionRing(world, center, radius * 0.5, false)
  const frozen = center.clone()
  setTimeout(() => explosionRing(world, frozen, radius * 0.8, false), 30)
  setTimeout(() => {
    explosionRing(world, frozen, radius, true)
    explosionSegments(world, frozen, radius)
  }, 70)
  return total
}

export function damageSegment(
  world: GameWorld,
  nodeId: string,
  segmentId: number,
  damage: number,
  point: Vector3,
): boolean {
  const target = useDestruction.getState().targets.get(nodeId)
  if (!target) return false
  const segment = target.segments.find((s) => s.id === segmentId)
  if (!segment || segment.broken) return false
  segment.hp -= damage
  for (let i = 0; i < 4; i++) {
    spawnDebris(point.x, point.y, point.z, 0.02 + Math.random() * 0.02, WOOD, 2, 0.9)
  }
  if (segment.hp > 0) {
    sfx.studHit()
    return true
  }
  segment.hp = 0 // clamp — debug snapshots read hp, don't show underflow
  segment.broken = true
  target.revision++
  useDestruction.getState().bump()
  // Charcoal-stick snap: 2-3 stick pieces spread along the long axis
  // (verticals fall as stacked thirds, plates as run pieces).
  const [sx, sy, sz] = segment.size
  const long = Math.max(sx, sy, sz)
  let ax = 0
  let ay = 1
  let az = 0
  if (sy < long) {
    ax = Math.cos(segment.yaw)
    ay = 0
    az = Math.sin(segment.yaw)
  }
  const pieces = 2 + (Math.random() < 0.5 ? 1 : 0)
  for (let i = 0; i < pieces; i++) {
    const t = ((i + 0.5) / pieces - 0.5) * long
    spawnDebris(
      segment.center[0] + ax * t,
      segment.center[1] + ay * t,
      segment.center[2] + az * t,
      0.06 + Math.random() * 0.04,
      WOOD,
      1.3,
      3.4,
    )
  }
  for (let i = 0; i < 6; i++) {
    spawnDebris(point.x, point.y, point.z, 0.02 + Math.random() * 0.025, WOOD, 2.4, 1.2)
  }
  sfx.studSnap()
  // A break may drop hanging sticks or trip the 30%-support rule — check
  // after a short settle so bursts coalesce into one avalanche.
  scheduleStructureCheck(world, nodeId)
  return true
}

/** Legacy alias — identical signature, same member layer. */
export const damageStud = damageSegment

export type TargetRayHit = { nodeId: string; distance: number; point: Vector3 }
/** Legacy alias. */
export type WallRayHit = TargetRayHit

/** First live voxel any damaged target's grid intersects along the ray. */
export function raycastVoxelTargets(
  origin: Vector3,
  direction: Vector3,
  maxDist: number,
): TargetRayHit | null {
  let best: TargetRayHit | null = null
  for (const target of useDestruction.getState().targets.values()) {
    const hit = raycastVoxels(
      target.grid,
      origin.x,
      origin.y,
      origin.z,
      direction.x,
      direction.y,
      direction.z,
      maxDist,
    )
    if (!hit) continue
    if (!best || hit.distance < best.distance) {
      best = {
        nodeId: target.nodeId,
        distance: hit.distance,
        point: origin.clone().addScaledVector(direction, hit.distance),
      }
    }
  }
  return best
}

/** Legacy alias. */
export const raycastVoxelWalls = raycastVoxelTargets

const _voxelCenter = new Vector3()

/** Capsule push-out against live voxels of every target (voxels ≈ spheres
 * of r=0.55·cell — close enough at 15 cm cells, and far cheaper than box
 * tests). */
export function collideVoxelTargets(pos: Vector3, vel: Vector3, radius: number, height: number): boolean {
  let grounded = false
  for (const target of useDestruction.getState().targets.values()) {
    const { grid } = target
    // Sphere radius keys off the LARGEST cell — any smaller and the capsule
    // could slip between skin voxels spaced a full length-cell apart.
    const r = grid.cell * 0.55
    // Yaw grids index cells in their local frame; a vertical capsule stays
    // a vertical capsule under a Y rotation, so only its XZ center moves.
    // The push-out below runs on world centers and needs no rotation.
    let px = pos.x
    let pz = pos.z
    if (grid.yaw !== 0) {
      const cos = Math.cos(grid.yaw)
      const sin = Math.sin(grid.yaw)
      px = pos.x * cos + pos.z * sin
      pz = -pos.x * sin + pos.z * cos
    }
    const minX = Math.floor((px - radius - r - grid.origin.x) / grid.cellX)
    const maxX = Math.floor((px + radius + r - grid.origin.x) / grid.cellX)
    const minY = Math.floor((pos.y - r - grid.origin.y) / grid.cellY)
    const maxY = Math.floor((pos.y + height + r - grid.origin.y) / grid.cellY)
    const minZ = Math.floor((pz - radius - r - grid.origin.z) / grid.cellZ)
    const maxZ = Math.floor((pz + radius + r - grid.origin.z) / grid.cellZ)
    if (maxX < 0 || maxY < 0 || maxZ < 0) continue
    for (let iz = Math.max(0, minZ); iz <= Math.min(grid.nz - 1, maxZ); iz++) {
      for (let iy = Math.max(0, minY); iy <= Math.min(grid.ny - 1, maxY); iy++) {
        for (let ix = Math.max(0, minX); ix <= Math.min(grid.nx - 1, maxX); ix++) {
          const idx = grid.index.get(ix + grid.nx * (iy + grid.ny * iz))
          if (idx === undefined || !grid.alive[idx]) continue
          _voxelCenter.set(
            grid.centers[idx * 3]!,
            grid.centers[idx * 3 + 1]!,
            grid.centers[idx * 3 + 2]!,
          )
          // Closest point on the capsule's core segment to the voxel center.
          const coreY = Math.min(Math.max(_voxelCenter.y, pos.y + radius), pos.y + height - radius)
          const dx = pos.x - _voxelCenter.x
          const dy = coreY - _voxelCenter.y
          const dz = pos.z - _voxelCenter.z
          const dist = Math.hypot(dx, dy, dz)
          const minDist = radius + r
          if (dist >= minDist || dist < 1e-6) continue
          const push = (minDist - dist) / dist
          pos.x += dx * push
          pos.y += dy * push
          pos.z += dz * push
          if (dy / dist > 0.55) grounded = true
          const nx = dx / dist
          const nyn = dy / dist
          const nz = dz / dist
          const into = vel.x * nx + vel.y * nyn + vel.z * nz
          if (into < 0) {
            vel.x -= nx * into
            vel.y -= nyn * into
            vel.z -= nz * into
          }
        }
      }
    }
  }
  return grounded
}

/** Legacy alias. */
export const collideVoxelWalls = collideVoxelTargets

/** Forget one voxel target (builder Z-undo unmounts its source mesh): the
 * replica unmounts and any pending island collapse for it is cancelled.
 * No-op if the node never voxelized. */
export function dropTarget(nodeId: string): void {
  const timer = islandTimers.get(nodeId)
  if (timer !== undefined) {
    clearTimeout(timer)
    islandTimers.delete(nodeId)
  }
  const state = useDestruction.getState()
  if (state.targets.delete(nodeId)) {
    state.bump()
    dropStructureTarget(nodeId)
    // A scene replica leaving changes what can prop placed pieces; piece
    // replicas don't (their own unmount already runs the slot cleanup).
    if (!nodeId.startsWith(PLACED_PIECE_PREFIX)) {
      notifySceneSupportChanged()
    }
  }
}

export function resetDestruction(): void {
  if (sceneSupportTimer !== null) {
    clearTimeout(sceneSupportTimer)
    sceneSupportTimer = null
  }
  for (const timer of islandTimers.values()) clearTimeout(timer)
  islandTimers.clear()
  for (const timer of structTimers.values()) clearTimeout(timer)
  structTimers.clear()
  for (const timer of skeletonTimers) clearTimeout(timer)
  skeletonTimers.length = 0
  skeletonSnapped.clear()
  prevoxelizeSkip.clear()
  resetStructure()
  useDestruction.getState().reset()
}
