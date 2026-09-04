import { describe, expect, test } from 'bun:test'
import { readOperableCommand, readOperableFrame } from './interact'

describe('shared operable wire boundary', () => {
  test('accepts normalized door/window states and commands', () => {
    expect(readOperableFrame({ v: 1, s: [['door-a', 1, -1]] })).toEqual({
      v: 1,
      s: [['door-a', 1, -1]],
    })
    expect(readOperableCommand({ v: 1, c: [['window-b', 7, 0, 1]] })).toEqual({
      v: 1,
      c: [['window-b', 7, 0, 1]],
    })
  })

  test('rejects invalid state, direction, revision and oversized ids', () => {
    expect(readOperableFrame({ v: 1, s: [['door-a', 2, 1]] })).toBeNull()
    expect(readOperableFrame({ v: 1, s: [['door-a', 1, 0]] })).toBeNull()
    expect(readOperableCommand({ v: 1, c: [['door-a', -1, 1, 1]] })).toBeNull()
    expect(readOperableFrame({ v: 1, s: [['x'.repeat(161), 1, 1]] })).toBeNull()
  })
})
