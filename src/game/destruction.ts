import { type AnyNodeId, useScene } from '@pascal-app/core'
import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  type Material,
  Matrix3,
  Matrix4,
  Mesh,
  type Object3D,
  Quaternion,
  Vector3,
} from 'three'
import { create } from 'zustand'
import { useBoots } from '../store'
import { sfx } from './audio'
import { passageCount, passageHidesCell, passageRelievesCell } from './collision'
import { spawnFloorBreach } from './craters'
import { spawnDebris, spawnFlatDebris } from './debris'
import { spawnDust, spawnHaze } from './dust'
import { blastDebrisActive, queueDebris } from './grenade'
import { groundSurfaceY, lotFloorY } from './ground'
import { perfEvent, perfSection } from './perf-monitor'
import { notifySceneSupportChanged, onPieceRemoved, pieceReplicaDead, slotOf } from './piece-slots'
import { buildRafters, rafterObbBasis, roofPlaneFrame, splitRaftersByPlane } from './roof-framing'
import {
  assignRoofTrisToMembers,
  dominantMaterialBy,
  dominantResidualMaterial,
  dominantSlopedMaterial,
  enumerateRoofPlanes,
  type RoofMemberTris,
  type RoofPlane,
} from './roof-planes'
import { hideForGameKeepingRoots, maskForGame, sweepWallBatches } from './session'
import {
  beginDamageBatch,
  endDamageBatch,
  publishBrokenSegment,
  publishKilledNode,
  publishNodeReset,
  publishRemovedCells,
  resetSharedDamage,
  setDamageRuntime,
  sharedLocalWork,
} from './shared-damage'
import { type LocalWork } from './shared-world'
import {
  cellToneAt,
  clearToneAudit,
  isUntexturedWhite,
  kindFallbackTone,
  mapAverageTone,
  mapPatternGrid,
  primedCellColor,
  reportToneFallback,
  resetSkinTones,
  resolveSurfaceTone,
  type SkinToneKind,
  type ToneGrid,
} from './skin-tone'
import {
  cancelSettleTask,
  dropStructureTarget,
  noteStructureCarve,
  registerStructureTarget,
  resetStructure,
  scheduleSettleTask,
  wireStructureDriver,
} from './structure'
import {
  gridContainsPoint,
  buildVoxelGrid,
  dropInteriorCells,
  findUnsupportedIslands,
  raycastObb,
  raycastVoxels,
  raycastYawObb,
  removeSphere,
  rotateByBasis,
  rotateByBasisInverse,
  type SkinLimit,
  type VoxelBasis,
  type VoxelGridData,
  type VoxelSource,
} from './voxel'
import { buildShellData, type ShellData, type ShellSourceTri } from './shell'
import { bvhFor, type GameWorld, isGlassLikeMesh, ITEM_FAMILY_KINDS } from './world'

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
 * ROOF PLANES (MULTILEVEL-PLAN Phase C2): a pitched roof shell becomes the
 * SAME anatomy laid on each slope — one target PER PLANE (ids
 * `<nodeId>#p<n>`, kind 'roof'), each a thin pinned grid axis-aligned in
 * its plane frame via a full quaternion basis (grid X = across the eave,
 * Y = up the slope, Z = through the assembly; outer/shingle surface = the
 * min-z face). dropInteriorCells leaves the shingle skin + underside deck,
 * ~1.2 m plane-space shingle sheets tile the faces, the plane's rafters
 * (roof-framing.ts) ride as segments, and islands seed from the EAVE row
 * (grid iy 0) plus cells standing over live walls (roofSeedPredicate).
 * Damage through the real node id or any member fans out to every sibling
 * plane (roofGroups). Roof/volume carves clamp their radius to
 * CARVE_CELL_FLOOR × the largest cell so no target is ever bulletproof.
 *
 * ── API (build against this) ──────────────────────────────────────────
 * State
 *   useDestruction            zustand store. `targets` (and its legacy
 *                             alias `walls` — the SAME Map instance) maps
 *                             nodeId → VoxelTarget. `version` bumps on any
 *                             change; re-read the map when it does.
 *   VoxelTarget               { nodeId, kind: 'wall' | 'slab' | 'roof' |
 *                             'volume', grid,
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
 *                             sandwich (skins + joists); ITEM_FAMILY_KINDS
 *                             (item/shelf/cabinet/counter…) get SILHOUETTE
 *                             cells — clamp(minDim/3, 0.055, 0.11) m under a
 *                             raised budget, so a toilet breaks as a toilet
 *                             (phase 6); everything else is a plain adaptive
 *                             volume (≤ 1600 voxels).
 *                             `ensureVoxelWall` is a legacy alias.
 *   prevoxelizeTick(world, budgetMs?, focus?)   voxelize the scene's
 *                             remaining walls AND item-family nodes AWAKE
 *                             (host meshes hide in the SAME tick, via the
 *                             ensureVoxelTarget path — voxel-first: items
 *                             read as voxels from session start and never
 *                             morph on first hit); everything else a blast
 *                             can reach prebuilds DORMANT. Work runs under
 *                             a per-frame TIME budget (explicit budgetMs,
 *                             or ADAPTIVE when omitted: 4 ms, raised to
 *                             8 ms while recent frames run comfortably
 *                             idle) and NEAREST `focus` (the player) FIRST,
 *                             re-sorted every ~2 s — the far tail keeps its
 *                             host meshes rendering and never blocks entry;
 *                             any first damage out there still lands via
 *                             the ensureVoxelTarget on-demand build.
 *                             Returns true once every node is handled —
 *                             drive it from a useFrame until then.
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
  /** Slope tilt (radians) — pitched roof members render/raycast as
   * Ry(−yaw)·Rz(pitch) (roof-framing.ts conventions). Absent/0 keeps the
   * yaw-only stud path bit-identical. */
  pitch?: number
  /** Roof-plane index this member frames (roof-framing.ts RafterMember). */
  planeIndex?: number
  /** Framing role tag ('rafter' | 'ridge' | 'plate' on roof members). */
  role?: string
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
   * 'roof' is one PITCHED plane of a roof shell (Phase C2: thin pinned grid
   * in the slope frame — thickness along grid Z, upSlope along grid Y —
   * with shingle sheets on the outer skin and that plane's rafters as
   * segments); 'volume' is plain. */
  kind: 'wall' | 'slab' | 'volume' | 'roof'
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
  /** Bumped when `baseColor` changes AFTER voxelize (async roof skin tone —
   * compressed shingle maps only resolve through a GPU readback a frame or
   * two later). voxel-walls.tsx re-primes the whole skin layer's colors on
   * a bump; paint coats re-apply on top via drainPaintTints (the paint
   * ledger's own serials never move). */
  skinRevision?: number
  /** The surface texture's CPU pattern grid (skin-tone.ts mapPatternGrid)
   * — when present, primedCellColor samples the PATTERN (brick courses,
   * shingle rows) per cell instead of the flat baseColor. Set at voxelize
   * for readable maps; pending textures deliver it with the async retint.
   * Layered kinds only (item cells carry their pattern IN cellColors). */
  toneGrid?: ToneGrid
  /** DORMANT prevoxelization (the grenade-lag fix): the grid + anatomy are
   * prebuilt off the blast frame, but the HOST keeps rendering and
   * colliding — no visual change until the first hit wakes the target
   * (wakeTarget: hide host, hand colliders over, flip the replica visible —
   * voxel-walls.tsx pre-mounts + pre-primes dormant replicas HIDDEN, so a
   * wake never mounts or primes anything in the blast frame). Dormant
   * targets are invisible to the voxel/segment raycasts and hidden in the
   * renderer; damage paths wake them first. */
  dormant?: boolean
  /** Deferred hideHostNode arguments while dormant (plain targets). */
  hostMeshes?: Mesh[]
  hostRoot?: Object3D
  /** FEET SEE THE PLANE (climb feel): true while this target's source
   * collider(s) stayed capsule-solid as `walkOnly` planks at the handover
   * (placed stairs/roof pieces — builder.tsx marks them walkOnClad).
   * While set, collideVoxelTargets SKIPS this grid (movement uses the
   * smooth plank; bullets/raycasts still see the voxels). Cleared — and the
   * planks demoted to `disabled` — by settleWalkOnly once damage crosses
   * WALK_ONLY_MAX_DAMAGE, so real holes take over collision too. */
  walkOnly?: boolean
  /** True for roof nodes (Phase C): the target frames RAFTERS instead of
   * studs/joists, sheet fly-offs voice shingleRip, and torn shards wear the
   * shingle debris tone. */
  roof?: boolean
  /** True for ITEM_FAMILY_KINDS targets (phase 6 silhouette lane): fine
   * shape-preserving cells, carve dust voiced 'concrete'-lite (the
   * porcelain read — see damageTarget). */
  item?: boolean
  /** True when ANY sub-mesh's dominant material reads metallic at
   * voxelize time (metalness > 0.5 OR a 'metal-*' pascal_material library
   * tag — catalog GLBs bake metallicFactor 0; see isMetalItemMaterial) —
   * shooting.ts swaps the carve chip/puff for spark streaks +
   * sfx.metalPing(), refined per cell through `cellMetal`. */
  metal?: boolean
  /** Per-voxel metal bit (1 = the cell's region reads metal) — same
   * region attribution as cellColors, allocated only when the item MIXES
   * materials with at least one metal region (a couch sparks on its chrome
   * handle, puffs on the leather). shooting.ts's isMetalHit reads the cell
   * nearest the impact. Never touched per frame. */
  cellMetal?: Uint8Array
  /** Per-voxel RGB (3 floats per index, working color space) — sampled at
   * VOXELIZE time from the item's own sub-mesh materials (silhouette lane
   * only; see sampleItemCellColors). voxel-walls.tsx prefers it over
   * baseColor per cell (same value jitter as walls) and debris tint reads
   * it through cellTint. Never touched per frame. */
  cellColors?: Float32Array
  /** Conforming shell fragments (S0 walls, S1 roof plane members + slabs —
   * each behind its session-latched shellFlags kind): the target's REAL
   * surface clipped into
   * 1–6-cell fragments (shell.ts). NOTE the indexing contract:
   * fragmentForCell / cellsOfFragment use LATTICE keys
   * (ix + nx·(iy + ny·iz)) — grid.count counts OCCUPIED voxels only, so
   * the shell is built over the full lattice (map a voxel index through
   * grid.coords to get its lattice key). Any fallback (flag off, tri cap,
   * clipper throw, no readable triangles) leaves this undefined = today's
   * voxel-only path, bit-identical. */
  shell?: ShellData
  /** The shell's material table — HOST material instances BY REFERENCE
   * (never clone/mutate/dispose; they outlive the session), indexed by
   * ShellGroup.materialIndex. Present exactly when `shell` is. */
  shellMaterials?: Material[]
  /** S2 LAZY SHELL TIER: this target's shell build is DEFERRED — it was
   * beyond SHELL_NEAR_RADIUS of the player at voxelize time. The target
   * still registers DORMANT exactly like a built shell (the host renders,
   * so the editor look holds), and the shell builds later — RE-COLLECTED
   * from the retained host meshes (target.hostMeshes / dormantRoofHide;
   * zero bytes retained beyond references the dormant lane keeps anyway,
   * vs ~200-400 B/tri for kept source-tri arrays) — via the budgeted
   * nearest-first queue (shellBuildTick) once the player approaches, or
   * synchronously at wakeTarget (per-frame budget-capped, voxel-only
   * fallback past it). Cleared on build or fallback. */
  shellPending?: ShellPendingBuild
  /** True for plates SYNTHESIZED under zero-extent ceiling planes: their
   * cells hold another target up only by direct contact (structure.ts
   * PLATE_CONTACT_SLACK), never across the general SUPPORT_GAP band — a
   * ceiling FINISH surface carries a wall RESTING on it, not one floating
   * 7 cm above (QA round 2 follow-up: the plate must not prop a wall whose
   * real slab was carved out from under it). */
  contactOnlySupport?: boolean
  /** FLOOR-family slab (nodeType slab/floor — never ceiling): the tone
   * chain runs through the 'floor' kind (wood-family fallback, never the
   * screed gray that read "white" — owner wave 5) and primedCellColor
   * paints every under-layer as dirt subfloor (skin-tone.ts
   * FLOOR_CORE_HEX) so a carved floor reveals earth. */
  floorCore?: boolean
  /** Voxel-only member of a SHELLED roof family (the `#residual` target
   * when the roof shell lane is latched ON): primedCellColor mutes its
   * cells toward bare structure/trim (skin-tone.ts STRUCTURAL_MUTE) — the
   * plane siblings wake as pixel-identical shells, so these cube cells
   * must read as cut sheathing/trim, never the residual material's
   * near-white siding (S1 QA: white stepped blocks on the roof rim at
   * wake). Never set on voxel-only sessions — the kill-switch look stays
   * bit-identical. */
  structuralMute?: boolean
  /** CEILING-family slab (nodeType 'ceiling'): voxel-walls renders it with
   * the FACE-tinted ceiling geometry (skin-tone.ts CEILING_FACE_TINT) —
   * the attic-side TOP and rim faces mute toward bare structure while the
   * bottom face (the room ceiling seen from below) stays bit-exact. Per
   * FACE, not per cell, because live host ceilings voxelize as a SINGLE
   * cell layer serving both sides: through the eave slit the interior
   * white read as a light sawtooth ring framing the dark roof
   * (round-5 QA). */
  ceilingTop?: boolean
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

// ── Wall openings (studs-through-openings fix) ─────────────────────────────

/**
 * One hosted door/window APERTURE in wall space: `u` runs along the wall
 * from its START (metres), `v` is height above the wall base. Rects come
 * from the host node snapshots collectWorld already carries (door/window
 * `position` is the child's CENTER in this same wall-local frame — origin
 * at the wall start, Y = center height; doors sit on the floor). Rects are
 * inflated by OPENING_PAD so framing never kisses the aperture edge.
 */
export type WallOpening = {
  u0: number
  u1: number
  v0: number
  v1: number
  kind: 'door' | 'window'
}

/** Aperture inflation — keeps clipped lumber a hair clear of the opening. */
const OPENING_PAD = 0.02
/** Clipped stud remainders (cripples) shorter than this are dropped. */
const CRIPPLE_MIN = 0.25
/** Header/sill members run the opening width plus this total bearing. */
const HEADER_OVERHANG = 0.1
/** Header/sill member height — same nominal band as the wall plates. */
const HEADER_H = 0.09

/** Snapshot node → inflated wall-space rect (null = not enough geometry).
 * Width/height fall back to the host schema defaults (door 0.9 × 2.1,
 * window 1.5 × 1.5); a snapshot with no `position` is unplaceable → null. */
function openingFromNode(
  node: Record<string, unknown>,
  kind: 'door' | 'window',
  length: number,
  height: number,
): WallOpening | null {
  const pos = node.position
  if (!Array.isArray(pos) || typeof pos[0] !== 'number' || typeof pos[1] !== 'number') {
    return null
  }
  const w = typeof node.width === 'number' ? node.width : kind === 'door' ? 0.9 : 1.5
  const h = typeof node.height === 'number' ? node.height : kind === 'door' ? 2.1 : 1.5
  const u0 = Math.max(0, pos[0] - w / 2 - OPENING_PAD)
  const u1 = Math.min(length, pos[0] + w / 2 + OPENING_PAD)
  // Doors always reach the floor (host renders position[1] = height/2).
  let v0 = pos[1] - h / 2
  if (kind === 'door') v0 = Math.min(v0, 0)
  v0 -= OPENING_PAD
  const v1 = Math.min(height, pos[1] + h / 2 + OPENING_PAD)
  if (u1 - u0 < 0.01 || v1 - v0 < 0.01) return null
  return { u0, u1, v0, v1, kind }
}

/**
 * All door/window apertures hosted by `wallId`, as inflated wall-space
 * rects. Hosted children link to their wall via `parentId` (and the host
 * schema's optional `wallId` mirror); window rects come from the
 * OperableEntry snapshots (cabinets are wall-mounted, not apertures — they
 * never cut framing). Doors with `openingKind: 'opening'` (frameless
 * archways) are still apertures. Test worlds without node snapshots simply
 * contribute nothing — walls keep their exact legacy framing.
 */
export function collectWallOpenings(world: GameWorld, wallId: string): WallOpening[] {
  const wall = world.walls.get(wallId)
  if (!wall) return []
  const { start, end } = wall.node
  const length = Math.hypot(end[0] - start[0], end[1] - start[1])
  const height = wall.node.height ?? 2.7
  if (length < 0.3) return []
  const hosted = (node: Record<string, unknown> | undefined): node is Record<string, unknown> =>
    !!node && (node.parentId === wallId || node.wallId === wallId)
  const openings: WallOpening[] = []
  for (const door of world.doors) {
    if (!hosted(door.node)) continue
    const rect = openingFromNode(door.node, 'door', length, height)
    if (rect) openings.push(rect)
  }
  for (const operable of world.operables ?? []) {
    if (operable.kind !== 'window' || !hosted(operable.node)) continue
    const rect = openingFromNode(operable.node, 'window', length, height)
    if (rect) openings.push(rect)
  }
  return openings
}

/** Subtract `cuts` intervals from [a, b] — the surviving sub-spans, sorted.
 * Overlapping cuts compose (each cut re-splits whatever survived so far). */
function subtractSpans(
  a: number,
  b: number,
  cuts: ReadonlyArray<readonly [number, number]>,
): Array<[number, number]> {
  let spans: Array<[number, number]> = [[a, b]]
  for (const [c0, c1] of cuts) {
    const next: Array<[number, number]> = []
    for (const [s0, s1] of spans) {
      if (c1 <= s0 || c0 >= s1) {
        next.push([s0, s1])
        continue
      }
      if (c0 > s0) next.push([s0, c0])
      if (c1 < s1) next.push([c1, s1])
    }
    spans = next
  }
  return spans.sort((x, y) => x[0] - y[0])
}

/** buildStuds' OWN scratch pair. It must never borrow ensureVoxelTarget's
 * `_bounds` / `_size`: buildStuds runs from the middle of that function
 * (the `segments` build), and the node AABB collected at its top is still
 * read afterwards — enqueueShellBuild(nodeId, _bounds) hands the deferred
 * shell queue its near-gate sphere from it. A shared scratch made that
 * sphere the WALL-MESH 2-corner box instead of the node AABB, which is
 * smaller for any wall whose transform rotates, so the sphere no longer
 * contained the node and the near gate read the wall as farther than it
 * is. Module-level, so this costs no per-call allocation. */
const _studBounds = new Box3()
const _studCenter = new Vector3()

/** Exported for the deterministic stud-openings tests only — gameplay goes
 * through ensureVoxelTarget, which feeds collectWallOpenings' rects in. */
export function buildStuds(
  wall: GameWorld['walls'] extends Map<string, infer V> ? V : never,
  grid: VoxelGridData,
  openings: WallOpening[] = [],
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
  _studBounds.makeEmpty()
  for (const mesh of wall.meshes) {
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
    _studBounds.expandByPoint(
      mesh.geometry.boundingBox!.min.clone().applyMatrix4(mesh.matrixWorld),
    )
    _studBounds.expandByPoint(
      mesh.geometry.boundingBox!.max.clone().applyMatrix4(mesh.matrixWorld),
    )
  }
  const baseY = _studBounds.min.y
  const midX = (start[0] + end[0]) / 2
  const midZ = (start[1] + end[1]) / 2
  const centerX = _studBounds.getCenter(_studCenter).x
  const centerZ = _studCenter.z
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
    // Openings clip the stud VERTICALLY: the aperture band [v0, v1] drops
    // out and the remainders survive as cripples (above doors/windows,
    // below sills) when long enough. Studs clear of every aperture take
    // the exact legacy push — walls without openings stay byte-identical.
    const u = Math.min(length, i * STUD_SPACING)
    const cuts: Array<readonly [number, number]> = []
    for (const o of openings) {
      if (u + STUD_WIDTH / 2 > o.u0 && u - STUD_WIDTH / 2 < o.u1) cuts.push([o.v0, o.v1])
    }
    if (cuts.length === 0) {
      studs.push({
        id: studs.length,
        center: [x, baseY + height / 2, z],
        size: [STUD_WIDTH, height - 0.1, depth],
        yaw,
        hp: STUD_HP,
        broken: false,
      })
      continue
    }
    for (const [v0, v1] of subtractSpans(0.05, height - 0.05, cuts)) {
      if (v1 - v0 < CRIPPLE_MIN) continue
      studs.push({
        id: studs.length,
        center: [x, baseY + (v0 + v1) / 2, z],
        size: [STUD_WIDTH, v1 - v0, depth],
        yaw,
        hp: STUD_HP,
        broken: false,
      })
    }
  }
  // Top & bottom plates. Doors reach the floor, so the BOTTOM plate clips
  // in `u` across every door aperture (no lumber lying across a doorway);
  // window bands never touch either plate. Clear plates keep the exact
  // legacy push (byte-identical framing for walls without openings).
  for (const [cy, plateH] of [
    [baseY + 0.045, 0.09],
    [baseY + height - 0.045, 0.09],
  ] as const) {
    const vc = cy - baseY // plate band center back in wall space
    const cuts: Array<readonly [number, number]> = []
    for (const o of openings) {
      if (o.v0 < vc + plateH / 2 && o.v1 > vc - plateH / 2) cuts.push([o.u0, o.u1])
    }
    if (cuts.length === 0) {
      studs.push({
        id: studs.length,
        center: [midX + offX, cy, midZ + offZ],
        size: [length, plateH, depth],
        yaw,
        hp: STUD_HP,
        broken: false,
      })
      continue
    }
    for (const [u0, u1] of subtractSpans(0, length, cuts)) {
      if (u1 - u0 < CRIPPLE_MIN) continue
      const um = (u0 + u1) / 2
      studs.push({
        id: studs.length,
        center: [start[0] + (dx * um) / length + offX, cy, start[1] + (dz * um) / length + offZ],
        size: [u1 - u0, plateH, depth],
        yaw,
        hp: STUD_HP,
        broken: false,
      })
    }
  }
  // Realism garnish: a HEADER across each aperture top (opening width +
  // bearing, lying flat like a plate run) and a SILL under windows. Both
  // ride the plate lane through buildSegments, so they break at hp 2 like
  // every other stick.
  for (const o of openings) {
    const um = (o.u0 + o.u1) / 2
    const half = (o.u1 - o.u0 + HEADER_OVERHANG) / 2
    const hu0 = Math.max(0, um - half)
    const hu1 = Math.min(length, um + half)
    if (hu1 - hu0 < 0.15) continue
    const hum = (hu0 + hu1) / 2
    const hx = start[0] + (dx * hum) / length + offX
    const hz = start[1] + (dz * hum) / length + offZ
    const headerV = o.v1 + HEADER_H / 2
    if (headerV + HEADER_H / 2 <= height - HEADER_H) {
      studs.push({
        id: studs.length,
        center: [hx, baseY + headerV, hz],
        size: [hu1 - hu0, HEADER_H, depth],
        yaw,
        hp: STUD_HP,
        broken: false,
      })
    }
    if (o.kind === 'window') {
      const sillV = o.v0 - HEADER_H / 2
      if (sillV - HEADER_H / 2 >= HEADER_H) {
        studs.push({
          id: studs.length,
          center: [hx, baseY + sillV, hz],
          size: [hu1 - hu0, HEADER_H, depth],
          yaw,
          hp: STUD_HP,
          broken: false,
        })
      }
    }
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

/** Node kinds that frame RAFTERS (Phase C3): the merged roof shell keeps
 * its adaptive volume grid, but its cavity carries pitched 2×6 rafters +
 * ridge boards from roof-framing.ts, revealed exactly like wall studs. */
const ROOF_KINDS = new Set(['roof', 'roof-segment'])

// ── Item silhouette lane (phase 6 — items keep their SHAPE) ─────────────────
// Owner call: a toilet or shower must NOT collapse into chunky generic
// blocks. ITEM_FAMILY_KINDS targets (world.ts owns the set — the same one
// whose glass-like sub-meshes shatter instead of voxelizing) grid at FINE
// cells traced from their own bounds, staying kind 'volume' (no skins, no
// framing — the shape IS the anatomy).

/** Silhouette cell: a third of the item's SMALLEST extent, clamped to
 * [0.055, 0.11] m — a 0.4 m-deep toilet grids at 0.11 m cells (hundreds of
 * voxels tracing the bowl) instead of the generic 0.15 m volume cell
 * (3 fat cubes). */
const ITEM_CELL_MIN = 0.055
const ITEM_CELL_MAX = 0.11
/** Raw-grid budget for the silhouette lane — raised over the generic
 * volume budget so mid-size fixtures keep their fine cells; larger items
 * grow the cell in the same ×1.35 steps buildVoxelGrid uses. */
const ITEM_VOXEL_BUDGET = 2600
/** voxel.ts's hard fill cap (MAX_VOXELS — module-private there): a grid
 * stops ADDING occupied cells at this count, which would silently chop the
 * TOP off a dense item. buildItemGrid detects the hit (count == cap) and
 * rebuilds one step coarser; raising the cap itself belongs to voxel.ts's
 * owner. */
const VOXEL_FILL_CEILING = 1600
/** Item carve dust intensity cap — the 'concrete'-lite voice (see
 * damageTarget's porcelain note). */
const ITEM_DUST_MAX = 0.55

// ── Item carve debris (natural breakage, owner call 2026-08-28) ─────────────
// An item must read as COMING APART, not as shedding wall crumbs: silhouette
// cells are small (0.055–0.11 m), so the wall recipe (up to 10 pieces at
// 0.6–1.1 × cell) reads as dust on a toilet. Item carves instead throw
// FEWER, LARGER tumbling chunks — one per ~2–3 removed cells, capped — each
// sampled from the exact cells the carve removed and wearing that cell's own
// region color (cellTint), so a chrome faucet sheds chrome and the bowl
// sheds porcelain.

/** ~One tumbling chunk per this many removed cells… */
export const ITEM_CHUNK_PER_CELLS = 2.5
/** …capped per carve so a warhammer smash can't flood the debris ring. */
export const ITEM_CHUNK_CAP = 14
/** Chunk draw-size band in CELLS: 1.6–2.6 × the grid cell — ~2–3× the wall
 * crumb band (0.6–1.1 × cell). Fewer, larger, heavier-reading pieces. */
export const ITEM_CHUNK_SCALE_MIN = 1.6
export const ITEM_CHUNK_SCALE_SPAN = 1.0

/** Pure (exported for tests): how many chunks one item carve spawns. */
export function itemChunkCount(removedCells: number): number {
  if (removedCells <= 0) return 0
  return Math.min(ITEM_CHUNK_CAP, Math.max(1, Math.round(removedCells / ITEM_CHUNK_PER_CELLS)))
}

/** Pure (exported for tests): one chunk's world size from the grid cell and
 * a 0..1 roll — always inside the 1.6–2.6 × cell band. */
export function itemChunkSize(cell: number, rand01: number): number {
  return cell * (ITEM_CHUNK_SCALE_MIN + rand01 * ITEM_CHUNK_SCALE_SPAN)
}

const _itemSize = new Vector3()

/**
 * SILHOUETTE grid for an item-family target. Budgeted in TWO stages: the
 * raw AABB grid is pre-grown to fit ITEM_VOXEL_BUDGET (hollow shells get to
 * exploit the raised budget — occupancy runs far under raw), and a build
 * that lands exactly on voxel.ts's fill ceiling (= possibly truncated
 * top-off) rebuilds coarser until it fits whole. solid=false keeps
 * buildVoxelGrid's own adaptive loop out of the way (its raw budget is far
 * above ITEM_VOXEL_BUDGET); the sizing here is the only authority.
 */
function buildItemGrid(sources: VoxelSource[], bounds: Box3): VoxelGridData {
  bounds.getSize(_itemSize)
  const minDim = Math.min(_itemSize.x, _itemSize.y, _itemSize.z)
  let cell = Math.min(ITEM_CELL_MAX, Math.max(ITEM_CELL_MIN, minDim / 3))
  const rawCount = () =>
    Math.max(1, Math.ceil(_itemSize.x / cell - 1e-6)) *
    Math.max(1, Math.ceil(_itemSize.y / cell - 1e-6)) *
    Math.max(1, Math.ceil(_itemSize.z / cell - 1e-6))
  for (let guard = 0; guard < 12 && rawCount() > ITEM_VOXEL_BUDGET; guard++) cell *= 1.35
  let grid = buildVoxelGrid(sources, bounds.clone(), cell, false)
  for (let guard = 0; guard < 4 && grid.count >= VOXEL_FILL_CEILING; guard++) {
    cell *= 1.35
    grid = buildVoxelGrid(sources, bounds.clone(), cell, false)
  }
  return grid
}

// ── Item palette (owner: "underline the material, embrace the shape") ───────
// Colorless generic voxels read as nothing; an item's voxels should wear the
// item's own materials. At VOXELIZE time (never per frame) each solid
// sub-mesh resolves one dominant tone — material.color × the map's canvas
// average, the roof-surface-color recipe — and every grid cell is primed
// from the region (sub-mesh world AABB) it came from. voxel-walls.tsx reads
// target.cellColors per instance; debris tint reads it via cellTint.

/** Minimal material slice the palette sampler reads (Mesh['material']). */
type ItemMaterialLike = {
  color?: Color
  map?: { image?: unknown } | null
  metalness?: number
  userData?: { pascal_material?: unknown }
}

/**
 * Average tone of a material's texture map — skin-tone.ts's cached CPU
 * read (data-image or tiny-canvas down-draw). Null headless or for
 * compressed/undrawable images — callers walk the fallback chain then.
 */
function itemMapAverage(material: ItemMaterialLike): Color | null {
  return mapAverageTone(material.map as Parameters<typeof mapAverageTone>[0])
}

/** Dominant material of one sub-mesh: single materials win outright;
 * multi-material meshes resolve through geometry groups to the material
 * covering the most indices (GLB primitives export finite group counts —
 * Infinity counts read as "to the end"). */
function dominantMeshMaterial(mesh: Mesh): ItemMaterialLike | null {
  const material = mesh.material
  if (!Array.isArray(material)) return (material as unknown as ItemMaterialLike) ?? null
  if (material.length === 0) return null
  const groups = mesh.geometry.groups
  if (groups.length === 0) return material[0] as unknown as ItemMaterialLike
  const total = mesh.geometry.getIndex()?.count ?? mesh.geometry.getAttribute('position')?.count ?? 0
  let bestIndex = 0
  let bestCount = -1
  const counts = new Map<number, number>()
  for (const group of groups) {
    const count = Number.isFinite(group.count) ? group.count : Math.max(0, total - group.start)
    const slot = group.materialIndex ?? 0
    counts.set(slot, (counts.get(slot) ?? 0) + count)
  }
  for (const [slot, count] of counts) {
    if (count > bestCount) {
      bestCount = count
      bestIndex = slot
    }
  }
  return (material[bestIndex] ?? material[0]) as unknown as ItemMaterialLike
}

/** Pascal material-library refs whose ids sit in the 'metal' category —
 * catalog GLBs tag every sub-material with `extras.pascal_material`
 * (→ material.userData through the loader), e.g. 'library:metal-chrome'.
 * The library category is the naming convention: every metal id is
 * 'metal-*'. */
const METAL_LIBRARY_REF = /^(?:library:)?metal-/

/** Metal read for ONE material (QA P9R1 fix 2): `metalness > 0.5` catches
 * host-resolved library materials (metal-chrome resolves at 0.6), but
 * catalog GLBs often BAKE metallicFactor 0 (the barbell's chrome bar ships
 * metalness 0) — there the `pascal_material` library tag is the ground
 * truth. Exported for tests. */
export function isMetalItemMaterial(material: ItemMaterialLike | null): boolean {
  if (!material) return false
  if ((material.metalness ?? 0) > 0.5) return true
  const tag = material.userData?.pascal_material
  return typeof tag === 'string' && METAL_LIBRARY_REF.test(tag)
}

/** One sub-mesh's resolved tone: base color × map average when the map is
 * readable (host GLB materials often carry the look in the MAP over a
 * white base — reading `color` alone yields white), else the base color
 * (UNLESS it's the untextured white default masking an unreadable map),
 * else the item fallback tone. `fallback` reports what the tone audit
 * should know (null = truthful tone). */
function itemRegionColor(mesh: Mesh): { tone: Color; fallback: 'no-material' | 'map-unreadable' | null } {
  const material = dominantMeshMaterial(mesh)
  const base = material?.color
  const mapTone = material ? itemMapAverage(material) : null
  if (mapTone) return { tone: base ? mapTone.multiply(base) : mapTone, fallback: null }
  if (material?.map && base && isUntexturedWhite(base)) {
    // A TEXTURED region rendering plain white is a lie (the map carries the
    // look; the base is the host's white default) — wear the item fallback
    // tone instead. A map-less white base stays: porcelain is porcelain.
    return { tone: kindFallbackTone('item'), fallback: 'map-unreadable' }
  }
  if (base) return { tone: base.clone(), fallback: material?.map ? 'map-unreadable' : null }
  return { tone: kindFallbackTone('item'), fallback: 'no-material' }
}

/** Region-volume tiebreak weight (m³ → score): at d² parity (cell inside
 * several overlapping sub-mesh boxes) the SMALLER region wins — a faucet's
 * chrome beats the whole-sink body — while any real distance gap (≳ 3 cm)
 * still beats volume. */
const REGION_VOLUME_WEIGHT = 1e-4

const _regionSize = new Vector3()

/**
 * Prime one color per grid cell from the sub-mesh region it came from: the
 * region minimizing (squared distance to its world AABB) +
 * (volume × REGION_VOLUME_WEIGHT) — containment reads as distance 0, so
 * detail shells beat enclosing bodies, and surface cells whose centers sit
 * a hair proud of a thin shell still resolve to it. Also returns the
 * cell-weighted average tone (the target's baseColor → dust/fallback
 * debris inherit the palette) and — when any region reads metal
 * (isMetalItemMaterial) — a per-cell metal mask riding the same
 * attribution. Voxelize-time only — O(cells × sub-meshes),
 * ≤ ~2600 × a handful. Null when the node exposes no solid meshes.
 */
function sampleItemCellColors(
  nodeId: string,
  grid: VoxelGridData,
  meshes: readonly Mesh[],
): { colors: Float32Array; average: Color; cellMetal?: Uint8Array } | null {
  if (meshes.length === 0 || grid.count === 0) return null
  const regions: Array<{
    box: Box3
    score: number
    r: number
    g: number
    b: number
    metal: boolean
    /** The region material's pattern grid (readable maps only) + the base
     * color multiplier — cells inside this region sample the TEXTURE at a
     * region-relative (u,v) instead of wearing the flat tone. */
    pattern: ToneGrid | null
    baseR: number
    baseG: number
    baseB: number
    /** (u,v) plane = the box's two DOMINANT axes (largest extents,
     * u = largest), world-position projection normalized over the box. */
    u0: number
    v0: number
    uInv: number
    vInv: number
    uAxis: 0 | 1 | 2
    vAxis: 0 | 1 | 2
  }> = []
  let anyMetal = false
  // Tone audit: an item counts as unresolved when ANY region wore a
  // fallback tone (unreadable map beats missing material as the reason).
  let fallbackWhy: 'no-material' | 'map-unreadable' | null = null
  for (const mesh of meshes) {
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
    const box = mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld)
    box.getSize(_regionSize)
    const { tone, fallback } = itemRegionColor(mesh)
    if (fallback && fallbackWhy !== 'map-unreadable') fallbackWhy = fallback
    // Metal rides the SAME region attribution as the palette (QA P9R1 fix
    // 2): most metal items are MIXED — a couch's chrome handle or the
    // barbell's bar must spark without turning the whole item metallic.
    const material = dominantMeshMaterial(mesh)
    const metal = isMetalItemMaterial(material)
    anyMetal ||= metal
    // Pattern lane: a readable map paints the region's cells with the
    // texture itself (one repeat across the region — items are small and
    // their host UVs unrecoverable; the pattern READ is what matters).
    const pattern = material?.map
      ? mapPatternGrid(material.map as Parameters<typeof mapPatternGrid>[0])
      : null
    const extents: Array<[number, 0 | 1 | 2]> = [
      [_regionSize.x, 0],
      [_regionSize.y, 1],
      [_regionSize.z, 2],
    ]
    extents.sort((a, b) => b[0] - a[0])
    const [uExtent, uAxis] = extents[0]!
    const [vExtent, vAxis] = extents[1]!
    const minArr = [box.min.x, box.min.y, box.min.z]
    regions.push({
      box,
      score: _regionSize.x * _regionSize.y * _regionSize.z * REGION_VOLUME_WEIGHT,
      r: tone.r,
      g: tone.g,
      b: tone.b,
      metal,
      pattern: uExtent > 1e-6 && vExtent > 1e-6 ? pattern : null,
      baseR: material?.color?.r ?? 1,
      baseG: material?.color?.g ?? 1,
      baseB: material?.color?.b ?? 1,
      u0: minArr[uAxis]!,
      v0: minArr[vAxis]!,
      uInv: uExtent > 1e-6 ? 1 / uExtent : 0,
      vInv: vExtent > 1e-6 ? 1 / vExtent : 0,
      uAxis,
      vAxis,
    })
  }
  if (fallbackWhy) reportToneFallback(nodeId, 'item', fallbackWhy)
  else clearToneAudit(nodeId)
  const colors = new Float32Array(grid.count * 3)
  const cellMetal = anyMetal ? new Uint8Array(grid.count) : undefined
  let sumR = 0
  let sumG = 0
  let sumB = 0
  for (let i = 0; i < grid.count; i++) {
    const x = grid.centers[i * 3]!
    const y = grid.centers[i * 3 + 1]!
    const z = grid.centers[i * 3 + 2]!
    let best = regions[0]!
    let bestScore = Infinity
    for (const region of regions) {
      const b = region.box
      const dx = Math.max(b.min.x - x, 0, x - b.max.x)
      const dy = Math.max(b.min.y - y, 0, y - b.max.y)
      const dz = Math.max(b.min.z - z, 0, z - b.max.z)
      const score = dx * dx + dy * dy + dz * dz + region.score
      if (score < bestScore) {
        bestScore = score
        best = region
      }
    }
    let r = best.r
    let g = best.g
    let b = best.b
    if (best.pattern) {
      // Sample the region's texture at the cell's projected (u,v) — the
      // per-cell pattern — modulated by the material's base color (the
      // same multiply the flat itemRegionColor tone applies).
      const u = ((best.uAxis === 0 ? x : best.uAxis === 1 ? y : z) - best.u0) * best.uInv
      const v = ((best.vAxis === 0 ? x : best.vAxis === 1 ? y : z) - best.v0) * best.vInv
      cellToneAt(_cellPattern, best.pattern, u, v)
      r = _cellPattern.r * best.baseR
      g = _cellPattern.g * best.baseG
      b = _cellPattern.b * best.baseB
    }
    colors[i * 3] = r
    colors[i * 3 + 1] = g
    colors[i * 3 + 2] = b
    if (cellMetal && best.metal) cellMetal[i] = 1
    sumR += r
    sumG += g
    sumB += b
  }
  return {
    colors,
    average: new Color(sumR / grid.count, sumG / grid.count, sumB / grid.count),
    cellMetal,
  }
}

const _cellPattern = new Color()

const _cellTint = new Color()

/** Debris/shard tone for one removed cell: the sampled item palette when
 * the target carries one, else the cell's PRIMED skin tone (skin-tone.ts
 * primedCellColor — the very color the voxel wore on the wall). Debris
 * always matches the surface it came off: a floor slab's under-layer cells
 * shed dirt-brown clods and its top cells shed tile/asphalt-pattern chips
 * — never the flat averaged baseColor lie (owner: "broken floor looks
 * broken"). Scratch — spawnDebris/spawnFlatDebris copy the color
 * immediately; primedCellColor is pure module-scratch math, so this stays
 * allocation-free in the carve hot path. Exported for tests. */
export function cellTint(target: VoxelTarget, idx: number): Color {
  const colors = target.cellColors
  if (!colors) return primedCellColor(_cellTint, target, idx)
  return _cellTint.setRGB(colors[idx * 3]!, colors[idx * 3 + 1]!, colors[idx * 3 + 2]!)
}

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
 * FOLLOW-UP: joists still run through stair holes — the world snapshot
 * carries no stair-opening geometry today (stair nodes aren't hosted
 * children of the slab the way doors/windows are of walls), so there is no
 * trivially-detectable rect to clip against; wire it through the
 * buildStuds-style opening clip once a stair-hole snapshot exists.
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
 * run and ~2.4 m up (roof planes pass ~1.2 m square shingle-course tiles).
 * Remainder tiles merge into their neighbor so no sliver sheets exist.
 * Works on yaw-local AND full-basis (pitched roof-plane) grids — tiling
 * runs on grid coords, centers/normals come out world-space.
 */
/** Scratch for buildSheets' basis-rotated outward normals. */
const _sheetNormalScratch = { x: 0, y: 0, z: 0 }

function buildSheets(
  grid: VoxelGridData,
  tileW = SHEET_W,
  tileH = SHEET_H,
): { sheets: SheetMember[]; sheetByCell: Int32Array } {
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
  const tileU = Math.max(1, Math.round(tileW / cells[u]!))
  const tileV = Math.max(1, Math.round(tileH / cells[v]!))
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
    // Full-basis grids (pitched roof planes) rotate through the quaternion
    // conjugate — the yaw trig below only knows Y rotations.
    const sign = side === 0 ? -1 : 1
    let nX = 0
    let nY = 0
    let nZ = 0
    if (grid.q.x !== 0 || grid.q.z !== 0) {
      rotateByBasisInverse(
        grid.q,
        t === 0 ? sign : 0,
        t === 1 ? sign : 0,
        t === 2 ? sign : 0,
        _sheetNormalScratch,
      )
      nX = _sheetNormalScratch.x
      nY = _sheetNormalScratch.y
      nZ = _sheetNormalScratch.z
    } else if (t === 0) {
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

/**
 * The material a target's tone chain should read: the one owning the most
 * FACE AREA (the old first-material grab returned white cap/trim slots on
 * textured hosts — the "voxels are still the default untextured white"
 * live complaint). Slab-family targets (floors included) prefer their
 * upward-facing area (the floor finish), then NON-downward faces — the
 * white ceiling underside must never win a floor's tone by area (owner
 * wave 5: "the floor inside the house is white") — and only then all
 * faces; everything else reads all faces. Exported for tests.
 */
export function dominantTargetMaterial(
  meshes: readonly Mesh[],
  kind: SkinToneKind,
): Parameters<typeof resolveSurfaceTone>[2] {
  if (kind === 'slab' || kind === 'floor') {
    const top = dominantMaterialBy(meshes, (ny) => ny > 0.7)
    if (top) return top
    const nonDown = dominantMaterialBy(meshes, (ny) => ny > -0.7)
    if (nonDown) return nonDown
  }
  return dominantMaterialBy(meshes, () => true)
}

/** The async-retint sink for a single target: when a pending tone lands
 * (texture finished loading / GPU readback), copy it — and the texture's
 * pattern grid — into the LIVE target and bump skinRevision — voxel-walls
 * re-primes the skin layer once (cells now wear the pattern); paint coats
 * re-apply from the ledger (drainPaintTints — the serials never move).
 * Looks the target up fresh: it may have dropped (or the session reset)
 * while the tone was pending. */
function retintTarget(nodeId: string): (tone: Color, grid: ToneGrid | null) => void {
  return (tone, grid) => {
    const live = useDestruction.getState().targets.get(nodeId)
    if (!live) return
    live.baseColor.copy(tone)
    if (grid) live.toneGrid = grid
    live.skinRevision = (live.skinRevision ?? 0) + 1
  }
}

/**
 * A node's explicitly saved coat — the color the paint bridge (or an editor
 * custom paint) wrote into the scene, resolved the way the host renders
 * walls: `node.slots[interior|exterior]` scene-material ref FIRST, then the
 * legacy inline `material`. Only 'custom' coats qualify — preset/texture
 * finishes keep the mesh-sample fallback, which reads their real render
 * tone. Pure and exported for tests.
 */
export function savedCoatHex(
  node: {
    slots?: Record<string, string>
    material?: { preset?: string; properties?: { color?: string } }
  },
  materials?: Record<string, { material?: { preset?: string; properties?: { color?: string } } }>,
): string | null {
  for (const side of ['interior', 'exterior']) {
    const ref = node.slots?.[side]
    if (typeof ref !== 'string' || !ref.startsWith('scene:')) continue
    const coat = materials?.[ref.slice('scene:'.length)]?.material
    if (coat?.preset === 'custom' && typeof coat.properties?.color === 'string') {
      return coat.properties.color
    }
  }
  const legacy = node.material
  if (legacy?.preset === 'custom' && typeof legacy.properties?.color === 'string') {
    return legacy.properties.color
  }
  return null
}

/** Wall lane: the scene node's saved coat beats the mesh sample — the first
 * mesh material can be a cap/default-face tone, so a freshly saved coat
 * would otherwise re-enter as the old greige skin. Read-only store access. */
function nodeCoatColor(nodeId: string): Color | null {
  const state = useScene.getState() as ReturnType<typeof useScene.getState> & {
    materials?: Record<string, { material?: { preset?: string; properties?: { color?: string } } }>
  }
  const node = state.nodes[nodeId as AnyNodeId] as Parameters<typeof savedCoatHex>[0] | undefined
  if (!node) return null
  const hex = savedCoatHex(node, state.materials)
  return hex ? new Color(hex) : null
}

/**
 * Hide a node's host meshes (session ledger — the editor gets them back
 * untouched) and hand its colliders over to the voxel replica. A wall's
 * render mesh is the scene-graph PARENT of its hosted door/window/item
 * roots (the host's WallRenderer nests them), so a plain `visible = false`
 * would cull live doors and windows along with the wall — masking keeps
 * them rendering; every other node's own root is fenced the same way the
 * collect-time mesh sweep fences (world.solidRoots). The node's OWN root
 * must not fence its own hide.
 *
 * FEET SEE THE PLANE: entries marked `walkOnClad` (placed stairs/roof
 * planks — builder.tsx) hand over as `walkOnly` instead of `disabled`, so
 * the capsule keeps the smooth merged-box surface while bullets, raycasts
 * and support probes switch to the voxel grid. Returns whether any entry
 * was promoted (the caller stamps target.walkOnly so collideVoxelTargets
 * skips the coincident grid).
 */
function hideHostNode(
  world: GameWorld,
  nodeId: string,
  meshes: readonly Mesh[],
  wallRoot?: Object3D,
  maskOnly?: boolean,
): boolean {
  // WALL swaps first dissolve the host's merged wall-batch presentation
  // (Full-height mode only): under a batch this wall's own mesh isn't the
  // one drawing, so hiding it below would leave the pristine merged copy
  // rendering over the voxel replica — the owner's "walls are forever up
  // in Full height" bug. No-op when no live batch exists (cheap: one pass
  // over each level root's direct children). See session.sweepWallBatches.
  if (wallRoot) sweepWallBatches()
  const keepRoots = new Set(world.solidRoots ?? [])
  if (wallRoot) keepRoots.delete(wallRoot)
  for (const collider of world.colliders) {
    if (collider.nodeId === nodeId) keepRoots.delete(collider.root)
  }
  // ITEM-family nodes hide via the layers mask, not the `visible` flip:
  // the first item wake used to stall the render submit ~60 ms with zero
  // renderer-count change — host-side systems reacting to `visible = false`
  // on the GLB item meshes. Masks don't cascade and nothing host-side
  // watches layers, so the wake goes back to being cheap. collectWorld's
  // mesh sweep gathered EVERY solid leaf mesh of the node (fenced at other
  // nodes' roots), so masking each one hides exactly what the flip hid;
  // restore rides the session teardown list.
  if (maskOnly) {
    for (const mesh of meshes) maskForGame(mesh)
  } else {
    for (const mesh of meshes) hideForGameKeepingRoots(mesh, keepRoots)
  }
  let walkOnly = false
  for (const collider of world.colliders) {
    if (collider.nodeId !== nodeId) continue
    if (collider.walkOnClad) {
      collider.walkOnly = true
      walkOnly = true
    } else {
      collider.disabled = true
    }
  }
  return walkOnly
}

/** FEET SEE THE PLANE retires past this damage: once a walk-only piece has
 * lost MORE than this fraction of its voxel cells, its smooth plank collider
 * demotes to `disabled` and the voxel grid (holes and all) owns movement
 * too. 12 % was chosen over per-column footprint checks because it is one
 * cheap compare per carve with no per-frame work — and a hole the capsule
 * (r 0.34 m) could actually fall through costs well past 12 % of a 3 m
 * plank's cells, so light chip damage never bumps the feet. */
export const WALK_ONLY_MAX_DAMAGE = 0.12

/** Pure flip decision (exported for tests): has this grid lost more than
 * WALK_ONLY_MAX_DAMAGE of its cells? */
export function walkOnlyExpired(aliveCount: number, count: number): boolean {
  return count - aliveCount > count * WALK_ONLY_MAX_DAMAGE
}

/** Demote a damaged-past-threshold walk-only target: clear target.walkOnly
 * (collideVoxelTargets collides its grid again) and flip its plank
 * colliders walkOnly → disabled (holes become real for feet too). No-op —
 * one boolean check — for everything else; every cell-removal path calls
 * it (carves, island crumbles, whole-target collapses). */
function settleWalkOnly(world: GameWorld, target: VoxelTarget): void {
  if (!target.walkOnly || !walkOnlyExpired(target.grid.aliveCount, target.grid.count)) return
  target.walkOnly = false
  for (const collider of world.colliders) {
    if (collider.nodeId !== target.nodeId || !collider.walkOnly) continue
    collider.walkOnly = false
    collider.disabled = true
  }
}

// ── Roof plane lane (MULTILEVEL-PLAN Phase C2) ──────────────────────────────
// A pitched roof shell voxelizes as ONE THIN PINNED GRID PER PLANE, each
// axis-aligned in its slope frame (grid X = across the eave, grid Y = up
// the slope, grid Z = through the assembly — the outer/shingle surface is
// the MIN-z face), instead of the old single axis-aligned volume whose
// adaptive cells stair-stepped the silhouette and could grow past every
// weapon's holeRadius (the QA "bulletproof roof"). Member targets live in
// the normal target map under `<nodeId>#p<n>` ids — plus one `#residual`
// member tracing the shell faces NO plane covers (vertical gable-end
// triangles; see buildRoofResidualTarget) — and the real node id keeps a
// group record so damage through EITHER id fans out to every sibling
// (the planes overlap a hair at ridges/hips — a seam shot must open both).
// Roof targets register with structure.ts as SUPPORTERS only (kind 'roof'
// is never a crumble candidate, matching the V1 pitched-grid rule).

/** In-plane preferred cell for roof plane grids (QA C2: ~0.18 m; large
 * planes grow adaptively in buildVoxelGrid's ×1.35 steps). */
const ROOF_PLANE_CELL = 0.18
/** Outer-skin shingle sheets tile ~1.2 m squares in plane space. */
const ROOF_SHEET_TILE = 1.2
/** Carve-radius safety floor for roof/volume targets, as a fraction of the
 * largest cell dimension — no target can ever be bulletproof again (QA C2
 * defect b: 0.5 m adaptive cells vs 0.11 m pistol holeRadius). */
/** ≥ a cell's half-diagonal (√3/2 ≈ 0.866): 0.75 left a dead band where a
 * carve sphere centered on a cell FACE missed the cell's center — catalog
 * items ate ~half of all rifle rounds with zero cells removed (the
 * "bullet-sponge toilet" live finding). */
const CARVE_CELL_FLOOR = 0.88
/** Slack the plane grid's bounds add through the thickness so the outer
 * and inner surfaces sit strictly inside the first/last cell layer (a face
 * exactly on a cell boundary voxelizes flakily — see PLATE_SYNTH_T). */
const ROOF_Z_PAD = 0.004

/** Real roof nodeId → its per-plane member target ids. */
const roofGroups = new Map<string, string[]>()
/** Member target id → its group's real nodeId. */
const roofMemberOf = new Map<string, string>()

const _planeBasisMat = new Matrix4()
const _planeQuat = new Quaternion()
const _planeAcross = new Vector3()
const _planeUp = new Vector3()
const _planeIn = new Vector3()
const _planeBounds = new Box3()

/**
 * Build one pitched VoxelTarget per enumerated roof plane; returns the
 * first member (ensureVoxelTarget's return for the real node id) or null
 * when the shell exposes no usable plane — the caller keeps the legacy
 * volume lane then (flat roofs frame nothing and stay chunky, as before).
 * All planes build in the SAME tick, so the merged host mesh hides exactly
 * once, after every replica is ready.
 */
function buildRoofPlaneTargets(
  world: GameWorld,
  nodeId: string,
  meshes: Mesh[],
  sources: VoxelSource[],
  dormant?: boolean,
  deferShell?: boolean,
): VoxelTarget | null {
  // Family AABB snapshot for the deferred-build queue (ensureVoxelTarget's
  // _bounds scratch still holds the node bounds at entry — copy the queue
  // inputs out before any other module code can touch the scratch).
  const familyBounds = deferShell ? _bounds.clone() : null
  const residualTris: number[] = []
  const planes = enumerateRoofPlanes(meshes, residualTris)
  if (planes.length === 0) return null
  // CONFORMING SHELL (S1a, session-latched 'roof' flag): every plane member
  // also carries its OWN slice of the host roof surface — bucketed ONCE per
  // family (assignRoofTrisToMembers). Bucketing before clipping is load-
  // bearing: shell.ts's cellOfTriangle clamps out-of-grid centroids, so an
  // unbucketed ridge/hip triangle would misfile into a border cell AND
  // duplicate across the sibling members' shells. The residual member stays
  // voxel-only. Shelled families ALWAYS register dormant below — the
  // first-damage family wake is the host→shell swap moment.
  // S2 LAZY TIER: a FAR family (deferShell) skips the bucketing + clipping
  // entirely — members stamp shellPending and the family builds later from
  // the retained meshes + these planes (see buildPendingRoofFamily).
  const shellOn = shellRoofEnabled()
  const shellDeferred = shellOn && deferShell === true
  const roofShell: RoofMemberTris | null =
    shellOn && !shellDeferred ? assignRoofTrisToMembers(meshes, planes) : null
  // One flat rafter layout over all planes, split per plane (ids re-based
  // 0..n−1 within each group — the SegmentMember contract per target).
  const rafterGroups = splitRaftersByPlane(buildRafters(null, null, planes), planes.length)
  // Skin tone: the roof SURFACE material (dominant sloped-face area), not
  // whatever material slot happens to come first on the merged mesh (QA c:
  // roofs rendered in the white Wall/Trim tone). resolveSurfaceTone walks
  // the full chain (map thumbnail → GPU readback for compressed KTX2 →
  // non-white base → dark-shingle fallback) and retints EVERY plane member
  // of the group when a pending texture resolves later — skinRevision
  // tells voxel-walls to re-prime colors (paint ledger serials stay
  // untouched; coats re-apply via drainPaintTints). The group registers a
  // few lines below; deliveries are async-only, so the lookup never races.
  const roofMaterial = dominantSlopedMaterial(meshes)
  const baseColor = resolveSurfaceTone(nodeId, 'roof', roofMaterial, (tone, grid) => {
    const live = useDestruction.getState().targets
    const group = roofGroups.get(nodeId)
    if (!group) return // roof dropped before the tone resolved
    for (const id of group) {
      // The residual member wears its OWN faces' tone (siding/trim), never
      // the shingle skin — see buildRoofResidualTarget.
      if (id.endsWith(ROOF_RESIDUAL_SUFFIX)) continue
      const member = live.get(id)
      if (!member) continue
      member.baseColor.copy(tone)
      if (grid) member.toneGrid = grid
      member.skinRevision = (member.skinRevision ?? 0) + 1
    }
  })
  // Readable shingle textures also hand every plane the PATTERN grid —
  // cells sample real shingle rows (cellPatternTone) instead of one
  // averaged tone; compressed maps deliver it via the retint above.
  const roofToneGrid = mapPatternGrid(roofMaterial?.map) ?? undefined
  const built: VoxelTarget[] = []
  /** Deferred-shell members: [target, planeIndex] to stamp after register. */
  const pendingPlanes: Array<[VoxelTarget, number]> = []
  for (let p = 0; p < planes.length; p++) {
    const plane = planes[p]!
    const { across, normal, upSlope } = roofPlaneFrame(plane.yaw, plane.pitch)
    // GRID frame: X = across, Y = upSlope, Z = −normal. Right-handed
    // (across × upSlope = −normal), and the OUTER surface lands on the
    // grid's MIN-z face so sheet/skin side 0 is always the shingle side.
    _planeBasisMat.makeBasis(
      _planeAcross.set(across[0], across[1], across[2]),
      _planeUp.set(upSlope[0], upSlope[1], upSlope[2]),
      _planeIn.set(-normal[0], -normal[1], -normal[2]),
    )
    // makeBasis columns are GRID → WORLD; VoxelBasis wants WORLD → GRID.
    _planeQuat.setFromRotationMatrix(_planeBasisMat).invert()
    const q: VoxelBasis = { x: _planeQuat.x, y: _planeQuat.y, z: _planeQuat.z, w: _planeQuat.w }
    // The eave center in grid coordinates (projections onto the frame).
    const [ex, ey, ez] = plane.eaveCenter
    const eA = ex * across[0] + ey * across[1] + ez * across[2]
    const eU = ex * upSlope[0] + ey * upSlope[1] + ez * upSlope[2]
    const eN = ex * normal[0] + ey * normal[1] + ez * normal[2] // inner surface
    const t = Math.max(0.02, plane.thickness)
    // Pin the thickness axis to ≥ 3 layers (two skins + cavity, exactly the
    // wall anatomy turned onto the slope); in-plane cells stay ~0.18 m.
    const layers = Math.max(3, Math.ceil((t + 2 * ROOF_Z_PAD) / 0.15 - 1e-6))
    const thicknessCell = (t + 2 * ROOF_Z_PAD) / layers
    _planeBounds.min.set(eA - plane.eaveLength / 2 - 0.01, eU - 0.01, -eN - t - ROOF_Z_PAD)
    _planeBounds.max.set(eA + plane.eaveLength / 2 + 0.01, eU + plane.slopeLength + 0.01, -eN + ROOF_Z_PAD)
    const grid = dropInteriorCells(
      buildVoxelGrid(
        sources,
        _planeBounds.clone(),
        ROOF_PLANE_CELL,
        false,
        { z: thicknessCell },
        0,
        q,
      ),
      MAX_ANATOMY_THICKNESS,
    )
    if (grid.count === 0) continue
    const sheetInfo = buildSheets(grid, ROOF_SHEET_TILE, ROOF_SHEET_TILE)
    const segments = rafterGroups[p] ?? []
    const memberId = `${nodeId}#p${p}`
    // S1a: this member's shell from ITS OWN world-frame bucket, clipped in
    // the member grid's shell frame (seed = the member id, so the fragment
    // pattern is stable per plane). A null/overflow build leaves just this
    // member voxel-only — never aborts the family.
    const memberShell = roofShell
      ? buildRoofMemberShell(memberId, roofShell.buckets[p]!, grid)
      : undefined
    const member: VoxelTarget = {
      nodeId: memberId,
      kind: 'roof',
      roof: true,
      grid,
      baseColor: baseColor.clone(),
      toneGrid: roofToneGrid,
      segments,
      studs: segments,
      sheets: sheetInfo.sheets,
      sheetByCell: sheetInfo.sheetByCell,
      removedQueue: [],
      revision: 0,
      shell: memberShell,
      shellMaterials: memberShell ? roofShell!.materials : undefined,
    }
    if (shellDeferred) pendingPlanes.push([member, p])
    built.push(member)
  }
  if (built.length === 0) return null

  // RESIDUAL LANE (the vanishing-gable-end fix): the shell's NON-SLOPED
  // faces — vertical gable-end triangles, fascia, flat caps — join no
  // plane cluster, yet hiding the merged host mesh below hides THEM too,
  // so the first hit used to erase them with nothing in their place (the
  // skeleton showed end-on on intersecting-gable roofs). One extra
  // fine-celled volume member traces exactly those excluded faces; a roof
  // with no residual faces builds nothing here (zero cost). Shelled
  // families mute the residual's cells toward bare structure/trim
  // (structuralMute) — its siblings wake pixel-identical shells, so white
  // siding CUBES on the rim would scream (S1 QA item 1).
  const residualTarget = buildRoofResidualTarget(nodeId, meshes, residualTris, shellOn)
  if (residualTarget) built.push(residualTarget)

  // Every plane replica is ready — hide the merged host mesh ONCE, in the
  // same tick, and hand the node's colliders over. Dormant prebuilds defer
  // that hide to wakeTarget (group-wide: one map entry per roof node).
  // Shelled families (S1a) ALWAYS defer: the first-damage wake IS the
  // host→shell swap (invisible — the member shells ARE the host surface),
  // exactly the S0 wall contract. Deferred-shell families (S2) too — the
  // host renders identically whether the shell is built or pending.
  const registerDormant = dormant === true || shellOn
  if (registerDormant) {
    dormantRoofHide.set(nodeId, meshes)
    for (const target of built) {
      target.dormant = true
      dormantCount++
    }
  } else {
    hideHostNode(world, nodeId, meshes)
  }
  const state = useDestruction.getState()
  const ids: string[] = []
  for (const target of built) {
    state.targets.set(target.nodeId, target)
    ids.push(target.nodeId)
    roofMemberOf.set(target.nodeId, nodeId)
    // SUPPORTERS only: kind 'roof' is never a structure crumble candidate.
    registerStructureTarget(target, 'roof')
  }
  roofGroups.set(nodeId, ids)
  // S2 lazy tier: stamp the deferred members + queue the FAMILY build
  // (one entry per family — the bucketing is shared, so the family is the
  // build unit; meshes come from dormantRoofHide at build time).
  if (shellDeferred && pendingPlanes.length > 0 && familyBounds) {
    for (const [member, planeIndex] of pendingPlanes) {
      member.shellPending = { kind: 'roof', planeIndex }
      shellPendingTotal++
    }
    pendingRoofShells.set(nodeId, { planes })
    enqueueShellBuild(nodeId, familyBounds)
  }
  state.bump()
  // Paint decal lane: the plane family is live under the scene node id.
  if (!registerDormant) targetLiveListener?.(nodeId)
  return built[0]!
}

/** The roof group's member id suffix for the excluded-faces target — the
 * same `#` membership pattern as the `#p<n>` plane ids (never a scene node
 * id on its own; damage fan-out, family wake, dropTarget, and the
 * demolition capture all treat it exactly like a plane member). */
const ROOF_RESIDUAL_SUFFIX = '#residual'

const _residualBounds = new Box3()

/**
 * Build the roof group's RESIDUAL member from the triangles
 * enumerateRoofPlanes excluded (packed world-space positions): a plain
 * 'volume' target whose grid is a fine SURFACE trace of exactly those
 * faces, so gable ends keep a replica when the merged host mesh hides.
 * The soup is OPEN geometry — buildVoxelGrid runs surfaceOnly (the
 * interior backface fill would flood the whole attic between two end
 * caps). Cell sizing is the item recipe's two stages leaning on
 * buildVoxelGrid's own adaptive loop (the soup is thin like a wall, so the
 * occupancy-discounted raw budget applies), and a build that lands on the
 * fill ceiling (= possibly truncated) rebuilds coarser until it fits
 * whole. Null when the roof has no residual faces or they trace to
 * nothing. Voxelize-time work only.
 */
function buildRoofResidualTarget(
  nodeId: string,
  meshes: Mesh[],
  tris: number[],
  structuralMute: boolean,
): VoxelTarget | null {
  if (tris.length === 0) return null
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(Float32Array.from(tris), 3))
  // Identity matrixWorld — the residual positions are world-space already.
  const soup = new Mesh(geometry)
  const sources: VoxelSource[] = [{ bvh: bvhFor(soup), matrixWorld: soup.matrixWorld }]
  geometry.computeBoundingBox()
  _residualBounds.copy(geometry.boundingBox!)
  let grid = buildVoxelGrid(
    sources,
    _residualBounds.clone(),
    ITEM_CELL_MAX,
    false,
    undefined,
    0,
    undefined,
    true,
  )
  for (let guard = 0; guard < 4 && grid.count >= VOXEL_FILL_CEILING; guard++) {
    grid = buildVoxelGrid(
      sources,
      _residualBounds.clone(),
      grid.cell * 1.35,
      false,
      undefined,
      0,
      undefined,
      true,
    )
  }
  if (grid.count === 0) return null
  const segments: SegmentMember[] = []
  const residualId = `${nodeId}${ROOF_RESIDUAL_SUFFIX}`
  const residualMaterial = dominantResidualMaterial(meshes)
  return {
    nodeId: residualId,
    kind: 'volume',
    grid,
    // The residual faces' OWN dominant tone (siding/trim on gable ends) —
    // never the shingle skin; the async roof retint skips this member too
    // (it carries its own pending-retry retint under the member id).
    baseColor: resolveSurfaceTone(residualId, 'volume', residualMaterial, retintTarget(residualId)),
    toneGrid: mapPatternGrid(residualMaterial?.map) ?? undefined,
    // Shelled family: the residual's awake cubes mute toward bare
    // structure/trim (see the VoxelTarget field doc) — voxel-only sessions
    // keep the exact legacy siding tone.
    structuralMute: structuralMute || undefined,
    segments,
    studs: segments,
    sheets: [],
    sheetByCell: EMPTY_SHEET_MAP,
    removedQueue: [],
    revision: 0,
  }
}

/** Paint decal lane (phase 9): fired once whenever a node's replica goes
 * LIVE (fresh awake voxelize, roof-plane decomposition, or a dormant wake
 * — the host hides in all three). paint.tsx registers its decal → cell-
 * ledger conversion here; null clears (PaintTool unmount). */
let targetLiveListener: ((nodeId: string) => void) | null = null
export function setTargetLiveListener(cb: ((nodeId: string) => void) | null): void {
  targetLiveListener = cb
}

// ── Conforming shell lane (S0 walls + S1 roofs/slabs, flag-latched) ─────────
// The target's REAL surface, clipped into per-cell fragments (shell.ts), so
// the first hit swaps the host mesh for a pixel-identical partitioned twin
// instead of the voxel-cube read. Everything here runs at VOXELIZE time
// only; carves/saves/raycasts keep reading the grid, untouched.

/** The shell lane's target kinds — one independent flag + latch each. */
export type ShellKind = 'wall' | 'roof' | 'slab'

/** Live shell toggles (QA: `__boots.setShell('wall', v)`). Each kind is
 * read ONCE per session, at the session's first voxelize of that kind
 * (prevoxelize reaches everything before any damage can) — see
 * shellEnabled. S2: all default ON — the game loads looking exactly like
 * the editor (host-original walls/roofs/slabs render until first damage;
 * the wake swaps in the conforming shell, invisibly). `setShell(kind,
 * false)` is the per-kind KILL-SWITCH: next session runs the voxel-only
 * path bit-identical to pre-shell, no code revert needed. */
export const shellFlags: Record<ShellKind, boolean> = {
  wall: true,
  roof: true,
  slab: true,
}

/** Flip a shell flag — affects the NEXT session only (prevoxelize latch). */
export function setShellFlag(kind: ShellKind, v: boolean): void {
  shellFlags[kind] = v
}

/** The session's latched flag values (null = that kind not latched yet). */
const shellLatch: Record<ShellKind, boolean | null> = {
  wall: null,
  roof: null,
  slab: null,
}

/** Latch-on-first-read runtime guard, PER KIND: the first voxelize of a
 * kind in a session freezes its flag for the WHOLE session, so a
 * mid-session flip can never split one house into shelled + unshelled
 * targets of one kind — a state no renderer or save lane has to reason
 * about. resetDestruction re-arms every latch. */
function shellEnabled(kind: ShellKind): boolean {
  return (shellLatch[kind] ??= shellFlags[kind])
}
const shellWallEnabled = (): boolean => shellEnabled('wall')
const shellRoofEnabled = (): boolean => shellEnabled('roof')
const shellSlabEnabled = (): boolean => shellEnabled('slab')

/** FNV-1a over the node id — the deterministic shell seed (same node id ⇒
 * same fragment pattern, every session). */
function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return h >>> 0
}

const _shellNormalMat = new Matrix3()
const _shellV = new Vector3()
const _shellFrame = { x: 0, y: 0, z: 0 }

/**
 * Collect a wall's host-mesh triangles in the SHELL frame — the grid frame
 * with the origin at zero (shell.ts assigns cells by flooring positions by
 * the cell size directly): p_shell = rotateByBasis(grid.q, p_world) − origin,
 * exactly the world→grid math buildVoxelGrid folds into its samplers (and
 * removeSphere/raycastVoxels apply per query). Normals ride the mesh's
 * normal matrix then the same basis rotation; uvs are carried VERBATIM (the
 * shell renders with the host's own material instances). Glass-like
 * sub-meshes are skipped — wall mesh sets are NOT glass-split by
 * collectWorld, and panes belong to the shatter lane. materialIndex points
 * into the returned `materials` table: HOST material instances BY
 * REFERENCE, deduped across meshes and geometry groups.
 */
function collectShellSourceTris(
  meshes: readonly Mesh[],
  grid: VoxelGridData,
): { tris: ShellSourceTri[]; materials: Material[] } {
  const tris: ShellSourceTri[] = []
  const materials: Material[] = []
  const { origin, q } = grid
  for (const mesh of meshes) {
    if (isGlassLikeMesh(mesh)) continue
    const geometry = mesh.geometry
    const position = geometry.getAttribute('position')
    if (!position) continue
    const normal = geometry.getAttribute('normal')
    const uv = geometry.getAttribute('uv')
    const index = geometry.index
    const meshMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    const slotOfMaterial = meshMaterials.map((m) => {
      let slot = materials.indexOf(m)
      if (slot < 0) {
        slot = materials.length
        materials.push(m)
      }
      return slot
    })
    _shellNormalMat.getNormalMatrix(mesh.matrixWorld)
    const vertexCount = index ? index.count : position.count
    const groups =
      geometry.groups.length > 0
        ? geometry.groups
        : [{ start: 0, count: vertexCount, materialIndex: 0 }]
    for (const group of groups) {
      const materialIndex =
        slotOfMaterial[Math.min(group.materialIndex ?? 0, slotOfMaterial.length - 1)] ?? 0
      const end = Math.min(group.start + group.count, vertexCount)
      for (let i = group.start; i + 3 <= end; i += 3) {
        const positions: number[] = []
        const normals: number[] = []
        const uvs: number[] = []
        for (let k = 0; k < 3; k++) {
          const vi = index ? index.getX(i + k) : i + k
          _shellV.fromBufferAttribute(position, vi).applyMatrix4(mesh.matrixWorld)
          rotateByBasis(q, _shellV.x, _shellV.y, _shellV.z, _shellFrame)
          positions.push(
            _shellFrame.x - origin.x,
            _shellFrame.y - origin.y,
            _shellFrame.z - origin.z,
          )
          if (normal) {
            _shellV.fromBufferAttribute(normal, vi).applyMatrix3(_shellNormalMat).normalize()
            rotateByBasis(q, _shellV.x, _shellV.y, _shellV.z, _shellFrame)
            normals.push(_shellFrame.x, _shellFrame.y, _shellFrame.z)
          } else normals.push(0, 1, 0)
          if (uv) uvs.push(uv.getX(vi), uv.getY(vi))
          else uvs.push(0, 0)
        }
        tris.push({ positions, normals, uvs, materialIndex })
      }
    }
  }
  return { tris, materials }
}

/**
 * Build the conforming shell for one SINGLE-GRID target (S0 walls; S1b
 * slabs — one grid covers top + bottom + rim, so the collect-everything
 * walk is the correct partition input there too), or undefined on ANY
 * fallback (no readable triangles, SHELL_TRI_CAP exceeded, clipper throw)
 * — the caller keeps today's voxel-only path then, never crashes. The
 * ShellGrid gets the FULL lattice count (nx·ny·nz): fragmentForCell is
 * indexed by lattice keys, not voxel indices (see the VoxelTarget.shell
 * doc).
 */
function buildWallShell(
  nodeId: string,
  meshes: readonly Mesh[],
  grid: VoxelGridData,
): { shell: ShellData; materials: Material[] } | undefined {
  try {
    const { tris, materials } = collectShellSourceTris(meshes, grid)
    if (tris.length === 0 || materials.length === 0) return undefined
    const shell = buildShellData(
      tris,
      {
        nx: grid.nx,
        ny: grid.ny,
        nz: grid.nz,
        cellX: grid.cellX,
        cellY: grid.cellY,
        cellZ: grid.cellZ,
        count: grid.nx * grid.ny * grid.nz,
      },
      hashString(nodeId),
    )
    if (!shell) return undefined
    return { shell, materials }
  } catch {
    return undefined // clipper threw — per-target voxel fallback, never crash
  }
}

/**
 * Build one ROOF PLANE MEMBER's conforming shell (S1a) from its
 * pre-bucketed WORLD-frame triangles (assignRoofTrisToMembers): transform
 * the bucket into the member grid's SHELL frame — the exact
 * collectShellSourceTris math, p_shell = rotateByBasis(grid.q, p_world) −
 * origin, normals rotation-only — then clip/cluster/pack with the member
 * id as the deterministic seed. Undefined on ANY fallback (empty bucket,
 * SHELL_TRI_CAP, clipper throw): that member keeps today's voxel-only
 * path — a single overflowing plane never aborts the family's shells.
 */
function buildRoofMemberShell(
  memberId: string,
  tris: readonly ShellSourceTri[],
  grid: VoxelGridData,
): ShellData | undefined {
  if (tris.length === 0) return undefined
  try {
    const { origin, q } = grid
    const local: ShellSourceTri[] = tris.map((tri) => {
      const positions: number[] = []
      const normals: number[] = []
      for (let k = 0; k < 9; k += 3) {
        rotateByBasis(q, tri.positions[k]!, tri.positions[k + 1]!, tri.positions[k + 2]!, _shellFrame)
        positions.push(_shellFrame.x - origin.x, _shellFrame.y - origin.y, _shellFrame.z - origin.z)
        rotateByBasis(q, tri.normals[k]!, tri.normals[k + 1]!, tri.normals[k + 2]!, _shellFrame)
        normals.push(_shellFrame.x, _shellFrame.y, _shellFrame.z)
      }
      return { positions, normals, uvs: tri.uvs, materialIndex: tri.materialIndex }
    })
    const shell = buildShellData(
      local,
      {
        nx: grid.nx,
        ny: grid.ny,
        nz: grid.nz,
        cellX: grid.cellX,
        cellY: grid.cellY,
        cellZ: grid.cellZ,
        count: grid.nx * grid.ny * grid.nz,
      },
      hashString(memberId),
    )
    return shell ?? undefined
  } catch {
    return undefined // clipper threw — this member voxel-only, never crash
  }
}

// ── Lazy shell tier (S2 — the memory lever) ─────────────────────────────────
// With shells DEFAULT ON, building every target's shell eagerly at voxelize
// costs ~66k fragments / est. ~140 MB CPU+GPU on the 408-target warner-2
// scene — for geometry that stays `visible = false` until a wake. Dormant
// targets don't need their shell until (a) the player gets close enough
// that a wake is imminent, or (b) an actual wake. So voxelize builds the
// grid/anatomy as always but SKIPS buildShellData beyond SHELL_NEAR_RADIUS
// of the player: the target is stamped `shellPending` and still registers
// dormant (host renders — the look is identical either way). Pending
// shells then build
//   - nearest-first from a budgeted queue (shellBuildTick — the
//     prevoxelize scheduler idioms: ~2 ms/tick, re-sort every
//     PREVOXELIZE_RESORT_MS around the moving player, near-gated so FAR
//     targets stay pending instead of eventually all building), or
//   - synchronously inside wakeTarget, capped per frame
//     (SHELL_SYNC_BUILD_BUDGET_MS) with a graceful voxel-only fallback —
//     a grenade waking many pending targets in one frame builds what the
//     budget allows and the rest wake as voxels (today's look), keeping
//     the boom frame bounded.
// MEMORY CHOICE (re-collect, not retain): pending builds re-collect their
// source triangles from the HOST meshes at build time. The dormant lane
// already retains those mesh references (target.hostMeshes /
// dormantRoofHide) for the deferred hide, so deferral retains ZERO extra
// bytes; keeping the collected shell-frame tris instead would pin
// ~200-400 B per source triangle per target for the whole session. The
// re-collect CPU (one O(tris) transform pass) is well inside the build
// budget.

/** What a deferred shell build needs beyond the retained host meshes. */
export type ShellPendingBuild =
  | { kind: 'single' } // walls + slabs: buildWallShell(hostMeshes, grid)
  | { kind: 'roof'; planeIndex: number } // roof plane member (family build)

/** Shell builds beyond this distance from the player defer (m). Must stay
 * ≥ BLAST_RADIUS (3.2) + throw/wake-ahead fan-out so a grenade landing
 * near the player only ever wakes ALREADY-BUILT shells; far grenades ride
 * the sync-build budget below. */
export const SHELL_NEAR_RADIUS = 14
/** Per-tick time budget for the background queue (ms). */
export const SHELL_BUILD_BUDGET_MS = 2
/** Wake-path sync builds allowed per frame window (ms of build time);
 * past it, this frame's remaining wakes fall back voxel-only. */
export const SHELL_SYNC_BUILD_BUDGET_MS = 3
/** Sync-budget accounting window — one display frame with slack. */
const SHELL_SYNC_WINDOW_MS = 12

/** The player position shells measure "near" against — stamped by every
 * focused prevoxelizeTick / shellBuildTick call. Unset (headless tests,
 * hand-built worlds) means EVERY shell builds eagerly, the S1 behavior. */
const shellFocus = { x: 0, y: 0, z: 0 }
let shellFocusSet = false
const _shellFocusV = new Vector3()

function stampShellFocus(focus: { x: number; y: number; z: number }): void {
  shellFocus.x = focus.x
  shellFocus.y = focus.y
  shellFocus.z = focus.z
  shellFocusSet = true
}

/** Near test at voxelize time: the node's world AABB within
 * SHELL_NEAR_RADIUS of the focus (no focus ⇒ near ⇒ eager). */
function shellBuildIsNear(bounds: Box3): boolean {
  if (!shellFocusSet) return true
  return (
    bounds.distanceToPoint(_shellFocusV.set(shellFocus.x, shellFocus.y, shellFocus.z)) <=
    SHELL_NEAR_RADIUS
  )
}

/** One queue entry per pending SINGLE target or roof FAMILY: id (nodeId or
 * roof group id), world AABB center + half-diagonal for the near gate. */
type ShellQueueEntry = { id: string; x: number; y: number; z: number; r: number; d2: number }

let shellQueue: ShellQueueEntry[] = []
let shellQueueCursor = 0
let shellQueueSortedAt = Number.NEGATIVE_INFINITY
/** Live count of targets with shellPending (roof members count each). */
let shellPendingTotal = 0
/** Deferred roof families: groupId → the voxelize-time plane enumeration
 * (a few dozen numbers per roof — meshes come from dormantRoofHide). */
const pendingRoofShells = new Map<string, { planes: RoofPlane[] }>()
/** Wake-path sync budget window (see SHELL_SYNC_BUILD_BUDGET_MS). */
let syncShellWindowStart = Number.NEGATIVE_INFINITY
let syncShellSpentMs = 0

/** QA/tests: pending deferred shell builds still outstanding. */
export function shellPendingCount(): number {
  return shellPendingTotal
}

/**
 * QA/tests: the near-gate SPHERE a pending entry was queued with (center +
 * radius, world space). The gate is `centerDistance − r > SHELL_NEAR_RADIUS
 * ⇒ still far`, so the sphere must CONTAIN the node's world AABB or a node
 * that is genuinely near reads as far and stays pending — see
 * shell-queue-bounds.test.ts.
 */
export function shellQueueSphere(
  id: string,
): { x: number; y: number; z: number; r: number } | null {
  for (const entry of shellQueue) {
    if (entry.id === id) return { x: entry.x, y: entry.y, z: entry.z, r: entry.r }
  }
  return null
}

function clearShellPending(target: VoxelTarget): void {
  if (!target.shellPending) return
  target.shellPending = undefined
  shellPendingTotal--
}

function enqueueShellBuild(id: string, bounds: Box3): void {
  shellQueue.push({
    id,
    x: (bounds.min.x + bounds.max.x) / 2,
    y: (bounds.min.y + bounds.max.y) / 2,
    z: (bounds.min.z + bounds.max.z) / 2,
    r:
      Math.hypot(
        bounds.max.x - bounds.min.x,
        bounds.max.y - bounds.min.y,
        bounds.max.z - bounds.min.z,
      ) / 2,
    d2: 0,
  })
}

/** Is this queue entry still owed a build? (Sync wakes and drops resolve
 * pendings out from under the queue — stale entries skip for free.) */
function shellEntryPending(id: string): boolean {
  if (pendingRoofShells.has(id)) return true
  return useDestruction.getState().targets.get(id)?.shellPending !== undefined
}

/** Build ONE pending single-target shell (walls + slabs): re-collect from
 * the retained host meshes, attach, and re-prime the core replica
 * (skinRevision — it may have primed full-size/facade while pending). */
function buildPendingSingleShell(target: VoxelTarget): void {
  const meshes = target.hostMeshes
  clearShellPending(target)
  if (!meshes || meshes.length === 0) return // already woke — voxel-only
  const built = buildWallShell(target.nodeId, meshes, target.grid)
  if (!built) return // S0/S1 fallback semantics: voxel-only, never crash
  target.shell = built.shell
  target.shellMaterials = built.materials
  target.skinRevision = (target.skinRevision ?? 0) + 1
  useDestruction.getState().bump()
}

/** Build a deferred roof FAMILY's member shells in one go — the tri
 * bucketing (assignRoofTrisToMembers) is the shared expensive step, so
 * the family is the build unit exactly as it is at eager voxelize. */
function buildPendingRoofFamily(groupId: string): void {
  const family = pendingRoofShells.get(groupId)
  pendingRoofShells.delete(groupId)
  const state = useDestruction.getState()
  const members: Array<[VoxelTarget, number]> = []
  for (const id of roofGroups.get(groupId) ?? []) {
    const member = state.targets.get(id)
    if (member?.shellPending?.kind === 'roof') {
      members.push([member, member.shellPending.planeIndex])
      clearShellPending(member)
    }
  }
  const meshes = dormantRoofHide.get(groupId)
  if (!family || !meshes || members.length === 0) return
  let roofShell: RoofMemberTris
  try {
    roofShell = assignRoofTrisToMembers(meshes, family.planes)
  } catch {
    return // family falls back voxel-only, never crashes
  }
  let attached = false
  for (const [member, planeIndex] of members) {
    const shell = buildRoofMemberShell(member.nodeId, roofShell.buckets[planeIndex] ?? [], member.grid)
    if (!shell) continue
    member.shell = shell
    member.shellMaterials = roofShell.materials
    member.skinRevision = (member.skinRevision ?? 0) + 1
    attached = true
  }
  if (attached) state.bump()
}

function buildPendingShellEntry(id: string): void {
  if (pendingRoofShells.has(id)) {
    buildPendingRoofFamily(id)
    return
  }
  const target = useDestruction.getState().targets.get(id)
  if (target?.shellPending) buildPendingSingleShell(target)
}

/** Drop a whole pending roof family — the wake-budget fallback. */
function dropPendingRoofFamily(groupId: string): void {
  pendingRoofShells.delete(groupId)
  const state = useDestruction.getState()
  for (const id of roofGroups.get(groupId) ?? []) {
    const member = state.targets.get(id)
    if (member) clearShellPending(member)
  }
}

/**
 * WAKE-PATH sync build: a pending shell must exist BEFORE the host hides
 * (the wake IS the invisible host→shell swap), so wakeTarget calls this
 * first. Builds are capped per frame window (SHELL_SYNC_BUILD_BUDGET_MS of
 * measured build time inside SHELL_SYNC_WINDOW_MS) — a blast waking many
 * pending targets in one frame builds what the budget allows and the rest
 * fall back to today's voxel wake, gracefully and permanently for those
 * targets. Uses the swappable scheduler clock so tests can pin the policy.
 */
function syncPendingShellForWake(target: VoxelTarget): void {
  const groupId = roofMemberOf.get(target.nodeId)
  const pendingFamily = groupId !== undefined && pendingRoofShells.has(groupId)
  if (!target.shellPending && !pendingFamily) return
  const t0 = now()
  if (t0 - syncShellWindowStart > SHELL_SYNC_WINDOW_MS) {
    syncShellWindowStart = t0
    syncShellSpentMs = 0
  }
  if (syncShellSpentMs >= SHELL_SYNC_BUILD_BUDGET_MS) {
    // Budget spent this frame — voxel-only fallback for this wake.
    if (pendingFamily && groupId !== undefined) dropPendingRoofFamily(groupId)
    else clearShellPending(target)
    perfEvent(`shell-sync-skip ${target.nodeId}`)
    return
  }
  if (pendingFamily && groupId !== undefined) buildPendingRoofFamily(groupId)
  else buildPendingSingleShell(target)
  const spent = now() - t0
  syncShellSpentMs += spent
  perfSection('shell-sync-build', spent)
}

/**
 * Background queue drain — one budgeted slice per frame (game-root drives
 * it after prevoxelize completes; a no-op costs one counter check).
 * Nearest-first around `focus`, re-sorted every PREVOXELIZE_RESORT_MS, and
 * NEAR-GATED: the pass stops at the first entry beyond SHELL_NEAR_RADIUS
 * (entries are sorted, so everything after is farther) — far shells STAY
 * pending until the player approaches or a wake demands them. That gate is
 * the memory lever: idle sessions hold shells only for the visited
 * neighborhood, never all 400+. budgetMs ≤ 0 is the probe/focus-stamp
 * contract (stamp the focus, never work). Returns true when nothing is
 * pending anymore.
 */
export function shellBuildTick(
  budgetMs: number = SHELL_BUILD_BUDGET_MS,
  focus?: { x: number; y: number; z: number },
): boolean {
  if (focus) stampShellFocus(focus)
  if (shellPendingTotal === 0) {
    if (shellQueue.length > 0) {
      shellQueue = []
      shellQueueCursor = 0
    }
    return true
  }
  if (budgetMs <= 0) return false
  const start = now()
  if (
    start - shellQueueSortedAt >= PREVOXELIZE_RESORT_MS ||
    shellQueueCursor >= shellQueue.length
  ) {
    // Compact stale entries, refresh distances, nearest first.
    const live: ShellQueueEntry[] = []
    for (const entry of shellQueue) {
      if (!shellEntryPending(entry.id)) continue
      entry.d2 = shellFocusSet
        ? (entry.x - shellFocus.x) ** 2 +
          (entry.y - shellFocus.y) ** 2 +
          (entry.z - shellFocus.z) ** 2
        : 0
      live.push(entry)
    }
    live.sort((a, b) => a.d2 - b.d2)
    shellQueue = live
    shellQueueCursor = 0
    shellQueueSortedAt = start
  }
  const deadline = start + budgetMs
  let built = 0
  while (shellQueueCursor < shellQueue.length) {
    const entry = shellQueue[shellQueueCursor]!
    if (!shellEntryPending(entry.id)) {
      shellQueueCursor++
      continue
    }
    // NEAR GATE: sorted order means the first far entry ends the pass.
    if (shellFocusSet && Math.sqrt(entry.d2) - entry.r > SHELL_NEAR_RADIUS) return false
    // At least one build lands per funded tick (the prevoxelize contract).
    if (built > 0 && now() >= deadline) return false
    const buildT0 = performance.now()
    buildPendingShellEntry(entry.id)
    perfSection('shell-queue-build', performance.now() - buildT0)
    built++
    shellQueueCursor++
  }
  return shellPendingTotal === 0
}

/**
 * Voxelize ANY collider group on first damage; hides the host meshes via
 * the session ledger. Walls (world.walls) become two drywall skins with
 * breakable studs in the cavity; item-family nodes take the SILHOUETTE lane
 * (buildItemGrid — fine shape-preserving cells); every other node type
 * (doors, roofs…) becomes a plain adaptive volume capped at 1600 voxels.
 */
export function ensureVoxelTarget(
  world: GameWorld,
  nodeId: string,
  opts?: { dormant?: boolean },
): VoxelTarget | null {
  const state = useDestruction.getState()
  const existing = state.targets.get(nodeId)
  if (existing) {
    // An awake request (the default) promotes a dormant prebuild in place.
    if (existing.dormant && !opts?.dormant) wakeTarget(world, existing)
    return existing
  }
  // A roof node that already decomposed into per-plane targets must never
  // rebuild from its (hidden, disabled) host meshes — hand back the first
  // live member instead.
  const roofGroup = roofGroups.get(nodeId)
  if (roofGroup) {
    for (const id of roofGroup) {
      const member = state.targets.get(id)
      if (member) {
        if (member.dormant && !opts?.dormant) wakeTarget(world, member)
        return member
      }
    }
    return null
  }

  perfEvent('voxelize')
  sessionWorld = world
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

  // ROOF PLANE LANE (Phase C2): pitched roof shells decompose into one
  // thin plane-aligned target per slope — see buildRoofPlaneTargets. Flat
  // or degenerate shells return null here and keep the volume lane below.
  // S2: far roofs defer their family shell build (lazy tier).
  if (!wall && nodeType !== null && ROOF_KINDS.has(nodeType)) {
    const primary = buildRoofPlaneTargets(
      world,
      nodeId,
      meshes,
      sources,
      opts?.dormant,
      !shellBuildIsNear(_bounds),
    )
    if (primary) return primary
  }

  let grid: ReturnType<typeof buildVoxelGrid>
  let kind: VoxelTarget['kind'] = wall ? 'wall' : 'volume'
  let slabThickness = 0
  let slabJoistsHang = false
  let contactOnlySupport = false
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
      contactOnlySupport = true
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
  } else if (nodeType !== null && ITEM_FAMILY_KINDS.has(nodeType)) {
    // ITEM SILHOUETTE (phase 6): fine cells traced from the item's own
    // bounds — a toilet reads as a toilet in voxels, never 3 fat cubes.
    // Glass-like sub-meshes never reach here: collectWorld routed them to
    // world.glass, so they are not collider sources for this node.
    grid = buildItemGrid(sources, _bounds)
  } else {
    grid = buildVoxelGrid(sources, _bounds.clone(), 0.15, true)
  }
  if (grid.count === 0) return null

  const sheetInfo = kind !== 'volume' ? buildSheets(grid) : null
  // The stud-line layout is scaffolding only — the real members are the
  // stick segments split from it. `studs` aliases the SAME array. Slabs
  // frame with joists generated from their world box (mirror of the studs).
  // Roof nodes reaching THIS point are the plane-less fallback (flat /
  // degenerate shells — buildRoofPlaneTargets above owns pitched roofs);
  // they enumerate zero planes and frame nothing.
  const roof = nodeType !== null && ROOF_KINDS.has(nodeType)
  const item = nodeType !== null && ITEM_FAMILY_KINDS.has(nodeType)
  // Item palette: sample the sub-mesh materials ONCE, at voxelize time —
  // the voxels (and their debris) wear the item's own tones, and the
  // target's flat baseColor becomes the palette average so dust/fallbacks
  // stay in family.
  const itemPalette = item ? sampleItemCellColors(nodeId, grid, meshes) : null
  // Metal read (phase 9 juice lane): ANY sub-mesh whose dominant material
  // reads metal (metalness OR pascal_material library tag — see
  // isMetalItemMaterial) flags the target, and the palette sampler's
  // per-cell mask localizes the sparks to the metal parts (shooting.ts's
  // isMetalHit — a couch sparks on its chrome handle only).
  const metal = item && itemPalette?.cellMetal !== undefined
  // A wall's saved custom coat beats the mesh read (flat paint — the tone
  // chain and the pattern lane both stand down); the dominant surface
  // material feeds both otherwise.
  const coatColor = wall ? nodeCoatColor(nodeId) : null
  // FLOOR-family slabs (everything but explicit ceilings) resolve through
  // the 'floor' tone lane: the fallback is wood-family (never the screed
  // gray that read "white") and the under-layers wear the dirt subfloor
  // tone (VoxelTarget.floorCore → skin-tone.ts). Owner wave 5.
  const floorSlab = kind === 'slab' && nodeType !== 'ceiling'
  // CEILING slabs take the FACE-tinted ceiling geometry in voxel-walls
  // (VoxelTarget.ceilingTop → skin-tone.ts CEILING_FACE_TINT): their attic
  // side is only ever seen through the eave slit, where interior white
  // read as light sawtooth teeth against the dark roof (round-5 QA).
  const ceilingSlab = kind === 'slab' && nodeType === 'ceiling'
  const toneKind: SkinToneKind = floorSlab ? 'floor' : kind
  const surfaceMaterial = itemPalette || coatColor ? null : dominantTargetMaterial(meshes, toneKind)
  // CONFORMING SHELL (S0 walls + S1b slabs, session-latched per-kind
  // flags): the target also carries its real surface partitioned into
  // per-cell fragments. Slab sandwiches reuse the wall builder unchanged —
  // ONE grid covers top + bottom + rim, so collecting every non-glass
  // triangle is the correct partition input (no per-member bucketing like
  // roofs need). Shelled targets register DORMANT below — the host keeps
  // rendering AND colliding until the first damage wakes them
  // (damageTarget → wakeTarget), and the wake IS the swap: hideHostNode
  // runs there while the shell + core replicas flip visible off the same
  // `dormant` drop / store bump. Any build fallback keeps today's
  // instant-awake voxel path.
  // S2 LAZY TIER: beyond SHELL_NEAR_RADIUS of the player the build DEFERS
  // (shellPending) — the target still registers dormant (host renders,
  // identical look) and the shell arrives via the budgeted queue or the
  // wake-path sync build.
  const shellKindOn = wall ? shellWallEnabled() : kind === 'slab' && shellSlabEnabled()
  const shellDeferred = shellKindOn && !shellBuildIsNear(_bounds)
  const targetShell =
    shellKindOn && !shellDeferred ? buildWallShell(nodeId, meshes, grid) : undefined
  const segments = wall
    ? buildSegments(wall, buildStuds(wall, grid, collectWallOpenings(world, nodeId)))
    : kind === 'slab'
      ? buildJoists(_bounds, slabThickness, slabJoistsHang)
      : roof
        ? buildRafters(null, null, enumerateRoofPlanes(meshes))
        : []
  const target: VoxelTarget = {
    nodeId,
    kind,
    roof,
    item,
    metal,
    cellMetal: itemPalette?.cellMetal,
    grid,
    // Tone chain: item palettes average their region tones; a wall's saved
    // custom coat beats the mesh read (see nodeCoatColor); everything else
    // resolves through resolveSurfaceTone — map thumbnail → GPU readback →
    // non-white material color → the kind fallback palette. NEVER the old
    // first-material grab (white on every textured host surface), and
    // pending textures retint later via skinRevision (retintTarget).
    baseColor: itemPalette?.average ?? coatColor ?? resolveSurfaceTone(
      nodeId,
      toneKind,
      surfaceMaterial,
      retintTarget(nodeId),
    ),
    // The PATTERN grid (readable maps): cells wear the texture's brick
    // courses / floor tiles instead of the flat tone. A saved custom coat
    // is flat paint over the surface — no pattern then; items carry theirs
    // in cellColors.
    toneGrid:
      itemPalette || coatColor ? undefined : (mapPatternGrid(surfaceMaterial?.map) ?? undefined),
    cellColors: itemPalette?.colors,
    segments,
    studs: segments,
    sheets: sheetInfo?.sheets ?? [],
    sheetByCell: sheetInfo?.sheetByCell ?? EMPTY_SHEET_MAP,
    removedQueue: [],
    revision: 0,
    contactOnlySupport,
    floorCore: floorSlab || undefined,
    ceilingTop: ceilingSlab || undefined,
    shell: targetShell?.shell,
    shellMaterials: targetShell?.materials,
  }

  // Hide the host meshes + hand the colliders over (keep-aware — see
  // hideHostNode for the hosted-children fencing rules). Dormant prebuilds
  // defer the hide to wakeTarget — the host keeps rendering AND colliding.
  // Shelled targets ALWAYS register dormant: the first-damage wake is the
  // host→shell swap moment (invisible — the shell IS the host surface).
  // A DEFERRED shell registers dormant too — same look, build later.
  if (opts?.dormant || targetShell || shellDeferred) {
    target.dormant = true
    dormantCount++
    target.hostMeshes = meshes
    target.hostRoot = wall?.root
    if (shellDeferred) {
      target.shellPending = { kind: 'single' }
      shellPendingTotal++
      enqueueShellBuild(nodeId, _bounds)
    }
  } else {
    target.walkOnly = hideHostNode(world, nodeId, meshes, wall?.root, item)
  }

  state.targets.set(nodeId, target)
  state.bump()
  // Cross-target support (Phase B3): record the target's world AABB so
  // carving it can wake the walls resting on it (structure.ts).
  registerStructureTarget(target, kind)
  // Paint decal lane: awake voxelize = the replica is live NOW; dormant
  // prebuilds fire from wakeTarget instead (the host is still showing).
  if (!target.dormant) targetLiveListener?.(nodeId)
  return target
}

/** Legacy alias — works for any node kind now, not just walls. */
export const ensureVoxelWall = ensureVoxelTarget

/** Deferred hideHostNode meshes for DORMANT roof groups (keyed by the real
 * roof node id — one hide for the whole plane family). */
const dormantRoofHide = new Map<string, Mesh[]>()

/** Live dormant-prebuild census — wakeAheadTick's O(1) idle-out. Every
 * `dormant = true` write increments, every wake/drop of a dormant target
 * decrements, resetDestruction zeroes. Once a session's dormants are all
 * awake, cooking sticks stop paying the full collider scan per frame. */
let dormantCount = 0

/** Tests + QA introspection. */
export function dormantTargetCount(): number {
  return dormantCount
}

/** The session's world, stamped by every voxelize — wakeTarget's fallback
 * for callers without a world in hand (structure crumbles). */
let sessionWorld: GameWorld | null = null

/** Promote a dormant prebuild: hide the host meshes, hand the colliders
 * over, and flip `dormant` — voxel-walls.tsx's replica is ALREADY mounted
 * and primed (hidden), so the visual side of a wake is a per-frame
 * visibility flip, never a mount (the 391 ms first-blast fix). Roof planes
 * wake as a family (the host shell is ONE merged mesh). Idempotent; no-op
 * on awake targets. */
export function wakeTarget(world: GameWorld, target: VoxelTarget): void {
  if (!target.dormant) return
  // Wakes are rare (once per target per session) — the tag can afford to
  // name the node, which lets a spike log point at the exact culprit.
  perfEvent(`wake ${target.nodeId}`)
  const wakeT0 = performance.now()
  // S2 lazy tier: a still-pending shell builds NOW (budget-capped, voxel-
  // only fallback) — it must exist before the host hides below, because
  // the wake is the invisible host→shell swap.
  syncPendingShellForWake(target)
  const groupId = roofMemberOf.get(target.nodeId)
  if (groupId !== undefined) {
    const meshes = dormantRoofHide.get(groupId)
    dormantRoofHide.delete(groupId)
    if (meshes) hideHostNode(world, groupId, meshes)
    const state = useDestruction.getState()
    for (const id of roofGroups.get(groupId) ?? []) {
      const member = state.targets.get(id)
      if (member?.dormant) {
        member.dormant = false
        dormantCount--
      }
    }
    state.bump()
    // Paint decal lane: the whole plane family just went live.
    targetLiveListener?.(groupId)
    perfSection('wake', performance.now() - wakeT0)
    return
  }
  target.walkOnly = hideHostNode(
    world,
    target.nodeId,
    target.hostMeshes ?? [],
    target.hostRoot,
    target.item,
  )
  target.dormant = false
  dormantCount--
  target.hostMeshes = undefined
  target.hostRoot = undefined
  useDestruction.getState().bump()
  // Paint decal lane: dormant wake — the host just hid, replica is live.
  targetLiveListener?.(target.nodeId)
  perfSection('wake', performance.now() - wakeT0)
}

const realNow: () => number =
  typeof performance !== 'undefined' ? () => performance.now() : () => Date.now()

/** Scheduler clock — swappable so tests drive deadlines deterministically. */
let now: () => number = realNow

/** TEST ONLY: inject a fake clock into the prevoxelize scheduler (deadline
 * math, re-sort staleness, the frame-dt average). Pass null to restore the
 * real clock. */
export function setPrevoxelizeClock(clock: (() => number) | null): void {
  now = clock ?? realNow
}

// ── Prevoxelize scheduling (perf fix 2: proximity order + time budget) ──────

/** Per-tick prevoxelize TIME budget under load (ms) — the legacy game-root
 * value, so worst-case throughput never regresses. */
export const PREVOXELIZE_BUDGET_BASE_MS = 4
/** Idle-accelerated budget (ms): frames comfortably under 60 Hz leave
 * headroom, so the background tail finishes sooner. */
export const PREVOXELIZE_BUDGET_IDLE_MS = 8
/** A frame-dt rolling average at or under this (ms) reads as idle. */
export const PREVOXELIZE_IDLE_FRAME_MS = 14
/** Re-sort the remaining queue around the (moving) player this often. */
export const PREVOXELIZE_RESORT_MS = 2000
/** EMA weight per frame-dt sample (~10 frames to mostly converge). */
const PREVOXELIZE_DT_ALPHA = 0.2
/** Ignore absurd tick gaps (tab hidden, debugger) in the dt average. */
const PREVOXELIZE_DT_MAX_SAMPLE_MS = 250

/** ADAPTIVE BUDGET: pick the per-tick time budget from the recent frame-dt
 * average — raise it while the loop runs comfortably idle, drop back to the
 * base the moment frames load up. Pure; exported for tests. */
export function prevoxelizeBudgetMs(frameDtEmaMs: number): number {
  return frameDtEmaMs <= PREVOXELIZE_IDLE_FRAME_MS
    ? PREVOXELIZE_BUDGET_IDLE_MS
    : PREVOXELIZE_BUDGET_BASE_MS
}

/** PROXIMITY ORDER: pending node ids sorted by squared distance from the
 * focus (nearest first). Ids without a known center sort LAST — they can
 * never displace a wall the player is standing next to. Pure; exported for
 * tests. */
export function sortPendingByDistance2(
  nodeIds: readonly string[],
  centers: ReadonlyMap<string, readonly [number, number, number]>,
  focus: { x: number; y: number; z: number },
): string[] {
  const scored = nodeIds.map((nodeId) => {
    const center = centers.get(nodeId)
    const d2 = center
      ? (center[0] - focus.x) ** 2 + (center[1] - focus.y) ** 2 + (center[2] - focus.z) ** 2
      : Number.MAX_VALUE
    return { nodeId, d2 }
  })
  scored.sort((a, b) => a.d2 - b.d2)
  return scored.map((s) => s.nodeId)
}

/** One pending-scan result: ids still needing a target, plus each id's
 * awake-vs-dormant lane (see scanPrevoxelizePending). */
type PrevoxelizePending = { ids: string[]; awake: Map<string, boolean> }

/**
 * Snapshot every node prevoxelize still owes a target — walls first, then
 * everything else a blast can reach (slabs, ceilings, roofs, items,
 * fixtures): first hits used to voxelize these synchronously — a grenade
 * mid-house built several BIG grids (BVH occupancy sweeps, segments,
 * sheets) inside the blast frame, the "big lag when grenades explode"
 * live report. Prebuilt DORMANT: the host keeps rendering/colliding
 * untouched; the first hit wakes a target with the expensive part already
 * done.
 *
 * VOXEL-FIRST ITEMS (owner call 2026-08-28): item-family nodes are the
 * exception — they voxelize AWAKE, exactly like walls. The host GLB hides
 * through the session ledger in the same tick and the silhouette replica
 * (fine shape-tracing cells + per-cell region palette) renders FROM
 * SESSION START — an item never morphs into voxels on its first hit, it
 * just starts losing chunks. This also deletes the first-item-wake spike
 * (62–68 ms live finding): there is no item wake left to pay for.
 *
 * VOXEL-FIRST ROOFS + SLABS (owner call 2026-08-28 round 2: "the roof
 * looked like editor, and 1st bullet it changed into voxels" — NO
 * morphing anywhere): roof and slab/ceiling/floor kinds voxelize AWAKE
 * too, wearing their per-cell texture patterns from frame one. The same
 * prevoxelize budget spreads the cost (the entry veil covers gear-up);
 * Esc-restore is untouched — the hide rides the same session ledger.
 * Only doors/windows and the block/column/stair family still prebuild
 * dormant: their hosts keep live behaviors (Doors renderer, stair walk
 * feel) that should not hand over until first damage.
 */
function scanPrevoxelizePending(
  world: GameWorld,
  targets: ReadonlyMap<string, VoxelTarget>,
): PrevoxelizePending {
  const ids: string[] = []
  const awake = new Map<string, boolean>()
  for (const nodeId of world.walls.keys()) {
    if (targets.has(nodeId) || prevoxelizeSkip.has(nodeId)) continue
    ids.push(nodeId)
    awake.set(nodeId, true)
  }
  for (const collider of world.colliders) {
    const nodeId = collider.nodeId
    if (
      awake.has(nodeId) || // wall id / earlier collider of the same node
      targets.has(nodeId) ||
      prevoxelizeSkip.has(nodeId) ||
      roofGroups.has(nodeId) ||
      // EVERY game-only '__boots' node manages its own lifecycle — never
      // prebuild any of them. Placed catalog items (ITEM_NODE_PREFIX)
      // re-voxelize on proxy→GLB swaps and first hits (and a target-less
      // placed item arriving mid-session would wedge warmup.tsx's
      // zero-budget completeness gate false forever). And the SPAWN
      // FIXTURES (gun/build tables '__boots-table*', the breaker
      // '__boots-switch') register 'item' colliders too: prebuilding THEM
      // meant a wake hid the tables themselves — the "everything
      // disappears when I approach the table" live report.
      nodeId.startsWith('__boots') ||
      !EXPLODABLE.has(collider.nodeType)
    ) {
      continue
    }
    ids.push(nodeId)
    // Voxel-first roofs/slabs prebuild AWAKE — unless their shell lane is
    // ON (S1): shelled targets must stay dormant so the first-damage wake
    // is the invisible host→shell swap (the awake lane would hide the host
    // and show voxels at session start, exactly the morph the shell
    // exists to avoid).
    awake.set(
      nodeId,
      ITEM_FAMILY_KINDS.has(collider.nodeType) ||
        (ROOF_KINDS.has(collider.nodeType) && !shellRoofEnabled()) ||
        (SLAB_KINDS.has(collider.nodeType) && !shellSlabEnabled()),
    )
  }
  return { ids, awake }
}

/** nodeId → world-space AABB center for every collider group (plus walls
 * missing from the collider list — hand-built worlds): ONE cheap
 * O(colliders + walls) pass per session, reused by every 2 s re-sort. */
function buildPrevoxelizeCenters(world: GameWorld): Map<string, [number, number, number]> {
  const boxes = new Map<string, Box3>()
  for (const collider of world.colliders) {
    const box = boxes.get(collider.nodeId)
    if (box) box.union(collider.worldBox)
    else boxes.set(collider.nodeId, collider.worldBox.clone())
  }
  const scratch = new Box3()
  for (const [nodeId, wall] of world.walls) {
    if (boxes.has(nodeId)) continue
    const box = new Box3()
    for (const mesh of wall.meshes) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
      box.union(scratch.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld))
    }
    if (!box.isEmpty()) boxes.set(nodeId, box)
  }
  const centers = new Map<string, [number, number, number]>()
  for (const [nodeId, box] of boxes) {
    centers.set(nodeId, [
      (box.min.x + box.max.x) / 2,
      (box.min.y + box.max.y) / 2,
      (box.min.z + box.max.z) / 2,
    ])
  }
  return centers
}

/** Persistent nearest-first work order (focus lane) — consumed across
 * ticks via the cursor, rebuilt on the PREVOXELIZE_RESORT_MS cadence
 * instead of every frame. */
let prevoxelizeQueue: string[] = []
let prevoxelizeQueueCursor = 0
let prevoxelizeQueueSortedAt = Number.NEGATIVE_INFINITY
/** Session-cached node centers for the re-sorts (null until first sort). */
let prevoxelizeCenters: Map<string, [number, number, number]> | null = null
/** Rolling frame-dt average (ms): the gap between consecutive ADAPTIVE
 * ticks IS the frame time — a local average, no perf-monitor coupling. */
let prevoxelizeDtEma = 1000 / 60
let prevoxelizeLastTickAt = -1

/** QA/tests introspection: the adaptive scheduler's live numbers. */
export function prevoxelizeSchedulerStats(): {
  frameDtEmaMs: number
  budgetMs: number
  queued: number
} {
  return {
    frameDtEmaMs: prevoxelizeDtEma,
    budgetMs: prevoxelizeBudgetMs(prevoxelizeDtEma),
    queued: Math.max(prevoxelizeQueue.length - prevoxelizeQueueCursor, 0),
  }
}

/**
 * Pre-clad the scene's walls — and, voxel-first, its item-family nodes —
 * in voxels a slice per tick, so the building already reads voxel at
 * session start instead of anything flipping on first hit. Every awake
 * node goes through ensureVoxelTarget — host meshes hide and colliders
 * hand over IN THE SAME TICK it voxelizes, never later. Returns true once
 * every node in the snapshot has a target; drive it from a per-frame loop
 * until then (game-root's Prevoxelize does).
 *
 * Scheduling (perf fix 2 — the 20-31 s post-veil churn on a 670-node
 * scene, ~211 s on a 3,745-node one):
 *  - TIME budget: work stops at a per-tick deadline (explicit budgetMs, or
 *    ADAPTIVE when omitted — prevoxelizeBudgetMs over a local frame-dt
 *    average), so cheap targets batch up and the tick never spends a fixed
 *    count regardless of size. At least ONE build always lands per funded
 *    tick, so a tiny budget can never stall the queue. budgetMs 0 keeps
 *    the "check, never work" probe contract (warmup.tsx, loading.ts).
 *  - PROXIMITY order: with a `focus` (the player rig), pending targets
 *    build nearest-first and the REMAINING queue re-sorts every
 *    PREVOXELIZE_RESORT_MS as the player moves. The far tail can wait
 *    minutes: hosts render + collide meanwhile, and any first damage out
 *    there builds on demand through ensureVoxelTarget (damageTarget /
 *    damageExplosion) exactly as before.
 */
export function prevoxelizeTick(
  world: GameWorld,
  budgetMs?: number,
  focus?: { x: number; y: number; z: number },
): boolean {
  const start = now()
  // Stamp the session's world on the FIRST tick, not on the first voxelize.
  // Remote damage can arrive before this client has built a single grid — the
  // shared bridge materializes through `sessionWorld`, and without this it
  // would have nothing to build from and would silently drop the frame.
  sessionWorld = world
  // S2 lazy shells measure "near" against the same focus the scheduler
  // sorts by — stamp it for every voxelize this tick performs.
  if (focus) stampShellFocus(focus)
  let budget: number
  if (budgetMs === undefined) {
    // ADAPTIVE lane (the game driver passes no budget): sample the gap
    // since the previous adaptive tick as this frame's dt.
    if (prevoxelizeLastTickAt >= 0) {
      const dt = start - prevoxelizeLastTickAt
      if (dt > 0 && dt < PREVOXELIZE_DT_MAX_SAMPLE_MS) {
        prevoxelizeDtEma += (dt - prevoxelizeDtEma) * PREVOXELIZE_DT_ALPHA
      }
    }
    prevoxelizeLastTickAt = start
    budget = prevoxelizeBudgetMs(prevoxelizeDtEma)
  } else {
    budget = budgetMs
  }

  let targets = useDestruction.getState().targets
  let pending = scanPrevoxelizePending(world, targets)
  if (pending.ids.length === 0) {
    prevoxelizeQueue = []
    prevoxelizeQueueCursor = 0
    return true
  }
  if (budget <= 0) return false // zero-budget probe: check, never work

  if (focus) {
    // Rebuild the nearest-first order when it went stale (the player kept
    // moving) or the persistent queue ran out from under the cursor.
    if (
      start - prevoxelizeQueueSortedAt >= PREVOXELIZE_RESORT_MS ||
      prevoxelizeQueueCursor >= prevoxelizeQueue.length
    ) {
      prevoxelizeCenters ??= buildPrevoxelizeCenters(world)
      prevoxelizeQueue = sortPendingByDistance2(pending.ids, prevoxelizeCenters, focus)
      prevoxelizeQueueCursor = 0
      prevoxelizeQueueSortedAt = start
    }
  } else {
    // No focus (headless callers, tests): the legacy walls-then-colliders
    // scan order, rebuilt per tick.
    prevoxelizeQueue = pending.ids
    prevoxelizeQueueCursor = 0
  }

  const deadline = start + budget
  let built = 0
  for (;;) {
    while (prevoxelizeQueueCursor < prevoxelizeQueue.length) {
      const nodeId = prevoxelizeQueue[prevoxelizeQueueCursor]!
      const awake = pending.awake.get(nodeId)
      if (
        awake === undefined || // handled since the queue was sorted
        targets.has(nodeId) ||
        roofGroups.has(nodeId) ||
        prevoxelizeSkip.has(nodeId)
      ) {
        prevoxelizeQueueCursor++
        continue
      }
      // TIME budget: yield the moment the clock is out — but always land
      // at least one build per funded tick so the queue can never stall.
      if (built > 0 && now() >= deadline) return false
      built++
      if (!ensureVoxelTarget(world, nodeId, awake ? undefined : { dormant: true })) {
        // Degenerate node (no meshes / empty grid) — it can never
        // voxelize, so don't let it wedge the driver in a forever-false
        // loop.
        prevoxelizeSkip.add(nodeId)
      }
      prevoxelizeQueueCursor++
    }
    // Queue drained with budget left: rescan. Anything still pending means
    // the persistent order predated it — rebuild and keep going under the
    // same deadline (each pass builds or skips at least one node, so this
    // always terminates).
    targets = useDestruction.getState().targets
    pending = scanPrevoxelizePending(world, targets)
    if (pending.ids.length === 0) return true
    if (focus) {
      prevoxelizeCenters ??= buildPrevoxelizeCenters(world)
      prevoxelizeQueue = sortPendingByDistance2(pending.ids, prevoxelizeCenters, focus)
      prevoxelizeQueueSortedAt = start
    } else {
      prevoxelizeQueue = pending.ids
    }
    prevoxelizeQueueCursor = 0
  }
}

/** Nodes ensureVoxelTarget refused (degenerate) — skipped on later ticks. */
const prevoxelizeSkip = new Set<string>()

/** Collider nodeId prefix item-place.tsx gives placed items (kept in
 * sync, the PLACED_PIECE_PREFIX convention). */
const ITEM_NODE_PREFIX = '__boots-item-'

/** Settle-drain key for a target's pending island check (structure.ts's
 * shared budgeted queue — see scheduleSettleTask). The logical 140 ms +
 * jitter stagger is unchanged; only EXECUTION is budget-capped per frame,
 * so a mass-carve's island flood-fills can't all run in one macrotask. */
const islandKey = (nodeId: string) => `island:${nodeId}`

let settleJitterRr = 0
/** B2 (perf 2026-08-27): round-robin 0–150 ms added to the fixed settle
 * delays so a multi-node blast's island crumbles + structure checks land
 * across several frames instead of coalescing into one. */
function nextSettleJitter(): number {
  settleJitterRr = (settleJitterRr + 1) % 6
  return settleJitterRr * 30
}

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
    // walkOnly planks defer to their voxel target here, same as disabled.
    if (collider.disabled || collider.walkOnly || collider.nodeId === target.nodeId) continue
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

/** How far below a roof cell's center the under-support probe looks for a
 * live wall/collider top (walls meet pitched planes at varying heights). */
const ROOF_PROBE_DROP = 0.6
/** Lateral tolerance of that probe (mirror of SLAB_PROBE_XZ). */
const ROOF_PROBE_XZ = 0.3

/**
 * Island support seeds for a PITCHED roof plane (QA C2 defect f): the
 * grid's iy = 0 row IS the eave row (grid Y = upSlope), so the default
 * base-row rule already means "supported from the eave" — kept as seed #1.
 * On top of it, any cell standing just above something live — a
 * non-disabled collider top or a live voxel cell of a non-roof target
 * within ROOF_PROBE_XZ laterally and ROOF_PROBE_DROP below — is seeded
 * too, so a plane bearing on an interior wall doesn't shed everything
 * uphill of a cut below that wall. Sibling roof planes never seed each
 * other (the ridge overlap would make the two slopes prop each other).
 */
export function roofSeedPredicate(world: GameWorld, target: VoxelTarget): (i: number) => boolean {
  const grid = target.grid
  let minY = Number.POSITIVE_INFINITY
  for (let i = 0; i < grid.count; i++) {
    if (!grid.alive[i]) continue
    const cy = grid.centers[i * 3 + 1]!
    if (cy < minY) minY = cy
  }
  if (!Number.isFinite(minY)) return () => false

  // Live collider tops that can reach ANY roof cell's support band.
  const boxes: Array<{ minX: number; maxX: number; minZ: number; maxZ: number; top: number }> = []
  for (const collider of world.colliders) {
    // walkOnly planks defer to their voxel target here, same as disabled.
    if (collider.disabled || collider.walkOnly) continue
    const top = collider.worldBox.max.y
    if (top < minY - ROOF_PROBE_DROP) continue
    boxes.push({
      minX: collider.worldBox.min.x - ROOF_PROBE_XZ,
      maxX: collider.worldBox.max.x + ROOF_PROBE_XZ,
      minZ: collider.worldBox.min.z - ROOF_PROBE_XZ,
      maxZ: collider.worldBox.max.z + ROOF_PROBE_XZ,
      top,
    })
  }

  // Live voxel cells of other NON-ROOF targets → coarse XZ hash of the
  // highest live cell top per bucket (a wall's bucket top = the wall top).
  const h = ROOF_PROBE_XZ
  const hashOf = (x: number, z: number) =>
    Math.round(x / h) * 73856093 + Math.round(z / h) * 19349663
  const topAt = new Map<number, number>()
  for (const other of useDestruction.getState().targets.values()) {
    if (other === target || other.kind === 'roof' || other.grid.aliveCount === 0) continue
    const og = other.grid
    for (let j = 0; j < og.count; j++) {
      if (!og.alive[j]) continue
      const cy = og.centers[j * 3 + 1]! + og.cell / 2
      if (cy < minY - ROOF_PROBE_DROP) continue
      const key = hashOf(og.centers[j * 3]!, og.centers[j * 3 + 2]!)
      const prior = topAt.get(key)
      if (prior === undefined || cy > prior) topAt.set(key, cy)
    }
  }

  return (i: number) => {
    if (grid.coords[i * 3 + 1] === 0) return true // eave row
    const x = grid.centers[i * 3]!
    const y = grid.centers[i * 3 + 1]!
    const z = grid.centers[i * 3 + 2]!
    for (const box of boxes) {
      if (box.top < y - ROOF_PROBE_DROP || box.top > y + 0.3) continue
      if (x >= box.minX && x <= box.maxX && z >= box.minZ && z <= box.maxZ) return true
    }
    if (topAt.size === 0) return false
    const bx = Math.round(x / h)
    const bz = Math.round(z / h)
    for (let ax = -1; ax <= 1; ax++) {
      for (let az = -1; az <= 1; az++) {
        const top = topAt.get((bx + ax) * 73856093 + (bz + az) * 19349663)
        if (top !== undefined && top >= y - ROOF_PROBE_DROP && top <= y + 0.3) return true
      }
    }
    return false
  }
}

function crumbleIslands(world: GameWorld, target: VoxelTarget): void {
  const islands = findUnsupportedIslands(
    target.grid,
    target.kind === 'slab'
      ? slabSeedPredicate(world, target)
      : target.kind === 'roof'
        ? roofSeedPredicate(world, target)
        : undefined,
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
  // An island crumble is DERIVED from the carve that undercut it, but the
  // derivation is order-dependent (findUnsupportedIslands floods a live grid
  // whose contents depend on which frames have arrived), so what converges is
  // the OUTCOME. Cells a stranger's shot already killed are not in `fallen` —
  // the loop above skips dead cells — so this cannot claim their work.
  publishRemovedCells(target, fallen)
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
      // Items collapse in the same CHUNKY band their carves shed (natural
      // breakage) — cell-size pieces read as dust at silhouette cells.
      target.item ? itemChunkSize(target.grid.cell, Math.random()) : target.grid.cell,
      cellTint(target, idx),
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
    spawnDust(_crumbleDust, 1, {
      kind: target.kind === 'volume' ? 'concrete' : 'drywall',
      tint: target.item ? target.baseColor : undefined,
    })
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
  // FEET SEE THE PLANE retires once the piece is damaged past threshold.
  settleWalkOnly(world, target)
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
/**
 * Scratch for the cells one whole-target collapse killed. Module-scope and
 * reused so single player never allocates it: the array keeps its capacity
 * across collapses and is consumed before this function can re-enter (the
 * publish happens before settleSupportAfterRemoval, which is the only path
 * back in here).
 */
const _collapsedCells: number[] = []

export function collapseWholeTarget(nodeId: string): number {
  // One collapse is one frame: the cell list, the kill bit, and every stick
  // the skeleton snap takes with it belong to the same outcome.
  beginDamageBatch()
  try {
    return collapseWholeTargetBody(nodeId)
  } finally {
    endDamageBatch()
  }
}

function collapseWholeTargetBody(nodeId: string): number {
  const target = useDestruction.getState().targets.get(nodeId)
  if (!target || target.grid.aliveCount === 0) return 0
  // A structure cascade can crumble a still-DORMANT prebuild (support shot
  // out from under a wall the blast never touched) — wake it first or the
  // host mesh keeps floating over the falling voxels. sessionWorld is the
  // world every voxelize call stamped (cleared on resetDestruction).
  // S2: every cell dies right below — a pending shell would build only to
  // mount fully dead. Skip it (voxel-only), don't burn the sync budget.
  if (target.dormant && sessionWorld) {
    clearShellPending(target)
    wakeTarget(sessionWorld, target)
  }
  const { grid } = target
  const total = grid.aliveCount
  const debrisChance = Math.min(1, CRUMBLE_DEBRIS_CAP / total)
  let first = -1
  _collapsedCells.length = 0
  for (let idx = 0; idx < grid.count; idx++) {
    if (!grid.alive[idx]) continue
    grid.alive[idx] = 0
    grid.aliveCount--
    target.removedQueue.push(idx)
    _collapsedCells.push(idx)
    if (first < 0) first = idx
    // Sheet bookkeeping only (torn cells) — same rule as island crumbles.
    const sheetId = target.sheetByCell[idx]
    if (sheetId !== undefined && sheetId >= 0) target.sheets[sheetId]!.torn++
    if (Math.random() < debrisChance) {
      spawnDebris(
        grid.centers[idx * 3]!,
        grid.centers[idx * 3 + 1]!,
        grid.centers[idx * 3 + 2]!,
        // Item collapses shed the same chunky band as item carves.
        target.item ? itemChunkSize(grid.cell, Math.random()) : grid.cell,
        cellTint(target, idx),
        1.6,
      )
    }
  }
  // BOTH halves go out. The kill bit is what a peer who has never materialized
  // this node can obey — it needs no grid at all, which is the whole point for
  // a dormant prebuild two rooms away. The cell list is what keeps the Save
  // ownership gate truthful: without it this peer would have no record of
  // having killed the cells, and a wall it levelled alone would be withheld
  // from its own demolition save.
  publishRemovedCells(target, _collapsedCells)
  publishKilledNode(nodeId)
  _collapsedCells.length = 0
  target.revision++
  useDestruction.getState().bump()
  // Nothing is left for a pending island pass to find.
  cancelSettleTask(islandKey(nodeId))
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
  // Nothing is left — a walk-only plank must not keep carrying the capsule.
  if (sessionWorld) settleWalkOnly(sessionWorld, target)
  return total
}

// Inject the structure ticker's runtime needs (see structure.StructureDriver).
wireStructureDriver({
  targets: () => useDestruction.getState().targets,
  collapse: collapseWholeTarget,
})

const _sheetCenter = new Vector3()
/** Scratch for the cells one sheet fly-off freed (see _collapsedCells). */
const _flownCells: number[] = []
/** Scratch launch direction for fly-off shards (the sheet's outward normal,
 * biased down-slope on roof planes). */
const _shardDir = { x: 0, y: 0, z: 0 }
const _slideDir = { x: 0, y: 0, z: 0 }
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
  _flownCells.length = 0
  for (const idx of sheet.cells) {
    if (!target.grid.alive[idx]) continue
    target.grid.alive[idx] = 0
    target.grid.aliveCount--
    target.removedQueue.push(idx)
    _flownCells.push(idx)
    sheet.torn++
    freed++
  }
  // The fly-off THRESHOLD is local (hit counters accumulate local hits and are
  // deliberately not replicated), so what crosses is the board's cells. A peer
  // that never shot this wall sees the same sheet leave; shared-derive's
  // sheetHasFlown then reads it as flown from the cells alone.
  publishRemovedCells(target, _flownCells)
  _flownCells.length = 0
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
    if (target.roof && (target.grid.q.x !== 0 || target.grid.q.z !== 0)) {
      // Shingle sheets shear OUTWARD + DOWN-SLOPE — grid +Y is the plane's
      // upSlope direction (rotate it out through the basis conjugate), so
      // torn courses slide off the eave instead of popping straight up.
      rotateByBasisInverse(target.grid.q, 0, 1, 0, _slideDir)
      _shardDir.x -= _slideDir.x * 0.7
      _shardDir.y -= _slideDir.y * 0.7
      _shardDir.z -= _slideDir.z * 0.7
    }
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
        target.roof ? 'shingle' : 'drywall',
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
  // Roof sheets shear off as shingles — drier rip, no papery crumple tail.
  if (target.roof) sfx.shingleRip()
  else sfx.paperTear()
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
/** Scratch for entrySkin's basis-rotated query point / direction. */
const _skinPoint = { x: 0, y: 0, z: 0 }
const _skinDir = { x: 0, y: 0, z: 0 }

function entrySkin(
  grid: VoxelGridData,
  x: number,
  y: number,
  z: number,
  direction?: Vector3,
): SkinLimit | null {
  if (grid.cellX === grid.cellZ && grid.cellY === grid.cellX) return null
  const axis = thicknessAxisOf(grid)
  // Rotated grids index in their local frame — rotate the query point in.
  // Pitched roof-plane grids carry a full basis (yaw parks at 0 there), so
  // the quaternion path must run BEFORE the yaw shortcut.
  let px = x
  let py = y
  let pz = z
  let dx = direction?.x ?? 0
  let dy = direction?.y ?? 0
  let dz = direction?.z ?? 0
  if (grid.q.x !== 0 || grid.q.z !== 0) {
    rotateByBasis(grid.q, x, y, z, _skinPoint)
    px = _skinPoint.x
    py = _skinPoint.y
    pz = _skinPoint.z
    if (direction) {
      rotateByBasis(grid.q, dx, dy, dz, _skinDir)
      dx = _skinDir.x
      dy = _skinDir.y
      dz = _skinDir.z
    }
  } else if (grid.yaw !== 0) {
    const cos = Math.cos(grid.yaw)
    const sin = Math.sin(grid.yaw)
    px = x * cos + z * sin
    pz = -x * sin + z * cos
    const ldx = dx * cos + dz * sin
    dz = -dx * sin + dz * cos
    dx = ldx
  }
  const p = axis === 0 ? px : axis === 1 ? py : pz
  const origin = axis === 0 ? grid.origin.x : axis === 1 ? grid.origin.y : grid.origin.z
  const cell = axis === 0 ? grid.cellX : axis === 1 ? grid.cellY : grid.cellZ
  const span = axis === 0 ? grid.nx : axis === 1 ? grid.ny : grid.nz
  let c = (p - origin) / cell
  // The hit point sits ON the struck face — often EXACTLY on a layer
  // boundary (a synthesized ceiling plate holds all its cells in the top
  // half, so an upward shot's entry point lands on the halves split and
  // float noise picked the EMPTY side: QA phase-6 round-3, 6/8 zero-carve
  // ceiling shots). Step half a thickness cell INTO the grid along the
  // shot so the sample sits inside the first cell layer the ray actually
  // crosses; grazing shots (no thickness-axis travel) keep the raw halves.
  const d = axis === 0 ? dx : axis === 1 ? dy : dz
  if (d > 1e-6) c += 0.5
  else if (d < -1e-6) c -= 0.5
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
    // Long-axis direction: verticals point up, plates run along their yaw,
    // pitched rafters climb their slope (roof-framing.ts local X in world).
    let ax = 0
    let ay = 1
    let az = 0
    if (sy < long) {
      const ct = segment.pitch ? Math.cos(segment.pitch) : 1
      ax = ct * Math.cos(segment.yaw)
      ay = segment.pitch ? Math.sin(segment.pitch) : 0
      az = ct * Math.sin(segment.yaw)
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

/**
 * A LEVELED wall takes its hosted apertures with it. Windows and doors are
 * SEPARATE nodes riding the wall (schema parentId/wallId mirrors); their
 * host colliders — sill, rails, jambs — stay enabled until the node itself
 * is damaged, so a fully-destroyed wall used to leave an INVISIBLE frame
 * barring the gap at chest and head height (the owner's "can't walk in
 * even when 1 wall is missing", A/B-proven: 1.64 m advance wedged vs
 * 14.81 m with the window's colliders dropped). Hosted apertures with a
 * voxel target collapse through the normal lane (wake → hide host →
 * collision moves to the now-empty grid); a targetless child just drops
 * its colliders. Reentrancy-safe: children are door/window kinds, and the
 * cascade only fires for kind 'wall'.
 */
function collapseHostedApertures(world: GameWorld, wallId: string): void {
  const hosted = (node: Record<string, unknown> | undefined): boolean =>
    !!node && (node.parentId === wallId || node.wallId === wallId)
  const targets = useDestruction.getState().targets
  const bury = (childId: string, colliderIndices: number[]) => {
    const child = targets.get(childId)
    if (child && child.grid.aliveCount > 0) {
      collapseWholeTarget(childId)
      return
    }
    if (child) return // already leveled — colliders belong to the grid now
    for (const index of colliderIndices) {
      const collider = world.colliders[index]
      if (collider) collider.disabled = true
    }
  }
  for (const door of world.doors) {
    if (hosted(door.node)) bury(door.nodeId, door.colliderIndices)
  }
  for (const operable of world.operables ?? []) {
    if (operable.kind === 'window' && hosted(operable.node)) {
      bury(operable.nodeId, operable.colliderIndices)
    }
  }
}

function settleSupportAfterRemoval(target: VoxelTarget): void {
  // The aperture cascade rides the shared removal hook: EVERY lane that can
  // zero a wall (whole collapse, island crumble, avalanche, fly-offs) lands
  // here, so the frame can never outlive its wall no matter how it died.
  if (target.kind === 'wall' && target.grid.aliveCount === 0 && sessionWorld) {
    collapseHostedApertures(sessionWorld, target.nodeId)
  }
  if (target.nodeId.startsWith(PLACED_PIECE_PREFIX)) {
    // Piece-as-unit death (phase 9 support lane): a placed piece dies as a
    // WHOLE once its replica drops under the alive-fraction floor — long
    // before the last voxel goes, and well below the walk-only demotion.
    if (!pieceReplicaDead(target.grid.aliveCount, target.grid.count)) return
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
  // One carve is ONE published frame. The fan-out below can touch every plane
  // of a roof group and every coincident wall twin, and a peer must receive
  // that as a single atomic outcome — not a dribble of frames that could be
  // applied half-way and leave a visibly different hole for a frame.
  beginDamageBatch()
  try {
    return damageTargetFan(world, nodeId, point, radius, direction)
  } finally {
    endDamageBatch()
  }
}

function damageTargetFan(
  world: GameWorld,
  nodeId: string,
  point: Vector3,
  radius: number,
  direction?: Vector3,
): number {
  const target = ensureVoxelTarget(world, nodeId)
  if (!target) return 0
  // Per-plane roofs: a carve through EITHER the real node id or one plane's
  // member id fans out to every sibling plane — the planes overlap a hair
  // at ridges/hips, so a seam shot must open both grids (removeSphere is a
  // no-op on planes the sphere never reaches, so this costs nothing else).
  const groupId = roofGroups.has(nodeId) ? nodeId : roofMemberOf.get(nodeId)
  const group = groupId !== undefined ? roofGroups.get(groupId) : undefined
  if (group) {
    let total = 0
    const targets = useDestruction.getState().targets
    for (const id of group) {
      const member = targets.get(id)
      if (member) {
        if (member.dormant) wakeTarget(world, member) // wakes the family
        total += damageTargetOne(world, member, point, radius, direction)
      }
    }
    return total
  }
  if (target.dormant) wakeTarget(world, target)
  let total = damageTargetOne(world, target, point, radius, direction)
  // COINCIDENT LAYERS (the "undestroyable wall" live report): room-drawn
  // houses ship one wall per ROOM side, so shared boundaries are TWO
  // stacked wall nodes (plus partial collinear overlaps). The per-target
  // skin pierce opened one skin of ONE twin per shot while the other kept
  // rendering over the hole — four perfectly co-located hits to see any
  // progress. Fan the same carve out to every other ALREADY-VOXELIZED
  // layered target: removeSphere is a no-op on grids the sphere never
  // reaches (the same economics as the roof fan-out above), so this only
  // costs on true overlaps — and one shot now opens the same hole in every
  // coincident layer. Pristine far walls stay untouched (voxelizing on a
  // miss would be wasted work; they enroll when a shot actually reaches
  // them through the hole).
  // BULLET-CLASS ONLY (radius under the pierce gate): the twin problem IS
  // the pierce gate, and explosion rings already sweep every collider in
  // range — fanning them re-carved the whole house per ring node, O(N²)
  // on a mid-house grenade (the "big lag when grenades explode" live
  // report, one day after this fan-out shipped).
  if (total > 0 && radius < WALL_PIERCE_RADIUS && target.kind !== 'volume') {
    for (const other of useDestruction.getState().targets.values()) {
      if (other === target || other.kind === 'volume') continue
      // Interpenetration test, not sphere reach: duplicates share the very
      // surface the shot entered (carve point ON both volumes), while a
      // stacked storey or a slab/wall seam merely TOUCHES — a grenade-class
      // sphere at a joint must not chew the neighbor through the fan-out
      // (locality there stays the per-target carve's job).
      if (!gridContainsPoint(other.grid, point.x, point.y, point.z)) continue
      if (other.dormant) wakeTarget(world, other)
      total += damageTargetOne(world, other, point, radius, direction)
    }
  }
  return total
}

/** True when this carve opened a slab THROUGH: some removed cell's plan
 * column (ix,iz) holds no live cell anymore, top skin to bottom skin —
 * daylight through the floor. Lattice keys per the grid contract
 * (ix + nx·(iy + ny·iz)); slabs keep ny ≤ ~4 layers so the scan is
 * O(removed × ny) Map lookups, paid only on floorCore slab carves.
 * Pure — exported for tests. */
export function floorBreachOpened(
  grid: Pick<VoxelGridData, 'coords' | 'index' | 'alive' | 'nx' | 'ny'>,
  removed: number[],
): boolean {
  const { coords, index, alive, nx, ny } = grid
  for (let n = 0; n < removed.length; n++) {
    const c = removed[n]! * 3
    const ix = coords[c]!
    const iz = coords[c + 2]!
    let open = true
    for (let iy = 0; iy < ny; iy++) {
      const j = index.get(ix + nx * (iy + ny * iz))
      if (j !== undefined && alive[j]) {
        open = false
        break
      }
    }
    if (open) return true
  }
  return false
}

/** The single-target carve body damageTarget dispatches to (roof groups
 * call it once per plane). */
function damageTargetOne(
  world: GameWorld,
  target: VoxelTarget,
  point: Vector3,
  radius: number,
  direction?: Vector3,
): number {
  const nodeId = target.nodeId
  // BULLETPROOF safety floor (QA C2 defect b): a carve on a roof/volume
  // target can never be smaller than the grid's own cells — adaptive volume
  // cells grow with node size (0.5 m on big roofs) while pistol/rifle
  // holeRadius is 0.11/0.16, which once made 32 shots remove ZERO voxels.
  if (target.roof || target.kind === 'volume') {
    const cellMax = Math.max(target.grid.cellX, target.grid.cellY, target.grid.cellZ)
    const floor = cellMax * CARVE_CELL_FLOOR
    if (radius < floor) radius = floor
  }
  // Slabs ride the whole wall lane: skin-respecting pierce gate, drywall
  // dust + paper shards, sheet fly-offs, framing splash-chips.
  const layered = target.kind !== 'volume'
  const skin =
    layered && radius < WALL_PIERCE_RADIUS
      ? entrySkin(target.grid, point.x, point.y, point.z, direction)
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
  // B5: indexed pushes — spread-push blows the argument limit on 1000+-cell carves.
  for (let i = 0; i < removed.length; i++) target.removedQueue.push(removed[i]!)
  // THE CARVE FOOTPRINT, replicated as an outcome. Everything that shaped it is
  // local and irreproducible: the nibble offsets and radii are Math.random(),
  // the skin gate depends on which face this player's shot entered, and the
  // adaptive cell floor depends on this node's grid. A peer re-simulating
  // "someone shot here" would carve a different hole; a peer told which cells
  // died carves the same one.
  publishRemovedCells(target, removed)
  target.revision++
  useDestruction.getState().bump()
  // FLOOR BREACH (owner "broken floor looks broken"): a ground-slab carve
  // that opened a plan column clean through stamps broken-earth under the
  // hole — the lawn plane (or the void) below must never read pristine.
  // Slab grids are identity-basis, so grid.origin.y is the world base
  // height; upper storeys no-op inside spawnFloorBreach (their holes show
  // the room below). Gated to floorCore slabs — the only targets whose
  // underside is terrain.
  if (
    target.floorCore === true &&
    target.kind === 'slab' &&
    floorBreachOpened(target.grid, removed)
  ) {
    spawnFloorBreach(point.x, point.z, target.grid.origin.y, radius)
  }
  if (target.item) {
    // NATURAL BREAKAGE: chunky, material-true pieces — one per ~2–3 removed
    // cells (capped), sampled EVENLY across the exact cells this carve took
    // out so the chunks fly from the hole, each tinted by its own cell's
    // region color. Slower launch + longer ttl than wall crumbs: big pieces
    // tumble and settle instead of pinging away.
    const chunks = itemChunkCount(removed.length)
    for (let i = 0; i < chunks; i++) {
      const idx = removed[Math.floor(((i + 0.5) * removed.length) / chunks)]!
      spawnDebris(
        target.grid.centers[idx * 3]!,
        target.grid.centers[idx * 3 + 1]!,
        target.grid.centers[idx * 3 + 2]!,
        itemChunkSize(target.grid.cell, Math.random()),
        cellTint(target, idx),
        2.0,
        3.2,
      )
    }
  } else {
    const debrisCount = Math.min(removed.length, 10)
    for (let i = 0; i < debrisCount; i++) {
      const idx = removed[Math.floor(Math.random() * removed.length)]!
      spawnDebris(
        target.grid.centers[idx * 3]!,
        target.grid.centers[idx * 3 + 1]!,
        target.grid.centers[idx * 3 + 2]!,
        target.grid.cell * (0.6 + Math.random() * 0.5),
        cellTint(target, idx),
        2.6,
      )
    }
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
    // drywall reads as tearing plates, not popping cubes. Tinted per CELL
    // (cellTint) so a floor's dirt core sheds brown flakes and a patterned
    // face sheds pattern-toned ones, matching the cubes above.
    const shards = Math.min(3, 1 + (removed.length >> 3))
    for (let n = 0; n < shards; n++) {
      const idx = removed[Math.floor(Math.random() * removed.length)]!
      spawnFlatDebris(
        target.grid.centers[idx * 3]!,
        target.grid.centers[idx * 3 + 1]!,
        target.grid.centers[idx * 3 + 2]!,
        0.1 + Math.random() * 0.16,
        0.12 + Math.random() * 0.2,
        cellTint(target, idx),
        undefined,
        target.roof ? 'shingle' : 'drywall',
      )
    }
    // Sheet accounting (hits + torn cells) — may fly whole sheets off.
    noteSheetCarve(target, removed, direction)
    // Splash chips the framing standing in the tear (hp-1 floor — see
    // chipSegmentSplash; only direct hits and blasts snap sticks).
    chipSegmentSplash(target, point, radius)
  } else {
    // Material tag (phase 4): plain volumes voice as CONCRETE — small,
    // short-lived, grayer puffs (dust.tsx owns the styling). ITEM targets
    // (phase 6 silhouette lane) would ideally voice 'porcelain', but
    // dust.tsx's DustMaterial union has no such kind — and an unknown
    // string would fall into spawnDust's plume-shaped else — so the tag is
    // GUARDED down to 'concrete'-LITE: same gray family, intensity capped
    // at ITEM_DUST_MAX, ceramic chips off a toilet rim rather than a
    // wall-sized cloud. Flip this if dust.tsx grows a real 'porcelain'.
    spawnDust(
      point,
      target.item
        ? Math.min(ITEM_DUST_MAX, 0.2 + removed.length / 40)
        : Math.min(1, 0.25 + removed.length / 30),
      {
        kind: 'concrete',
        direction: direction ? _plumeDir.copy(direction) : undefined,
        tint: target.item ? target.baseColor : undefined,
      },
    )
    if (target.roof) {
      // Roof shells are volume grids (until the plane-grid lane lands) but
      // must still READ as roofing: a couple of torn shingle plates flutter
      // off the carve rim, and splash chips the rafters standing in it.
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
          undefined,
          'shingle',
        )
      }
      chipSegmentSplash(target, point, radius)
    }
  }
  // Walls/slabs get the papery drywallCrunch from shooting.ts; only plain
  // volumes voice their own crunch here (avoids the two sounds layering).
  if (!layered) sfx.voxelCrunch(Math.min(1, removed.length / 12))

  // Island check through the shared settle drain (structure.ts): same
  // 140 ms + jitter logical delay, 'replace' re-arms it per carve exactly
  // like the old clearTimeout+setTimeout — but a blast's dozen checks now
  // EXECUTE at most SETTLE_DRAIN_BUDGET per frame instead of coalescing.
  scheduleSettleTask(islandKey(nodeId), 140 + nextSettleJitter(), () => {
    crumbleIslands(world, target)
    settleSupportAfterRemoval(target) // island crumble can zero a piece
  })
  // Cladding all gone? The bare frame can't stand — skeleton snap.
  maybeSkeletonSnap(target)
  settleSupportAfterRemoval(target)
  // FEET SEE THE PLANE retires once the piece is damaged past threshold.
  settleWalkOnly(world, target)
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
 * slab-kind OR roof-kind collider (first shot must already tear at full
 * width — roofs joined the tear lane with the Phase C2 plane grids). */
export function isTearLaneNode(world: GameWorld, nodeId: string): boolean {
  const target = useDestruction.getState().targets.get(nodeId)
  if (target) return target.kind !== 'volume'
  if (world.walls.has(nodeId)) return true
  for (const collider of world.colliders) {
    if (collider.nodeId === nodeId) {
      return SLAB_KINDS.has(collider.nodeType) || ROOF_KINDS.has(collider.nodeType)
    }
  }
  return false
}

/**
 * One-shot landing-plane resolve for debris/dust ("floors for things",
 * MULTILEVEL-PLAN Phase B polish): the HIGHEST live surface at or below
 * (x, y, z) — a live (non-disabled) collider top, a live voxel cell of any
 * target (downward DDA), else THE GROUND AT THIS XZ. Colliders
 * whose top is above the probe point are skipped (a probe from inside a
 * wall's box must not "land" on that wall's top), and voxelized nodes are
 * covered by their grids since voxelization disables the host collider.
 * WALL grids are skipped entirely: debris/dust spawns AT wall faces, so a
 * downward DDA through the source wall's own cells would resolve the wall
 * itself as the floor and leave pieces (and dust) hovering mid-air at the
 * face — floors are slabs/plates/volumes, never wall bodies.
 * Called once per debris piece (at apex) / dust burst / bot settle step.
 *
 * SCULPTED GROUND: the baseline used to be the literal 0 plane, and the
 * 'site' heightfield could never correct it — a collider box test reduces the
 * whole lot's terrain to ONE number (its highest vertex), so a probe below
 * that height skipped terrain entirely and fell through to 0 while a probe
 * above it "landed" on a phantom flat plane at the summit. Every outdoor
 * chunk, dust puff, glass plate and ground bot therefore resolved to y = 0:
 * buried on a knoll, hovering metres over an excavation. The baseline is now
 * ground.ts's height at this XZ (still exactly 0 on a flat scene) and the
 * 'site' colliders are skipped so their AABB can't out-vote it.
 *
 * The `groundY <= y + 0.02` gate is load-bearing: a room dug into a hillside
 * has terrain ABOVE its floor, and a piece resting inside it must land on the
 * floor it is standing on, not on the hill outside the wall. When the terrain
 * is above the probe point AND nothing else is under it, the body is INSIDE
 * the ground — the probe reports the point itself, so a settle never drags it
 * further in (the capsule resolve lifts it out instead). That case used to
 * report 0 and yanked hillside bots down through the hill they stood on.
 */
export function probeLandingY(world: GameWorld, x: number, y: number, z: number): number {
  const groundY = groundSurfaceY(x, z)
  const terrainUnderfoot = groundY <= y + 0.02
  // Search floor: the ground when it IS underfoot, else the lot's hard floor
  // (never above the probe point, so `reach` below stays sane).
  const searchFloor = terrainUnderfoot ? groundY : Math.min(lotFloorY(), y)
  let best = searchFloor
  let found = terrainUnderfoot
  for (const collider of world.colliders) {
    // walkOnly planks defer to their voxel target here, same as disabled.
    if (collider.disabled || collider.walkOnly) continue
    // The terrain is answered analytically above; its AABB top is the whole
    // lot's summit and would flatten every probe onto it.
    if (collider.nodeType === 'site') continue
    const box = collider.worldBox
    const top = box.max.y
    if (top <= best || top > y + 0.02) continue
    if (x < box.min.x - 0.02 || x > box.max.x + 0.02) continue
    if (z < box.min.z - 0.02 || z > box.max.z + 0.02) continue
    best = top
    found = true
  }
  for (const target of useDestruction.getState().targets.values()) {
    const grid = target.grid
    if (target.kind === 'wall' || grid.aliveCount === 0) continue
    const reach = y + 0.01 - best
    if (reach <= 0) break
    const hit = raycastVoxels(grid, x, y + 0.01, z, 0, -1, 0, reach)
    // distance ≥ 0.02 rejects "probe point already inside a live cell"
    // (a piece would otherwise freeze at its own apex height).
    if (hit && hit.distance >= 0.02) {
      const top = y + 0.01 - hit.distance
      if (top > best) {
        best = top
        found = true
      }
    }
  }
  return found ? best : y
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

/** Module-level scratch for pitched-member raycasts — allocation-free. */
const _segmentBasis: VoxelBasis = { x: 0, y: 0, z: 0, w: 1 }

/** Nearest live (unbroken) framing segment any voxelized wall exposes along
 * the ray — analytic ray-vs-OBB, no meshes involved. Pitched roof members
 * (segment.pitch set) route through the quaternion OBB with the
 * roof-framing basis; yaw-only members keep the legacy path bit-identical. */
export function raycastSegments(
  origin: Vector3,
  direction: Vector3,
  maxDist: number,
): SegmentRayHit | null {
  let bestDist = maxDist
  let bestNode: string | null = null
  let bestSegment = -1
  for (const target of useDestruction.getState().targets.values()) {
    if (target.dormant) continue // framing hides behind the live host mesh
    for (const segment of target.segments) {
      if (segment.broken) continue
      const t = segment.pitch
        ? raycastObb(
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
            rafterObbBasis(segment.yaw, segment.pitch, _segmentBasis),
            bestDist,
          )
        : raycastYawObb(
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
/** Settle-drain key of a wall's pending 30%-support check — rides the same
 * budgeted queue as the island checks (see islandKey). */
const framingKey = (nodeId: string) => `framing:${nodeId}`

/** Scratch for one avalanche band's cells (see _collapsedCells). */
const _avalancheCells: number[] = []

function scheduleStructureCheck(world: GameWorld, nodeId: string): void {
  scheduleSettleTask(framingKey(nodeId), 160 + nextSettleJitter(), () => {
    const target = useDestruction.getState().targets.get(nodeId)
    if (!target) return
    // The 30 %-support check can snap dozens of sticks and fly several sheets
    // in one pass — one frame, not one per stick.
    beginDamageBatch()
    try {
      checkStructuralCollapse(world, target)
    } finally {
      endDamageBatch()
    }
  })
}

function breakSegmentQuiet(target: VoxelTarget, segment: SegmentMember): void {
  segment.hp = 0
  segment.broken = true
  // Every silent break funnels through here — hanging sticks above a chain
  // break, the whole frame above the 30 % support ceiling, and the skeleton
  // snap's staggered rain. Breaking is one-way, so a set union converges; and
  // WHICH sticks break is Map-order-dependent in the paths above, which is
  // exactly why it is replicated rather than re-derived.
  publishBrokenSegment(target.nodeId, segment.id)
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
        _avalancheCells.length = 0
        for (const idx of indices) {
          if (!live.grid.alive[idx]) continue
          live.grid.alive[idx] = 0
          live.grid.aliveCount--
          live.removedQueue.push(idx)
          _avalancheCells.push(idx)
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
        // The avalanche bands land on setTimeout, one per 60 ms, so each band
        // is its own frame — which is right: a peer should watch the wall come
        // down in layers, not blink to rubble.
        publishRemovedCells(live, _avalancheCells)
        _avalancheCells.length = 0
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
/** Nodes carved per staggered blast step (~one display frame apart). The
 * blast's frame cost — carve CPU, wakes, and the render submit behind
 * them — scales with nodes touched per frame, so this bounds it. Roof
 * GROUPS count their plane fan-out against this budget (weight = plane
 * count): one "node" that carves 4-6 plane grids is 4-6 steps' worth. */
export const EXPLOSION_NODES_PER_STEP = 4
/** Nodes carved SYNCHRONOUSLY inside the detonation frame itself (the
 * boom-moment budget, QA 2026-08-28 scale round): explodeAt's frame also
 * pays glass, dust storm, crater, sfx and the render submit, and the
 * profiled boom frame was ~half sync carve (7 ms of a 16.6 ms worst at a
 * 51-target house — and it grows with material density at the blast
 * point). Two nearest nodes still put the hole AT the blast point this
 * very frame; the rest of the core lands one display frame later, inside
 * the flash + dust storm, which reads identical. */
export const EXPLOSION_CORE_NODES = 2
/** Gap between staggered blast steps — one display frame. */
const EXPLOSION_STEP_MS = 16
/** Bumped on resetDestruction — staggered blast steps from a torn-down
 * session abort instead of carving into the next session's targets. */
let blastEpoch = 0

const _boomPoint = new Vector3()
const _boomSeg = new Vector3()

/**
 * One explosion: every destructible collider group whose bounds touch the
 * radius takes the full-depth center carve (radius ≥ WALL_PIERCE_RADIUS, so
 * both drywall skins go in one hit) plus EXPLOSION_NIBBLES ragged rim
 * nibbles, then framing segments inside the radius snap (which arms the
 * 30%-support check). Returns the total voxels removed.
 */
/** One node's share of a blast ring: the full-depth carve, plus the ragged
 * rim nibbles on the outermost pass. */
function carveExplosionNode(
  world: GameWorld,
  nodeId: string,
  center: Vector3,
  ring: number,
  withNibbles: boolean,
): number {
  let total = damageTarget(world, nodeId, center, ring)
  if (!withNibbles) return total
  for (let i = 0; i < EXPLOSION_NIBBLES; i++) {
    _boomPoint
      .set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
      .normalize()
      .multiplyScalar(ring * (0.75 + Math.random() * 0.3))
      .add(center)
    total += damageTarget(world, nodeId, _boomPoint, 0.3 + Math.random() * 0.2)
  }
  return total
}

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
    total += carveExplosionNode(world, collider.nodeId, center, ring, withNibbles)
  }
  return total
}

/**
 * WAKE-AHEAD (QA 2026-08-28): wake the nearest still-dormant explodable
 * node within `radius` of `center` — one node per call, zero allocations.
 * The grenade's ~2 s fuse calls this once per frame while the stick flies/
 * cooks, so by detonation every node the blast can reach is already awake
 * and the boom frame pays repeat-blast prices (the first-blast spike was
 * the wake-frame render submit, and it scales with wakes per frame).
 * Returns true when it woke something (callers budget one per frame).
 */
export function wakeAheadTick(world: GameWorld, center: Vector3, radius: number): boolean {
  // Everything is awake (any mid/late session): don't pay the collider scan
  // per cooking stick per frame just to find nothing.
  if (dormantCount === 0) return false
  const targets = useDestruction.getState().targets
  let best: VoxelTarget | null = null
  let bestD = Number.POSITIVE_INFINITY
  for (const collider of world.colliders) {
    if (!EXPLODABLE.has(collider.nodeType)) continue
    const d = collider.worldBox.distanceToPoint(center)
    if (d > radius || d >= bestD) continue
    // Roof shells enroll per PLANE under member ids — resolve through the
    // group so the family wake (wakeTarget fans it out) still applies.
    const groupId = roofGroups.has(collider.nodeId) ? collider.nodeId : undefined
    const memberId = groupId ? (roofGroups.get(groupId)?.[0] ?? collider.nodeId) : collider.nodeId
    const target = targets.get(memberId)
    if (!target || !target.dormant) continue
    best = target
    bestD = d
  }
  if (!best) return false
  wakeTarget(world, best)
  return true
}

/** Explodable nodes whose bounds sit within `ring`, nearest first — the
 * order the staggered carve walks so the blast reads as one expanding
 * shockwave (per-BLAST allocations only, never per frame). `w` is the
 * node's step-budget weight: a roof node fans its carve out to every
 * sibling plane grid (damageTarget's group dispatch), so it weighs its
 * plane count — a hip roof can't ride a 4-node step as if it were one. */
function collectExplosionNodes(
  world: GameWorld,
  center: Vector3,
  ring: number,
): { id: string; d: number; w: number }[] {
  const seen = new Set<string>()
  const out: { id: string; d: number; w: number }[] = []
  for (const collider of world.colliders) {
    if (seen.has(collider.nodeId)) continue
    if (!EXPLODABLE.has(collider.nodeType)) continue
    const d = collider.worldBox.distanceToPoint(center)
    if (d > ring) continue
    seen.add(collider.nodeId)
    const group = roofGroups.get(collider.nodeId) ?? roofGroups.get(roofMemberOf.get(collider.nodeId) ?? '')
    out.push({ id: collider.nodeId, d, w: group ? Math.max(1, group.length) : 1 })
  }
  out.sort((a, b) => a.d - b.d)
  return out
}

function explosionSegments(world: GameWorld, center: Vector3, radius: number): void {
  // WHICH 48 sticks snap depends on Map iteration order, and that order is
  // prevoxelization order — it depends on where this player happened to be
  // standing when each wall enrolled. Two peers would cap at different sticks.
  // So the set is published as an outcome, in one frame.
  beginDamageBatch()
  try {
    const radiusSq = radius * radius
    let snapped = 0
    outer: for (const target of useDestruction.getState().targets.values()) {
      if (target.dormant) continue // the blast rings wake what they reach
      for (const segment of target.segments) {
        if (segment.broken) continue
        _boomSeg.set(segment.center[0], segment.center[1], segment.center[2])
        if (_boomSeg.distanceToSquared(center) > radiusSq) continue
        damageSegment(world, target.nodeId, segment.id, 999, _boomSeg)
        if (++snapped >= EXPLOSION_SEGMENT_CAP) break outer
      }
    }
  } finally {
    endDamageBatch()
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
    // The whole blast in one frame (this is the test/edge path — the staggered
    // path below publishes one frame per step, which is what players see).
    beginDamageBatch()
    try {
      const total = explosionRing(world, center, radius, true)
      explosionSegments(world, center, radius)
      return total
    } finally {
      endDamageBatch()
    }
  }
  // PER-NODE stagger inside each ring (QA 2026-08-28): the frame cost of a
  // blast scales with how many nodes carve — and, on the FIRST mid-house
  // blast, WAKE — in one frame (a single wake doesn't even spike; ~15 in
  // one frame was a ~100 ms render submit). So each ring walks its nodes
  // nearest-first at EXPLOSION_NODES_PER_STEP per display frame instead of
  // all at once. The 30/70 ms ring marks hold as "not before" gates, the
  // rings still read as one expanding shockwave, and a 14-node house now
  // spreads across ~10 frames of small steps instead of 3 long ones.
  const frozen = center.clone()
  const blastT0 = now()
  const rings = [
    { ring: radius * 0.5, notBefore: blastT0, withNibbles: false, tag: 'boom-ring1' },
    { ring: radius * 0.8, notBefore: blastT0 + 30, withNibbles: false, tag: 'boom-ring2' },
    { ring: radius, notBefore: blastT0 + 70, withNibbles: true, tag: 'boom-ring3' },
  ]
  let ringIndex = -1 // step() advances to ring 0 on its first pass
  let nodes: { id: string; d: number; w: number }[] = []
  let cursor = 0
  let coreTotal = 0
  const epoch = blastEpoch
  /** One staggered step is one published frame: the peers watch the same
   * shockwave expand at the same granularity the local player does. Each step
   * is its own macrotask, so these batches never nest. */
  const step = (budget: number): void => {
    beginDamageBatch()
    try {
      stepBody(budget)
    } finally {
      endDamageBatch()
    }
  }
  const stepBody = (budget: number): void => {
    // Session ended mid-blast (Save/Discard tears the store down) — drop
    // the tail instead of carving into the next session's targets.
    if (epoch !== blastEpoch) return
    const stepT0 = performance.now()
    let carved = 0
    while (carved < budget) {
      if (cursor >= nodes.length) {
        // Ring exhausted — segments snap after the last ring, then done.
        if (ringIndex >= rings.length - 1) {
          if (ringIndex >= 0) perfSection(rings[ringIndex]!.tag, performance.now() - stepT0)
          const segT0 = performance.now()
          explosionSegments(world, frozen, radius)
          perfSection('boom-segments', performance.now() - segT0)
          return
        }
        const next = rings[ringIndex + 1]!
        const wait = next.notBefore - now()
        if (wait > 0) {
          if (ringIndex >= 0) perfSection(rings[ringIndex]!.tag, performance.now() - stepT0)
          setTimeout(() => step(EXPLOSION_NODES_PER_STEP), wait)
          return
        }
        ringIndex++
        nodes = collectExplosionNodes(world, frozen, next.ring)
        cursor = 0
        continue
      }
      const ring = rings[ringIndex]!
      const node = nodes[cursor]!
      // A heavy node (roof group) never squeezes into a nearly-spent step —
      // it opens the NEXT one instead. Only a step's FIRST node may exceed
      // the budget (something must always carve, or the blast stalls).
      if (carved > 0 && carved + node.w > budget) break
      const removed = carveExplosionNode(world, node.id, frozen, ring.ring, ring.withNibbles)
      cursor++
      if (ringIndex === 0) coreTotal += removed
      carved += node.w
    }
    perfSection(rings[ringIndex]!.tag, performance.now() - stepT0)
    setTimeout(() => step(EXPLOSION_NODES_PER_STEP), EXPLOSION_STEP_MS)
  }
  // The first pass runs synchronously with the SMALL boom-moment budget: it
  // advances into ring 0 and carves the nearest core node(s) THIS frame —
  // instant feedback at the blast point; everything else rides the
  // staggered steps behind it, starting one display frame later.
  step(EXPLOSION_CORE_NODES)
  return coreTotal
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
  // Blast frames route snap debris through the grenade queue (capped +
  // drained a budget per frame); single gunshot breaks keep the inline path.
  const emit = blastDebrisActive() ? queueDebris : spawnDebris
  for (let i = 0; i < 4; i++) {
    emit(point.x, point.y, point.z, 0.02 + Math.random() * 0.02, WOOD, 2, 0.9)
  }
  if (segment.hp > 0) {
    sfx.studHit()
    return true
  }
  segment.hp = 0 // clamp — debug snapshots read hp, don't show underflow
  segment.broken = true
  // A stick's hp is local (it accumulates local hits); only the break crosses.
  publishBrokenSegment(nodeId, segmentId)
  target.revision++
  useDestruction.getState().bump()
  // Charcoal-stick snap: 2-3 stick pieces spread along the long axis
  // (verticals fall as stacked thirds, plates as run pieces, pitched
  // rafters as slope pieces — roof-framing.ts local X in world).
  const [sx, sy, sz] = segment.size
  const long = Math.max(sx, sy, sz)
  let ax = 0
  let ay = 1
  let az = 0
  if (sy < long) {
    const ct = segment.pitch ? Math.cos(segment.pitch) : 1
    ax = ct * Math.cos(segment.yaw)
    ay = segment.pitch ? Math.sin(segment.pitch) : 0
    az = ct * Math.sin(segment.yaw)
  }
  const pieces = 2 + (Math.random() < 0.5 ? 1 : 0)
  for (let i = 0; i < pieces; i++) {
    const t = ((i + 0.5) / pieces - 0.5) * long
    emit(
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
    emit(point.x, point.y, point.z, 0.02 + Math.random() * 0.025, WOOD, 2.4, 1.2)
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

/**
 * A cell standing in an OPEN DOORWAY is transparent to these rays.
 *
 * Third lane of the same rule. The player already walks through those cells
 * (collision.ts relief) and no longer sees them (voxel-walls.tsx), so a bullet
 * that stopped dead in mid-air in an open doorway reads as the GUN being
 * broken — and enemy line-of-sight blocked by cells that exist for neither the
 * eye nor the feet makes bots refuse to shoot back through a door they can
 * walk through.
 *
 * UNPADDED, exactly like the render lane and unlike the collision lane: here
 * over-relieving is the dangerous direction, because a pad that reached past
 * the aperture would let shots through the wall BESIDE a doorway, or through a
 * door that is shut. Under-relieving costs at most the half-cell fringe lining
 * the opening, and a shot that clips that fringe is a shot that grazed the
 * jamb — which is what a player would expect to see happen anyway.
 *
 * Module-scope so the hot path (every bullet, plus every bot's melee probe)
 * allocates no closure; `_skipGrid` is set immediately before the call and
 * read only inside it, and nothing here can yield.
 */
let _skipGrid: VoxelGridData | null = null
const _skipOpenDoorway = (index: number): boolean => {
  const grid = _skipGrid
  if (grid === null) return false
  const i = index * 3
  return passageHidesCell(grid.centers[i]!, grid.centers[i + 1]!, grid.centers[i + 2]!)
}

/** First live voxel any damaged target's grid intersects along the ray. */
export function raycastVoxelTargets(
  origin: Vector3,
  direction: Vector3,
  maxDist: number,
): TargetRayHit | null {
  let best: TargetRayHit | null = null
  // No door open anywhere: hand the walk no predicate at all, so the common
  // case is the walk it always was.
  const relieve = passageCount() > 0
  for (const target of useDestruction.getState().targets.values()) {
    if (target.dormant) continue // the host mesh still owns rays/collision
    _skipGrid = target.grid
    const hit = raycastVoxels(
      target.grid,
      origin.x,
      origin.y,
      origin.z,
      direction.x,
      direction.y,
      direction.z,
      maxDist,
      relieve ? _skipOpenDoorway : undefined,
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
  _skipGrid = null // don't pin a whole grid's buffers alive between shots
  return best
}

/** Legacy alias. */
export const raycastVoxelWalls = raycastVoxelTargets

const _voxelCenter = new Vector3()
/** Scratch for collideVoxelTargets' basis-rotated capsule center. */
const _capsuleLocal = { x: 0, y: 0, z: 0 }

/** Capsule push-out against live voxels of every target (voxels ≈ spheres
 * of r=0.55·cell — close enough at 15 cm cells, and far cheaper than box
 * tests). */
export function collideVoxelTargets(pos: Vector3, vel: Vector3, radius: number, height: number): boolean {
  let grounded = false
  for (const target of useDestruction.getState().targets.values()) {
    // FEET SEE THE PLANE: a lightly-damaged placed ramp/roof piece keeps its
    // smooth walkOnly plank in collideCapsule — colliding its coincident
    // voxel cells too would re-bump every lip the plank exists to hide.
    if (target.walkOnly) continue
    // Dormant prebuilds: the HOST colliders still own collision (the hide/
    // handover is deferred to wakeTarget) — colliding the coincident grid
    // too double-solidifies every prebuilt slab/stair/item, bumping feet on
    // voxel lips that stick out past the host surface.
    if (target.dormant) continue
    const { grid } = target
    // Sphere radius keys off the LARGEST cell — any smaller and the capsule
    // could slip between skin voxels spaced a full length-cell apart.
    const r = grid.cell * 0.55
    // Rotated grids index cells in their local frame. Yaw grids keep a
    // vertical capsule vertical (only its XZ center moves); a FULL-basis
    // grid (pitched roof plane) tilts the capsule in grid space, so its
    // cell range is taken conservatively from the capsule's bounding
    // sphere around its mid-height. The push-out below runs on world
    // centers and needs no rotation either way.
    let px = pos.x
    let py = pos.y
    let pz = pos.z
    let reachX = radius + r
    let reachDown = r
    let reachUp = height + r
    let reachZ = radius + r
    if (grid.q.x !== 0 || grid.q.z !== 0) {
      rotateByBasis(grid.q, pos.x, pos.y + height / 2, pos.z, _capsuleLocal)
      px = _capsuleLocal.x
      py = _capsuleLocal.y
      pz = _capsuleLocal.z
      const reach = height / 2 + radius + r
      reachX = reach
      reachDown = reach
      reachUp = reach
      reachZ = reach
    } else if (grid.yaw !== 0) {
      const cos = Math.cos(grid.yaw)
      const sin = Math.sin(grid.yaw)
      px = pos.x * cos + pos.z * sin
      pz = -pos.x * sin + pos.z * cos
    }
    const minX = Math.floor((px - reachX - grid.origin.x) / grid.cellX)
    const maxX = Math.floor((px + reachX - grid.origin.x) / grid.cellX)
    const minY = Math.floor((py - reachDown - grid.origin.y) / grid.cellY)
    const maxY = Math.floor((py + reachUp - grid.origin.y) / grid.cellY)
    const minZ = Math.floor((pz - reachZ - grid.origin.z) / grid.cellZ)
    const maxZ = Math.floor((pz + reachZ - grid.origin.z) / grid.cellZ)
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
          // OPEN-DOORWAY RELIEF: a cell standing inside an open door's
          // registered passage prism, at or above the feet, is the blocker that
          // door promised away (see collision.ts::passageRelievesCell — cells
          // BELOW the feet keep resolving, so a voxel floor still carries the
          // capsule across the threshold). Without this, waking a wall whose
          // grid crosses a doorway re-solidifies the very geometry the prism
          // relieves in the triangle lane, and the open door stops admitting
          // the player. `r` is the cell's half-extent: the test has to know a
          // cell is a CUBE, or the ring of cells whose centres sit just outside
          // the prism lines the aperture and seals it anyway.
          if (passageRelievesCell(_voxelCenter.x, _voxelCenter.y, _voxelCenter.z, pos.y, r)) {
            continue
          }
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

/**
 * OPERABLE HANDBACK (owner repro 2026-08-30, Starter House: "can't walk
 * through a regular door — something on the wall blocks me"): a CLOSED door
 * that catches ANY stray fire wakes its voxel replica AT THE CLOSED POSE.
 * The twin looks just like the door, the E prompt stands down (interact's
 * isVoxelized), and the doorway is sealed for the rest of the session —
 * one pistol round turned the house's only entrance into a wall.
 *
 * This hands the node back to the interact system: reverse hideHostNode
 * (for a non-wall node the meshes ensureVoxelTarget collected and hid ARE
 * exactly the node's collider meshes — doors have no glass split and nest
 * no other node's kept root, so the hide plan was a plain `visible = false`
 * per mesh; the session exit ledger re-asserts `visible = true`, so a
 * mid-session un-hide stays consistent) and drop the target, so the leaf
 * renders, swings, and re-voxelizes from its LIVE pose on the next hit.
 * The few carved cells "heal" — a fair trade against a permanently sealed
 * house. The DAMAGE POLICY lives with the caller (interact.tsx
 * DOOR_RESTORE_MAX_DAMAGE); this refuses only structural impossibilities:
 * no session, no target, or a roof-family member (never a door). A still-
 * DORMANT target only retires its stale prebuild — the host already
 * renders and collides. Returns whether the host owns the node again.
 */
export function restoreOperableTarget(nodeId: string): boolean {
  const state = useDestruction.getState()
  const target = state.targets.get(nodeId)
  if (!target) return false
  if (target.dormant) {
    // Nothing was damaged, but the epoch still goes out: a peer's frame for
    // this door may be in flight, and without a higher epoch their holes would
    // land on a node the host has just taken back.
    publishNodeReset(nodeId)
    dropTarget(nodeId)
    return true
  }
  if (roofGroups.has(nodeId) || roofMemberOf.has(nodeId)) return false
  const world = sessionWorld
  if (!world) return false
  for (const collider of world.colliders) {
    if (collider.nodeId !== nodeId) continue
    collider.mesh.visible = true
    collider.disabled = false
    collider.ballistic = false
  }
  // THE ONE NON-MONOTONE OPERATION. Every other damage op is a set union, so
  // it converges by construction; this one un-destroys, which no grow-only set
  // can express. It publishes a new EPOCH: a higher epoch wins outright on
  // every receiver and drops the whole old generation of holes, including this
  // client's own — which is right, because the door came back.
  publishNodeReset(nodeId)
  dropTarget(nodeId)
  return true
}

/** Forget one voxel target (builder Z-undo unmounts its source mesh): the
 * replica unmounts and any pending island collapse for it is cancelled.
 * No-op if the node never voxelized. */
export function dropTarget(nodeId: string): void {
  // A roof node id fans out to its per-plane member targets.
  const group = roofGroups.get(nodeId)
  if (group) {
    roofGroups.delete(nodeId)
    pendingRoofShells.delete(nodeId) // S2: nothing left to build for
    // The group's shingle tone resolved (and audited) under the REAL node
    // id — the member recursion below only clears the member ids.
    clearToneAudit(nodeId)
    for (const id of group) {
      roofMemberOf.delete(id)
      dropTarget(id)
    }
    return
  }
  roofMemberOf.delete(nodeId)
  cancelSettleTask(islandKey(nodeId))
  cancelSettleTask(framingKey(nodeId))
  // Tone audit: nothing renders this node's fallback anymore, and any
  // pending texture retry would deliver to a dead target.
  clearToneAudit(nodeId)
  const state = useDestruction.getState()
  const dropping = state.targets.get(nodeId)
  if (dropping?.dormant) dormantCount--
  if (dropping) clearShellPending(dropping) // S2 pending census stays true
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

/**
 * What THIS peer destroyed, or null in single player — the Save bridge's only
 * window onto the shared model.
 *
 * save-demolition.ts asks destruction.ts rather than the shared modules on
 * purpose. It already depends on this file for the runtime targets, and routing
 * the question through here means the bridge never holds a SharedWorld handle:
 * it cannot read a stranger's work even by accident, and there is no import
 * cycle to make module evaluation order matter.
 */
export function localDemolitionWork(): LocalWork | null {
  return sharedLocalWork()
}

export function resetDestruction(): void {
  sessionWorld = null
  blastEpoch++
  // A teardown mid-batch must not leak half a frame into the next session.
  // The injected sync and runtime survive: whoever wired them owns unwiring.
  resetSharedDamage()
  dormantRoofHide.clear()
  dormantCount = 0
  // Next session re-reads shellFlags (per-kind prevoxelize latches).
  shellLatch.wall = null
  shellLatch.roof = null
  shellLatch.slab = null
  // Lazy shell tier (S2): pending builds die with their targets.
  shellQueue = []
  shellQueueCursor = 0
  shellQueueSortedAt = Number.NEGATIVE_INFINITY
  shellPendingTotal = 0
  pendingRoofShells.clear()
  shellFocusSet = false
  syncShellWindowStart = Number.NEGATIVE_INFINITY
  syncShellSpentMs = 0
  if (sceneSupportTimer !== null) {
    clearTimeout(sceneSupportTimer)
    sceneSupportTimer = null
  }
  // Island + framing settle tasks die with the whole drain in
  // resetStructure() below (the queue is shared — see structure.ts).
  for (const timer of skeletonTimers) clearTimeout(timer)
  skeletonTimers.length = 0
  skeletonSnapped.clear()
  prevoxelizeSkip.clear()
  prevoxelizeQueue = []
  prevoxelizeQueueCursor = 0
  prevoxelizeQueueSortedAt = Number.NEGATIVE_INFINITY
  prevoxelizeCenters = null
  prevoxelizeDtEma = 1000 / 60
  prevoxelizeLastTickAt = -1
  roofGroups.clear()
  roofMemberOf.clear()
  resetSkinTones()
  resetStructure()
  useDestruction.getState().reset()
}

// ── The shared-world damage bridge (see shared-damage.ts) ────────────────────

/**
 * What a stranger's damage is allowed to do to this client's scene.
 *
 * Registered once at module load. shared-damage.ts calls in here only while it
 * is applying a merged frame, with its own publish path disarmed — so the local
 * cascades this provokes still happen (collapse is DERIVED, not received) but
 * are never mistaken for this player's own work, and so can never ride into the
 * owner's demolition save under our authorship.
 *
 * Every entry point MATERIALIZES first. Remote damage arrives for nodes this
 * player has never walked near: a dormant prebuild whose host mesh is still
 * doing the rendering, a target whose conforming shell has not been built yet,
 * or a node with no voxel target at all. A wall has to be able to lose its
 * cells on this screen without this player ever having fired at it.
 */
const _remoteDust = new Vector3()

function remoteTarget(nodeId: string): VoxelTarget | null {
  const world = sessionWorld
  if (!world) return null
  let target = useDestruction.getState().targets.get(nodeId) ?? null
  if (target === null) {
    // A roof PLANE member (`<nodeId>#p0`) exists only once its group has
    // decomposed — build the group, then look the member up again.
    const hash = nodeId.indexOf('#')
    if (hash > 0) {
      ensureVoxelTarget(world, nodeId.slice(0, hash))
      target = useDestruction.getState().targets.get(nodeId) ?? null
    }
  }
  target ??= ensureVoxelTarget(world, nodeId)
  if (target === null) return null
  // A prebuild that is still asleep has its host mesh rendering over the grid;
  // killing cells underneath it would change nothing on screen.
  if (target.dormant) wakeTarget(world, target)
  return target
}

setDamageRuntime({
  materialize: (nodeId) => remoteTarget(nodeId),

  removeCells: (handle, indices) => {
    const world = sessionWorld
    const target = useDestruction.getState().targets.get(handle.nodeId)
    if (!world || !target) return
    const { grid } = target
    let removed = 0
    let first = -1
    for (const idx of indices) {
      if (!grid.alive[idx]) continue
      grid.alive[idx] = 0
      grid.aliveCount--
      target.removedQueue.push(idx)
      if (first < 0) first = idx
      // Sheet bookkeeping only — torn cells, no hits. Same rule as an island
      // crumble: these cells are an already-decided outcome, and whether the
      // board has flown is derivable from its cells being dead.
      const sheetId = target.sheetByCell[idx]
      if (sheetId !== undefined && sheetId >= 0) target.sheets[sheetId]!.torn++
      removed++
    }
    if (removed === 0 || first < 0) return
    // Someone else's shot should look and sound like a shot. Sampled debris,
    // never 1:1 — a remote whole-wall collapse would otherwise flood the ring.
    const spawn = Math.min(removed, 10)
    for (let n = 0; n < spawn; n++) {
      const idx = indices[Math.floor(((n + 0.5) * indices.length) / spawn)]
      if (idx === undefined) continue
      spawnDebris(
        grid.centers[idx * 3]!,
        grid.centers[idx * 3 + 1]!,
        grid.centers[idx * 3 + 2]!,
        grid.cell,
        cellTint(target, idx),
        1.8,
      )
    }
    _remoteDust.set(grid.centers[first * 3]!, grid.centers[first * 3 + 1]!, grid.centers[first * 3 + 2]!)
    spawnDust(_remoteDust, Math.min(1, 0.4 + removed / 18), {
      kind: target.kind === 'volume' ? 'concrete' : 'drywall',
      tint: target.item ? target.baseColor : undefined,
    })
    sfx.crumble(removed)
    target.revision++
    useDestruction.getState().bump()
    // The SAME tail a local carve runs. Everything below is derived from state
    // that has already converged, so both clients reach the same conclusion —
    // and where the derivation is order-dependent (the island flood, the 30 %
    // support rule) its own outcome is published in turn by whoever gets there.
    scheduleSettleTask(islandKey(target.nodeId), 140 + nextSettleJitter(), () => {
      crumbleIslands(world, target)
      settleSupportAfterRemoval(target)
    })
    maybeSkeletonSnap(target)
    settleSupportAfterRemoval(target)
    settleWalkOnly(world, target)
    noteStructureCarve(world, target.nodeId)
  },

  breakSegments: (handle, ids) => {
    const target = useDestruction.getState().targets.get(handle.nodeId)
    if (!target) return
    let changed = false
    for (const id of ids) {
      const segment = target.segments.find((s) => s.id === id)
      if (!segment || segment.broken) continue
      breakSegmentQuiet(target, segment)
      changed = true
    }
    if (!changed) return
    sfx.studSnap()
    target.revision++
    useDestruction.getState().bump()
    // A break may drop hanging sticks or trip the support rule — same settle.
    if (sessionWorld) scheduleStructureCheck(sessionWorld, target.nodeId)
  },

  killNode: (nodeId) => {
    // The kill BIT needs no grid on the wire, but it needs one here: a target
    // that never voxelized is still being rendered by its host mesh, and the
    // node has to leave this player's screen.
    const target = remoteTarget(nodeId)
    if (target === null) return
    collapseWholeTarget(target.nodeId)
  },

  resetNode: (nodeId) => {
    restoreOperableTarget(nodeId)
  },
})
