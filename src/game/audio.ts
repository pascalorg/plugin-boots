/**
 * Procedural SFX — no assets, no copyright, all WebAudio synthesis. The
 * palette chases the classic tactical-FPS timbres: dry noise-crack gunshots
 * with a low thump and a short slap-back, cadenced cloth-on-concrete
 * footsteps, glass as a burst of inharmonic partials.
 *
 * One shared AudioContext behind a soft limiter; every voice is fire-and-
 * forget with envelope-driven gain so nothing needs manual cleanup.
 */

let ctx: AudioContext | null = null
let master: DynamicsCompressorNode | null = null
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
    const gain = ctx.createGain()
    gain.gain.value = 0.5
    master.connect(gain)
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

export const sfx = {
  resume(): void {
    ensureContext()
  },

  pistolShot(): void {
    burst({ duration: 0.09, gain: 0.9, filterType: 'highpass', freq: 900 })
    burst({ duration: 0.05, gain: 0.5, freq: 3200, q: 0.6 })
    thump(150, 0.1, 0.8)
    // slap-back
    burst({ duration: 0.06, gain: 0.16, filterType: 'highpass', freq: 700, delay: 0 }, 0.07)
  },

  rifleShot(): void {
    burst({ duration: 0.11, gain: 1.0, filterType: 'highpass', freq: 600 })
    burst({ duration: 0.07, gain: 0.5, freq: 2400, q: 0.5 })
    thump(110, 0.13, 0.9)
    burst({ duration: 0.09, gain: 0.2, filterType: 'highpass', freq: 500 }, 0.08)
  },

  knifeSwing(): void {
    burst({ duration: 0.12, gain: 0.25, freq: 2600, freqEnd: 700, q: 1.4 })
  },

  knifeHit(): void {
    burst({ duration: 0.05, gain: 0.4, freq: 1800, q: 2 })
    thump(240, 0.06, 0.35)
  },

  voxelCrunch(intensity = 1): void {
    burst({ duration: 0.1, gain: 0.35 * intensity, freq: 900, freqEnd: 300, q: 0.7 })
    thump(120, 0.09, 0.3 * intensity)
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

  explosion(): void {
    burst({ duration: 0.35, gain: 0.9, filterType: 'lowpass', freq: 900, freqEnd: 120 })
    thump(60, 0.4, 0.8)
    burst({ duration: 0.2, gain: 0.3, filterType: 'highpass', freq: 1500 }, 0.02)
  },

  damage(): void {
    thump(140, 0.12, 0.4, 0, 'sawtooth')
  },
}
