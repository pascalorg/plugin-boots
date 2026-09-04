import { afterEach, describe, expect, test } from 'bun:test'
import {
  audioDebug,
  footstepMix,
  heartbeatBpm,
  HURT_DEFAULT_DMG,
  HURT_FULL_DMG,
  hurtMix,
  LAND_DEFAULT_DEPTH,
  LAND_SUB_DEPTH,
  landMix,
  lowHpSeverity,
  PAN_MONO_COMP,
  REMOTE_SHOT_MAX_M,
  REMOTE_SHOT_VOICE_CAP,
  REMOTE_SHOT_WINDOW_MS,
  REMOTE_STEP_LEVEL_0,
  REMOTE_STEP_MAX_M,
  REMOTE_STEP_VOICE_CAP,
  REMOTE_STEP_WINDOW_MS,
  remoteShotMix,
  remoteShotVoiceGate,
  remoteStepAttenuation,
  remoteStepCutoffHz,
  remoteStepLevel,
  remoteStepMix,
  remoteStepVoiceGate,
  resetRemoteShotVoiceGate,
  resetRemoteStepVoiceGate,
  resetSnapVoiceGate,
  sfx,
  SNAP_VOICE_CAP,
  SNAP_WINDOW_MS,
  snapVoiceGate,
  SPATIAL_PAN_MAX,
  spatialPan,
  SPEED_OF_SOUND_MS,
  VEHICLE_ENGINE_MAX_M,
  vehicleEngineMix,
} from './audio'
import { FEEL } from './feel'
import { MOVE } from './movement'

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

  test('vehicleEngine(): shared-motion loop is safe without WebAudio', () => {
    const engine = sfx.vehicleEngine()
    expect(() => {
      engine.setMotion(0, false, 0)
      engine.setMotion(6, true, 12, -0.5)
      engine.stop()
      engine.stop()
      engine.setMotion(10, true, 0, 1)
    }).not.toThrow()
  })
})

describe('vehicleEngineMix — synchronized RPM with listener-local distance', () => {
  test('ignition gates sound and distance rolls it to silence', () => {
    expect(vehicleEngineMix(8, false, 0).level).toBe(0)
    expect(vehicleEngineMix(8, true, 0).level).toBeGreaterThan(0)
    expect(vehicleEngineMix(8, true, 30).level).toBeLessThan(vehicleEngineMix(8, true, 0).level)
    expect(vehicleEngineMix(8, true, VEHICLE_ENGINE_MAX_M).level).toBe(0)
  })

  test('speed raises pitch/load equally for forward and reverse', () => {
    const idle = vehicleEngineMix(0, true, 0)
    const forward = vehicleEngineMix(10, true, 0)
    const reverse = vehicleEngineMix(-10, true, 0)
    expect(forward.pitchHz).toBeGreaterThan(idle.pitchHz)
    expect(forward.pulseHz).toBeGreaterThan(idle.pulseHz)
    expect(reverse).toEqual(forward)
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

// ── 2026-09-02 audio lane: the shared distance rig, steps, intensities ──────

describe('spatialPan — the one pan law for every placed sound', () => {
  test('scales to ±SPATIAL_PAN_MAX, clamps, and is centre for junk', () => {
    expect(spatialPan(0)).toBe(0)
    expect(spatialPan(0.5)).toBeCloseTo(0.5 * SPATIAL_PAN_MAX, 12)
    expect(spatialPan(1)).toBe(SPATIAL_PAN_MAX)
    expect(spatialPan(-1)).toBe(-SPATIAL_PAN_MAX)
    expect(spatialPan(7)).toBe(SPATIAL_PAN_MAX) // an un-normalized bearing never leaves one ear
    expect(spatialPan(-7)).toBe(-SPATIAL_PAN_MAX)
    // A source AT the listener (0/0) must not reach an AudioParam as NaN — that throws.
    expect(spatialPan(Number.NaN)).toBe(0)
    expect(spatialPan(Number.POSITIVE_INFINITY)).toBe(0)
  })

  test('PAN_MONO_COMP undoes the centred panner\'s mono loss and is equal-power at any pan', () => {
    // A mono source through a StereoPanner: L = cos(x·π/2), R = sin(x·π/2), x = (pan + 1) / 2.
    // Wired straight into the stereo master it is copied to both ears at unity — power 2.
    for (const pan of [0, 0.3, -0.5, SPATIAL_PAN_MAX, -SPATIAL_PAN_MAX]) {
      const x = ((pan + 1) / 2) * (Math.PI / 2)
      const l = Math.cos(x) * PAN_MONO_COMP
      const r = Math.sin(x) * PAN_MONO_COMP
      expect(l * l + r * r).toBeCloseTo(2, 12)
    }
    // Centre: exactly the loudness the straight connection had (botTell's by-ear tuning).
    expect(Math.cos(Math.PI / 4) * PAN_MONO_COMP).toBeCloseTo(1, 12)
  })
})

describe('remoteStepMix — the quiet law, same shape as remote gunfire', () => {
  afterEach(() => resetRemoteStepVoiceGate())

  test('level = LEVEL_0 × attenuation; quadratic, monotone, exactly 0 at and past 22 m', () => {
    expect(remoteStepMix(0).level).toBe(REMOTE_STEP_LEVEL_0)
    expect(remoteStepMix(0).attenuation).toBe(1)
    expect(remoteStepLevel(-3)).toBe(REMOTE_STEP_LEVEL_0)
    let previous = Number.POSITIVE_INFINITY
    for (let d = 0; d <= 30; d += 0.25) {
      const m = remoteStepMix(d)
      expect(m.level).toBeCloseTo(REMOTE_STEP_LEVEL_0 * m.attenuation, 12)
      expect(m.level).toBeLessThanOrEqual(previous)
      expect(m.attenuation).toBeGreaterThanOrEqual(0)
      expect(m.attenuation).toBeLessThanOrEqual(1)
      previous = m.level
    }
    expect(remoteStepAttenuation(REMOTE_STEP_MAX_M)).toBe(0)
    expect(remoteStepMix(REMOTE_STEP_MAX_M + 10).level).toBe(0)
    expect(remoteStepMix(REMOTE_STEP_MAX_M / 2).level).toBeCloseTo(REMOTE_STEP_LEVEL_0 / 4, 9)
  })

  test('air cutoff falls with distance and floors; delay is d/343 s capped at 0.1', () => {
    expect(remoteStepCutoffHz(0)).toBe(2400)
    expect(remoteStepCutoffHz(10)).toBe(1600)
    expect(remoteStepCutoffHz(100)).toBe(600)
    expect(remoteStepMix(0).delayS).toBe(0)
    expect(remoteStepMix(10).delayS).toBeCloseTo(10 / SPEED_OF_SOUND_MS, 12)
    expect(remoteStepMix(20).delayS).toBeCloseTo(20 / SPEED_OF_SOUND_MS, 12)
    expect(remoteStepMix(60).delayS).toBe(0.1)
  })

  test('a peer at 3 m steps about as loud as their gun would (the laws agree near)', () => {
    // Both laws normalized to their own point-blank level: within 10 % at 3 m,
    // so a shooter's steps and shots read as coming from the same body.
    const step = remoteStepMix(3).attenuation
    const shot = remoteShotMix(3).level
    expect(Math.abs(step - shot)).toBeLessThan(0.1)
  })

  test(`governor: ${REMOTE_STEP_VOICE_CAP} steps per ${REMOTE_STEP_WINDOW_MS} ms, then a fresh window`, () => {
    for (let i = 0; i < REMOTE_STEP_VOICE_CAP; i++) expect(remoteStepVoiceGate(5000)).toBe('voice')
    expect(remoteStepVoiceGate(5000 + REMOTE_STEP_WINDOW_MS)).toBe('skip')
    expect(remoteStepVoiceGate(5000 + REMOTE_STEP_WINDOW_MS + 1)).toBe('voice')
  })

  test('sfx.remoteFootstep is a silent no-op headless (any distance, pan, intensity)', () => {
    expect(() => sfx.remoteFootstep(3, 0.2)).not.toThrow()
    expect(() => sfx.remoteFootstep(0, -2, 0.3)).not.toThrow()
    expect(() => sfx.remoteFootstep(100, Number.NaN)).not.toThrow()
    expect(() => sfx.botTell('dog', 4, 0.5)).not.toThrow()
  })
})

describe('footstepMix — a walk is softer and duller than a run', () => {
  test('pace 1 is the pre-intensity voice; monotone in gain and brightness', () => {
    expect(footstepMix().gain).toBeCloseTo(0.16, 12)
    expect(footstepMix().freq).toBe(380)
    let g = -1
    let f = -1
    for (let p = 0; p <= 1; p += 0.1) {
      const m = footstepMix(p)
      expect(m.gain).toBeGreaterThan(g)
      expect(m.freq).toBeGreaterThan(f)
      g = m.gain
      f = m.freq
    }
    // A walk is quieter but still a step, not a whisper (≥ half the run's gain).
    expect(footstepMix(0).gain).toBeGreaterThanOrEqual(0.16 * 0.5)
  })

  test('clamps and tolerates junk', () => {
    expect(footstepMix(4)).toEqual(footstepMix(1))
    expect(footstepMix(-1)).toEqual(footstepMix(0))
    expect(footstepMix(Number.NaN)).toEqual(footstepMix(1))
    expect(() => sfx.footstep(0.4)).not.toThrow()
  })
})

describe('landMix — a heavier landing thumps lower and louder', () => {
  /** What player.tsx sends for a landing at `fallSpeed` m/s: feel.landDepth / LAND_DIP_MAX. */
  const liveDepth = (fallSpeed: number) =>
    Math.min(FEEL.LAND_DIP_MAX, Math.max(FEEL.LAND_DIP_MIN, fallSpeed * FEEL.LAND_DIP_PER_MS)) / FEEL.LAND_DIP_MAX

  test('the default depth IS the standing jump the game sends, and reproduces the old thump exactly', () => {
    // A jump leaves at MOVE.jumpSpeed and lands at the same speed; the default is
    // derived from that, not pinned — a pinned 0.5 was a depth no jump ever produced.
    expect(LAND_DEFAULT_DEPTH).toBeCloseTo(liveDepth(MOVE.jumpSpeed), 12)
    expect(LAND_DEFAULT_DEPTH).toBeGreaterThan(0.6)
    expect(LAND_DEFAULT_DEPTH).toBeLessThan(0.7)
    const m = landMix()
    expect(m.thumpHz).toBeCloseTo(95, 12)
    expect(m.thumpS).toBeCloseTo(0.1, 12)
    expect(m.thumpGain).toBeCloseTo(0.3, 12)
    expect(m.burstGain).toBeCloseTo(0.2, 12)
    expect(m.subGain).toBe(0)
    expect(landMix(LAND_DEFAULT_DEPTH)).toEqual(m)
    expect(landMix(liveDepth(MOVE.jumpSpeed))).toEqual(m)
  })

  test('live range: the softest voiced landing is softer than a jump, and no jump reaches the sub-thump', () => {
    const ledge = landMix(liveDepth(FEEL.LAND_SFX_FALL)) // the 4 m/s threshold that voices at all
    const jump = landMix(LAND_DEFAULT_DEPTH)
    expect(ledge.thumpGain).toBeLessThan(jump.thumpGain)
    expect(ledge.thumpHz).toBeGreaterThan(jump.thumpHz)
    expect(ledge.thumpS).toBeLessThan(jump.thumpS)
    expect(ledge.subGain).toBe(0)
    // Even a jump that fell one whole max-dt frame further stays under the sub-thump.
    const lateFrame = liveDepth(MOVE.jumpSpeed + MOVE.gravity * FEEL.DT_MAX)
    expect(lateFrame).toBeLessThan(LAND_SUB_DEPTH)
    expect(landMix(lateFrame).subGain).toBe(0)
    // A real drop does get it, in full at the dip ceiling.
    expect(landMix(1).subGain).toBeCloseTo(0.3, 12)
  })

  test('deeper → lower pitch, more gain, longer, and a sub-thump only past LAND_SUB_DEPTH', () => {
    let hz = Number.POSITIVE_INFINITY
    let gain = -1
    let s = -1
    for (let k = 0; k <= 20; k++) {
      const d = k / 20
      const m = landMix(d)
      expect(m.thumpHz).toBeLessThan(hz)
      expect(m.thumpGain).toBeGreaterThan(gain)
      expect(m.thumpS).toBeGreaterThan(s)
      hz = m.thumpHz
      gain = m.thumpGain
      s = m.thumpS
      if (d <= LAND_SUB_DEPTH) expect(m.subGain).toBe(0)
      else expect(m.subGain).toBeGreaterThan(0)
    }
    // The heaviest thump still sits well under the limiter's flood level.
    expect(landMix(1).thumpGain + landMix(1).subGain).toBeLessThan(0.8)
  })

  test('clamps and tolerates junk', () => {
    expect(landMix(3)).toEqual(landMix(1))
    expect(landMix(-2)).toEqual(landMix(0))
    expect(landMix(Number.NaN)).toEqual(landMix())
    expect(() => sfx.land(1)).not.toThrow()
    expect(() => sfx.land()).not.toThrow()
  })
})

describe('hurtMix — a bigger hit is a sharper hurt', () => {
  test('the default amount (a droid swing) reproduces the old voice: 140 Hz sawtooth, 0.12 s, 0.4, no crack', () => {
    const m = hurtMix()
    expect(m.thumpHz).toBeCloseTo(140, 12)
    expect(m.thumpS).toBeCloseTo(0.12, 12)
    expect(m.thumpGain).toBeCloseTo(0.4, 12)
    expect(m.crackGain).toBe(0)
    expect(hurtMix(HURT_DEFAULT_DMG)).toEqual(m)
  })

  test('a PvP round (10) has no crack; a grenade at your feet (≥ 40) is the sharpest', () => {
    expect(hurtMix(10).crackGain).toBe(0)
    expect(hurtMix(10).thumpHz).toBeLessThan(hurtMix().thumpHz)
    const full = hurtMix(HURT_FULL_DMG)
    expect(full.crackGain).toBeCloseTo(0.4, 12)
    expect(full.thumpHz).toBe(175)
    expect(hurtMix(90)).toEqual(full) // capped
    let hz = -1
    let gain = -1
    let s = Number.POSITIVE_INFINITY
    let crack = -1
    for (let a = 0; a <= HURT_FULL_DMG; a += 4) {
      const m = hurtMix(a)
      expect(m.thumpHz).toBeGreaterThan(hz) // sharper = higher
      expect(m.thumpGain).toBeGreaterThan(gain) // louder
      expect(m.thumpS).toBeLessThan(s) // shorter
      expect(m.crackGain).toBeGreaterThanOrEqual(crack)
      hz = m.thumpHz
      gain = m.thumpGain
      s = m.thumpS
      crack = m.crackGain
    }
  })

  test('junk amounts fall back to the default; the voice never throws headless', () => {
    expect(hurtMix(Number.NaN)).toEqual(hurtMix())
    expect(hurtMix(-5)).toEqual(hurtMix(0))
    expect(() => sfx.damage(50)).not.toThrow()
    expect(() => sfx.damage()).not.toThrow()
  })
})

describe('audioDebug — the headless-QA read of the mix', () => {
  test('without WebAudio: no context, no master chain, muffle open, plain counters', () => {
    const d = audioDebug()
    expect(d.hasWebAudio).toBe(false)
    expect(d.state).toBe('none')
    expect(d.masterChain).toBe(false)
    expect(d.muffleHz).toBe(19000)
    expect(typeof d.voiced.remoteSteps).toBe('number')
    expect(typeof d.voiced.remoteShots).toBe('number')
    // A fresh copy each call — never the live counter object.
    expect(audioDebug().voiced).not.toBe(d.voiced)
  })

  test('headless, a remote step over range or over the governor is counted as skipped, never voiced', () => {
    resetRemoteStepVoiceGate()
    const before = audioDebug().voiced
    sfx.remoteFootstep(REMOTE_STEP_MAX_M + 8, 0) // out of range: a skip, not "never called"
    sfx.remoteFootstep(REMOTE_STEP_MAX_M, 0.5) // exactly at the cutoff is silence too
    for (let i = 0; i < REMOTE_STEP_VOICE_CAP + 3; i++) sfx.remoteFootstep(2, 0) // 3 over the governor
    const after = audioDebug().voiced
    expect(after.remoteSteps).toBe(before.remoteSteps) // no context → nothing voiced
    expect(after.remoteStepsSkipped - before.remoteStepsSkipped).toBe(2 + 3)
    resetRemoteStepVoiceGate()
  })

  test('remote shots and bot tells out of range are skips too; local voices count nothing without WebAudio', () => {
    resetRemoteShotVoiceGate()
    const before = audioDebug().voiced
    sfx.remoteShot('rifle', REMOTE_SHOT_MAX_M + 10)
    sfx.botTell('droid', REMOTE_SHOT_MAX_M + 10)
    sfx.botTell('dog', 4) // in range but no context: neither voiced nor skipped
    sfx.footstep(1)
    sfx.land()
    sfx.damage(25)
    const after = audioDebug().voiced
    expect(after.remoteShotsSkipped - before.remoteShotsSkipped).toBe(1)
    expect(after.botTellsSkipped - before.botTellsSkipped).toBe(1)
    expect(after.remoteShots).toBe(before.remoteShots)
    expect(after.botTells).toBe(before.botTells)
    // "Voiced" = a graph actually built into the master chain — none exists headless.
    expect(after.footsteps).toBe(before.footsteps)
    expect(after.lands).toBe(before.lands)
    expect(after.hurts).toBe(before.hurts)
    resetRemoteShotVoiceGate()
  })
})
