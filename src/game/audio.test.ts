import { describe, expect, test } from 'bun:test'
import {
  heartbeatBpm,
  lowHpSeverity,
  REMOTE_SHOT_MAX_M,
  REMOTE_SHOT_VOICE_CAP,
  REMOTE_SHOT_WINDOW_MS,
  remoteShotMix,
  remoteShotVoiceGate,
  resetRemoteShotVoiceGate,
  resetSnapVoiceGate,
  sfx,
  SNAP_VOICE_CAP,
  SNAP_WINDOW_MS,
  snapVoiceGate,
  SPEED_OF_SOUND_MS,
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

/**
 * Remote gunfire — the distance law the owner asked for in so many words:
 * "everyone nearby should hear it close and everyone far should just hear a
 * little bit of it far. Opening on distance."
 *
 * Four things move together in remoteShotMix and each one is a different cue a
 * player reads without thinking: how loud, how bright (air eats the crack
 * first), how late (sound is slow), and how much low boom is left. Timbre is
 * reviewed by ear; the LAW is pinned here.
 */
describe('remoteShotMix — one law, four cues', () => {
  test('level falls monotonically to exactly nothing at the cutoff', () => {
    const at = (d: number) => remoteShotMix(d).level
    expect(at(0)).toBeCloseTo(1, 5)
    let previous = at(0)
    for (let d = 1; d <= REMOTE_SHOT_MAX_M; d += 1) {
      const level = at(d)
      expect(level).toBeLessThan(previous)
      previous = level
    }
    expect(at(REMOTE_SHOT_MAX_M)).toBe(0)
    expect(at(REMOTE_SHOT_MAX_M + 50)).toBe(0)
    // Nearby is genuinely LOUD and far is genuinely faint — the point of the ask.
    expect(at(5)).toBeGreaterThan(0.5)
    expect(at(60)).toBeLessThan(0.1)
    expect(at(60)).toBeGreaterThan(0)
  })

  test('the crack loses its top end with distance (the "opening")', () => {
    expect(remoteShotMix(0).cutoffHz).toBeGreaterThan(15000)
    expect(remoteShotMix(20).cutoffHz).toBeLessThan(remoteShotMix(0).cutoffHz)
    expect(remoteShotMix(80).cutoffHz).toBeLessThan(remoteShotMix(20).cutoffHz)
    // Floored, so a far shot is a muffled thump and never nothing at all.
    expect(remoteShotMix(500).cutoffHz).toBe(320)
  })

  test('arrival is late by the real speed of sound, capped', () => {
    expect(remoteShotMix(0).delayS).toBe(0)
    expect(remoteShotMix(SPEED_OF_SOUND_MS).delayS).toBe(0.35) // capped, not 1 s
    expect(remoteShotMix(34.3).delayS).toBeCloseTo(0.1, 4)
  })

  test('boom weight grows to full and stays there', () => {
    expect(remoteShotMix(0).boom).toBe(0)
    expect(remoteShotMix(45).boom).toBe(1)
    expect(remoteShotMix(200).boom).toBe(1)
    expect(remoteShotMix(22.5).boom).toBeCloseTo(0.5, 5)
  })

  test('junk and negative distances behave like point blank', () => {
    expect(remoteShotMix(-5).level).toBeCloseTo(1, 5)
    expect(remoteShotMix(Number.NaN).level).toBeCloseTo(1, 5)
  })
})

describe('remote-shot voice governor', () => {
  test(`a lobby of miniguns voices CAP rounds per ${REMOTE_SHOT_WINDOW_MS}ms window`, () => {
    resetRemoteShotVoiceGate()
    for (let i = 0; i < REMOTE_SHOT_VOICE_CAP; i++) {
      expect(remoteShotVoiceGate(1000 + i)).toBe('voice')
    }
    // Twelve peers firing 24 rounds a second each cost the same as six.
    for (let i = 0; i < 40; i++) {
      expect(remoteShotVoiceGate(1000 + REMOTE_SHOT_VOICE_CAP + i * 0.5)).toBe('skip')
    }
  })

  test('the window reopens, so sustained fire keeps ticking', () => {
    resetRemoteShotVoiceGate()
    for (let i = 0; i < 30; i++) remoteShotVoiceGate(500)
    expect(remoteShotVoiceGate(500 + REMOTE_SHOT_WINDOW_MS)).toBe('skip') // still inside
    expect(remoteShotVoiceGate(500 + REMOTE_SHOT_WINDOW_MS + 1)).toBe('voice')
    resetRemoteShotVoiceGate() // leave no window for other test files
  })

  test('single distant shots always voice (nobody else firing)', () => {
    resetRemoteShotVoiceGate()
    expect(remoteShotVoiceGate(0)).toBe('voice')
    expect(remoteShotVoiceGate(REMOTE_SHOT_WINDOW_MS * 4)).toBe('voice')
    resetRemoteShotVoiceGate()
  })
})

describe('sfx.remoteShot (silent no-op headless)', () => {
  test('every kind, distance, pan and burst offset is safe', () => {
    resetRemoteShotVoiceGate()
    expect(() => {
      sfx.remoteShot('pistol', 0)
      sfx.remoteShot('rifle', 12, -1)
      sfx.remoteShot('minigun', 70, 1, 0.04)
      sfx.remoteShot('rifle', REMOTE_SHOT_MAX_M + 10) // out of range → returns early
      sfx.remoteShot('rifle', -5, 42, -3) // junk pan/offset clamped
      sfx.remoteShot('rifle', Number.NaN)
      for (let i = 0; i < 60; i++) sfx.remoteShot('minigun', 8, 0) // flood the gate
    }).not.toThrow()
    resetRemoteShotVoiceGate()
  })
})
