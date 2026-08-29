'use client'

import { useFrame } from '@react-three/fiber'
import { useLayoutEffect, useRef } from 'react'
import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  Group,
  type Material,
  Mesh,
  MeshBasicMaterial,
} from 'three'
import type { ShellData } from './shell'

/**
 * Shell S0 — pooled fragment debris (real surface pieces tumble off).
 *
 * When the shell carve (shell-render.tsx) kills fragments, the N nearest
 * dead fragments to the carve point become short-lived TUMBLING MESHES that
 * carry the REAL textured surface piece: each pooled slot's geometry
 * re-indexes the shared shell vertex arrays with the dead fragment's own
 * index block, so the chip flying off is pixel-identical to the piece that
 * just went degenerate in the shell. Ballistics are hand-rolled and mirror
 * debris.tsx: gravity 14, one damped ground bounce (restitution 0.3), then
 * sliding friction; shrink-out over the last 15% of life (SCALE, not
 * opacity — the host materials are not ours to make transparent).
 *
 * SESSION-LIFETIME CONTRACT
 *   - `materials` are HOST material instances passed BY REFERENCE (the
 *     exact instances the shell renders with, so a chip matches the wall
 *     it broke from). Never mutate, clone or dispose them.
 *   - The pool is BOUNDED: SHELL_DEBRIS_CAP slots; a spawn past the cap
 *     evicts the live slot closest to expiry (lowest ttl, lowest index on
 *     ties). Idle frames cost one number compare — no allocation.
 *   - Session teardown disposes the per-slot geometries ONLY, plus one
 *     module-owned placeholder material. The wrapped Float32Arrays belong
 *     to the shell and are never touched.
 *
 * ATTRIBUTE OWNERSHIP — why each slot gets its OWN BufferAttribute objects:
 * three deallocates GPU buffers PER ATTRIBUTE on geometry.dispose(), so if
 * slot geometries shared the ShellMesh's attribute instances, disposing one
 * slot would yank the live shell's vertex buffers. Instead every slot's
 * geometry wraps the SAME shell Float32Arrays in FRESH BufferAttribute
 * objects (cheap — no array copy) plus its OWN preallocated Uint32Array
 * index, so per-slot disposal is safe by construction. Documented cost:
 * each bound slot uploads its own GPU copy of the shell vertex data —
 * bounded by the pool cap and freed at session teardown.
 *
 * FRAME CONVENTION: shell positions are TARGET-LOCAL (grid frame), so slot
 * pivots animate in grid space and the layer's group renders at identity.
 * Milestone 4 (game-root wiring) parents <ShellDebrisLayer/> under the
 * target's positioned root so the pieces fly off at the building's world
 * pose; `floorY` and `carvePoint` are given in that same grid frame.
 *
 * TUMBLE PIVOT: a fragment's vertices sit far from the grid origin, so a
 * naive mesh rotation would swing it in a huge orbit. Each slot is a
 * two-node chain — pivot Group (animated: position/rotation/scale) holding
 * the Mesh offset by −centroid — so the piece spins and shrinks about its
 * own center, and at spawn (pivot at +centroid, rotation 0) its world
 * transform is EXACTLY identity: the chip starts precisely where the shell
 * surface was.
 */

// ─── Pure core ───────────────────────────────────────────────────────────

export const SHELL_DEBRIS_CAP = 20
/** Ballistics — same numbers as debris.tsx cube chunks. */
export const SHELL_DEBRIS_GRAVITY = 14
export const SHELL_DEBRIS_RESTITUTION = 0.3
/** Horizontal damp on the one bounce / sliding friction after it. */
const BOUNCE_DAMP = 0.75
const FRICTION_DAMP = 0.7
/** Fraction of ttl0 over which a dying piece shrinks to nothing. */
export const SHELL_DEBRIS_SHRINK = 0.15
/** Chips settle this far above the caller's floor plane (half-height-ish). */
export const SHELL_DEBRIS_REST = 0.05
/** Launch bands (debris.tsx-calibrated): outward 2.0–3.5 + 1.2–2.2 up. */
const SPEED_MIN = 2.0
const SPEED_SPAN = 1.5
const UP_MIN = 1.2
const UP_SPAN = 1.0
/** Life band 2.5–3.2 s; tumble rate band mirrors debris.tsx cube spin. */
const TTL_MIN = 2.5
const TTL_SPAN = 0.7
const SPIN = 9

/**
 * The ≤cap newly dead fragments whose FIRST cell's center is nearest the
 * carve point (squared distance; deterministic ties by fragment id). The
 * shell carries no cell centers, so the caller passes a `cellCenters`
 * lookup (grid-frame, same space as carvePoint). Fragments without cells
 * are skipped.
 */
export function pickDebrisFragments(
  newlyDead: number[],
  shell: ShellData,
  carvePoint: readonly [number, number, number],
  cellCenters: (cell: number) => [number, number, number],
  cap = 8,
): number[] {
  const scored: { fragment: number; d2: number }[] = []
  for (const fragment of newlyDead) {
    const cells = shell.cellsOfFragment[fragment]
    if (!cells || cells.length === 0) continue
    const center = cellCenters(cells[0]!)
    const dx = center[0] - carvePoint[0]
    const dy = center[1] - carvePoint[1]
    const dz = center[2] - carvePoint[2]
    scored.push({ fragment, d2: dx * dx + dy * dy + dz * dz })
  }
  scored.sort((a, b) => a.d2 - b.d2 || a.fragment - b.fragment)
  if (scored.length > cap) scored.length = Math.max(0, cap)
  return scored.map((s) => s.fragment)
}

/**
 * Copy one fragment's contiguous index block from the PRISTINE shell.index
 * into `out` (caller-preallocated at the max fragment index count) and
 * return the count. Unknown fragments copy nothing and return 0.
 */
export function fragmentIndexSlice(shell: ShellData, fragment: number, out: Uint32Array): number {
  const range = shell.fragments[fragment]
  if (!range) return 0
  out.set(shell.index.subarray(range.indexStart, range.indexStart + range.indexCount))
  return range.indexCount
}

/**
 * The material slot a fragment renders with: shell groups are material-
 * major and every fragment sits inside exactly one group, so find the
 * group containing the fragment's indexStart. Falls back to 0.
 */
export function fragmentMaterialIndex(shell: ShellData, fragment: number): number {
  const range = shell.fragments[fragment]
  if (!range) return 0
  for (const group of shell.groups) {
    if (range.indexStart >= group.start && range.indexStart < group.start + group.count) {
      return group.materialIndex
    }
  }
  return 0
}

/** The physics half of a slot — a plain mutable record so stepDebris stays
 * pure and headless-testable. Positions/velocities are grid-frame. */
export type ShellDebrisBody = {
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
  /** Rest plane for the pivot (floor + SHELL_DEBRIS_REST, set at spawn). */
  floorY: number
  ttl: number
  ttl0: number
  bounced: boolean
}

/**
 * One pure physics step, ZERO allocations: ttl countdown (expiry kills the
 * slot), gravity, position/spin integration, then the debris.tsx ground
 * contact — one damped bounce (restitution 0.3, horizontal ×0.75), and
 * sliding friction (vy pinned to 0, horizontal ×0.7) on every contact
 * after it. Returns whether the slot is still alive.
 */
export function stepDebris(slot: ShellDebrisBody, dt: number): boolean {
  if (!slot.alive) return false
  slot.ttl -= dt
  if (slot.ttl <= 0) {
    slot.alive = false
    return false
  }
  slot.vy -= SHELL_DEBRIS_GRAVITY * dt
  slot.px += slot.vx * dt
  slot.py += slot.vy * dt
  slot.pz += slot.vz * dt
  slot.rx += slot.wx * dt
  slot.ry += slot.wy * dt
  slot.rz += slot.wz * dt
  if (slot.py < slot.floorY && slot.vy < 0) {
    slot.py = slot.floorY
    if (slot.bounced) {
      slot.vy = 0
      slot.vx *= FRICTION_DAMP
      slot.vz *= FRICTION_DAMP
    } else {
      slot.vy = -slot.vy * SHELL_DEBRIS_RESTITUTION
      slot.vx *= BOUNCE_DAMP
      slot.vz *= BOUNCE_DAMP
      slot.bounced = true
    }
  }
  return true
}

/** Uniform draw scale for a piece: 1 through life, linear to 0 over the
 * last SHELL_DEBRIS_SHRINK fraction of ttl0 (shrink-out, not fade-out). */
export function shellDebrisScale(ttl: number, ttl0: number): number {
  if (!(ttl0 > 0)) return 0
  const s = ttl / (ttl0 * SHELL_DEBRIS_SHRINK)
  return s > 1 ? 1 : s < 0 ? 0 : s
}

/**
 * Claim a pool slot: the first free one, else evict the live slot closest
 * to expiry (lowest ttl; deterministic ties by lowest index). Pure over
 * any {alive, ttl} array so the policy is testable without the pool.
 */
export function claimSlot(slots: readonly { alive: boolean; ttl: number }[]): number {
  let evict = 0
  let evictTtl = Number.POSITIVE_INFINITY
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i]!
    if (!s.alive) return i
    if (s.ttl < evictTtl) {
      evictTtl = s.ttl
      evict = i
    }
  }
  return evict
}

// ─── Pool ────────────────────────────────────────────────────────────────

/** The shared shell vertex arrays a slot geometry wraps (from ShellData —
 * the same objects the ShellMesh attributes wrap; never mutated). */
export type ShellGeometryArrays = {
  positions: Float32Array
  normals: Float32Array
  uvs: Float32Array
}

/** One pool slot: the pure body plus render bindings the component applies
 * lazily (`dirty`). `indices` is the slot-OWNED index storage (grow-only);
 * the slot geometry's index attribute wraps it directly. */
export type ShellDebrisSlot = ShellDebrisBody & {
  fragment: number
  /** Indices in use this life (drawRange; `indices` may be longer). */
  count: number
  /** Spawn centroid — the tumble pivot (mesh offset = −centroid). */
  cx: number
  cy: number
  cz: number
  material: Material | null
  arrays: ShellGeometryArrays | null
  indices: Uint32Array
  /** Geometry (re)bind pending — set by spawn, cleared by the layer. */
  dirty: boolean
}

const makeSlot = (): ShellDebrisSlot => ({
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
  floorY: 0,
  ttl: 0,
  ttl0: 1,
  bounced: false,
  fragment: -1,
  count: 0,
  cx: 0,
  cy: 0,
  cz: 0,
  material: null,
  arrays: null,
  indices: new Uint32Array(0),
  dirty: false,
})

const slots: ShellDebrisSlot[] = Array.from({ length: SHELL_DEBRIS_CAP }, makeSlot)
let liveCount = 0

/**
 * Claim slots for the given (already picked, already dead) fragments and
 * launch them from the carve. Headless-safe: writes pool data only — the
 * mounted <ShellDebrisLayer/> binds geometry lazily via `dirty`. Per slot:
 *   - index block copied from the PRISTINE shell.index (the ShellMesh
 *     carves its own live copy, so the block here is still real geometry);
 *   - material resolved by group lookup (host instance, BY REFERENCE);
 *   - velocity = outward from carvePoint (unit, from the vertex centroid)
 *     × 2.0–3.5, plus a 1.2–2.2 vertical kick; degenerate outward
 *     directions fall back to a random horizontal heading;
 *   - rotation starts at ZERO — the chip begins exactly in the shell's
 *     surface pose — with a random tumble rate;
 *   - ttl 2.5–3.2 s, shrink-out over the last 15%.
 * All randomness comes from the caller's rng (deterministic in tests).
 */
export function spawnShellDebris(
  shellGeometryArrays: ShellGeometryArrays,
  shell: ShellData,
  fragments: number[],
  materials: Material[],
  carvePoint: readonly [number, number, number],
  floorY: number,
  rng: () => number = Math.random,
): void {
  for (const fragment of fragments) {
    const range = shell.fragments[fragment]
    if (!range || range.indexCount === 0) continue
    const i = claimSlot(slots)
    const slot = slots[i]!
    if (!slot.alive) liveCount++
    if (slot.indices.length < range.indexCount) slot.indices = new Uint32Array(range.indexCount)
    const count = fragmentIndexSlice(shell, fragment, slot.indices)
    // Vertex centroid over the block's referenced vertices — the shell
    // packs vertices unshared, so this is the plain mean of the piece.
    const positions = shellGeometryArrays.positions
    let cx = 0
    let cy = 0
    let cz = 0
    for (let k = 0; k < count; k++) {
      const v = slot.indices[k]! * 3
      cx += positions[v]!
      cy += positions[v + 1]!
      cz += positions[v + 2]!
    }
    cx /= count
    cy /= count
    cz /= count
    let ox = cx - carvePoint[0]
    let oy = cy - carvePoint[1]
    let oz = cz - carvePoint[2]
    const len = Math.sqrt(ox * ox + oy * oy + oz * oz)
    if (len > 1e-6) {
      ox /= len
      oy /= len
      oz /= len
    } else {
      const theta = rng() * Math.PI * 2
      ox = Math.cos(theta)
      oy = 0
      oz = Math.sin(theta)
    }
    const speed = SPEED_MIN + rng() * SPEED_SPAN
    slot.alive = true
    slot.fragment = fragment
    slot.count = count
    slot.cx = cx
    slot.cy = cy
    slot.cz = cz
    slot.px = cx
    slot.py = cy
    slot.pz = cz
    slot.vx = ox * speed
    slot.vy = oy * speed + UP_MIN + rng() * UP_SPAN
    slot.vz = oz * speed
    slot.rx = 0
    slot.ry = 0
    slot.rz = 0
    slot.wx = (rng() - 0.5) * SPIN
    slot.wy = (rng() - 0.5) * SPIN
    slot.wz = (rng() - 0.5) * SPIN
    slot.floorY = floorY + SHELL_DEBRIS_REST
    slot.ttl = TTL_MIN + rng() * TTL_SPAN
    slot.ttl0 = slot.ttl
    slot.bounced = false
    slot.material = materials[fragmentMaterialIndex(shell, fragment)] ?? materials[0] ?? null
    slot.arrays = shellGeometryArrays
    slot.dirty = true
  }
}

/** Session teardown / new-shell reset: drop every slot's life and its
 * references into the old shell (arrays + host material). Slot geometries
 * are the LAYER's to dispose — this only clears pool data. */
export function clearShellDebris(): void {
  for (const slot of slots) {
    slot.alive = false
    slot.dirty = false
    slot.material = null
    slot.arrays = null
  }
  liveCount = 0
}

/** Headless test probe — live piece count + mean CURRENT vertical velocity
 * (fresh spawns: their launch vy), mirroring debrisCensus. */
export function shellDebrisCensus(): { live: number; meanVy: number } {
  let live = 0
  let vy = 0
  for (const slot of slots) {
    if (!slot.alive) continue
    live++
    vy += slot.vy
  }
  return { live, meanVy: live > 0 ? vy / live : 0 }
}

// ─── Component ───────────────────────────────────────────────────────────

/**
 * (Re)bind one slot's geometry after a spawn. Vertex attributes are
 * replaced only when the wrapped arrays changed (new shell — fresh
 * BufferAttribute objects, OURS, wrapping the shared arrays; see the
 * ownership note in the module doc). The index attribute wraps the slot's
 * own Uint32Array; a grow re-allocates it, so bind re-reads identity off
 * the geometry every time (also the WebGPU rule from shell-render.tsx:
 * never trust a cached attribute array across frames) and otherwise
 * re-uploads just the used range.
 */
function bindSlot(slot: ShellDebrisSlot, mesh: Mesh): void {
  const geo = mesh.geometry
  const arrays = slot.arrays
  if (arrays) {
    const position = geo.getAttribute('position')
    if (!position || position.array !== arrays.positions) {
      geo.setAttribute('position', new BufferAttribute(arrays.positions, 3))
      geo.setAttribute('normal', new BufferAttribute(arrays.normals, 3))
      geo.setAttribute('uv', new BufferAttribute(arrays.uvs, 2))
    }
  }
  let index = geo.index
  if (!index || index.array !== slot.indices) {
    index = new BufferAttribute(slot.indices, 1)
    index.setUsage(DynamicDrawUsage)
    geo.setIndex(index)
  } else {
    index.addUpdateRange(0, slot.count)
    index.needsUpdate = true
  }
  geo.setDrawRange(0, slot.count)
  if (slot.material) mesh.material = slot.material
  // Tumble pivot: the mesh sits at −centroid inside its pivot group, so
  // pivot-at-centroid renders the untouched surface pose (identity world
  // transform at spawn) and rotation/scale act about the piece's center.
  mesh.position.set(-slot.cx, -slot.cy, -slot.cz)
  slot.dirty = false
}

/** Placeholder for never-yet-bound meshes — module-owned, disposed with
 * the layer. Host materials only ever ARRIVE by reference via bindSlot. */
let placeholderMaterial: MeshBasicMaterial | null = null

/**
 * Owns the pool's meshes and steps them. Mount ONE per game session,
 * inside the target's positioned root group (milestone 4 does that
 * parenting — everything here is grid-frame, so the layer itself renders
 * at identity). Spawning is decoupled: callers hit spawnShellDebris from
 * anywhere (even before this mounts — binds catch up on the next frame).
 */
export function ShellDebrisLayer() {
  const groupRef = useRef<Group>(null!)
  const pivotsRef = useRef<Group[] | null>(null)
  const meshesRef = useRef<Mesh[] | null>(null)
  const sweep = useRef(false)

  useLayoutEffect(() => {
    const group = groupRef.current
    const placeholder = (placeholderMaterial ??= new MeshBasicMaterial())
    const pivots: Group[] = []
    const meshes: Mesh[] = []
    for (let i = 0; i < SHELL_DEBRIS_CAP; i++) {
      const pivot = new Group()
      pivot.visible = false
      const mesh = new Mesh(new BufferGeometry(), placeholder)
      mesh.castShadow = true
      mesh.receiveShadow = true
      // No bounding volumes are ever computed for the ride-along geometry.
      mesh.frustumCulled = false
      pivot.add(mesh)
      group.add(pivot)
      pivots.push(pivot)
      meshes.push(mesh)
    }
    pivotsRef.current = pivots
    meshesRef.current = meshes
    return () => {
      clearShellDebris()
      for (let i = 0; i < pivots.length; i++) {
        group.remove(pivots[i]!)
        // OUR geometries, OUR attribute objects — safe to dispose; the
        // wrapped Float32Arrays are the shell's and survive untouched.
        meshes[i]!.geometry.dispose()
      }
      placeholderMaterial?.dispose()
      placeholderMaterial = null
      pivotsRef.current = null
      meshesRef.current = null
    }
  }, [])

  useFrame((_, rawDt) => {
    const pivots = pivotsRef.current
    const meshes = meshesRef.current
    if (!pivots || !meshes) return
    if (liveCount === 0) {
      // Idle = one number compare. `sweep` covers an external
      // clearShellDebris (session teardown) racing a visible pool.
      if (sweep.current) {
        for (const pivot of pivots) pivot.visible = false
        sweep.current = false
      }
      return
    }
    sweep.current = true
    const dt = Math.min(rawDt, 1 / 30)
    for (let i = 0; i < SHELL_DEBRIS_CAP; i++) {
      const slot = slots[i]!
      const pivot = pivots[i]!
      if (!slot.alive) {
        if (pivot.visible) pivot.visible = false
        continue
      }
      if (slot.dirty) bindSlot(slot, meshes[i]!)
      if (!stepDebris(slot, dt)) {
        liveCount--
        pivot.visible = false
        continue
      }
      if (!pivot.visible) pivot.visible = true
      pivot.position.set(slot.px, slot.py, slot.pz)
      pivot.rotation.set(slot.rx, slot.ry, slot.rz)
      pivot.scale.setScalar(shellDebrisScale(slot.ttl, slot.ttl0))
    }
  })

  return <group ref={groupRef} userData={{ __boots: true }} />
}
