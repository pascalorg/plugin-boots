import { getCollabBus } from './net'
import {
  enableMic,
  loadMicPref,
  type MicPref,
  micState,
  micSupported,
  prefetchIceServers,
  primeVoiceOutputs,
  releaseMic,
  voiceSupported,
} from './voice'

/**
 * THE MIC GATE — the microphone is asked for ON THE VEIL, never mid-entry.
 *
 * enterGame() (session.ts) fires `requestFullscreen` synchronously and the
 * pointer lock as it settles, and it EXITS the game the moment either is lost.
 * A permission bubble opening inside that sequence can end the very first Jump
 * In in exitGame, with the player none the wiser. So every entry button runs
 * through `beginEntry` instead of calling enterGame() directly:
 *
 *   ask-first       → the click becomes the permission prompt ("ALLOW THE MIC ↑",
 *                     button busy). The game is NOT entered. When the dialog
 *                     settles the button reads "⏵ PLAY" and the NEXT click runs
 *                     the plan again — now 'enter-with-mic' or 'enter-silent'.
 *   enter-with-mic  → the browser already said yes: acquire and enter in the
 *                     same click (no dialog can appear).
 *   enter-silent    → the player switched the mic off, the browser refused it,
 *                     or there is nobody to talk to (no bus): just enter — and
 *                     let go of any track an earlier click acquired. The veil
 *                     lets the toggle flip AFTER 'ask-first' brought the mic up
 *                     (the prompt settled, the button reads PLAY, the player
 *                     picks MIC OFF), and a live track carried into the game
 *                     would be swapped into every sender: a hot mic against an
 *                     explicit off.
 *
 * Both audio outputs and the ICE set are primed FIRST, unconditionally, because
 * they need the gesture (iOS) or the head start (a relay fetch) whatever the
 * mic decision is — hearing does not depend on speaking.
 *
 * Store-free and DOM-free: the callers hand in `setLabel`/`enter`, so the drop
 * veil, the re-entry pill and the sidebar button share one flow and this file
 * is testable with fakes.
 */

export type MicPermission = 'granted' | 'prompt' | 'denied' | 'unknown'

export type EntryPlan = 'enter-with-mic' | 'enter-silent' | 'ask-first'

export const ASK_LABEL = 'ALLOW THE MIC ↑'
export const READY_LABEL = '⏵ PLAY'
/** Under the button while the plan is 'ask-first'. */
export const ASK_HINT = 'your browser will ask for the mic'

/**
 * What the browser would do if we asked right now — WITHOUT asking.
 *
 * `navigator.permissions.query({name:'microphone'})` is the direct answer where
 * it exists (Chromium, Safari 16+). Firefox has no microphone descriptor and
 * throws; there, a labelled `audioinput` in `enumerateDevices()` means the
 * origin has been granted before (labels are withheld until it has). No
 * `mediaDevices` at all (an insecure origin, an old webview) reads 'denied':
 * nothing we could ask would succeed.
 */
export async function readMicPermission(): Promise<MicPermission> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return 'denied'
  try {
    const status = await navigator.permissions?.query({ name: 'microphone' as PermissionName })
    const state = status?.state
    if (state === 'granted' || state === 'prompt' || state === 'denied') return state
  } catch {
    // No descriptor for the microphone (Firefox) — fall through to the labels.
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices?.()
    if (devices?.some((device) => device.kind === 'audioinput' && device.label !== '')) {
      return 'granted'
    }
  } catch {
    // enumerateDevices refused: nothing more to learn without asking.
  }
  return 'unknown'
}

let cached: MicPermission = 'unknown'

/** Fire the read (veil mount); the answer is ready by the time the button is. */
export function primeMicPermission(): void {
  void readMicPermission()
    .then((permission) => {
      cached = permission
    })
    .catch(() => {})
}

export function cachedMicPermission(): MicPermission {
  return cached
}

/** Record what a real prompt taught us (also the test seam). */
export function noteMicPermission(permission: MicPermission): void {
  cached = permission
}

/** PURE: the decision, from the three facts that bear on it. */
export function planEntry(args: {
  pref: MicPref
  permission: MicPermission
  voicePossible: boolean
}): EntryPlan {
  if (!args.voicePossible || args.pref === 'off' || args.permission === 'denied') {
    return 'enter-silent'
  }
  if (args.permission === 'granted') return 'enter-with-mic'
  return 'ask-first'
}

/** Is there a call to join at all: a bus to signal over, WebRTC, and a mic API. */
export function voicePossible(): boolean {
  return getCollabBus() !== null && voiceSupported() && micSupported()
}

/** The plan the next click would run, for the veil's hint line. */
export function currentEntryPlan(): EntryPlan {
  return planEntry({ pref: loadMicPref(), permission: cached, voicePossible: voicePossible() })
}

export type EntryUi = {
  /** Relabel the button; `busy` disables it while the dialog is open. */
  setLabel(text: string, busy: boolean): void
  /** Enter the game — the caller's existing enterGame() path. */
  enter(): void
}

/**
 * The click handler every entry button delegates to. Synchronous up to
 * `enableMic()` / `enter()`, so both run inside the click's transient
 * activation — the mic prompt and the fullscreen request each need it.
 */
export function beginEntry(ui: EntryUi): void {
  primeVoiceOutputs()
  prefetchIceServers()
  const plan = currentEntryPlan()
  if (plan === 'ask-first') {
    ui.setLabel(ASK_LABEL, true)
    void enableMic()
      .then((mic) => {
        cached =
          mic === 'live' || mic === 'muted'
            ? 'granted'
            : mic === 'denied' || mic === 'unavailable'
              ? 'denied'
              : 'unknown'
      })
      .catch(() => {
        cached = 'unknown'
      })
      .finally(() => {
        ui.setLabel(READY_LABEL, false)
      })
    return
  }
  if (plan === 'enter-with-mic') void enableMic()
  else releaseAcquiredMic()
  ui.enter()
}

/**
 * Drop a track the veil acquired when the entry ends up silent. Only the
 * states that HOLD or are about to hold a device are touched: 'denied' and
 * 'unavailable' stay as they are, so the pill can still say why the mic is off
 * ("MIC BLOCKED — LISTENING"). An 'asking' acquisition is released too — the
 * epoch check in enableMic stops the late track instead of keeping it.
 */
function releaseAcquiredMic(): void {
  const mic = micState()
  if (mic === 'live' || mic === 'muted' || mic === 'asking') releaseMic()
}
