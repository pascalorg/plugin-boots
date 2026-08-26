import { raycastVoxels, type VoxelGridData } from './voxel'

/**
 * Cross-target structural support (docs/MULTILEVEL-PLAN.md Phase B3, V1) —
 * "destroying what holds a thing up drops it".
 *
 * Each voxel target's per-grid island flood (voxel.ts) only knows about the
 * target's OWN base row, so an upper-storey wall standing on a slab is
 * "supported" forever even after the slab under it is carved away, and a
 * ground wall keeps standing when everything beneath its base is gone. This
 * module adds the missing BETWEEN-target rule:
 *
 *   a WALL target whose entire (sampled) base row has nothing live beneath
 *   it — no terrain within SUPPORT_GAP, no live collider top, no live voxel
 *   cell of another target — crumbles wholesale.
 *
 * Wiring (destruction.ts owns the hooks — this module never imports it at
 * runtime, the driver is injected):
 *   registerStructureTarget(target)   at ensureVoxelTarget — records the
 *                                     target's world AABB for the
 *                                     rests-on interest test.
 *   noteStructureCarve(world, id)     after any carve/crumble of target id:
 *                                     marks every candidate whose AABB rests
 *                                     on id dirty and arms the settle tick.
 *   dropStructureTarget(id) / resetStructure()   lifecycle.
 *
 * The tick (STRUCTURE_SETTLE_MS after a carve, per-target re-checks
 * throttled to STRUCTURE_TICK_MS) probes dirty candidates and crumbles the
 * unsupported ones through driver.collapse — destruction.ts's
 * collapseWholeTarget, whose settleSupportAfterRemoval already notifies the
 * builder piece SupportGraph (piece-slots.notifySceneSupportChanged), so
 * placed pieces standing on a crumbled host wall fall too. Cascades run as
 * staggered WAVES (the computeCollapse-rings feel): wave N's fallers seed
 * wave N+1 (their dependents) STRUCTURE_WAVE_MS later, capped at
 * STRUCTURE_WAVE_CAP crumbles per wave and STRUCTURE_MAX_WAVES waves per
 * tick — anything past a cap is logged and left dirty for the next tick.
 *
 * V1 scope (deliberate): only host WALL targets (yaw-only grids, never
 * `__boots-piece-*` — pieces have their own SupportGraph) can fall;
 * every target/collider counts as a supporter. Pitched-basis grids (roofs)
 * neither probe nor fall until Phase C seeds their eave rows. Known V1
 * blind spot: two floating corner walls whose base cells interpenetrate can
 * prop each other (the probe is per-target, not a component BFS) — the
 * same-row hits are mostly rejected by the min-drop gate, but a true mutual
 * ring needs the graph pass deferred to V2.
 */

// ── Tunables (exported for tests) ───────────────────────────────────────────

/** How far below a base cell's bottom face support may sit (metres). */
export const SUPPORT_GAP = 0.35
/** Carve → support-check settle (island crumbles land at 140 ms first). */
export const STRUCTURE_SETTLE_MS = 200
/** Per-target re-check throttle — a wall is probed at most this often. */
export const STRUCTURE_TICK_MS = 500
/** Stagger between cascade waves (the 120–180 ms collapse-rings feel). */
export const STRUCTURE_WAVE_MS = 150
/** Max targets crumbled per wave. */
export const STRUCTURE_WAVE_CAP = 4
/** Max cascade waves per tick — the rest waits for the next tick. */
export const STRUCTURE_MAX_WAVES = 3
/** Base-row probe sample cap (evenly strided across the row). */
const SAMPLE_CAP = 16
/** XZ slack for collider-top / rests-on containment tests (metres). */
const XZ_MARGIN = 0.05
/** A voxel support hit must enter BELOW our cell (top face at least this
 * close to our bottom) — rejects same-row corner interpenetration while
 * tolerating a few cm of slab-top/wall-base overlap. */
const MIN_DROP_SLACK = 0.06

// ── Pure probe (unit-testable — no module state) ────────────────────────────

/** Minimal target shape the probe needs (VoxelTarget satisfies it). */
export type SupportTargetLike = { nodeId: string; grid: VoxelGridData }

/** Minimal collider shape (world.ts ColliderEntry satisfies it). */
export type SupportColliderLike = {
  nodeId: string
  worldBox: {
    min: { x: number; y: number; z: number }
    max: { x: number; y: number; z: number }
  }
  disabled?: boolean
}

export type SupportProbeCtx = {
  colliders: readonly SupportColliderLike[]
  /** Every live voxel target (self is skipped by nodeId). A THUNK — the
   * probe re-iterates once per sampled base cell, and Map.values() style
   * iterators are one-shot. */
  targets: () => Iterable<SupportTargetLike>
  /** Ground plane height (collision.ts's lot plane) — default 0. */
  terrainY?: number
}

/**
 * True while anything live still holds the target's base row up: terrain,
 * a live (non-disabled, foreign) collider whose top reaches into the
 * SUPPORT_GAP band under a base cell, or a live voxel cell of another
 * target within that band (downward DDA). Samples ≤ SAMPLE_CAP base cells;
 * ANY supported sample keeps the whole target standing ("entire base row
 * has nothing live beneath" is the crumble condition, so the bias is
 * toward standing). Non-wall shapes and pitched-basis grids report
 * supported — V1 never drops them.
 */
export function probeTargetSupport(target: SupportTargetLike, ctx: SupportProbeCtx): boolean {
  const grid = target.grid
  if (grid.aliveCount === 0) return true // nothing left to hold up
  if (grid.q.x !== 0 || grid.q.z !== 0) return true // pitched basis: Phase C

  // Lowest LIVE row is the base row (a fully-carved iy=0 row already dooms
  // the wall via findUnsupportedIslands — no seeds — before we ever run).
  let minIy = Number.POSITIVE_INFINITY
  for (let i = 0; i < grid.count; i++) {
    if (!grid.alive[i]) continue
    const iy = grid.coords[i * 3 + 1]!
    if (iy < minIy) minIy = iy
  }
  if (!Number.isFinite(minIy)) return true
  const base: number[] = []
  for (let i = 0; i < grid.count; i++) {
    if (grid.alive[i] && grid.coords[i * 3 + 1] === minIy) base.push(i)
  }
  if (base.length === 0) return true

  const terrainY = ctx.terrainY ?? 0
  const halfCell = grid.cellY / 2
  const reach = halfCell + SUPPORT_GAP + 0.02
  const minDrop = Math.max(0, halfCell - MIN_DROP_SLACK)
  const stride = Math.max(1, Math.ceil(base.length / SAMPLE_CAP))
  for (let s = 0; s < base.length; s += stride) {
    const idx = base[s]!
    const cx = grid.centers[idx * 3]!
    const cy = grid.centers[idx * 3 + 1]!
    const cz = grid.centers[idx * 3 + 2]!
    const bottom = cy - halfCell
    // 1) Terrain — the lot's infinite ground plane (collision.ts).
    if (bottom <= terrainY + SUPPORT_GAP) return true
    // 2) Live collider top inside the support band under this cell.
    for (const collider of ctx.colliders) {
      if (collider.disabled || collider.nodeId === target.nodeId) continue
      const box = collider.worldBox
      if (box.max.y < bottom - SUPPORT_GAP || box.min.y > bottom + 0.02) continue
      if (cx < box.min.x - XZ_MARGIN || cx > box.max.x + XZ_MARGIN) continue
      if (cz < box.min.z - XZ_MARGIN || cz > box.max.z + XZ_MARGIN) continue
      return true
    }
    // 3) Live voxel cell of ANOTHER target below this cell (short DDA down;
    // the min-drop gate rejects same-row corner interpenetration).
    for (const other of ctx.targets()) {
      if (other.nodeId === target.nodeId || other.grid.aliveCount === 0) continue
      const hit = raycastVoxels(other.grid, cx, cy, cz, 0, -1, 0, reach)
      if (hit && hit.distance >= minDrop) return true
    }
  }
  return false
}

// ── Session registry + cascade ticker (driver-injected, no runtime deps) ────

/** What the ticker needs from destruction.ts — injected there at module
 * init (wireStructureDriver) so this module never imports it at runtime. */
export type StructureDriver = {
  targets: () => Map<string, SupportTargetLike>
  /** Crumble the whole target (destruction.collapseWholeTarget). */
  collapse: (nodeId: string) => void
}

/** The slice of GameWorld the tick keeps (colliders feed the probe). */
type WorldLike = { colliders: readonly SupportColliderLike[] }

type StructureEntry = {
  nodeId: string
  /** World AABB of the voxel grid (from cell centers ± cell/2). */
  minX: number
  minY: number
  minZ: number
  maxX: number
  maxY: number
  maxZ: number
  /** True when this target may CRUMBLE (host wall, yaw-only grid). */
  candidate: boolean
}

let driver: StructureDriver | null = null
const entries = new Map<string, StructureEntry>()
const dirty = new Set<string>()
const lastCheck = new Map<string, number>()
let lastWorld: WorldLike | null = null
let tickTimer: ReturnType<typeof setTimeout> | null = null
const waveTimers = new Set<ReturnType<typeof setTimeout>>()

const now: () => number =
  typeof performance !== 'undefined' ? () => performance.now() : () => Date.now()

/** destruction.ts installs its collapse/lookup here at module init. */
export function wireStructureDriver(next: StructureDriver): void {
  driver = next
}

/** Piece-collider prefix (builder pieces have their own SupportGraph). */
const PLACED_PIECE_PREFIX = '__boots-piece-'

/**
 * Record a freshly voxelized target: its world AABB (interest tests) and
 * whether it is a crumble CANDIDATE. Idempotent per nodeId.
 */
export function registerStructureTarget(target: SupportTargetLike, kind: string): void {
  if (entries.has(target.nodeId)) return
  const grid = target.grid
  if (grid.count === 0) return
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
  const half = grid.cell / 2
  entries.set(target.nodeId, {
    nodeId: target.nodeId,
    minX: minX - half,
    minY: minY - half,
    minZ: minZ - half,
    maxX: maxX + half,
    maxY: maxY + half,
    maxZ: maxZ + half,
    candidate:
      kind === 'wall' &&
      !target.nodeId.startsWith(PLACED_PIECE_PREFIX) &&
      target.grid.q.x === 0 &&
      target.grid.q.z === 0,
  })
}

/** True when `upper`'s base sits on (or within SUPPORT_GAP above) `lower`'s
 * AABB with XZ overlap — the "register interest" test. */
function restsOn(upper: StructureEntry, lower: StructureEntry): boolean {
  if (upper.minY < lower.minY - XZ_MARGIN) return false
  if (upper.minY > lower.maxY + SUPPORT_GAP) return false
  if (upper.maxX < lower.minX - 0.1 || upper.minX > lower.maxX + 0.1) return false
  if (upper.maxZ < lower.minZ - 0.1 || upper.minZ > lower.maxZ + 0.1) return false
  return true
}

/** Every candidate resting on any of `ids` (never the fallers themselves). */
function dependentsOf(ids: readonly string[]): string[] {
  const out: string[] = []
  for (const entry of entries.values()) {
    if (!entry.candidate || ids.includes(entry.nodeId)) continue
    for (const id of ids) {
      const lower = entries.get(id)
      if (lower && restsOn(entry, lower)) {
        out.push(entry.nodeId)
        break
      }
    }
  }
  return out
}

/**
 * Target `nodeId` just lost material (carve, island crumble, whole-target
 * collapse) — mark every candidate resting on it dirty and arm the settle
 * tick. destruction.ts calls this from damageTarget + the island timer.
 */
export function noteStructureCarve(world: WorldLike, nodeId: string): void {
  lastWorld = world
  const carved = entries.get(nodeId)
  if (!carved) return
  for (const id of dependentsOf([nodeId])) dirty.add(id)
  if (dirty.size > 0) scheduleTick(STRUCTURE_SETTLE_MS)
}

function scheduleTick(delayMs: number): void {
  if (tickTimer !== null) return
  tickTimer = setTimeout(() => {
    tickTimer = null
    runWave([...dirty], 0)
  }, delayMs)
}

/**
 * One cascade wave: probe the candidates, crumble the unsupported (cap
 * STRUCTURE_WAVE_CAP), then seed the fallers' dependents as the next wave
 * STRUCTURE_WAVE_MS later. Throttled / over-cap targets go back to `dirty`
 * for the next tick (dropped work is logged, never lost).
 */
function runWave(candidates: readonly string[], wave: number): void {
  const world = lastWorld
  if (!driver || !world) {
    dirty.clear()
    return
  }
  const targets = driver.targets()
  const fell: string[] = []
  let deferred = 0
  const t = now()
  for (const id of candidates) {
    dirty.delete(id)
    const entry = entries.get(id)
    if (!entry?.candidate) continue
    const target = targets.get(id)
    if (!target || target.grid.aliveCount === 0) continue
    const last = lastCheck.get(id)
    if (last !== undefined && t - last < STRUCTURE_TICK_MS) {
      dirty.add(id) // probed too recently — re-check next tick
      deferred++
      continue
    }
    if (fell.length >= STRUCTURE_WAVE_CAP) {
      dirty.add(id) // wave full — next tick picks it up
      deferred++
      continue
    }
    lastCheck.set(id, t)
    const ctx = { colliders: world.colliders, targets: () => targets.values() }
    if (!probeTargetSupport(target, ctx)) fell.push(id)
  }

  for (const id of fell) driver.collapse(id)

  if (deferred > 0) {
    console.warn(`[boots] structure: deferred ${deferred} support checks to the next tick`)
    scheduleTick(STRUCTURE_TICK_MS)
  }
  if (fell.length === 0) return
  const next = dependentsOf(fell)
  if (next.length === 0) return
  if (wave + 1 >= STRUCTURE_MAX_WAVES) {
    console.warn(
      `[boots] structure: wave cap reached — ${next.length} dependents wait for the next tick`,
    )
    for (const id of next) dirty.add(id)
    scheduleTick(STRUCTURE_TICK_MS)
    return
  }
  const timer = setTimeout(() => {
    waveTimers.delete(timer)
    runWave(next, wave + 1)
  }, STRUCTURE_WAVE_MS)
  waveTimers.add(timer)
}

/** Run the settle tick NOW (deterministic tests) — wave 0 executes
 * synchronously; later waves still stagger on STRUCTURE_WAVE_MS timers. */
export function runStructureTickNow(): void {
  if (tickTimer !== null) {
    clearTimeout(tickTimer)
    tickTimer = null
  }
  runWave([...dirty], 0)
}

/** True while a settle tick or a cascade wave is still scheduled. */
export function structurePendingWork(): boolean {
  return tickTimer !== null || waveTimers.size > 0 || dirty.size > 0
}

/** Forget one target (builder undo dropTarget). Dependents keep their dirty
 * flag if already set — the probe simply stops seeing the target. */
export function dropStructureTarget(nodeId: string): void {
  entries.delete(nodeId)
  dirty.delete(nodeId)
  lastCheck.delete(nodeId)
}

/** Session teardown — cancel timers, forget everything. */
export function resetStructure(): void {
  if (tickTimer !== null) {
    clearTimeout(tickTimer)
    tickTimer = null
  }
  for (const timer of waveTimers) clearTimeout(timer)
  waveTimers.clear()
  entries.clear()
  dirty.clear()
  lastCheck.clear()
  lastWorld = null
}
