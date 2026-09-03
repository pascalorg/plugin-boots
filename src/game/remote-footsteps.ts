import { sharedAudioContext } from './audio'

/**
 * REMOTE FOOTSTEPS — the sound of other people's planted feet.
 *
 * The gait phase (remote-players.tsx) crosses k·π at the exact instant a drawn
 * foot lands, so the renderer counts those crossings (footPlants) and voices
 * one step per crossing at the peer's distance and bearing. Planted feet with
 * no sound read as half done; a step you hear from your left before you turn
 * is most of what "hearing each other" means in a building.
 *
 * Pure cores (level law, plant counter, voice gate) are exported and tested;
 * the voicing is a silent no-op without WebAudio (headless, tests).
 *
 * WHY THIS IS ITS OWN FILE AND NOT `sfx.remoteFootstep`: the mix module
 * (audio.ts) belongs to another lane tonight. This builds the same gain →
 * lowpass → stereo-pan rig the remote gunshot uses, off the shared context, and
 * routes it to the destination directly — so for now footsteps bypass the
 * master compressor and the concussion muffle. Folding it into audio.ts (one
 * `spatialRig` helper for shots and steps, `burst(..., dest)`) is the follow-up.
 */

/** Past this range (m) a footstep is not voiced at all — steps are quiet things. */
export const REMOTE_STEP_MAX_M = 22
/** Level at zero distance — the local footstep's own gain. */
export const REMOTE_STEP_LEVEL_0 = 0.16
/** Voice governor: at most this many steps per rolling window, so a crowd
 * marching past never builds a hundred filter chains (or starves gunfire). */
export const REMOTE_STEP_WINDOW_MS = 250
export const REMOTE_STEP_VOICE_CAP = 16
/** Sound is slow (m/s): a far step lands a beat after the foot does. */
const SPEED_OF_SOUND_MS = 343

/** Level 0..REMOTE_STEP_LEVEL_0 for a step `distance` metres away: a quadratic
 * roll-off to exactly 0 at REMOTE_STEP_MAX_M (monotone, pinned). */
export function remoteStepLevel(distance: number): number {
  const d = distance > 0 ? distance : 0
  if (d >= REMOTE_STEP_MAX_M) return 0
  const w = 1 - d / REMOTE_STEP_MAX_M
  return REMOTE_STEP_LEVEL_0 * w * w
}

/** Lowpass cutoff (Hz) for a step at this distance — the air eats the click first. */
export function remoteStepCutoffHz(distance: number): number {
  const d = distance > 0 ? distance : 0
  const hz = 2400 - 80 * d
  return hz < 600 ? 600 : hz
}

/**
 * How many foot plants happened between two gait phases: the number of k·π
 * crossed going from `prev` to `phase` (either direction). A settle that
 * lands exactly ON k·π counts once; a stationary phase counts none. Capped at
 * 2 — a phase that jumped a whole cycle in one frame is a hitch, not a sprint.
 */
export function footPlants(prev: number, phase: number): number {
  if (!Number.isFinite(prev) || !Number.isFinite(phase) || prev === phase) return 0
  const lo = prev < phase ? prev : phase
  const hi = prev < phase ? phase : prev
  // Multiples of π in (lo, hi]: the plant is the instant we REACH the mark.
  const n = Math.floor(hi / Math.PI) - Math.floor(lo / Math.PI)
  return n > 2 ? 2 : n < 0 ? 0 : n
}

let windowStart = Number.NEGATIVE_INFINITY
let windowCount = 0

export function remoteStepVoiceGate(nowMs: number): 'voice' | 'skip' {
  if (nowMs - windowStart > REMOTE_STEP_WINDOW_MS) {
    windowStart = nowMs
    windowCount = 0
  }
  windowCount++
  return windowCount <= REMOTE_STEP_VOICE_CAP ? 'voice' : 'skip'
}

/** Test hook — module state outlives a test file. */
export function resetRemoteStepVoiceGate(): void {
  windowStart = Number.NEGATIVE_INFINITY
  windowCount = 0
}

let noiseBuffer: AudioBuffer | null = null
/** One second of white noise, built once (the same idiom audio.ts uses). */
function noise(c: AudioContext): AudioBuffer {
  if (noiseBuffer && noiseBuffer.sampleRate === c.sampleRate) return noiseBuffer
  const length = c.sampleRate
  const buffer = c.createBuffer(1, length, c.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1
  noiseBuffer = buffer
  return buffer
}

/**
 * Voice one remote footstep `distance` metres away, `pan` −1..1 along the
 * listener's right axis (softened to ±0.8, like the gunshot). Delayed by the
 * speed of sound. Silent no-op beyond range, over the per-window cap, or
 * without WebAudio.
 */
export function remoteFootstep(distance: number, pan = 0): void {
  const level = remoteStepLevel(distance)
  if (level <= 0.004) return
  if (typeof performance === 'undefined' || remoteStepVoiceGate(performance.now()) === 'skip') return
  const c = sharedAudioContext()
  if (!c) return
  const t = c.currentTime + Math.min(0.1, (distance > 0 ? distance : 0) / SPEED_OF_SOUND_MS)
  const duration = 0.055
  const src = c.createBufferSource()
  src.buffer = noise(c)
  src.loop = true
  const voice = c.createBiquadFilter()
  voice.type = 'bandpass'
  voice.frequency.setValueAtTime(380 + Math.random() * 240, t)
  voice.Q.value = 0.9
  const env = c.createGain()
  env.gain.setValueAtTime(level * (1 + Math.random() * 0.3), t)
  env.gain.exponentialRampToValueAtTime(0.0001, t + duration)
  const air = c.createBiquadFilter()
  air.type = 'lowpass'
  air.frequency.value = remoteStepCutoffHz(distance)
  air.Q.value = 0.7
  src.connect(voice)
  voice.connect(env)
  env.connect(air)
  const panner = typeof c.createStereoPanner === 'function' ? c.createStereoPanner() : null
  if (panner) {
    panner.pan.value = Math.max(-0.8, Math.min(0.8, pan * 0.8))
    air.connect(panner)
    panner.connect(c.destination)
  } else {
    air.connect(c.destination)
  }
  src.start(t)
  src.stop(t + duration + 0.05)
}
