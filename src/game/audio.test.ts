import { describe, expect, test } from 'bun:test'
import {
  heartbeatBpm,
  lowHpSeverity,
  resetSnapVoiceGate,
  sfx,
  SNAP_VOICE_CAP,
  SNAP_WINDOW_MS,
  snapVoiceGate,
} from './audio'

/**
 * Headless contract tests — bun test has no `window`, so ensureContext()
 * returns null and every voice must be a SILENT NO-OP (never a throw,
 * never a null where the API promises a handle). That "always a handle"
 * promise is what lets callers (trees-destruct crackle fade, the paint
 * tool's spray) drive handles unconditionally in frame loops; a regression
 * here is a crash on browsers without WebAudio. Timbre itself is reviewed
 * by ear — what's testable is the API surface.
 */

describe('handle-returning loop voices never null (WebAudio absent)', () => {
  test('spray(): { start, stop }, idempotent both ways, restartable', () => {
    const spray = sfx.spray()
    expect(typeof spray.start).toBe('function')
    expect(typeof spray.stop).toBe('function')
    // start/stop in every order — silent no-ops must never throw.
    expect(() => {
      spray.start()
      spray.start() // idempotent while "running"
      spray.stop()
      spray.stop() // idempotent when already stopped
      spray.start() // works again after stop
      spray.stop()
    }).not.toThrow()
    // stop() before any start() on a fresh handle is safe too.
    expect(() => sfx.spray().stop()).not.toThrow()
  })

  test('treeCrackle(): still a handle — the fade drives it every frame', () => {
    const crackle = sfx.treeCrackle()
    expect(() => {
      crackle.setIntensity(0.7)
      crackle.setIntensity(0) // fade tail
      crackle.stop()
      crackle.stop()
    }).not.toThrow()
  })
})

describe('char-feel one-shots (silent no-ops headless)', () => {
  test('charSnap accepts a snap depth, including out-of-range values', () => {
    expect(() => {
      sfx.charSnap() // legacy call — depth defaults to 0
      sfx.charSnap(0)
      sfx.charSnap(1)
      sfx.charSnap(2)
      sfx.charSnap(-1) // clamped low
      sfx.charSnap(99) // clamped high
    }).not.toThrow()
  })

  test('emberCrackle fires without a context', () => {
    expect(() => {
      sfx.emberCrackle()
      sfx.emberCrackle()
    }).not.toThrow()
  })
})

describe('phase-9 juice voices (headless contracts)', () => {
  test('killConfirm and metalPing are silent no-ops without WebAudio', () => {
    expect(() => {
      sfx.killConfirm()
      sfx.metalPing()
      sfx.killConfirm()
      sfx.metalPing()
    }).not.toThrow()
  })

  test('droneBuzz keeps its null-without-WebAudio contract (callers null-check)', () => {
    expect(sfx.droneBuzz()).toBeNull()
  })
})

describe('session-start warmers (silent no-ops headless)', () => {
  test('prime() is idempotent and safe without WebAudio', () => {
    expect(() => {
      sfx.prime() // first-use cost prepay (noise buffer + master chain)
      sfx.prime() // idempotent — warmup remounts every session
    }).not.toThrow()
  })
})

describe('heartbeat mapping stays the single severity source', () => {
  test('bpm curve endpoints', () => {
    expect(lowHpSeverity(100)).toBe(0)
    expect(lowHpSeverity(0)).toBe(1)
    expect(heartbeatBpm(100)).toBe(70)
    expect(heartbeatBpm(0)).toBe(150)
  })
})

describe('segment-snap voice governor (grenade boom-trim)', () => {
  test('a blast flood voices CAP snaps, ONE collapsed crack, then silence', () => {
    resetSnapVoiceGate()
    // 48 snaps land within ~1 ms of each other on the segment-ring frame.
    for (let i = 0; i < SNAP_VOICE_CAP; i++) {
      expect(snapVoiceGate(1000 + i)).toBe('snap')
    }
    expect(snapVoiceGate(1000 + SNAP_VOICE_CAP)).toBe('crack')
    for (let i = SNAP_VOICE_CAP + 1; i < 48; i++) {
      expect(snapVoiceGate(1000 + i)).toBe('skip')
    }
  })

  test('single snaps outside the window always voice (rifle-shot path)', () => {
    resetSnapVoiceGate()
    expect(snapVoiceGate(0)).toBe('snap')
    expect(snapVoiceGate(SNAP_WINDOW_MS + 1)).toBe('snap') // fresh window
    expect(snapVoiceGate(3 * SNAP_WINDOW_MS)).toBe('snap')
  })

  test('a saturated window reopens after SNAP_WINDOW_MS', () => {
    resetSnapVoiceGate()
    for (let i = 0; i < 48; i++) snapVoiceGate(500)
    expect(snapVoiceGate(500 + SNAP_WINDOW_MS)).toBe('skip') // still inside
    expect(snapVoiceGate(500 + SNAP_WINDOW_MS + 1)).toBe('snap')
  })

  test('studSnap flood is a silent no-op headless (never throws)', () => {
    resetSnapVoiceGate()
    expect(() => {
      for (let i = 0; i < 60; i++) sfx.studSnap()
    }).not.toThrow()
    resetSnapVoiceGate() // leave no window for other test files
  })
})
