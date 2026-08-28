'use client'

import { useFrame, useThree } from '@react-three/fiber'
import { memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import {
  BoxGeometry,
  Color,
  DynamicDrawUsage,
  type Group,
  type InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three'
import { useDestruction, type VoxelTarget } from './destruction'
import { perfSection } from './perf-monitor'
import { type RoofToneRenderer, setRoofTextureRenderer } from './roof-planes'
import { primedCellColor } from './skin-tone'

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

/** One pending dormant prime. `primed` doubles as the unmount tombstone. */
export type DormantPrimeEntry = { primed: boolean; prime: () => void }

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
 * Tombstoned/woken entries drop for free (never counted against budget). */
export function drainDormantPrimes(budget = DORMANT_PRIME_PER_FRAME): number {
  let primed = 0
  while (primeQueue.length > 0 && primed < budget) {
    const entry = primeQueue.shift()!
    if (entry.primed) continue
    entry.primed = true
    entry.prime()
    primed++
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

const _matrix = new Matrix4()
const _pos = new Vector3()
const _scale = new Vector3()
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

// Shared render resources — every layer of every replica is configuration-
// identical per layer type (all per-instance variation rides instanceMatrix
// + instanceColor; paint gates ride mesh.userData), so one geometry and one
// material per layer serve the whole house instead of 3N fresh objects.
// Passed via `args`, so R3F never auto-disposes them on unmount; they live
// for the module (the dust-texture idiom).
const VOXEL_GEOMETRY = new BoxGeometry()
const SKIN_MATERIAL = new MeshStandardMaterial({ roughness: 0.92 })
const BOARD_MATERIAL = new MeshStandardMaterial({ roughness: 0.95 })
const WOOD_MATERIAL = new MeshStandardMaterial({ roughness: 0.85 })

function isGone(m: SandwichMember): boolean {
  return m.broken === true || m.torn === true
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

/** Write every member's matrix + color. Gone members get the zero matrix. */
function uploadLayer(
  mesh: InstancedMesh,
  members: SandwichMember[],
  base: Color,
  damaged: Color,
  jitter: number,
  inset: number,
  pinch: boolean,
  maxHp: number,
): void {
  for (let i = 0; i < members.length; i++) {
    const m = members[i]!
    if (isGone(m)) {
      mesh.setMatrixAt(i, ZERO)
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
    if (m.pitch) {
      // Pitched roof member: local→world = Ry(−yaw)·Rz(pitch).
      _quat.setFromAxisAngle(UP, -m.yaw).multiply(_qz.setFromAxisAngle(Z_AXIS, m.pitch))
    } else if (m.yaw === 0) _quat.identity()
    else _quat.setFromAxisAngle(UP, -m.yaw)
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
}

/** One sandwich layer (boards or segments) as a single InstancedMesh. */
function MemberLayer({
  members,
  base,
  damaged,
  jitter,
  inset,
  pinch,
  material,
}: {
  members: SandwichMember[]
  base: Color
  damaged: Color
  jitter: number
  inset: number
  pinch: boolean
  material: MeshStandardMaterial
}) {
  const meshRef = useRef<InstancedMesh>(null!)
  const checksum = useRef(Number.NaN)
  const maxHp = useRef(1)

  useLayoutEffect(() => {
    const mesh = meshRef.current
    mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    mesh.frustumCulled = false
    // Full hp = the healthiest member at voxelize time (fresh members are
    // all at max; robust even if we mount mid-fight).
    let max = 1
    for (const m of members) if ((m.hp ?? 1) > max) max = m.hp ?? 1
    maxHp.current = max
    uploadLayer(mesh, members, base, damaged, jitter, inset, pinch, max)
    checksum.current = layerChecksum(members)
  }, [members, base, damaged, jitter, inset, pinch])

  useFrame(() => {
    const mesh = meshRef.current
    if (!mesh) return
    // Dormant replica (parent group hidden — the wake IS the visibility
    // flip, done by the parent's earlier-registered useFrame in this same
    // frame): members BY CONTRACT can't change while dormant (damage paths
    // always wake first), so skip the O(members) checksum entirely.
    if (mesh.parent && mesh.parent.visible === false) return
    // Chips (hp loss without break) never bump revision, so poll the cheap
    // checksum every frame and re-upload the whole small layer on change.
    const h = layerChecksum(members)
    if (h === checksum.current) return
    checksum.current = h
    uploadLayer(mesh, members, base, damaged, jitter, inset, pinch, maxHp.current)
  })

  return <instancedMesh args={[VOXEL_GEOMETRY, material, members.length]} ref={meshRef} />
}

/** Prime (or re-prime) the skin layer's matrices + colors from the grid.
 * Runs on mount and again whenever `skinRevision` bumps (async roof tone).
 * Clears the mesh's paint gates afterwards so drainPaintTints re-applies
 * any painted cells on top — the paint LEDGER's serials never move. */
function primeSkin(mesh: InstancedMesh, wall: VoxelTarget): void {
  const { grid } = wall
  // Per-axis scale with a 1.5% inset: anisotropic wall grids have thin
  // skin cells along the thickness axis (a uniform grid.cell cube would
  // visually fill the cavity), and the inset keeps each cube's face from
  // merging with its neighbors — the clean "block" read walls now wear
  // from session start.
  _scale.set(grid.cellX * 0.985, grid.cellY * 0.985, grid.cellZ * 0.985)
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
  for (let i = 0; i < grid.count; i++) {
    if (grid.alive[i]) {
      _pos.set(grid.centers[i * 3]!, grid.centers[i * 3 + 1]!, grid.centers[i * 3 + 2]!)
      _matrix.compose(_pos, _quat, _scale)
      mesh.setMatrixAt(i, _matrix)
    } else {
      mesh.setMatrixAt(i, ZERO)
    }
    // Shared per-cell prime tone (skin-tone.ts) — paint.tsx feathers coats
    // up from exactly this color, so the two must never drift.
    mesh.setColorAt(i, primedCellColor(_color, wall, i))
  }
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  // Paint gate reset (paint.tsx drainPaintTints): the wholesale color prime
  // just overwrote any painted cells — dropping the mesh-side gates makes
  // the next drain re-coat them from the ledger (serials stay intact).
  mesh.userData.__bootsPaintSerial = undefined
  mesh.userData.__bootsPaintTarget = undefined
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
  const warmDraw = useRef(0)
  const primeEntry = useRef<DormantPrimeEntry>(null!)
  const sandwich = wall as SandwichTarget
  const boards = sandwich.boards
  // Until destruction-core lands `segments`, the studs render as the wood
  // layer — same member shape, same single-draw-call path.
  const segments =
    sandwich.segments && sandwich.segments.length > 0 ? sandwich.segments : wall.studs

  useLayoutEffect(() => {
    const mesh = meshRef.current
    mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    mesh.frustumCulled = false
    // Awake targets prime here, at mount, like always. DORMANT prebuilds
    // stay hidden with identity matrices and prime through the budgeted
    // queue (or on their wake, whichever comes first) — the mount itself is
    // already spread across session-start frames by the Prevoxelize budget.
    const entry: DormantPrimeEntry = {
      primed: false,
      prime: () => {
        primeSkin(mesh, wall)
        // primeSkin reads grid.alive directly, so removals queued while the
        // prime waited are already baked in — sync counters, drop the queue.
        revision.current = wall.revision
        skinRevision.current = wall.skinRevision ?? 0
        wall.removedQueue.length = 0
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
            group.position.y -= WARM_DRAW_DROP
            // 2, not 1: the drain (parent useFrame) may run BEFORE this
            // replica's own useFrame in the same frame — a 1-frame latch
            // would restore + re-hide before anything ever drew.
            warmDraw.current = 2
            perfSection('warm-draw-armed', 0)
          }
        }
      },
    }
    primeEntry.current = entry
    revision.current = wall.revision
    skinRevision.current = wall.skinRevision ?? 0
    if (wall.dormant) queueDormantPrime(entry)
    else primeDormantNow(entry)
    return () => {
      entry.primed = true // tombstone — the drain skips unmounted replicas
    }
  }, [wall])

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
      group.position.y += WARM_DRAW_DROP
      perfSection('warm-draw-done', 0)
    }
    // Wake = visibility flip (+ an on-the-spot prime if the budgeted queue
    // hadn't reached this target). While dormant nothing below can change:
    // damage paths always wake first, so revision/skin drains wait here.
    if (!syncDormantWallFrame(group, wall, primeEntry.current)) return
    if (revision.current !== wall.revision) {
      revision.current = wall.revision
      const queue = wall.removedQueue
      for (let i = 0; i < queue.length; i++) mesh.setMatrixAt(queue[i]!, ZERO)
      queue.length = 0
      mesh.instanceMatrix.needsUpdate = true
    }
    // Async skin tone landed (roof shingle GPU readback — destruction.ts
    // bumps skinRevision after retinting baseColor): re-prime the whole
    // layer once. Idles at one number compare per target per frame.
    if (skinRevision.current !== (wall.skinRevision ?? 0)) {
      skinRevision.current = wall.skinRevision ?? 0
      primeSkin(mesh, wall)
    }
  })

  return (
    <group ref={groupRef} userData={{ __boots: true }} visible={!wall.dormant}>
      <instancedMesh args={[VOXEL_GEOMETRY, SKIN_MATERIAL, wall.grid.count]} ref={meshRef} />
      {boards && boards.length > 0 && (
        <MemberLayer
          base={BOARD_BASE}
          damaged={BOARD_DAMAGED}
          inset={0.99}
          jitter={0.05}
          material={BOARD_MATERIAL}
          members={boards}
          pinch={false}
        />
      )}
      {segments.length > 0 && (
        <MemberLayer
          base={WOOD_BASE}
          damaged={WOOD_DAMAGED}
          inset={0.99}
          jitter={0.1}
          material={WOOD_MATERIAL}
          members={segments}
          pinch={true}
        />
      )}
    </group>
  )
})

export function VoxelWalls() {
  const version = useDestruction((s) => s.version)
  // Roof skin tone rig (roof-planes.ts): the async shingle-tone readback
  // needs the LIVE renderer — register it for the session, clear on unmount.
  const gl = useThree((s) => s.gl)
  useEffect(() => {
    setRoofTextureRenderer(gl as unknown as RoofToneRenderer)
    return () => {
      setRoofTextureRenderer(null)
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
