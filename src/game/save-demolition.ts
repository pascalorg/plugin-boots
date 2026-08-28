import { type AnyNodeId, useScene } from '@pascal-app/core'
import { create } from 'zustand'
import { useDestruction, type VoxelTarget } from './destruction'

/**
 * Save-the-demolition — the other half of the persistence contract
 * (docs/SESSION-CHANGES.md). During play nothing persists; on exit the
 * session's FULLY destroyed scene nodes are captured here so the panel can
 * offer, next to Keep: "also delete what you leveled". Deletion runs
 * through the host's user-intent `deleteNodes` (descendant cascade, ONE
 * undo step) and only ever from the explicit button.
 *
 * "Fully destroyed" is strict: every voxel dead AND every framing segment
 * snapped. A wall with one stud standing is NOT persisted — partial damage
 * has no faithful node representation, so it stays intact in the editor
 * (the panel copy says so).
 */

export type DestroyedNode = { nodeId: string; kind: 'wall' | 'volume' }

type DemolitionState = {
  destroyed: DestroyedNode[]
  setDestroyed: (destroyed: DestroyedNode[]) => void
  clear: () => void
}

export const useDemolition = create<DemolitionState>((set) => ({
  destroyed: [],
  setDestroyed: (destroyed) => set({ destroyed }),
  clear: () => set({ destroyed: [] }),
}))

/** Strict classifier — exported for tests. */
export function isFullyDestroyed(target: {
  grid: { aliveCount: number }
  segments: ReadonlyArray<{ broken: boolean }>
}): boolean {
  if (target.grid.aliveCount > 0) return false
  for (const segment of target.segments) {
    if (!segment.broken) return false
  }
  return true
}

/**
 * Snapshot the session's leveled nodes. Called from exitGame BEFORE the
 * destruction state resets with the game tree. Game-only targets (tables,
 * builder pieces — '__boots' ids) never qualify: they are not scene nodes.
 */
export function captureDemolition(): number {
  const destroyed: DestroyedNode[] = []
  // Roof shells enroll per PLANE under `<nodeId>#p<n>` member ids plus one
  // `#residual` (destruction.ts roofGroups) — member ids exist in no scene
  // store, so deleteNodes on them silently no-ops. Fold members back onto
  // their GROUP node: it qualifies only when EVERY member is leveled.
  const roofLeveled = new Map<string, boolean>()
  for (const target of useDestruction.getState().targets.values() as Iterable<VoxelTarget>) {
    if (target.nodeId.startsWith('__boots')) continue
    const hash = target.nodeId.indexOf('#')
    if (hash !== -1) {
      const groupId = target.nodeId.slice(0, hash)
      roofLeveled.set(groupId, (roofLeveled.get(groupId) ?? true) && isFullyDestroyed(target))
      continue
    }
    if (!isFullyDestroyed(target)) continue
    destroyed.push({ nodeId: target.nodeId, kind: target.kind === 'wall' ? 'wall' : 'volume' })
  }
  for (const [groupId, leveled] of roofLeveled) {
    if (leveled) destroyed.push({ nodeId: groupId, kind: 'volume' })
  }
  useDemolition.getState().setDestroyed(destroyed)
  return destroyed.length
}

/** The explicit save: delete every captured node in ONE undoable batch. */
export function deleteDestroyed(): number {
  const destroyed = useDemolition.getState().destroyed
  if (destroyed.length === 0) return 0
  const ids = destroyed.map((d) => d.nodeId as AnyNodeId)
  useScene.getState().deleteNodes(ids)
  useDemolition.getState().clear()
  return ids.length
}

export function discardDemolition(): void {
  useDemolition.getState().clear()
}
