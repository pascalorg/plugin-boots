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
 * Loop voices (stop() always idempotent):
 * - sfx.droneBuzz() — { setIntensity, stop } the shared drone-pack voice
 *   (redesigned 2026-08-28, owner: "super annoying"): a LOW dual-rotor hum
 *   — two detuned sawtooths under a 260Hz lowpass whose ~2.6Hz beating plus
 *   a gentle 11Hz blade-pass AM make the wobble — duty-cycled by a slow
 *   ~0.17Hz swell so it breathes instead of droning. setIntensity keeps the
 *   legacy input scale (a target level ≤ DRONE_LEVEL_MAX, enemies.tsx feeds
 *   (1 − d/22) × 0.09) but the voice SQUARES the normalized value — strong
 *   distance falloff: a drone at half the audible range plays at a quarter
 *   level. ONE voice serves the whole pack (enemies.tsx drives it off the
 *   nearest drone), so concurrency is capped by construction. Returns null
 *   without WebAudio.
 * - sfx.machineSpinup() — { setProgress(0..1), stop } gear-up countdown
 *   voice: distant machinery waking up. progress sweeps pitch 50→180Hz,
 *   lowpass 350→2200Hz, AM 18→40Hz and level 0→~0.09 (capped so it stays
 *   distant) on short smoothed ramps — call setProgress freely, no zipper.
 *   Returns null without WebAudio.
 * - sfx.treeCrackle() — { setIntensity(0..1), stop } burning-tree voice:
 *   irregular bandpassed pops (3→8/s with jitter as intensity rises).
 *   ALWAYS returns a handle (silent no-op without WebAudio) — no null check.
 * - sfx.minigun() — { setSpin(0..1), shot(), stop() } rotary-gun voice: two
 *   detuned saws through a bandpass with barrel-pass AM make the whine
 *   (pitch/brightness/AM rate/level all follow setSpin); shot() layers a
 *   heavy per-round tick, round-robin detuned, sized for ~24/s. The
 *   viewmodel drives it: setSpin every frame from the spin-up state, shot()
 *   per fired round, stop() on unmount/holster. ALWAYS returns a handle
 *   (silent no-op without WebAudio) — no null check.
 * - sfx.sirenLoop() — { start(), stop() } quiet rotating-alarm whine for the
 *   countdown beacon: two alternating triangle tones (720/580Hz, 1.1s full
 *   period) under a slow AM sweep, level ~0.05. start() is idempotent while
 *   running and works again after stop(); ALWAYS returns a handle (silent
 *   no-op without WebAudio) — no null check.
 *
 * Phase-3 material one-shots: paperTear() (drywall skin ripping off in
 * plates), shingleRip() (roof sheet fly-off — drier/shorter than paperTear:
 * layered noise burst over a low deck knock), charSnap() (charred wood
 * breaking — higher/shorter than studSnap). crumble()/woodCrumble() now
 * seat a low rumble bed + drifting dust hiss under the bursts, scaling
 * with `size`, for the heavy slow-lobby collapse feel.
 *
 * Phase-4 one-shots: hammerSmash() — the warhammer's deep thunder crack
 * (60–90Hz thump stack + masonry snap + long dust tail, loud but limited);
 * grenadeBeep() — short 900Hz arming blip for the fuse/HUD pip.
 *
 * Phase-9 juice one-shots: killConfirm() — the bot-kill tick, one low
 * triangle blip, softer than hitmarker(); metalPing() — metallic impact
 * ring for metal-flagged item hits (shooting.ts's spark lane).
 *
 * Phase-6 char-feel: charSnap(depth) — depth = prior snaps on the SAME
 * tree; each successive snap sits ~9% lower with a deeper, longer thunk
 * (trees-destruct passes CHAR_HITS - charHits - 1). emberCrackle() — 2–3
 * soft ember pops for the burnt-crown collapse moment (quiet, well under
 * the limiter). sfx.spray() — { start(), stop() } paint-tool aerosol hiss:
 * looped bandpass noise ~3kHz with a slow ~1.3Hz AM shimmer at level
 * ~0.045; start idempotent while running (works again after stop), stop
 * idempotent; ALWAYS returns a handle (silent no-op without WebAudio).
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

/** Drone-pack voice tuning — see droneBuzz() in the header. The level max
 * is the legacy caller scale: enemies.tsx passes (1 − d/22) × 0.09. */
const DRONE_LEVEL_MAX = 0.09
const DRONE_ROTOR_HZ = 74
const DRONE_DETUNE = 1.036

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

/**
 * Segment-snap voice governor (grenade boom-trim): full studSnap voices
 * allowed per rolling window before the flood collapses. Pure window math,
 * exported for tests; studSnap feeds it performance.now().
 */
export const SNAP_WINDOW_MS = 120
export const SNAP_VOICE_CAP = 5
let snapWindowStart = Number.NEGATIVE_INFINITY
let snapWindowCount = 0

/**
 * One call per would-be snap voice: 'snap' voices the normal crack (calls
 * 1..CAP of a window), 'crack' voices the single collapsed meaty crack
 * (call CAP+1), 'skip' is silent (the rest of the window). A gap longer
 * than SNAP_WINDOW_MS since the window OPENED starts a fresh window.
 */
export function snapVoiceGate(nowMs: number): 'snap' | 'crack' | 'skip' {
  if (nowMs - snapWindowStart > SNAP_WINDOW_MS) {
    snapWindowStart = nowMs
    snapWindowCount = 0
  }
  snapWindowCount++
  if (snapWindowCount <= SNAP_VOICE_CAP) return 'snap'
  return snapWindowCount === SNAP_VOICE_CAP + 1 ? 'crack' : 'skip'
}

/** Test hook — clears the rolling window (module state survives across
 * bun test files otherwise). */
export function resetSnapVoiceGate(): void {
  snapWindowStart = Number.NEGATIVE_INFINITY
  snapWindowCount = 0
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

/** Handle returned by sfx.treeCrackle() — the burning-tree pop loop. */
export type TreeCrackleHandle = {
  setIntensity: (v: number) => void
  stop: () => void
}

/** Handle returned by sfx.minigun() — whine loop + per-shot tick. */
export type MinigunHandle = {
  setSpin: (v: number) => void
  shot: () => void
  stop: () => void
}

/** Handle returned by sfx.sirenLoop() — the countdown beacon alarm. */
export type SirenLoopHandle = {
  start: () => void
  stop: () => void
}

/** Handle returned by sfx.spray() — the paint-tool aerosol hiss loop. */
export type SprayHandle = {
  start: () => void
  stop: () => void
}

export const sfx = {
  resume(): void {
    ensureContext()
  },

  /**
   * Pre-pay every first-use audio cost during a loading beat (perf round
   * 2026-08-27, minigun finding A3): builds the context + master chain,
   * fills the 1-second noise buffer (a 48k-iteration JS loop that otherwise
   * lands inside the FIRST gunshot's frame) and runs one inaudible burst so
   * the whole source→filter→gain→master path has voiced once. Idempotent
   * and near-free after the first call; silent no-op without WebAudio.
   * warmup.tsx calls it at session start — inside the Jump-in user gesture,
   * so the context is allowed to run.
   */
  prime(): void {
    const c = ensureContext()
    if (!c || !master) return
    noise(c)
    burst({ duration: 0.02, gain: 0.0001, freq: 1000 })
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

  /**
   * Dry gypsum rip — a drywall plate tearing off the studs. Two short bright
   * noise tears (bandpass sweeping through the 1.4–2.6kHz paper band, 60–90ms)
   * a hair apart, then a papery crumple tail of tiny high crinkles falling
   * away. Round-robin detuned — plates rip in runs.
   */
  paperTear(): void {
    const v = rr()
    burst({ duration: 0.06 + Math.random() * 0.02, gain: 0.5, freq: 1400 * v, freqEnd: 2600 * v, q: 1.5 })
    burst(
      { duration: 0.07 + Math.random() * 0.02, gain: 0.42, freq: 2500 * v, freqEnd: 1450 * v, q: 1.5 },
      0.045 + Math.random() * 0.025,
    )
    // papery crumple tail
    let at = 0.09
    for (let i = 0; i < 3; i++) {
      at += 0.03 + Math.random() * 0.045
      burst({ duration: 0.025, gain: 0.13 - i * 0.035, filterType: 'highpass', freq: 3200 + Math.random() * 2200 }, at)
    }
  },

  /**
   * Shingle sheet ripping off the roof deck (MULTILEVEL-PLAN Phase C) —
   * DRIER and SHORTER than paperTear: asphalt granules shear, they don't
   * crinkle. One tight mid noise tear (lower band than the drywall paper
   * sweep) layered with a hot granular scrape, seated on a low deck knock,
   * then a single gritty tick — no papery crumple tail. Round-robin
   * detuned; the destruction manager voices it on roof-sheet fly-offs
   * where drywall sheets call paperTear().
   */
  shingleRip(): void {
    const v = rr()
    // dry mid tear — the mat shearing off the deck
    burst({ duration: 0.045 + Math.random() * 0.015, gain: 0.5, freq: 950 * v, freqEnd: 1900 * v, q: 1.1 })
    // granular scrape layered right on top
    burst({ duration: 0.05, gain: 0.3, filterType: 'highpass', freq: 2700 * v, q: 0.7 }, 0.015)
    // low knock — the deck thud under the sheet letting go
    thump(120 * v, 0.07, 0.4, 0.01)
    // one gritty tick, then silence (drier than paperTear's crumple tail)
    burst({ duration: 0.03, gain: 0.12, freq: 1600 + Math.random() * 900, q: 2.5 }, 0.075)
  },

  /**
   * Sharp wood crack: hot burst + resonant body + trailing splinter ticks.
   * FLOOD-GATED (boom-trim 2026-08-27): a grenade snaps up to 48 framing
   * segments in one burst and each snap calls this — the ear can't tell 48
   * overlapping cracks from a handful, but the mixer pays ~5 node chains
   * per voice. snapVoiceGate caps full voices per rolling window; the first
   * call past the cap collapses into ONE meatier "whole bay letting go"
   * crack, the rest of the window is silent. Single snaps (a rifle shot
   * breaking one stud) always voice — the window only bites on floods.
   */
  studSnap(): void {
    const gate = snapVoiceGate(performance.now())
    if (gate === 'skip') return
    const v = rr()
    if (gate === 'crack') {
      // The collapsed flood voice: hotter attack, doubled deeper body, a
      // spray of splinter ticks — one voice standing in for dozens.
      burst({ duration: 0.055, gain: 1, filterType: 'highpass', freq: 950 * v, q: 0.7 })
      thump(140 * v, 0.14, 0.65)
      thump(90 * v, 0.2, 0.45, 0.025)
      let sprayAt = 0
      for (let i = 0; i < 4; i++) {
        sprayAt += 0.025 + Math.random() * 0.04
        burst({ duration: 0.025, gain: 0.16, freq: 2000 + Math.random() * 2000, q: 3 }, sprayAt)
      }
      return
    }
    burst({ duration: 0.04, gain: 0.85, filterType: 'highpass', freq: 1200 * v, q: 0.7 })
    thump(180 * v, 0.09, 0.5)
    const ticks = 2 + Math.floor(Math.random() * 2)
    let at = 0
    for (let i = 0; i < ticks; i++) {
      at += 0.03 + Math.random() * 0.05
      burst({ duration: 0.025, gain: 0.18, freq: 2200 + Math.random() * 1800, q: 3 }, at)
    }
  },

  /**
   * Brittle charcoal crack — charred wood breaking like a stick of charcoal.
   * Higher and shorter than studSnap: a hot 2kHz-up snap, a small dry knock
   * (no meaty body), and one or two glassy shard ticks.
   *
   * `depth` = how many snaps this tree already took (0 = first): each
   * successive break on the same trunk lands ~9% lower with a deeper,
   * slightly longer knock — the sticks left standing are thicker, closer
   * to the trunk. Clamped 0..4; round-robin variance still applies on top.
   */
  charSnap(depth = 0): void {
    const v = rr()
    const d = Math.min(4, Math.max(0, depth))
    const p = 1 - 0.09 * d // whole-voice pitch drop per prior snap
    burst({ duration: 0.028 + 0.004 * d, gain: 0.75, filterType: 'highpass', freq: 2100 * v * p, q: 0.8 })
    // The knock deepens fastest — successive breaks read as heavier wood.
    thump(320 * v * p * p, 0.05 + 0.012 * d, 0.28 + 0.03 * d)
    const ticks = 1 + Math.floor(Math.random() * 2)
    let at = 0
    for (let i = 0; i < ticks; i++) {
      at += 0.02 + Math.random() * 0.03
      burst({ duration: 0.018, gain: 0.16, freq: (3200 + Math.random() * 2600) * p, q: 4 }, at)
    }
  },

  /**
   * Ember settle — 2–3 soft pops as a burnt crown lets go: tiny bandpassed
   * ticks in the 1–2.6kHz coal band, staggered a few tens of ms apart, plus
   * one faint low ember knock. QUIET by design (peak gain ~0.14, far under
   * the one-shot palette) so a whole grove charring keeps limiter headroom.
   * Round-robin detuned so back-to-back collapses never repeat.
   */
  emberCrackle(): void {
    const v = rr()
    const pops = 2 + Math.floor(Math.random() * 2)
    let at = 0.01
    for (let i = 0; i < pops; i++) {
      burst(
        {
          duration: 0.02 + Math.random() * 0.03,
          gain: 0.14 - i * 0.03,
          freq: (1000 + Math.random() * 1600) * v,
          q: 3,
        },
        at,
      )
      at += 0.045 + Math.random() * 0.07
    }
    thump(140 * v, 0.06, 0.08, 0.02)
  },

  /** Dull wood knock — the stud takes the hit but holds. */
  studHit(): void {
    const v = rr()
    thump(160 * v, 0.07, 0.35)
    burst({ duration: 0.04, gain: 0.22, freq: 750 * v, q: 1.4 })
  },

  /**
   * Warhammer wall smash — deep thunder crack. A 60–90Hz thump stack under
   * a lowpass boom carries the thunder body, a hot highpass snap + mid
   * crack land the masonry break, and a long hiss-and-rumble tail reads as
   * dust pouring off the wall. LOUD by design — the master compressor keeps
   * it inside the mix. Round-robin detuned so chained swings never repeat.
   */
  hammerSmash(): void {
    const v = rr()
    // masonry crack — hot and instant
    burst({ duration: 0.05, gain: 0.9, filterType: 'highpass', freq: 1100 * v, q: 0.7 })
    burst({ duration: 0.08, gain: 0.5, freq: 2300 * v, freqEnd: 900 * v, q: 1.2 })
    // thunder body — stacked 60–90Hz thumps + a lowpass boom
    thump(88 * v, 0.22, 0.85)
    thump(72 * v, 0.3, 0.8, 0.015)
    thump(60, 0.42, 0.75, 0.03)
    burst({ duration: 0.4, gain: 0.75, filterType: 'lowpass', freq: 700, freqEnd: 90 })
    // long dust tail — high debris hiss over a settling rumble
    burst({ duration: 0.7, gain: 0.09, filterType: 'highpass', freq: 4000 * v }, 0.08)
    burst({ duration: 0.55, gain: 0.16, filterType: 'lowpass', freq: 260, freqEnd: 70 }, 0.12)
  },

  /** Rubble fall, weighted: low rumble bed + dust hiss under the bursts. */
  crumble(size: number): void {
    const heavy = Math.min(1, size / 24)
    // rumble bed — the collapse reads heavy, not just clicky
    burst({ duration: 0.28 + 0.3 * heavy, gain: 0.22 + 0.3 * heavy, filterType: 'lowpass', freq: 240, freqEnd: 80 })
    thump(52, 0.26 + 0.22 * heavy, 0.28 + 0.25 * heavy)
    // dust drifting after the impacts
    burst({ duration: 0.3 + 0.35 * heavy, gain: 0.05 + 0.07 * heavy, filterType: 'highpass', freq: 4500 }, 0.06)
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
    const heavy = Math.min(1, size / 24)
    // lighter rumble than masonry, same dust
    burst({ duration: 0.24 + 0.26 * heavy, gain: 0.18 + 0.26 * heavy, filterType: 'lowpass', freq: 220, freqEnd: 85 })
    thump(58, 0.24 + 0.2 * heavy, 0.24 + 0.2 * heavy)
    burst({ duration: 0.28 + 0.3 * heavy, gain: 0.05 + 0.06 * heavy, filterType: 'highpass', freq: 4200 }, 0.05)
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

  /** Heavy electrical knife-switch CLUNK — the breaker throw on the switch
   * wall. Low thunk + metallic snap + a brief contact buzz; ~0.3 s total,
   * deliberately louder than doorLatch (it arms the whole assault). */
  breakerThrow(): void {
    thump(95, 0.14, 0.55) // the low body of the handle slamming home
    burst({ duration: 0.05, gain: 0.45, freq: 2600, freqEnd: 900, q: 3 }) // metallic snap
    thump(300, 0.05, 0.35, 0.03, 'square') // contact clack
    thump(120, 0.22, 0.16, 0.06, 'sawtooth') // brief mains buzz as contacts seat
  },

  hitmarker(): void {
    thump(1100, 0.03, 0.14, 0, 'triangle')
  },

  /** Kill-confirm tick — softer and lower than hitmarker: one triangle
   * blip at low gain (the "that one dropped" cue under the marker flare). */
  killConfirm(): void {
    thump(560, 0.06, 0.12, 0, 'triangle')
  },

  /** Metallic impact ping — a bullet on sheet metal: two high-Q inharmonic
   * ring partials (noise-through-filter rings at Q≥14, the glass idiom)
   * over a small dull body knock. Round-robin detuned so a burst into a
   * fridge doesn't ring identical. */
  metalPing(): void {
    const v = rr()
    burst({ duration: 0.14, gain: 0.32, freq: 3300 * v, q: 14 })
    burst({ duration: 0.1, gain: 0.15, freq: 5170 * v, q: 16 }, 0.004)
    thump(210 * v, 0.05, 0.18)
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
    // Two detuned low rotors — their ~2.6Hz beat is the hum's slow churn.
    const oscA = c.createOscillator()
    oscA.type = 'sawtooth'
    oscA.frequency.value = DRONE_ROTOR_HZ
    const oscB = c.createOscillator()
    oscB.type = 'sawtooth'
    oscB.frequency.value = DRONE_ROTOR_HZ * DRONE_DETUNE
    // Lowpass strips the sawtooth edge — a hum, not the old piercing whine.
    const filter = c.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 260
    filter.Q.value = 0.8
    // Gentle blade-pass amplitude wobble.
    const am = c.createGain()
    am.gain.value = 0.86
    const wobble = c.createOscillator()
    wobble.type = 'sine'
    wobble.frequency.value = 11
    const wobbleDepth = c.createGain()
    wobbleDepth.gain.value = 0.12
    wobble.connect(wobbleDepth)
    wobbleDepth.connect(am.gain)
    // Duty cycle: a slow swell so the threat cue breathes — subtle rises
    // and dips instead of a constant tone.
    const duty = c.createGain()
    duty.gain.value = 0.72
    const swell = c.createOscillator()
    swell.type = 'sine'
    swell.frequency.value = 0.17
    const swellDepth = c.createGain()
    swellDepth.gain.value = 0.28
    swell.connect(swellDepth)
    swellDepth.connect(duty.gain)
    const gain = c.createGain()
    gain.gain.value = 0.0
    oscA.connect(filter)
    oscB.connect(filter)
    filter.connect(am)
    am.connect(duty)
    duty.connect(gain)
    gain.connect(master)
    oscA.start()
    oscB.start()
    wobble.start()
    swell.start()
    oscA.onended = () => {
      gain.disconnect()
      wobbleDepth.disconnect()
      swellDepth.disconnect()
    }
    // Change gate: enemies.tsx calls setIntensity every frame (including a
    // constant 0 with no drones alive) and each call used to write THREE
    // automation-timeline events — ~360/s for the whole session. The
    // setTargetAtTime curves converge on their own, so an unchanged target
    // needs no new events; idle cost drops to one compare.
    let lastN = -1
    return {
      setIntensity: (v: number) => {
        // Legacy input scale (target level ≤ DRONE_LEVEL_MAX) — normalize,
        // then SQUARE: strong distance falloff, near drones still read.
        const n = Math.min(1, Math.max(0, v / DRONE_LEVEL_MAX))
        if (Math.abs(n - lastN) < 1e-4) return
        lastN = n
        const t = c.currentTime
        gain.gain.setTargetAtTime(0.075 * n * n, t, 0.12)
        // Rotors lean up slightly as the pack closes — menace, not siren.
        const f = DRONE_ROTOR_HZ + 14 * n
        oscA.frequency.setTargetAtTime(f, t, 0.25)
        oscB.frequency.setTargetAtTime(f * DRONE_DETUNE, t, 0.25)
      },
      stop: () => {
        gain.gain.setTargetAtTime(0.0001, c.currentTime, 0.05)
        const end = c.currentTime + 0.3
        oscA.stop(end)
        oscB.stop(end)
        wobble.stop(end)
        swell.stop(end)
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

  /**
   * Burning-tree crackle loop — irregular pops through a bandpass, scheduled
   * 3→8 pops/s (with ±40% jitter per gap) as intensity rises 0→1; pop level
   * scales with intensity and every third-or-so pop lands a small ember
   * knock. Same 100ms-lookahead interval scheduler as heartbeat(), so pops
   * keep firing through tab hiccups. setIntensity(0) keeps the timer alive
   * but silent; stop() is idempotent. ALWAYS returns a handle — a silent
   * no-op without WebAudio, so callers never null-check.
   */
  treeCrackle(): TreeCrackleHandle {
    const c = ensureContext()
    let intensity = 0
    let stopped = false
    const LOOKAHEAD = 0.35
    let nextPop = c ? c.currentTime + 0.05 : 0
    const schedule = () => {
      if (!c || !master) return
      const now = c.currentTime
      if (nextPop < now) nextPop = now + 0.02 // resync after throttling
      while (nextPop < now + LOOKAHEAD) {
        if (intensity > 0.01) {
          const when = nextPop - now
          const v = rr()
          burst(
            {
              duration: 0.025 + Math.random() * 0.04,
              gain: (0.08 + 0.22 * intensity) * (0.7 + Math.random() * 0.6),
              freq: (900 + Math.random() * 1900) * v,
              q: 2.5,
            },
            when,
          )
          if (Math.random() < 0.3) thump(110 + Math.random() * 90, 0.06, 0.12 * intensity, when)
        }
        const rate = 3 + 5 * intensity // pops per second
        nextPop += (1 / rate) * (0.6 + Math.random() * 0.8) // jitter
      }
    }
    const timer = c ? setInterval(schedule, 100) : null
    if (c) schedule()
    return {
      setIntensity: (v: number) => {
        intensity = Math.min(1, Math.max(0, v))
      },
      stop: () => {
        if (stopped) return
        stopped = true
        if (timer) clearInterval(timer)
      },
    }
  },

  /**
   * Rotary-gun voice. The whine is two slightly detuned sawtooths through a
   * bandpass with an AM tremolo at the barrel-pass rate: setSpin(0..1)
   * sweeps pitch 70→450Hz, brightness 400→3000Hz, AM 0→27Hz and level
   * 0→~0.11 on short smoothed ramps (drive it every frame, no zipper; spin 0
   * is silent). shot() fires the per-round heavy tick — hot highpass crack,
   * mid snap, low thump — round-robin detuned and sized short enough for a
   * ~24/s cadence without smearing the limiter. stop() ramps the whine out
   * and kills the oscillators; idempotent, and setSpin/shot after stop are
   * no-ops. ALWAYS returns a handle — silent no-op without WebAudio.
   */
  minigun(): MinigunHandle {
    const c = ensureContext()
    if (!c || !master) {
      return { setSpin: () => {}, shot: () => {}, stop: () => {} }
    }
    const oscA = c.createOscillator()
    oscA.type = 'sawtooth'
    oscA.frequency.value = 70
    const oscB = c.createOscillator()
    oscB.type = 'sawtooth'
    oscB.frequency.value = 70 * 1.011 // beating between the pair = mechanical
    const filter = c.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.value = 400
    filter.Q.value = 1.1
    // AM at the barrel-pass rate — six barrels sweeping past the ear.
    const am = c.createGain()
    am.gain.value = 0.75
    const lfo = c.createOscillator()
    lfo.frequency.value = 0
    const lfoDepth = c.createGain()
    lfoDepth.gain.value = 0.25
    lfo.connect(lfoDepth)
    lfoDepth.connect(am.gain)
    const gain = c.createGain()
    gain.gain.value = 0
    oscA.connect(filter)
    oscB.connect(filter)
    filter.connect(am)
    am.connect(gain)
    gain.connect(master)
    oscA.start()
    oscB.start()
    lfo.start()
    let stopped = false
    oscA.onended = () => {
      gain.disconnect()
      lfoDepth.disconnect()
    }
    return {
      setSpin: (s: number) => {
        if (stopped) return
        const x = Math.min(1, Math.max(0, s))
        const t = c.currentTime
        const f = 70 + 380 * x
        oscA.frequency.setTargetAtTime(f, t, 0.06)
        oscB.frequency.setTargetAtTime(f * 1.011, t, 0.06)
        filter.frequency.setTargetAtTime(400 + 2600 * x, t, 0.06)
        lfo.frequency.setTargetAtTime(27 * x, t, 0.06)
        gain.gain.setTargetAtTime(x < 0.02 ? 0 : Math.min(0.11, 0.02 + 0.1 * x), t, 0.05)
      },
      shot: () => {
        if (stopped) return
        const v = rr()
        burst({ duration: 0.035, gain: 0.55, filterType: 'highpass', freq: 1500 * v, q: 0.7 })
        burst({ duration: 0.03, gain: 0.25, freq: 2800 * v, q: 1.2 })
        thump(95 * v, 0.06, 0.4)
      },
      stop: () => {
        if (stopped) return
        stopped = true
        gain.gain.setTargetAtTime(0.0001, c.currentTime, 0.06)
        const end = c.currentTime + 0.4
        oscA.stop(end)
        oscB.stop(end)
        lfo.stop(end)
      },
    }
  },

  /**
   * Quiet rotating-alarm whine — the gun-table siren beacon during the
   * post-pickup countdown. Two alternating triangle tones (720/580Hz, one
   * full swap every 1.1s) ride a slow ~0.9Hz AM sweep — the beacon head
   * passing the ear — at level ~0.05 so it sits far under the guns. Tone
   * flips run on the same lookahead scheduler as heartbeat(), so the
   * alternation survives tab throttling. start() is a no-op while running
   * (and works again after stop()); stop() ramps out, kills the
   * oscillators and is idempotent. ALWAYS returns a handle — silent no-op
   * without WebAudio.
   */
  sirenLoop(): SirenLoopHandle {
    let osc: OscillatorNode | null = null
    let lfo: OscillatorNode | null = null
    let gain: GainNode | null = null
    let timer: ReturnType<typeof setInterval> | null = null
    const HALF = 0.55 // s per tone — full 720/580 period 1.1s
    return {
      start: () => {
        const c = ensureContext()
        if (!c || !master || osc) return
        const o = c.createOscillator()
        o.type = 'triangle'
        o.frequency.value = 720
        // Slow AM — the rotating head sweeping toward and away.
        const am = c.createGain()
        am.gain.value = 0.75
        lfo = c.createOscillator()
        lfo.type = 'sine'
        lfo.frequency.value = 0.9
        const lfoDepth = c.createGain()
        lfoDepth.gain.value = 0.25
        lfo.connect(lfoDepth)
        lfoDepth.connect(am.gain)
        const g = c.createGain()
        g.gain.value = 0
        o.connect(am)
        am.connect(g)
        g.connect(master)
        o.start()
        lfo.start()
        o.onended = () => {
          g.disconnect()
          lfoDepth.disconnect()
        }
        g.gain.setTargetAtTime(0.05, c.currentTime, 0.15)
        osc = o
        gain = g
        let hi = true
        let nextFlip = c.currentTime + HALF
        const schedule = () => {
          const now = c.currentTime
          if (nextFlip < now) nextFlip = now + 0.02 // resync after throttling
          while (nextFlip < now + 0.4) {
            hi = !hi
            o.frequency.setTargetAtTime(hi ? 720 : 580, nextFlip, 0.04)
            nextFlip += HALF
          }
        }
        timer = setInterval(schedule, 150)
        schedule()
      },
      stop: () => {
        if (timer) {
          clearInterval(timer)
          timer = null
        }
        if (!osc || !ctx) return
        gain?.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.08)
        const end = ctx.currentTime + 0.4
        osc.stop(end)
        lfo?.stop(end)
        osc = null
        lfo = null
        gain = null
      },
    }
  },

  /**
   * Soft aerosol hiss loop — the paint tool's spray-can voice. Looped noise
   * through a bandpass parked near 3kHz (round-robin detuned per start so
   * successive coats don't ring identical) with a slow ~1.3Hz AM shimmer —
   * the can's pressure breathing — at level ~0.045: QUIET, it sits under
   * footsteps and never leans on the limiter. start() is a no-op while
   * running and works again after stop(); stop() ramps out over ~80ms and
   * kills the source; both idempotent. ALWAYS returns a handle — silent
   * no-op without WebAudio.
   */
  spray(): SprayHandle {
    let src: AudioBufferSourceNode | null = null
    let lfo: OscillatorNode | null = null
    let gain: GainNode | null = null
    return {
      start: () => {
        const c = ensureContext()
        if (!c || !master || src) return
        const v = rr()
        const s = c.createBufferSource()
        s.buffer = noise(c)
        s.loop = true
        const filter = c.createBiquadFilter()
        filter.type = 'bandpass'
        filter.frequency.value = 3000 * v
        filter.Q.value = 0.9
        // Slow AM — the can breathing as pressure ebbs and swells.
        const am = c.createGain()
        am.gain.value = 0.82
        lfo = c.createOscillator()
        lfo.type = 'sine'
        lfo.frequency.value = 1.3
        const lfoDepth = c.createGain()
        lfoDepth.gain.value = 0.18
        lfo.connect(lfoDepth)
        lfoDepth.connect(am.gain)
        const g = c.createGain()
        g.gain.value = 0
        s.connect(filter)
        filter.connect(am)
        am.connect(g)
        g.connect(master)
        s.start()
        lfo.start()
        s.onended = () => {
          g.disconnect()
          lfoDepth.disconnect()
        }
        g.gain.setTargetAtTime(0.045, c.currentTime, 0.04)
        src = s
        gain = g
      },
      stop: () => {
        if (!src || !ctx) return
        gain?.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.03)
        const end = ctx.currentTime + 0.25
        src.stop(end)
        lfo?.stop(end)
        src = null
        lfo = null
        gain = null
      },
    }
  },

  /**
   * Ball-bearing can rattle — the sprayer shaken awake (R cycle / draw-in;
   * viewmodel.tsx already calls sfx.paintRattle?.() feature-detected).
   * 3–5 short metallic ticks: hot bandpass ping + tiny square knock per
   * tick, 45–90 ms apart, round-robin detuned. Quiet — peak ~0.22.
   */
  paintRattle(): void {
    const v = rr()
    const ticks = 3 + Math.floor(Math.random() * 3)
    let at = 0
    for (let i = 0; i < ticks; i++) {
      burst({ duration: 0.02, gain: 0.22, freq: (2600 + Math.random() * 1400) * v, q: 4 }, at)
      thump(430 * v, 0.03, 0.1, at + 0.004, 'square')
      at += 0.045 + Math.random() * 0.045
    }
  },

  /** Short 900Hz arming blip — the grenade fuse / HUD-pip beep. */
  grenadeBeep(): void {
    const c = ensureContext()
    if (!c || !master) return
    const t = c.currentTime
    const osc = c.createOscillator()
    osc.type = 'square'
    osc.frequency.value = 900
    const gain = c.createGain()
    gain.gain.setValueAtTime(0.16, t)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.06)
    osc.connect(gain)
    gain.connect(master)
    osc.start(t)
    osc.stop(t + 0.08)
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
