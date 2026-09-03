import { afterEach, describe, expect, test } from 'bun:test'
import {
  footPlants,
  REMOTE_STEP_LEVEL_0,
  REMOTE_STEP_MAX_M,
  REMOTE_STEP_VOICE_CAP,
  REMOTE_STEP_WINDOW_MS,
  remoteFootstep,
  remoteStepCutoffHz,
  remoteStepLevel,
  remoteStepVoiceGate,
  resetRemoteStepVoiceGate,
} from './remote-footsteps'
import * as audio from './audio'

/**
 * Remote footsteps, the pure half: the distance law, the plant counter that
 * turns gait phase into step instants, and the voice governor. The WebAudio
 * graph itself is heard live; headless it must be a silent no-op.
 */

afterEach(() => resetRemoteStepVoiceGate())

describe('remoteStepLevel — quiet things, gone by 22 m', () => {
  test('full level at the feet, monotone down, exactly 0 at and past the cutoff', () => {
    expect(remoteStepLevel(0)).toBe(REMOTE_STEP_LEVEL_0)
    expect(remoteStepLevel(-3)).toBe(REMOTE_STEP_LEVEL_0) // behind you is still point blank
    let previous = Number.POSITIVE_INFINITY
    for (let d = 0; d <= 30; d += 0.25) {
      const level = remoteStepLevel(d)
      expect(level).toBeGreaterThanOrEqual(0)
      expect(level).toBeLessThanOrEqual(previous)
      previous = level
    }
    expect(remoteStepLevel(REMOTE_STEP_MAX_M)).toBe(0)
    expect(remoteStepLevel(REMOTE_STEP_MAX_M + 10)).toBe(0)
    // Halfway out a step is a quarter as loud (quadratic, not linear).
    expect(remoteStepLevel(REMOTE_STEP_MAX_M / 2)).toBeCloseTo(REMOTE_STEP_LEVEL_0 / 4, 9)
  })

  test('the air eats the click first: cutoff falls with distance, floored', () => {
    expect(remoteStepCutoffHz(0)).toBe(2400)
    expect(remoteStepCutoffHz(10)).toBe(1600)
    expect(remoteStepCutoffHz(100)).toBe(600)
  })
})

describe('footPlants — k·π crossings between two gait phases', () => {
  test('no crossing, one crossing, two (and capped at two)', () => {
    expect(footPlants(0, 1)).toBe(0)
    expect(footPlants(3, 3.2)).toBe(1) // through π
    expect(footPlants(6.2, 6.4)).toBe(1) // through 2π
    expect(footPlants(0.1, Math.PI * 2 + 0.2)).toBe(2)
    expect(footPlants(0, 40)).toBe(2) // a hitch is not a sprint
  })

  test('landing exactly on the mark counts; standing still does not', () => {
    expect(footPlants(3.0, Math.PI)).toBe(1)
    expect(footPlants(0.5, 0.5)).toBe(0)
    expect(footPlants(Math.PI, Math.PI)).toBe(0)
  })

  test('direction-agnostic (a settle backward toward k·π is a plant too)', () => {
    expect(footPlants(3.3, 3.0)).toBe(1)
    expect(footPlants(-0.1, 0.1)).toBe(1) // through 0
  })

  test('junk phases are silent', () => {
    expect(footPlants(Number.NaN, 1)).toBe(0)
    expect(footPlants(1, Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('voice governor', () => {
  test(`at most ${REMOTE_STEP_VOICE_CAP} steps per ${REMOTE_STEP_WINDOW_MS} ms window, then a fresh window`, () => {
    for (let i = 0; i < REMOTE_STEP_VOICE_CAP; i++) expect(remoteStepVoiceGate(1000)).toBe('voice')
    expect(remoteStepVoiceGate(1000 + REMOTE_STEP_WINDOW_MS)).toBe('skip')
    expect(remoteStepVoiceGate(1000 + REMOTE_STEP_WINDOW_MS + 1)).toBe('voice')
  })
})

describe('remoteFootstep — headless', () => {
  test('is a silent no-op without WebAudio and never throws', () => {
    expect(() => remoteFootstep(3, 0.2)).not.toThrow()
    expect(() => remoteFootstep(0, -2)).not.toThrow()
    expect(() => remoteFootstep(100, 0)).not.toThrow()
    expect(() => remoteFootstep(3, 0.2, 0.5)).not.toThrow()
  })

  test('the law and the governor ARE audio.ts\'s (one source of truth, master-routed)', () => {
    expect(remoteStepLevel).toBe(audio.remoteStepLevel)
    expect(remoteStepCutoffHz).toBe(audio.remoteStepCutoffHz)
    expect(remoteStepVoiceGate).toBe(audio.remoteStepVoiceGate)
    expect(REMOTE_STEP_MAX_M).toBe(audio.REMOTE_STEP_MAX_M)
    expect(REMOTE_STEP_LEVEL_0).toBe(audio.REMOTE_STEP_LEVEL_0)
    expect(remoteStepLevel(5)).toBe(audio.remoteStepMix(5).level)
  })

  test('delegates to sfx.remoteFootstep: over the governor it is counted as skipped', () => {
    resetRemoteStepVoiceGate()
    const before = audio.audioDebug().voiced.remoteStepsSkipped
    for (let i = 0; i < REMOTE_STEP_VOICE_CAP + 2; i++) remoteFootstep(1, 0)
    expect(audio.audioDebug().voiced.remoteStepsSkipped - before).toBe(2)
  })
})
