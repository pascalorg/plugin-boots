'use client'

import { useFrame } from '@react-three/fiber'
import { memo, useEffect, useMemo, useRef } from 'react'
import type { Group } from 'three'
import { probeLandingY, shellFlags, useDestruction, type VoxelTarget } from './destruction'
import type { ShellData } from './shell'
import {
  pickDebrisFragments,
  ShellDebrisLayer,
  type ShellGeometryArrays,
  spawnShellDebris,
} from './shell-debris'
import {
  drainShellRemovals,
  ShellMesh,
  type ShellLive,
  type ShellRemovalBatch,
} from './shell-render'
import { gridFrameToWorld, rotateByBasisInverse, type VoxelGridData } from './voxel'
import { coreThicknessAxis } from './voxel-walls'
import type { GameWorld } from './world'

/**
 * Shell S0 — the mounting layer (milestone 4): one positioned group per
 * shelled target, rendering the conforming shell mesh in the target's
 * SHELL frame, plus ONE world-frame debris pool for the whole session.
 *
 * FRAME DECISION (the one coherent choice, everything else follows):
 *
 *   - The SHELL MESH renders shell-frame geometry (grid frame, origin at
 *     zero — shell.ts packs it that way) inside a group transformed by
 *     gridFrameToWorld(grid) (voxel.ts): world = q⁻¹ ⊗ (p + origin).
 *   - DEBRIS is WORLD-frame: the pooled ShellDebrisLayer is a module
 *     singleton (one slots array for the whole session), so it cannot be
 *     parented per target — it mounts ONCE at identity, and every spawn
 *     hands it WORLD-frame vertex copies (worldShellArrays, built lazily
 *     on a target's first carve and cached for the session), a world
 *     carve point (the mean of the carve's dead voxel centers —
 *     grid.centers ARE world-space), and a world floor from
 *     probeLandingY. Chips therefore spawn exactly on the wall surface
 *     and fall along world −Y whatever the wall's yaw.
 *
 * DRAIN OWNERSHIP (resolves the shell-render.tsx milestone-2 note):
 * voxel-walls.tsx owns target.removedQueue (it drains AND clears it).
 * The shell lane never touches it — each ShellTargetLayer detects carves
 * by a revision-gated diff of grid.alive against its own seen-copy
 * (diffNewlyDead), so frame ordering against the core drain can never
 * lose removals. The newly dead voxels map to LATTICE keys — plus the
 * voxel-less cavity cells of the same thickness column (deadLatticeKeys):
 * edge-face fragments (wall tops, jamb reveals) live on lattice cells
 * dropInteriorCells never kept as voxels, and they detach when either
 * skin of their column is carved instead of floating forever. The keys
 * feed BOTH consumers: a wrapper-owned ShellLive queue for <ShellMesh/>
 * (its killed-flags dedupe re-reads for free) and this layer's own
 * drainShellRemovals bookkeeping for the debris picks.
 *
 * The wrapper's frame callback runs at priority −1 — before the default
 * subscribers, so the ShellMesh carve and the debris bind land in the
 * SAME frame as the core voxel removal (negative priorities keep R3F's
 * auto-render, unlike positive ones). Correctness never depends on it:
 * a mis-ordered frame just delivers one frame late.
 */

// ─── Pure helpers (headless-tested) ──────────────────────────────────────

/**
 * Newly dead voxels since the last look: every index whose seen-copy says
 * alive but the live grid says dead. Marks them seen and returns them.
 * `seen` starts ALL-ONES at mount so carves that landed between voxelize
 * and the React mount (first-hit voxelize + carve in one tick) still
 * surface on the first frame. Zero allocations with a reused `out`.
 */
export function diffNewlyDead(
  alive: Uint8Array,
  seen: Uint8Array,
  out: number[] = [],
): number[] {
  out.length = 0
  for (let i = 0; i < alive.length; i++) {
    if (seen[i] !== 0 && alive[i] === 0) {
      seen[i] = 0
      out.push(i)
    }
  }
  return out
}

/**
 * Dead voxel indices → LATTICE keys (ix + nx·(iy + ny·iz) — the
 * fragmentForCell indexing), each expanded along the THICKNESS axis into
 * the adjacent voxel-less cavity cells of its column. Why: shell fragments
 * on edge faces (wall top/bottom/side faces, opening reveals) sit on
 * lattice cells dropInteriorCells dropped — no voxel can ever die there —
 * so they are declared dead with the first skin voxel of their column.
 * The walk stops at any cell grid.index knows (a REAL voxel, dead or
 * alive, owns its own fate). Duplicate keys are fine — every consumer
 * dedupes through killed flags.
 */
export function deadLatticeKeys(
  grid: VoxelGridData,
  deadVoxels: readonly number[],
  out: number[] = [],
): number[] {
  out.length = 0
  const { nx, ny, nz, coords, index } = grid
  const axis = coreThicknessAxis(grid)
  const span = axis === 0 ? nx : axis === 1 ? ny : nz
  const stride = axis === 0 ? 1 : axis === 1 ? nx : nx * ny
  for (const i of deadVoxels) {
    const ix = coords[i * 3]!
    const iy = coords[i * 3 + 1]!
    const iz = coords[i * 3 + 2]!
    const key = ix + nx * (iy + ny * iz)
    out.push(key)
    const c = axis === 0 ? ix : axis === 1 ? iy : iz
    for (let step = 1; c + step < span; step++) {
      const neighbor = key + stride * step
      if (index.has(neighbor)) break
      out.push(neighbor)
    }
    for (let step = 1; c - step >= 0; step++) {
      const neighbor = key - stride * step
      if (index.has(neighbor)) break
      out.push(neighbor)
    }
  }
  return out
}

/** Module scratch for latticeCellWorldCenter — single-threaded, fully
 * overwritten by rotateByBasisInverse on every call. */
const latticeVec = { x: 0, y: 0, z: 0 }

/** World-space center of a LATTICE cell (which may carry no voxel — edge
 * fragments live on such cells): the geometric cell center pushed through
 * the grid→world transform. Writes into `out` (like its voxel.ts siblings)
 * so the per-carve debris pick allocates nothing. */
export function latticeCellWorldCenter(
  grid: VoxelGridData,
  cell: number,
  out: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  const ix = cell % grid.nx
  const iy = Math.floor(cell / grid.nx) % grid.ny
  const iz = Math.floor(cell / (grid.nx * grid.ny))
  rotateByBasisInverse(
    grid.q,
    grid.origin.x + (ix + 0.5) * grid.cellX,
    grid.origin.y + (iy + 0.5) * grid.cellY,
    grid.origin.z + (iz + 0.5) * grid.cellZ,
    latticeVec,
  )
  out[0] = latticeVec.x
  out[1] = latticeVec.y
  out[2] = latticeVec.z
  return out
}

/**
 * WORLD-frame copies of a shell's vertex arrays for the debris pool (see
 * the frame decision in the module doc): positions through the full
 * grid→world transform, normals through the rotation only, uvs SHARED
 * (frame-free). One copy per shelled target, built lazily on its first
 * carve — bounded by SHELL_TRI_CAP and freed with the session.
 */
export function worldShellArrays(
  shell: ShellData,
  grid: { origin: { x: number; y: number; z: number }; q: VoxelGridData['q'] },
): ShellGeometryArrays {
  const positions = new Float32Array(shell.positions.length)
  const normals = new Float32Array(shell.normals.length)
  const v = { x: 0, y: 0, z: 0 }
  for (let i = 0; i < shell.positions.length; i += 3) {
    rotateByBasisInverse(
      grid.q,
      shell.positions[i]! + grid.origin.x,
      shell.positions[i + 1]! + grid.origin.y,
      shell.positions[i + 2]! + grid.origin.z,
      v,
    )
    positions[i] = v.x
    positions[i + 1] = v.y
    positions[i + 2] = v.z
    rotateByBasisInverse(grid.q, shell.normals[i]!, shell.normals[i + 1]!, shell.normals[i + 2]!, v)
    normals[i] = v.x
    normals[i + 1] = v.y
    normals[i + 2] = v.z
  }
  return { positions, normals, uvs: shell.uvs }
}

/** Fragments with at least one DEAD voxel-backed cell — the headless
 * census fallback (voxel-less edge cells can't testify; the live session
 * census reads the wrappers' killed flags instead, which include them). */
export function countDeadFragments(shell: ShellData, grid: VoxelGridData): number {
  let dead = 0
  for (const cells of shell.cellsOfFragment) {
    for (const cell of cells) {
      const idx = grid.index.get(cell)
      if (idx !== undefined && grid.alive[idx] === 0) {
        dead++
        break
      }
    }
  }
  return dead
}

// ─── Census (the __boots.shell() handle) ─────────────────────────────────

/** Live wrappers' killed flags, keyed by nodeId — the census prefers these
 * (they carry the voxel-less edge-fragment deaths the fallback can't see). */
const shellKillRegistry = new Map<string, Uint8Array>()

/** QA census: shelled-target count, total fragments, fragments killed.
 * `enabled` reports the LIVE flag (the session may be latched differently
 * — targets with shells tell the latched truth). Plain data only. */
export function shellCensus(): {
  enabled: boolean
  targets: number
  fragments: number
  killed: number
} {
  let targets = 0
  let fragments = 0
  let killed = 0
  for (const target of useDestruction.getState().targets.values()) {
    const shell = target.shell
    if (!shell) continue
    targets++
    fragments += shell.fragments.length
    const flags = shellKillRegistry.get(target.nodeId)
    if (flags) {
      for (let i = 0; i < flags.length; i++) if (flags[i] !== 0) killed++
    } else {
      killed += countDeadFragments(shell, target.grid)
    }
  }
  return { enabled: shellFlags.wall, targets, fragments, killed }
}

// ─── Components ──────────────────────────────────────────────────────────

const DEBRIS_PICK_CAP = 8

/** memo for the same reason as VoxelWallMesh: store bumps re-render the
 * layer (membership), but each target object is stable — all its updates
 * are mutations drained in useFrame. */
const ShellTargetLayer = memo(function ShellTargetLayer({
  target,
  world,
}: {
  target: VoxelTarget
  world: GameWorld
}) {
  const shell = target.shell!
  const groupRef = useRef<Group>(null!)
  // Wrapper-owned live state for <ShellMesh/> — its queue carries LATTICE
  // keys (fragmentForCell indexing), never target.removedQueue's voxel
  // indices, and never competes with voxel-walls' destructive drain.
  const liveRef = useRef<ShellLive>({
    dormant: target.dormant === true,
    removedQueue: [],
    revision: 0,
  })
  const revisionSeen = useRef(Number.NaN)
  // ALL-ONES so pre-mount carves (first-hit voxelize) diff on frame one.
  const aliveSeen = useRef<Uint8Array>(new Uint8Array(target.grid.count).fill(1))
  const killed = useRef<Uint8Array>(new Uint8Array(shell.fragments.length))
  const deadScratch = useRef<number[]>([])
  const keysScratch = useRef<number[]>([])
  const batchScratch = useRef<ShellRemovalBatch>({ fragments: [] })
  const worldArraysRef = useRef<ShellGeometryArrays | null>(null)

  // Census registration: the wrapper's killed flags include the voxel-less
  // edge fragments the headless fallback can't count.
  useEffect(() => {
    shellKillRegistry.set(target.nodeId, killed.current)
    return () => {
      shellKillRegistry.delete(target.nodeId)
    }
  }, [target])

  const transform = useMemo(() => gridFrameToWorld(target.grid), [target])

  // Hoisted once per target (not rebuilt per carve): the debris pick's cell
  // lookup, reusing one tuple — pickDebrisFragments reads the components
  // immediately, so the shared scratch is safe.
  const cellCenters = useMemo(() => {
    const out: [number, number, number] = [0, 0, 0]
    return (cell: number) => latticeCellWorldCenter(target.grid, cell, out)
  }, [target])

  // Priority −1: run BEFORE the default-frame consumers (ShellMesh, the
  // debris binds, voxel-walls) so a carve's shell death + chip spawn land
  // in the same frame as its core removal — see the module doc.
  useFrame(() => {
    const group = groupRef.current
    if (!group) return
    // Full-demolition backstop: with every voxel dead the whole group goes
    // (edge fragments whose columns were never re-carved included).
    const visible = target.grid.aliveCount > 0
    if (group.visible !== visible) group.visible = visible
    const live = liveRef.current
    const dormant = target.dormant === true
    if (live.dormant !== dormant) live.dormant = dormant
    if (dormant) return
    if (revisionSeen.current === target.revision) return
    revisionSeen.current = target.revision
    const dead = diffNewlyDead(target.grid.alive, aliveSeen.current, deadScratch.current)
    if (dead.length === 0) return
    // World carve point: mean of the dead voxels' (world-space) centers.
    const centers = target.grid.centers
    let cx = 0
    let cy = 0
    let cz = 0
    for (const i of dead) {
      cx += centers[i * 3]!
      cy += centers[i * 3 + 1]!
      cz += centers[i * 3 + 2]!
    }
    cx /= dead.length
    cy /= dead.length
    cz /= dead.length
    const keys = deadLatticeKeys(target.grid, dead, keysScratch.current)
    // Feed the shell carve (ShellMesh drains by revision, dedupes re-reads).
    live.removedQueue.length = 0
    for (const key of keys) live.removedQueue.push(key)
    live.revision++
    // Debris: our own killed bookkeeping names the newly dead fragments;
    // the nearest ≤ cap become world-frame chips (the rest just vanish —
    // the core's regular debris/dust already reads the overflow).
    const batch = drainShellRemovals(shell, keys, killed.current, batchScratch.current)
    if (batch.fragments.length === 0) return
    const arrays = (worldArraysRef.current ??= worldShellArrays(shell, target.grid))
    const picked = pickDebrisFragments(
      batch.fragments,
      shell,
      [cx, cy, cz],
      cellCenters,
      DEBRIS_PICK_CAP,
    )
    const floorY = probeLandingY(world, cx, cy, cz)
    spawnShellDebris(arrays, shell, picked, target.shellMaterials ?? [], [cx, cy, cz], floorY)
  }, -1)

  return (
    <group
      position={[transform.position.x, transform.position.y, transform.position.z]}
      quaternion={[
        transform.quaternion.x,
        transform.quaternion.y,
        transform.quaternion.z,
        transform.quaternion.w,
      ]}
      ref={groupRef}
      userData={{ __boots: true }}
    >
      <ShellMesh live={liveRef.current} materials={target.shellMaterials ?? []} shell={shell} />
    </group>
  )
})

/**
 * Mount ONE per session, a sibling of <VoxelWalls/> (game-root): one
 * positioned wrapper per shelled target plus the single world-frame
 * debris pool. Renders nothing while no target carries a shell — the
 * usual case (shellFlags.wall defaults OFF).
 */
export function ShellLayer({ world }: { world: GameWorld }) {
  const version = useDestruction((s) => s.version)
  const shelled = useMemo(() => {
    void version
    const out: VoxelTarget[] = []
    for (const target of useDestruction.getState().targets.values()) {
      if (target.shell) out.push(target)
    }
    return out
  }, [version])
  if (shelled.length === 0) return null
  return (
    <group userData={{ __boots: true }}>
      {shelled.map((target) => (
        <ShellTargetLayer key={target.nodeId} target={target} world={world} />
      ))}
      <ShellDebrisLayer />
    </group>
  )
}
