import { afterEach, describe, expect, test } from 'bun:test'
import {
  ACCENT_PALETTE,
  type BotKind,
  bots,
  botVisualParams,
  resetBots,
  spawnBot,
  waveState,
} from './enemies-state'

/**
 * PER-UNIT VISUAL VARIATION — the pure generator (enemies-state.botVisualParams)
 * that de-clones the horde. Pins the contract enemies.tsx renders against:
 * - deterministic: same (id, kind, wave) → identical params, every call,
 * - ranges: droid scale 0.9–1.15×, swing amplitude 0.5–0.95 rad, dog gait
 *   offsets in [0, 2π), exactly two dog body lengths, drone rotors ∈ {2, 4},
 * - the accent index is PER WAVE (wave mod palette size — a wave shares one
 *   color) while everything else varies per unit id,
 * - spawnBot stamps bot.visual from the generator (id + the live wave).
 * Render-only: pathing/collision/waves logic never reads any of this.
 */

const KINDS: readonly BotKind[] = ['droid', 'dog', 'drone']

afterEach(() => {
  resetBots()
})

describe('botVisualParams', () => {
  test('deterministic per (id, kind, wave)', () => {
    for (const kind of KINDS) {
      for (const id of [1, 7, 123, 4096]) {
        expect(botVisualParams(id, kind, 3)).toEqual(botVisualParams(id, kind, 3))
      }
    }
  })

  test('droid: scale jitter stays in 0.9–1.15, swing amplitude in 0.5–0.95', () => {
    for (let id = 1; id <= 200; id++) {
      const v = botVisualParams(id, 'droid', 1)
      expect(v.scale).toBeGreaterThanOrEqual(0.9)
      expect(v.scale).toBeLessThanOrEqual(1.15)
      expect(v.swingAmp).toBeGreaterThanOrEqual(0.5)
      expect(v.swingAmp).toBeLessThanOrEqual(0.95)
    }
  })

  test('dogs and drones never take the droid size jitter', () => {
    for (let id = 1; id <= 50; id++) {
      expect(botVisualParams(id, 'dog', 1).scale).toBe(1)
      expect(botVisualParams(id, 'drone', 1).scale).toBe(1)
    }
  })

  test('dog: gait offsets in [0, 2π) and BOTH body lengths occur', () => {
    const lengths = new Set<number>()
    for (let id = 1; id <= 100; id++) {
      const v = botVisualParams(id, 'dog', 1)
      for (const off of v.gait) {
        expect(off).toBeGreaterThanOrEqual(0)
        expect(off).toBeLessThan(Math.PI * 2)
      }
      lengths.add(v.bodyLen)
    }
    expect([...lengths].sort()).toEqual([1, 1.3])
  })

  test('drone: rotors ∈ {2, 4} and both body variants occur', () => {
    const rotors = new Set<number>()
    const shapes = new Set<boolean>()
    for (let id = 1; id <= 100; id++) {
      const v = botVisualParams(id, 'drone', 1)
      expect(v.rotors === 2 || v.rotors === 4).toBe(true)
      rotors.add(v.rotors)
      shapes.add(v.round)
    }
    expect([...rotors].sort()).toEqual([2, 4])
    expect(shapes.size).toBe(2)
  })

  test('accent is per WAVE: wave mod palette size, valid for any wave', () => {
    for (let wave = 0; wave <= 9; wave++) {
      const v = botVisualParams(11, 'droid', wave)
      expect(v.accent).toBe(wave % ACCENT_PALETTE.length)
      expect(v.accent).toBeGreaterThanOrEqual(0)
      expect(v.accent).toBeLessThan(ACCENT_PALETTE.length)
    }
  })

  test('units actually vary: neighboring ids roll distinct looks', () => {
    const scales = new Set<number>()
    const amps = new Set<number>()
    for (let id = 1; id <= 20; id++) {
      const v = botVisualParams(id, 'droid', 1)
      scales.add(v.scale)
      amps.add(v.swingAmp)
    }
    expect(scales.size).toBe(20)
    expect(amps.size).toBe(20)
  })

  test('spawnBot stamps visual from the generator with the live wave', () => {
    waveState.wave = 5
    spawnBot('droid', 0, 0)
    spawnBot('drone', 2, 2)
    for (const bot of bots) {
      expect(bot.visual).toEqual(botVisualParams(bot.id, bot.kind, 5))
      expect(bot.visual.accent).toBe(5 % ACCENT_PALETTE.length)
    }
  })

  test('resetBots re-arms the id counter: session 2 looks like session 1', () => {
    // Regression: the module-level id counter survived resetBots(), so
    // re-entering play in the same page continued the sequence and
    // re-rolled every unit's look — breaking the "same every session"
    // contract this file pins.
    spawnBot('dog', 0, 0)
    spawnBot('droid', 1, 0)
    spawnBot('drone', 2, 0)
    const firstSession = bots.map((bot) => ({ id: bot.id, ...bot.visual }))
    resetBots()
    spawnBot('dog', 0, 0)
    spawnBot('droid', 1, 0)
    spawnBot('drone', 2, 0)
    expect(bots.map((bot) => ({ id: bot.id, ...bot.visual }))).toEqual(firstSession)
  })
})
