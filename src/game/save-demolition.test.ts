import { afterEach, describe, expect, test } from 'bun:test'
import { resetDestruction, useDestruction, type VoxelTarget } from './destruction'
import {
  captureDemolition,
  discardDemolition,
  isFullyDestroyed,
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
})
