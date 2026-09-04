import { describe, expect, test } from 'bun:test'
import { readTreeCommand, readTreeFrame, TREE_SYNC_CAP } from './tree-sync'

describe('shared combat-tree wire boundary', () => {
  test('accepts bounded grove state and cumulative damage', () => {
    expect(readTreeFrame({ v: 1, t: [[3, 1, 52, 24, 1.25, 3]] })).toEqual({
      v: 1,
      t: [[3, 1, 52, 24, 1.25, 3]],
    })
    expect(readTreeCommand({ v: 1, h: [[3, 2, 20, 1, 12]] })).toEqual({
      v: 1,
      h: [[3, 2, 20, 1, 12]],
    })
  })

  test('rejects hostile ids, state and unbounded arrays', () => {
    expect(readTreeFrame({ v: 1, t: [[-1, 0, 70, 0, 0, 3]] })).toBeNull()
    expect(readTreeFrame({ v: 1, t: [[1, 9, 70, 0, 0, 3]] })).toBeNull()
    expect(readTreeCommand({ v: 1, h: [[1, -1, 2, 0, 0]] })).toBeNull()
    expect(
      readTreeFrame({
        v: 1,
        t: Array(TREE_SYNC_CAP + 1).fill([0, 0, 70, 0, 0, 3]),
      }),
    ).toBeNull()
  })
})
