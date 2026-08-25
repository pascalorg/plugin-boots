/**
 * Procedural SFX — no assets, no copyright, all WebAudio synthesis. The
 * palette chases the classic tactical-FPS timbres: dry noise-crack gunshots
 * with a low thump and a short slap-back, cadenced cloth-on-concrete
 * footsteps, glass as a burst of inharmonic partials. Materials get distinct
 * voices: papery drywall, knocking/cracking wood studs, creaking doors.
 *
 * One shared AudioContext behind a soft limiter; every voice is fire-and-
 * forget with envelope-driven gain so nothing needs manual cleanup.
 *
 * Master chain: compressor → lowpass ("muffle", 19kHz open) → gain → out.
 * Damage-feel hooks (driven from enemies.tsx off health/stagger):
 * - sfx.setMuffle(0..1) — concussion: sweeps the master lowpass 19kHz→700Hz.
 * - sfx.heartbeat() — looping lub-dub, returns { setRate, setLevel, stop }.
 * - heartbeatBpm(health) — THE single severity→bpm mapping. Both the audible
 *   heartbeat (enemies.tsx: `handle.setRate(heartbeatBpm(health))`) and the
 *   HUD's red pulse (hud.ts beat()) must use it so they never drift apart.
 * - setHeartbeatPulseListener(cb) — phase hook: cb(delayMs) fires once per
 *   scheduled audible lub, delayMs before it sounds. hud.ts registers its
 *   beatPulse() here on mount so the visual pulse lands on the sound.
 *
 * Loop voices (both null-safe: null without WebAudio, stop() idempotent):
 * - sfx.droneBuzz() — { setIntensity(0..1), stop } fixed-pitch hover buzz.
 * - sfx.machineSpinup() — { setProgress(0..1), stop } gear-up countdown
 *   voice: distant machinery waking up. progress sweeps pitch 50→180Hz,
 *   lowpass 350→2200Hz, AM 18→40Hz and level 0→~0.09 (capped so it stays
 *   distant) on short smoothed ramps — call setProgress freely, no zipper.
 */

/** Health at/below which the low-HP heartbeat (audio + HUD pulse) engages. */
export const HEARTBEAT_HP = 45

/** Low-HP severity 0..1: 0 at/above HEARTBEAT_HP, 1 at 0hp. */
export function lowHpSeverity(health: number): number {
  return Math.min(1, Math.max(0, (HEARTBEAT_HP - health) / HEARTBEAT_HP))
}

/**
 * Single source of truth for heartbeat pacing: ~70bpm at the 45hp threshold
 * rising to 150bpm at 0hp. Used by hud.ts's vignette pulse and meant for
 * enemies.tsx's `heartbeat().setRate(...)` — same curve, zero drift.
 */
export function heartbeatBpm(health: number): number {
  return 70 + 80 * lowHpSeverity(health)
}

/**
 * Called once per scheduled audible lub with the ms until it sounds, so the
 * HUD can phase-lock its visual pulse. Registered by hud.ts on mount; pass
 * null to clear. Silent beats (level ~0) do NOT fire it — the HUD falls back
 * to self-timing at heartbeatBpm().
 */
let heartbeatPulseListener: ((delayMs: number) => void) | null = null
export function setHeartbeatPulseListener(cb: ((delayMs: number) => void) | null): void {
  heartbeatPulseListener = cb
}

/** Muffle sweep endpoints — fully open vs. concussed. */
const MUFFLE_OPEN_HZ = 19000
const MUFFLE_CLOSED_HZ = 700

let ctx: AudioContext | null = null
let master: DynamicsCompressorNode | null = null
let muffleFilter: BiquadFilterNode | null = null
let noiseBuffer: AudioBuffer | null = null

function ensureContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    ctx = new Ctor()
    master = ctx.createDynamicsCompressor()
    master.threshold.value = -18
    master.ratio.value = 12
    master.attack.value = 0.002
    master.release.value = 0.12
    muffleFilter = ctx.createBiquadFilter()
    muffleFilter.type = 'lowpass'
    muffleFilter.frequency.value = MUFFLE_OPEN_HZ
    muffleFilter.Q.value = 0.7
    const gain = ctx.createGain()
    gain.gain.value = 0.5
    master.connect(muffleFilter)
    muffleFilter.connect(gain)
    gain.connect(ctx.destination)
  }
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}

function noise(c: AudioContext): AudioBuffer {
  if (noiseBuffer) return noiseBuffer
  const buffer = c.createBuffer(1, c.sampleRate, c.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  noiseBuffer = buffer
  return buffer
}

/**
 * Round-robin ±8% pitch/filter variance — cycling a fixed detune table
 * guarantees consecutive one-shots never land identical (pure random can),
 * so repeated footsteps/shots/crunches don't fatigue the ear.
 */
const RR_STEPS = [1, 1.06, 0.94, 1.03, 0.92, 1.08, 0.97, 1.05] as const
let rrIndex = 0
function rr(): number {
  rrIndex = (rrIndex + 1) % RR_STEPS.length
  return RR_STEPS[rrIndex] ?? 1
}

type BurstOpts = {
  duration: number
  gain: number
  filterType?: BiquadFilterType
  freq?: number
  freqEnd?: number
  q?: number
  delay?: number
}

/** Enveloped noise through a filter — the workhorse voice. */
function burst(o: BurstOpts, when = 0): void {
  const c = ensureContext()
  if (!c || !master) return
  const t = c.currentTime + when
  const src = c.createBufferSource()
  src.buffer = noise(c)
  src.loop = true
  const filter = c.createBiquadFilter()
  filter.type = o.filterType ?? 'bandpass'
  filter.frequency.setValueAtTime(o.freq ?? 1200, t)
  if (o.freqEnd) filter.frequency.exponentialRampToValueAtTime(o.freqEnd, t + o.duration)
  filter.Q.value = o.q ?? 0.8
  const gain = c.createGain()
  gain.gain.setValueAtTime(o.gain, t)
  gain.gain.exponentialRampToValueAtTime(0.0001, t + o.duration)
  src.connect(filter)
  filter.connect(gain)
  gain.connect(master)
  src.start(t)
  src.stop(t + o.duration + 0.05)
}

/** Short pitched thump — body for shots, lands, thunks. */
function thump(freq: number, duration: number, gainValue: number, when = 0, type: OscillatorType = 'sine'): void {
  const c = ensureContext()
  if (!c || !master) return
  const t = c.currentTime + when
  const osc = c.createOscillator()
  osc.type = type
  osc.frequency.setValueAtTime(freq, t)
  osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq * 0.4), t + duration)
  const gain = c.createGain()
  gain.gain.setValueAtTime(gainValue, t)
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration)
  osc.connect(gain)
  gain.connect(master)
  osc.start(t)
  osc.stop(t + duration + 0.05)
}

/** Handle returned by sfx.machineSpinup() — the 5s gear-up countdown voice. */
export type MachineSpinupHandle = {
  setProgress: (p: number) => void
  stop: () => void
}

/** Handle returned by sfx.heartbeat(). */
export type HeartbeatHandle = {
  setRate: (bpm: number) => void
  setLevel: (v: number) => void
  stop: () => void
}

export const sfx = {
  resume(): void {
    ensureContext()
  },

  /**
   * Concussion muffle, 0 (clear) → 1 (fully concussed). Sweeps the master
   * lowpass from 19kHz down to 700Hz on an exponential curve, smoothed over
   * ~80ms. Driven from enemies.tsx on stagger edges — this module only
   * exposes the knob.
   */
  setMuffle(v: number): void {
    const c = ensureContext()
    if (!c || !muffleFilter) return
    const x = Math.min(1, Math.max(0, v))
    const freq = MUFFLE_OPEN_HZ * (MUFFLE_CLOSED_HZ / MUFFLE_OPEN_HZ) ** x
    muffleFilter.frequency.setTargetAtTime(freq, c.currentTime, 0.08)
  },

  /**
   * Looping heartbeat — a lub-dub pair (90Hz then 70Hz thumps, 120ms apart)
   * scheduled sample-accurately via a 100ms lookahead interval, so the pulse
   * stays steady even when the tab hiccups. setRate/setLevel take effect on
   * the next unscheduled beat. Starts silent-safe: with level 0 the timer
   * runs but schedules nothing. Driven from enemies.tsx off health — feed
   * setRate with heartbeatBpm(health) (the shared mapping, see header) so
   * audio and HUD stay in step. Each audible lub also pings the registered
   * heartbeat-pulse listener (see setHeartbeatPulseListener). Always returns
   * a handle (no-op without WebAudio).
   */
  heartbeat(): HeartbeatHandle {
    const c = ensureContext()
    let bpm = 60
    let level = 0.5
    const LOOKAHEAD = 0.3
    let nextBeat = c ? c.currentTime + 0.05 : 0
    const schedule = () => {
      if (!c || !master) return
      const now = c.currentTime
      if (nextBeat < now) nextBeat = now + 0.02 // resync after throttling
      while (nextBeat < now + LOOKAHEAD) {
        if (level > 0.001) {
          const when = nextBeat - now
          thump(90, 0.14, 0.5 * level, when) // lub
          thump(70, 0.16, 0.4 * level, when + 0.12) // dub
          heartbeatPulseListener?.(when * 1000) // phase-lock the HUD pulse
        }
        nextBeat += 60 / bpm
      }
    }
    const timer = c ? setInterval(schedule, 100) : null
    if (c) schedule()
    return {
      setRate: (v: number) => {
        bpm = Math.min(220, Math.max(20, v))
      },
      setLevel: (v: number) => {
        level = Math.min(1, Math.max(0, v))
      },
      stop: () => {
        if (timer) clearInterval(timer)
      },
    }
  },

  pistolShot(): void {
    const v = rr()
    burst({ duration: 0.09, gain: 0.9, filterType: 'highpass', freq: 900 * v })
    burst({ duration: 0.05, gain: 0.5, freq: 3200 * v, q: 0.6 })
    thump(150 * v, 0.1, 0.8)
    // slap-back
    burst({ duration: 0.06, gain: 0.16, filterType: 'highpass', freq: 700 * v }, 0.07)
  },

  rifleShot(): void {
    const v = rr()
    burst({ duration: 0.11, gain: 1.0, filterType: 'highpass', freq: 600 * v })
    burst({ duration: 0.07, gain: 0.5, freq: 2400 * v, q: 0.5 })
    thump(110 * v, 0.13, 0.9)
    burst({ duration: 0.09, gain: 0.2, filterType: 'highpass', freq: 500 * v }, 0.08)
  },

  knifeSwing(): void {
    burst({ duration: 0.12, gain: 0.25, freq: 2600, freqEnd: 700, q: 1.4 })
  },

  knifeHit(): void {
    burst({ duration: 0.05, gain: 0.4, freq: 1800, q: 2 })
    thump(240, 0.06, 0.35)
  },

  voxelCrunch(intensity = 1): void {
    const v = rr()
    burst({ duration: 0.1, gain: 0.35 * intensity, freq: 900 * v, freqEnd: 300 * v, q: 0.7 })
    thump(120 * v, 0.09, 0.3 * intensity)
  },

  /** Soft papery powder crunch — drier and lighter than voxelCrunch. */
  drywallCrunch(intensity = 1): void {
    const v = rr()
    burst({ duration: 0.09, gain: 0.3 * intensity, freq: 600 * v, freqEnd: 250 * v, q: 0.9 })
    // tiny dust tail
    burst({ duration: 0.12, gain: 0.07 * intensity, filterType: 'highpass', freq: 3800 * v }, 0.025)
  },

  /** Sharp wood crack: hot burst + resonant body + trailing splinter ticks. */
  studSnap(): void {
    const v = rr()
    burst({ duration: 0.04, gain: 0.85, filterType: 'highpass', freq: 1200 * v, q: 0.7 })
    thump(180 * v, 0.09, 0.5)
    const ticks = 2 + Math.floor(Math.random() * 2)
    let at = 0
    for (let i = 0; i < ticks; i++) {
      at += 0.03 + Math.random() * 0.05
      burst({ duration: 0.025, gain: 0.18, freq: 2200 + Math.random() * 1800, q: 3 }, at)
    }
  },

  /** Dull wood knock — the stud takes the hit but holds. */
  studHit(): void {
    const v = rr()
    thump(160 * v, 0.07, 0.35)
    burst({ duration: 0.04, gain: 0.22, freq: 750 * v, q: 1.4 })
  },

  crumble(size: number): void {
    const n = Math.min(6, 1 + Math.floor(size / 8))
    for (let i = 0; i < n; i++) {
      burst(
        { duration: 0.12, gain: 0.28, freq: 500 + Math.random() * 500, freqEnd: 200, q: 0.8 },
        i * 0.045 + Math.random() * 0.03,
      )
      thump(90 + Math.random() * 60, 0.12, 0.25, i * 0.05)
    }
  },

  /** Framing gives way: rubble like crumble, laced with studSnap cracks. */
  woodCrumble(size: number): void {
    const n = Math.min(5, 1 + Math.floor(size / 8))
    for (let i = 0; i < n; i++) {
      const at = i * 0.05 + Math.random() * 0.03
      burst({ duration: 0.12, gain: 0.26, freq: 400 + Math.random() * 400, freqEnd: 180, q: 0.9 }, at)
      thump(80 + Math.random() * 50, 0.12, 0.24, at)
      if (i % 2 === 0) {
        burst({ duration: 0.035, gain: 0.4, filterType: 'highpass', freq: 1300 + Math.random() * 400 }, at + 0.01)
        burst({ duration: 0.025, gain: 0.15, freq: 2400 + Math.random() * 1600, q: 3 }, at + 0.05 + Math.random() * 0.03)
      }
    }
  },

  glassCrack(): void {
    burst({ duration: 0.08, gain: 0.4, freq: 4200, q: 3 })
    burst({ duration: 0.05, gain: 0.3, freq: 6800, q: 4 }, 0.015)
  },

  glassShatter(): void {
    const c = ensureContext()
    if (!c || !master) return
    for (let i = 0; i < 9; i++) {
      const f = 2400 + Math.random() * 5200
      burst({ duration: 0.14 + Math.random() * 0.2, gain: 0.16, freq: f, q: 6 }, Math.random() * 0.16)
    }
    burst({ duration: 0.25, gain: 0.3, filterType: 'highpass', freq: 3000 })
  },

  footstep(): void {
    burst({
      duration: 0.055,
      gain: 0.16 + Math.random() * 0.05,
      freq: 380 + Math.random() * 240,
      q: 0.9,
    })
  },

  jump(): void {
    burst({ duration: 0.07, gain: 0.14, freq: 500, q: 1 })
  },

  land(): void {
    thump(95, 0.1, 0.3)
    burst({ duration: 0.07, gain: 0.2, freq: 300, q: 0.8 })
  },

  pickup(): void {
    thump(520, 0.05, 0.25, 0, 'square')
    thump(780, 0.06, 0.22, 0.06, 'square')
  },

  weaponSwitch(): void {
    burst({ duration: 0.05, gain: 0.15, freq: 1500, q: 1.2 })
    thump(340, 0.04, 0.12, 0.03, 'triangle')
  },

  reload(): void {
    thump(420, 0.04, 0.2, 0, 'square')
    thump(300, 0.05, 0.2, 0.16, 'square')
    thump(560, 0.04, 0.22, 0.34, 'square')
  },

  dryFire(): void {
    thump(900, 0.03, 0.15, 0, 'square')
  },

  place(): void {
    thump(180, 0.09, 0.4)
    burst({ duration: 0.06, gain: 0.2, freq: 900, q: 1 })
  },

  /** Quiet hinge groan — slow AM wobble on a rising sawtooth. */
  doorCreak(): void {
    const c = ensureContext()
    if (!c || !master) return
    const t = c.currentTime
    const v = rr()
    const osc = c.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(90 * v, t)
    osc.frequency.exponentialRampToValueAtTime(160 * v, t + 0.4)
    const filter = c.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.value = 320 * v
    filter.Q.value = 1.4
    const am = c.createGain()
    am.gain.value = 0.05
    const lfo = c.createOscillator()
    lfo.frequency.value = 7
    const lfoDepth = c.createGain()
    lfoDepth.gain.value = 0.03
    lfo.connect(lfoDepth)
    lfoDepth.connect(am.gain)
    const env = c.createGain()
    env.gain.setValueAtTime(0.0001, t)
    env.gain.exponentialRampToValueAtTime(1, t + 0.05)
    env.gain.setValueAtTime(1, t + 0.3)
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.4)
    osc.connect(filter)
    filter.connect(am)
    am.connect(env)
    env.connect(master)
    osc.start(t)
    lfo.start(t)
    osc.stop(t + 0.45)
    lfo.stop(t + 0.45)
  },

  /** Two short square blips — the latch catching. */
  doorLatch(): void {
    thump(550, 0.035, 0.2, 0, 'square')
    thump(380, 0.035, 0.2, 0.04, 'square')
  },

  hitmarker(): void {
    thump(1100, 0.03, 0.14, 0, 'triangle')
  },

  botHit(): void {
    burst({ duration: 0.05, gain: 0.3, freq: 2200, q: 2.5 })
    thump(200, 0.05, 0.2)
  },

  botDie(): void {
    burst({ duration: 0.2, gain: 0.4, freq: 800, freqEnd: 150, q: 1 })
    thump(80, 0.25, 0.4)
  },

  droneBuzz(): { stop: () => void; setIntensity: (v: number) => void } | null {
    const c = ensureContext()
    if (!c || !master) return null
    const osc = c.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.value = 160
    const lfo = c.createOscillator()
    lfo.frequency.value = 33
    const lfoGain = c.createGain()
    lfoGain.gain.value = 22
    lfo.connect(lfoGain)
    lfoGain.connect(osc.frequency)
    const gain = c.createGain()
    gain.gain.value = 0.0
    osc.connect(gain)
    gain.connect(master)
    osc.start()
    lfo.start()
    return {
      setIntensity: (v: number) => {
        gain.gain.setTargetAtTime(Math.min(0.09, v), c.currentTime, 0.08)
      },
      stop: () => {
        gain.gain.setTargetAtTime(0.0001, c.currentTime, 0.05)
        osc.stop(c.currentTime + 0.3)
        lfo.stop(c.currentTime + 0.3)
      },
    }
  },

  /**
   * Distant machinery waking up — the gear-up countdown voice. A sawtooth
   * rises 50→180Hz through a lowpass opening 350→2200Hz, with a slow AM
   * tremolo speeding 18→40Hz and level swelling 0→~0.09 (hard ceiling so it
   * reads as far-away), ALL driven by setProgress(0..1). Targets move on
   * short setTargetAtTime ramps, so per-frame setProgress calls are smooth
   * (no zipper) and allocation-free. Routes through the master chain, so
   * setMuffle concusses it like everything else. stop() ramps to silence,
   * then the ended oscillators disconnect the chain; stop is idempotent and
   * setProgress after stop is a no-op. Returns null without WebAudio.
   */
  machineSpinup(): MachineSpinupHandle | null {
    const c = ensureContext()
    if (!c || !master) return null
    const osc = c.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.value = 50
    const filter = c.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 350
    filter.Q.value = 0.9
    // Tremolo: idles between ~0.4 and 1.0 of the swell level.
    const am = c.createGain()
    am.gain.value = 0.7
    const lfo = c.createOscillator()
    lfo.frequency.value = 18
    const lfoDepth = c.createGain()
    lfoDepth.gain.value = 0.3
    lfo.connect(lfoDepth)
    lfoDepth.connect(am.gain)
    const gain = c.createGain()
    gain.gain.value = 0.0
    osc.connect(filter)
    filter.connect(am)
    am.connect(gain)
    gain.connect(master)
    osc.start()
    lfo.start()
    let stopped = false
    osc.onended = () => {
      gain.disconnect()
      lfoDepth.disconnect()
    }
    return {
      setProgress: (p: number) => {
        if (stopped) return
        const x = Math.min(1, Math.max(0, p))
        const t = c.currentTime
        osc.frequency.setTargetAtTime(50 + 130 * x, t, 0.1)
        filter.frequency.setTargetAtTime(350 + 1850 * x, t, 0.1)
        lfo.frequency.setTargetAtTime(18 + 22 * x, t, 0.1)
        gain.gain.setTargetAtTime(Math.min(0.09, 0.12 * x), t, 0.08)
      },
      stop: () => {
        if (stopped) return
        stopped = true
        gain.gain.setTargetAtTime(0.0001, c.currentTime, 0.05)
        osc.stop(c.currentTime + 0.35)
        lfo.stop(c.currentTime + 0.35)
      },
    }
  },

  explosion(): void {
    burst({ duration: 0.35, gain: 0.9, filterType: 'lowpass', freq: 900, freqEnd: 120 })
    thump(60, 0.4, 0.8)
    burst({ duration: 0.2, gain: 0.3, filterType: 'highpass', freq: 1500 }, 0.02)
  },

  damage(): void {
    thump(140, 0.12, 0.4, 0, 'sawtooth')
  },
}
