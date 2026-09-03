import { describe, expect, test } from 'bun:test'
import { Group } from 'three'
import { FEEL, recoilEnvelope } from './feel'
import {
  HAND_GRIPS,
  READY_TIME,
  RECOIL_TIME,
  SUPPORT_LAG,
  SWAY_COMPLIANCE,
  TRIGGER_ADS_TIGHTEN,
  TRIGGER_HOLD,
  TRIGGER_TIME,
} from './hand-grips'
import { TRIGGER_CURL, TRIGGER_REST } from './hand-pose'
import {
  applyHandMotion,
  driveHands,
  HAND_REFS,
  type HandMotionState,
  handMotionOf,
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
  held: 0,
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

  test('handSignals defaults to internal derivation, everything at rest', () => {
    expect(handSignals.external).toBe(false)
    expect(handSignals.shot).toBe(false)
    expect(handSignals.drawn).toBe(false)
    expect(handSignals.held).toBe(false)
    expect(handSignals.aim).toBe(0)
    expect(handSignals.recoil).toBe(0)
    expect(handSignals.swayX).toBe(0)
    expect(handSignals.swayY).toBe(0)
    expect(handSignals.swayRoll).toBe(0)
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

  test('the SHOT FRAME reads the full pull and the full kick; both return to exactly 0 within their times', () => {
    const st = fresh()
    stepHandMotion(st, 1 / 60, true, false, 0)
    expect(st.recoil).toBe(1) // feel.recoilEnvelope(0): the kick is on the fire frame
    expect(st.squeeze).toBe(1) // the bang happens at full pull
    let t = 1 / 60
    let releasing = false
    let prev = 1
    while (t < 0.5) {
      stepHandMotion(st, 1 / 60, false, false, 0)
      t += 1 / 60
      expect(st.squeeze).toBeLessThanOrEqual(prev + 1e-12) // monotone release
      if (st.squeeze < 1) releasing = true
      prev = st.squeeze
      if (t > TRIGGER_TIME + 1 / 30) expect(st.squeeze).toBe(0)
      if (t > RECOIL_TIME + 1 / 30) expect(st.recoil).toBe(0)
    }
    expect(releasing).toBe(true)
    expect(RECOIL_TIME).toBe(FEEL.RECOIL_TIME)
    // the peaks survive for a slow poller
    expect(st.peakSqueeze).toBe(1)
    expect(st.peakRecoil).toBe(1)
  })

  test('the local recoil clock IS feel.recoilEnvelope over FEEL.RECOIL_TIME (one source)', () => {
    const st = fresh()
    stepHandMotion(st, 1 / 60, true, false, 0)
    for (let i = 0; i < 6; i++) {
      stepHandMotion(st, 1 / 60, false, false, 0)
      expect(st.recoil).toBeCloseTo(recoilEnvelope(st.recoilT), 12)
    }
  })

  test('an external recoil value replaces the local clock (the viewmodel drives it)', () => {
    const st = fresh()
    stepHandMotion(st, 1 / 60, false, false, 0, 0.42)
    expect(st.recoil).toBe(0.42)
    expect(st.recoilT).toBe(1) // the clock did not start
    stepHandMotion(st, 1 / 60, true, false, 0, 0.9)
    expect(st.recoil).toBe(0.9) // even on a shot frame the external value wins
    stepHandMotion(st, 1 / 60, false, false, 0, 0)
    expect(st.recoil).toBe(0)
  })

  test('a HELD trigger keeps the index pulled and releases smoothly when let go', () => {
    const st = fresh()
    let t = 0
    while (t < 0.2) {
      stepHandMotion(st, 1 / 60, false, false, 0, undefined, true)
      t += 1 / 60
    }
    expect(st.held).toBeGreaterThan(0.95)
    expect(st.squeeze).toBeGreaterThan(0.95)
    // let go: eases out over ~0.3 s, never snaps
    let prev = st.squeeze
    let released = false
    t = 0
    while (t < 0.6) {
      stepHandMotion(st, 1 / 60, false, false, 0, undefined, false)
      t += 1 / 60
      expect(st.squeeze).toBeLessThanOrEqual(prev + 1e-12)
      expect(prev - st.squeeze).toBeLessThan(0.25)
      prev = st.squeeze
      if (st.squeeze === 0) released = true
    }
    expect(released).toBe(true)
    expect(st.held).toBe(0)
  })

  test('a draw parks the shot clocks and the held pull (a fresh weapon starts clean)', () => {
    const st = fresh()
    stepHandMotion(st, 1 / 60, true, false, 0, undefined, true)
    expect(st.squeeze).toBe(1)
    stepHandMotion(st, 1 / 60, false, true, 0)
    expect(st.triggerT).toBe(1)
    expect(st.recoilT).toBe(1)
    expect(st.held).toBe(0)
    expect(st.squeeze).toBe(0)
    expect(st.recoil).toBe(0)
    expect(st.readyT).toBe(0) // the dip starts on the draw frame …
    stepHandMotion(st, 1 / 60, false, false, 0)
    expect(st.readyT).toBeGreaterThan(0) // … and plays from the next
    expect(st.ready).toBeGreaterThan(0)
  })

  test('a 1/30 dt (headless cap) still shows recoil > 0.3 and squeeze > 0.5 on the shot frame and the next', () => {
    const st = fresh()
    stepHandMotion(st, 1 / 30, true, false, 0)
    expect(st.recoil).toBeGreaterThan(0.3)
    expect(st.squeeze).toBeGreaterThan(0.5)
    stepHandMotion(st, 1 / 30, false, false, 0)
    expect(st.recoil).toBeGreaterThan(0.3)
    expect(st.squeeze).toBeGreaterThan(0.5) // TRIGGER_HOLD + the release's slow start
    expect(TRIGGER_HOLD).toBeLessThan(1 / 30)
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

describe('applyHandMotion / driveHands', () => {
  test('the support hand sits at the table position minus SWAY_COMPLIANCE of the sway, plus the recoil lag', () => {
    const refs = HAND_REFS.rifle
    const left = new Group()
    const right = new Group()
    refs.left.current = left
    refs.right.current = right
    try {
      const st = fresh()
      st.recoil = 1
      applyHandMotion(HAND_GRIPS.rifle, refs, st, 0, 0.01, -0.02)
      const p = HAND_GRIPS.rifle.left!.position
      expect(left.position.x).toBeCloseTo(p[0] - 0.01 * SWAY_COMPLIANCE, 12)
      expect(left.position.y).toBeCloseTo(p[1] + 0.02 * SWAY_COMPLIANCE, 12)
      expect(left.position.z).toBeCloseTo(p[2] - SUPPORT_LAG, 12)
      // at rest, exactly the table
      st.recoil = 0
      applyHandMotion(HAND_GRIPS.rifle, refs, st, 0, 0, 0)
      expect([left.position.x, left.position.y, left.position.z]).toEqual([p[0], p[1], p[2]])
    } finally {
      refs.left.current = null
      refs.right.current = null
    }
  })

  test('driveHands reads handSignals for the shown weapon and leaves the others parked; no refs is fine', () => {
    const prev = { ...handSignals }
    try {
      handSignals.external = true
      handSignals.shot = true
      handSignals.recoil = 1
      handSignals.aim = 0.5
      handSignals.held = true
      driveHands('pistol', 1 / 60, 0)
      const st = handMotionOf('pistol')
      expect(st.squeeze).toBe(1)
      expect(st.recoil).toBe(1)
      expect(st.aim).toBe(0.5)
      expect(handMotionOf('rifle').squeeze).toBe(0)
      handSignals.shot = false
      handSignals.held = false
      handSignals.recoil = 0
      for (let i = 0; i < 40; i++) driveHands('pistol', 1 / 60, i / 60)
      expect(st.squeeze).toBe(0)
      expect(st.recoil).toBe(0)
      expect(handMotionOf('zzz' as ToolId)).toBe(handMotionOf('knife'))
    } finally {
      Object.assign(handSignals, prev)
    }
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
