import { afterEach, describe, expect, test } from 'bun:test'
import { resetDestruction, useDestruction, type VoxelTarget } from './destruction'
import {
  captureDemolition,
  discardDemolition,
  isFullyDestroyed,
  mergePendingDemolition,
  useDemolition,
} from './save-demolition'

const target = (aliveCount: number, broken: boolean[]) => ({
  grid: { aliveCount },
  segments: broken.map((b) => ({ broken: b })),
})

describe('isFullyDestroyed (the strict save-demolition classifier)', () => {
  test('leveled wall: zero voxels + every segment snapped', () => {
    expect(isFullyDestroyed(target(0, [true, true, true]))).toBe(true)
  })

  test('one live voxel keeps the node', () => {
    expect(isFullyDestroyed(target(1, [true, true]))).toBe(false)
  })

  test('one standing stick keeps the node', () => {
    expect(isFullyDestroyed(target(0, [true, false, true]))).toBe(false)
  })

  test('volume targets (no segments) level on voxels alone', () => {
    expect(isFullyDestroyed(target(0, []))).toBe(true)
    expect(isFullyDestroyed(target(4, []))).toBe(false)
  })
})

describe('captureDemolition (member ids fold onto scene nodes)', () => {
  const seed = (nodeId: string, kind: string, aliveCount: number, broken: boolean[] = []) => {
    useDestruction
      .getState()
      .targets.set(nodeId, { nodeId, kind, ...target(aliveCount, broken) } as unknown as VoxelTarget)
  }

  afterEach(() => {
    discardDemolition()
    resetDestruction()
  })

  test('roof plane/residual members are never captured raw; the GROUP node is, once every member is leveled', () => {
    // Roof shells enroll per plane under `<nodeId>#p<n>` + `#residual`
    // member ids — none exists in the scene store, so capturing one made
    // the panel promise deletions deleteNodes silently no-ops on.
    seed('roof-9#p0', 'roof', 0)
    seed('roof-9#p1', 'roof', 0)
    seed('roof-9#residual', 'volume', 0)
    seed('roof-7#p0', 'roof', 0)
    seed('roof-7#p1', 'roof', 12) // one plane still standing
    seed('wall-1', 'wall', 0, [true, true])
    seed('__boots-piece-3', 'wall', 0) // game-only, never a scene node
    expect(captureDemolition()).toBe(2)
    const destroyed = useDemolition.getState().destroyed
    expect(destroyed).toContainEqual({ nodeId: 'wall-1', kind: 'wall' })
    expect(destroyed).toContainEqual({ nodeId: 'roof-9', kind: 'volume' })
    expect(destroyed.some((d) => d.nodeId.includes('#'))).toBe(false)
    expect(destroyed.some((d) => d.nodeId.startsWith('roof-7'))).toBe(false)
    expect(destroyed.some((d) => d.nodeId.startsWith('__boots'))).toBe(false)
  })

  // A pending decision spans every session since the last Save/Discard. The
  // destruction runtime is rebuilt from the restored scene on each Jump in, so
  // a capture that REPLACED dropped the previous session's demolition — from
  // the panel and, worse, from Save, which then wrote nothing for it.
  test('a second session keeps the first session leveled wall pending', () => {
    seed('wall-1', 'wall', 0, [true])
    expect(captureDemolition()).toBe(1)

    // Re-entry: the scene was restored, so the runtime knows nothing of wall-1.
    resetDestruction()
    seed('wall-2', 'wall', 0, [true])
    expect(captureDemolition()).toBe(2)

    const { destroyed, mine } = useDemolition.getState()
    expect(destroyed).toEqual([
      { nodeId: 'wall-1', kind: 'wall' },
      { nodeId: 'wall-2', kind: 'wall' },
    ])
    // The allow-list deleteDestroyed re-checks at click time has to carry both.
    expect([...mine].sort()).toEqual(['wall-1', 'wall-2'])
  })

  test('a session that levels nothing leaves the pending list untouched', () => {
    seed('wall-1', 'wall', 0, [true])
    expect(captureDemolition()).toBe(1)

    resetDestruction()
    seed('wall-9', 'wall', 12, [false]) // shot at, nowhere near leveled
    // Non-zero is what keeps exitGame's pendingDecision true.
    expect(captureDemolition()).toBe(1)
    expect(useDemolition.getState().destroyed).toEqual([{ nodeId: 'wall-1', kind: 'wall' }])
  })

  test('the same wall leveled twice is listed once', () => {
    seed('wall-1', 'wall', 0, [true])
    captureDemolition()
    resetDestruction()
    seed('wall-1', 'wall', 0, [true])
    expect(captureDemolition()).toBe(1)
    expect(useDemolition.getState().destroyed).toEqual([{ nodeId: 'wall-1', kind: 'wall' }])
    expect(useDemolition.getState().mine).toEqual(['wall-1'])
  })

  test('the decision clears the accumulation, so the next session starts empty', () => {
    seed('wall-1', 'wall', 0, [true])
    captureDemolition()
    discardDemolition()
    resetDestruction()
    seed('wall-2', 'wall', 0, [true])
    expect(captureDemolition()).toBe(1)
    expect(useDemolition.getState().destroyed).toEqual([{ nodeId: 'wall-2', kind: 'wall' }])
  })

  test('the withheld count is per-exit, not a running total', () => {
    // A bare count can't be deduplicated, and the shared model re-projects the
    // same stranger's rubble into the rebuilt runtime on every entry — summing
    // it would report one withheld wall as 2, then 3.
    mergePendingDemolition([{ nodeId: 'wall-1', kind: 'wall' }], 1)
    expect(useDemolition.getState().foreign).toBe(1)
    mergePendingDemolition([{ nodeId: 'wall-2', kind: 'wall' }], 1)
    expect(useDemolition.getState().destroyed).toHaveLength(2)
    expect(useDemolition.getState().foreign).toBe(1)
    mergePendingDemolition([], 0)
    expect(useDemolition.getState().foreign).toBe(0)
  })
})
