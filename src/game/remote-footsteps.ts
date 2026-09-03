import { sfx } from './audio'

/**
 * REMOTE FOOTSTEPS — the sound of other people's planted feet.
 *
 * The gait phase (remote-players.tsx) crosses k·π at the exact instant a drawn
 * foot lands, so the renderer counts those crossings (footPlants) and voices
 * one step per crossing at the peer's distance and bearing. Planted feet with
 * no sound read as half done; a step you hear from your left before you turn
 * is most of what "hearing each other" means in a building.
 *
 * The plant counter is the only thing that lives here: it is gait math, not
 * audio. The distance law (remoteStepMix), the voice governor and the voice
 * itself (sfx.remoteFootstep) live in audio.ts since 2026-09-02, where they
 * share the spatialRig with remote gunfire and bot tells — so a peer's steps
 * sit under the master compressor and the concussion muffle like every other
 * sound with a place in the world (the round-1 build routed them straight to
 * the destination and stayed crisp while a grenade had your ears ringing).
 * The law and the governor are re-exported so nothing that imported them from
 * here has to move.
 */
export {
  REMOTE_STEP_LEVEL_0,
  REMOTE_STEP_MAX_M,
  REMOTE_STEP_VOICE_CAP,
  REMOTE_STEP_WINDOW_MS,
  remoteStepCutoffHz,
  remoteStepLevel,
  remoteStepVoiceGate,
  resetRemoteStepVoiceGate,
} from './audio'

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

/**
 * Voice one remote footstep `distance` metres away, `pan` −1..1 along the
 * listener's right axis, `intensity` the stepper's pace 0..1 (a walk is
 * softer than a run). Delegates to sfx.remoteFootstep — the master-routed
 * voice. Silent no-op beyond range, over the per-window cap, or without
 * WebAudio.
 */
export function remoteFootstep(distance: number, pan = 0, intensity = 1): void {
  sfx.remoteFootstep(distance, pan, intensity)
}
