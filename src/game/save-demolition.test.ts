import { describe, expect, test } from 'bun:test'
import { isFullyDestroyed } from './save-demolition'

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
