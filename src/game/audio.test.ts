import { describe, expect, test } from 'bun:test'
import { heartbeatBpm, lowHpSeverity, sfx } from './audio'

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

describe('heartbeat mapping stays the single severity source', () => {
  test('bpm curve endpoints', () => {
    expect(lowHpSeverity(100)).toBe(0)
    expect(lowHpSeverity(0)).toBe(1)
    expect(heartbeatBpm(100)).toBe(70)
    expect(heartbeatBpm(0)).toBe(150)
  })
})
