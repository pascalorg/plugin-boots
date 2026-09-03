import { describe, expect, test } from 'bun:test'
import { HAND_GRIPS, READY_TIME, RECOIL_TIME, SUPPORT_LAG, TRIGGER_ADS_TIGHTEN, TRIGGER_TIME } from './hand-grips'
import { TRIGGER_CURL, TRIGGER_REST } from './hand-pose'
import {
  HAND_REFS,
  type HandMotionState,
  handSignals,
  idleDrift,
  stepHandMotion,
  supportOffset,
  triggerAngles,
} from './weapon-hands'
import type { ToolId } from './viewmodel'

/**
 * THE FIRST-PERSON HANDS' MOTION, without a scene: the per-weapon ref table
 * exists for every tool, and the pure clocks/appliers the frame loop calls do
 * what the curves promise — a shot squeezes the index and slides the support
 * hand back, ADS tightens, a draw dips the support hand once, and everything
 * settles to exactly the table pose.
 */

const TOOLS: ToolId[] = ['knife', 'pistol', 'rifle', 'minigun', 'hammer', 'builder', 'paint']
const fresh = (): HandMotionState => ({
  triggerT: 1,
  recoilT: 1,
  readyT: 1,
  prevShots: 0,
  prevShown: false,
  squeeze: 0,
  recoil: 0,
  ready: 0,
  aim: 0,
  peakRecoil: 0,
  peakSqueeze: 0,
})

describe('HAND_REFS', () => {
  test('one ref set per tool, matching the grip table, all empty until mounted', () => {
    for (const w of TOOLS) {
      const r = HAND_REFS[w]
      expect(r).toBeDefined()
      expect(r.right.current).toBeNull()
      expect(r.left.current).toBeNull()
      expect(r.trigger.length).toBe(3)
      for (const t of r.trigger) expect(t.current).toBeNull()
      expect(HAND_GRIPS[w]).toBeDefined()
    }
    expect(Object.keys(HAND_REFS).sort()).toEqual([...TOOLS].sort())
  })

  test('handSignals defaults to internal derivation', () => {
    expect(handSignals.external).toBe(false)
    expect(handSignals.shot).toBe(false)
    expect(handSignals.drawn).toBe(false)
    expect(handSignals.aim).toBe(0)
  })
})

describe('stepHandMotion', () => {
  test('at rest everything is exactly zero and clocks are parked', () => {
    const st = fresh()
    stepHandMotion(st, 1 / 60, false, false, 0)
    expect(st.squeeze).toBe(0)
    expect(st.recoil).toBe(0)
    expect(st.ready).toBe(0)
    expect(st.triggerT).toBe(1)
    expect(st.recoilT).toBe(1)
  })

  test('a shot restarts the trigger and recoil clocks; both peak then return to 0 within their times', () => {
    const st = fresh()
    stepHandMotion(st, 1 / 60, true, false, 0)
    expect(st.recoil).toBeGreaterThan(0.5) // reads on the very first frame
    expect(st.squeeze).toBeGreaterThan(0)
    let maxSqueeze = st.squeeze
    let maxRecoil = st.recoil
    let t = 1 / 60
    while (t < 0.5) {
      stepHandMotion(st, 1 / 60, false, false, 0)
      t += 1 / 60
      maxSqueeze = Math.max(maxSqueeze, st.squeeze)
      maxRecoil = Math.max(maxRecoil, st.recoil)
      if (t > TRIGGER_TIME + 1 / 30) expect(st.squeeze).toBe(0)
      if (t > RECOIL_TIME + 1 / 30) expect(st.recoil).toBe(0)
    }
    expect(maxSqueeze).toBeGreaterThan(0.85)
    expect(maxRecoil).toBeGreaterThan(0.9)
    // the peaks survive for a slow poller
    expect(st.peakSqueeze).toBeCloseTo(maxSqueeze, 12)
    expect(st.peakRecoil).toBeCloseTo(maxRecoil, 12)
  })

  test('a 1/30 dt (headless cap) still shows recoil > 0.3 and squeeze > 0.5 on the shot frame', () => {
    const st = fresh()
    stepHandMotion(st, 1 / 30, true, false, 0)
    expect(st.recoil).toBeGreaterThan(0.3)
    expect(st.squeeze).toBeGreaterThan(0.5)
  })

  test('a draw dips the support hand once over READY_TIME', () => {
    const st = fresh()
    stepHandMotion(st, 1 / 60, false, true, 0)
    let peak = 0
    let t = 1 / 60
    while (t < READY_TIME + 0.1) {
      stepHandMotion(st, 1 / 60, false, false, 0)
      t += 1 / 60
      peak = Math.max(peak, st.ready)
    }
    expect(peak).toBeGreaterThan(0.025)
    expect(st.ready).toBe(0)
  })

  test('aim is clamped to 0..1', () => {
    const st = fresh()
    stepHandMotion(st, 1 / 60, false, false, 3)
    expect(st.aim).toBe(1)
    stepHandMotion(st, 1 / 60, false, false, -1)
    expect(st.aim).toBe(0)
  })

  test('a 1/30 dt (headless cap) still shows a squeeze on at least one frame', () => {
    const st = fresh()
    stepHandMotion(st, 1 / 30, true, false, 0)
    expect(st.squeeze).toBeGreaterThan(0.5)
  })
})

describe('appliers', () => {
  test('triggerAngles: rest at zero, TRIGGER_CURL at full squeeze, +TIGHTEN at full aim, idle added', () => {
    const out: [number, number, number] = [0, 0, 0]
    triggerAngles(0, 0, 0, out)
    expect(out).toEqual([...TRIGGER_REST])
    triggerAngles(1, 0, 0, out)
    for (let i = 0; i < 3; i++) expect(out[i]!).toBeCloseTo(TRIGGER_CURL[i]!, 12)
    triggerAngles(0, 1, 0, out)
    for (let i = 0; i < 3; i++) expect(out[i]!).toBeCloseTo(TRIGGER_REST[i]! + TRIGGER_ADS_TIGHTEN, 12)
    triggerAngles(0, 0, 0.02, out)
    for (let i = 0; i < 3; i++) expect(out[i]!).toBeCloseTo(TRIGGER_REST[i]! + 0.02, 12)
  })

  test('supportOffset: recoil slides the hand back (−z), the ready dip drops it (−y) and fades with aim', () => {
    const out: [number, number, number] = [0, 0, 0]
    supportOffset(0, 0, 0, out)
    expect(out).toEqual([0, -0, -0])
    supportOffset(1, 0, 0, out)
    expect(out[2]).toBeCloseTo(-SUPPORT_LAG, 12)
    supportOffset(0, 0.03, 0, out)
    expect(out[1]).toBeCloseTo(-0.03, 12)
    supportOffset(0, 0.03, 1, out)
    expect(out[1]).toBeCloseTo(0, 12)
  })

  test('idleDrift is small, bounded, and steadier at ADS', () => {
    let max = 0
    let maxAds = 0
    for (let t = 0; t < 10; t += 0.05) {
      max = Math.max(max, Math.abs(idleDrift(t, 0)))
      maxAds = Math.max(maxAds, Math.abs(idleDrift(t, 1)))
    }
    expect(max).toBeLessThanOrEqual(0.04 + 1e-12)
    expect(max).toBeGreaterThan(0.035)
    expect(maxAds).toBeLessThan(max * 0.3)
  })
})
