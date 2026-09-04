import { describe, expect, test } from 'bun:test'
import {
  HORDE_MAX_BOTS,
  validateHordeCommand,
  validateHordeFrame,
} from './horde-sync'

const frame = () => ({
  v: 1,
  w: 2,
  i: 4,
  a: true,
  l: true,
  c: 0,
  ca: false,
  b: [[7, 1, 1, 2, 3, 0.25, 35, 0, 0, 1.5, 0.2, 0, 19]],
})

describe('shared horde wire boundary', () => {
  test('accepts a compact finite authority snapshot', () => {
    const out = validateHordeFrame(frame())!
    expect(out.w).toBe(2)
    expect(out.b[0]).toEqual([7, 1, 1, 2, 3, 0.25, 35, 0, 0, 1.5, 0.2, 0, 19])
  })

  test('rejects malformed bots and an unbounded horde', () => {
    expect(validateHordeFrame({ ...frame(), b: [[1, 9, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]] })).toBeNull()
    expect(validateHordeFrame({ ...frame(), b: Array.from({ length: HORDE_MAX_BOTS + 1 }, () => []) })).toBeNull()
    expect(validateHordeFrame({ ...frame(), b: [[1, 0, Number.NaN, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]] })).toBeNull()
  })

  test('normalizes cumulative switch and damage commands', () => {
    expect(validateHordeCommand({ v: 1, a: [3, true], h: { 7: 40, nope: 9, 8: -1 } })).toEqual({
      v: 1,
      a: [3, true],
      h: { 7: 40 },
    })
    expect(validateHordeCommand(null)).toBeNull()
  })
})
