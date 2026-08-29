'use client'

import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  type Material,
  type Mesh,
} from 'three'
import type { ShellData } from './shell'

/**
 * Shell S0 — the shell renderer (degenerate-index carve, partial uploads).
 *
 * One <mesh> per shell: the packed ShellData arrays from shell.ts upload
 * once as a multi-group BufferGeometry, and every fragment removal after
 * that is an IN-PLACE index edit — the fragment's contiguous index block is
 * overwritten with a single repeated vertex, turning all of its triangles
 * degenerate (zero area, culled by the rasterizer). No draw-call count
 * changes, no group shuffling, no re-pack: one small partial buffer upload
 * per killed fragment (addUpdateRange), which is why shell.ts packs each
 * fragment contiguously in the first place.
 *
 * SESSION-LIFETIME CONTRACT
 *   - `materials` are HOST material instances passed BY REFERENCE (the real
 *     editor materials, so the shell matches the building exactly). Never
 *     mutate, clone or dispose them — they outlive the session and other
 *     meshes render with them at the same time.
 *   - The geometry is OURS: built here from the shell arrays, disposed here
 *     on unmount. The vertex attributes reference shell's Float32Arrays
 *     directly (they never change), but the index is a fresh Uint32Array
 *     COPY — the live one gets carved in place, and shell.index must stay
 *     pristine so a rebuilt/remounted ShellMesh starts whole.
 *   - `live` is a mutable session object the caller owns; this component
 *     only reads it (see the drain note on `removedQueue` below).
 *
 * WEBGPU NOTE: after the first render the renderer may REPLACE an
 * attribute's backing array (e.g. index-format promotion or staging
 * copies). Never cache `index.array` across frames — always re-read
 * `mesh.geometry.index` (and its `.array`) inside the frame loop right
 * before writing, which is what the drain below does.
 *
 * DRAIN OWNERSHIP (this milestone): `live.removedQueue` is read
 * NON-DESTRUCTIVELY — the core voxel layer also consumes it, so this
 * component never clears or shifts it. New work is detected by
 * `live.revision` (`revisionSeen` gating: process only when the revision
 * moved since we last looked), and the caller-owned `killed` flags make
 * re-reading stale queue entries free (already-dead fragments dedupe out).
 * If another consumer clears the queue before our frame callback runs,
 * that revision's removals are missed — acceptable here because nothing
 * clears it yet; milestone 4 (game-root wiring) defines the single-drain
 * ownership for real.
 */

// ─── Pure core ───────────────────────────────────────────────────────────

/** A touched index range, in indices (BufferAttribute.addUpdateRange units). */
export type ShellIndexRange = { start: number; count: number }

/**
 * Carve one fragment out of a LIVE index array: overwrite its whole index
 * block with the block's first vertex (index[indexStart]), so every
 * triangle in the block references one vertex three times — degenerate,
 * zero area, invisible — while the buffer layout (groups, ranges, draw
 * calls) stays untouched. Returns the touched range for the partial upload.
 */
export function killFragmentIndices(
  index: Uint32Array,
  fragment: { indexStart: number; indexCount: number },
): ShellIndexRange {
  const { indexStart, indexCount } = fragment
  if (indexCount > 0) {
    const anchor = index[indexStart]!
    for (let i = indexStart + 1; i < indexStart + indexCount; i++) index[i] = anchor
  }
  return { start: indexStart, count: indexCount }
}

/** One drain's newly dead fragments + their index ranges (reusable scratch). */
export type ShellRemovalBatch = { fragments: number[]; ranges: ShellIndexRange[] }

/**
 * Map dead CELLS to newly dead FRAGMENTS. RULE: a fragment dies when ANY of
 * its cells dies (fragments are 1–6 cell chips — losing a cell means the
 * chip breaks free). Cells that carry no surface (fragmentForCell −1) are
 * skipped; fragments already flagged in the caller-owned `killed` array
 * dedupe out (this marks the new ones). Pure bookkeeping by design: it does
 * NOT touch any index array — the component applies each range via
 * killFragmentIndices, so tests cover both halves independently. Pass `out`
 * to reuse the batch arrays (its lengths reset every call).
 */
export function drainShellRemovals(
  shell: ShellData,
  deadCells: Iterable<number>,
  killed: Uint8Array,
  out: ShellRemovalBatch = { fragments: [], ranges: [] },
): ShellRemovalBatch {
  out.fragments.length = 0
  out.ranges.length = 0
  for (const cell of deadCells) {
    const fragment = shell.fragmentForCell[cell] ?? -1
    if (fragment < 0 || killed[fragment] !== 0) continue
    killed[fragment] = 1
    const range = shell.fragments[fragment]!
    out.fragments.push(fragment)
    out.ranges.push({ start: range.indexStart, count: range.indexCount })
  }
  return out
}

/** Fragments not yet killed — 0 means the whole shell is gone. */
export function aliveFragmentCount(killed: Uint8Array): number {
  let alive = 0
  for (let i = 0; i < killed.length; i++) {
    if (killed[i] === 0) alive++
  }
  return alive
}

// ─── Component ───────────────────────────────────────────────────────────

/** The narrow live-state contract this milestone codes against — the real
 * target object (destruction wiring) lands in a later milestone. */
export type ShellLive = {
  dormant?: boolean
  /** Dead cell ids; read non-destructively here (see DRAIN OWNERSHIP). */
  removedQueue: number[]
  /** Bumped by the caller whenever removedQueue gained entries. */
  revision: number
}

export function ShellMesh({
  shell,
  materials,
  live,
}: {
  shell: ShellData
  materials: Material[]
  live: ShellLive
}) {
  const meshRef = useRef<Mesh>(null!)
  // Per-shell mutable state, all preallocated with the geometry — the idle
  // frame path below allocates NOTHING (number compares + early returns).
  const killedRef = useRef<Uint8Array>(new Uint8Array(0))
  const aliveRef = useRef(0)
  const revisionSeen = useRef(Number.NaN)
  const drainOut = useRef<ShellRemovalBatch>({ fragments: [], ranges: [] })

  // Build ONCE per shell identity. Vertex attributes wrap shell's arrays
  // (never mutated); the index is a fresh COPY (the live one gets carved —
  // shell.index stays pristine). Groups come straight from the material-
  // major pack, one group per material run.
  const geometry = useMemo(() => {
    const geo = new BufferGeometry()
    geo.setAttribute('position', new BufferAttribute(shell.positions, 3))
    geo.setAttribute('normal', new BufferAttribute(shell.normals, 3))
    geo.setAttribute('uv', new BufferAttribute(shell.uvs, 2))
    const index = new BufferAttribute(new Uint32Array(shell.index), 1)
    index.setUsage(DynamicDrawUsage)
    geo.setIndex(index)
    for (const group of shell.groups) geo.addGroup(group.start, group.count, group.materialIndex)
    // The live bookkeeping rides the same identity: a new shell = a fresh
    // carve state (idempotent, so a strict-mode double render is harmless).
    killedRef.current = new Uint8Array(shell.fragments.length)
    aliveRef.current = shell.fragments.length
    revisionSeen.current = Number.NaN
    return geo
  }, [shell])

  // Dispose only OUR geometry — never the host's materials (by-reference).
  useEffect(() => () => geometry.dispose(), [geometry])

  useFrame(() => {
    const mesh = meshRef.current
    if (!mesh) return
    // (a) Visibility: dormant shells hide (the host renders), and a fully
    // carved shell stays hidden. Write only on change.
    const visible = live.dormant !== true && aliveRef.current > 0
    if (mesh.visible !== visible) mesh.visible = visible
    if (live.dormant === true) return
    // (b) revisionSeen gating — the idle path ends here, allocation-free.
    if (live.revision === revisionSeen.current) return
    revisionSeen.current = live.revision
    if (live.removedQueue.length === 0 || aliveRef.current === 0) return
    const index = mesh.geometry.index
    if (!index) return
    // WebGPU: re-read the index attribute's array HERE, never from a cached
    // reference — the renderer may have replaced it after the first render.
    const indexArray = index.array as Uint32Array
    // Snapshot-read the queue without clearing it (see DRAIN OWNERSHIP).
    const batch = drainShellRemovals(shell, live.removedQueue, killedRef.current, drainOut.current)
    if (batch.fragments.length === 0) return
    for (let i = 0; i < batch.fragments.length; i++) {
      const range = killFragmentIndices(indexArray, shell.fragments[batch.fragments[i]!]!)
      index.addUpdateRange(range.start, range.count)
    }
    index.needsUpdate = true
    aliveRef.current -= batch.fragments.length
    // (c) Last fragment carved: hide right now, not next frame.
    if (aliveRef.current <= 0 && mesh.visible) mesh.visible = false
  })

  return (
    <mesh
      castShadow
      frustumCulled={false}
      geometry={geometry}
      material={materials}
      receiveShadow
      ref={meshRef}
      visible={live.dormant !== true}
    />
  )
}
