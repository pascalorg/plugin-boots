import { useFrame } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import { takeAction } from './input'
import { getRemotes } from './presence'
import { getSession } from './session'
import {
  micState,
  onVoiceEvent,
  resumeVoiceOutputs,
  selfTalking,
  setVoiceLocalEcho,
  talkingPeerCount,
  toggleMic,
  voiceActive,
  voiceConnectedCount,
  voiceDebug,
  voiceExcluded,
  voiceInternals,
  voiceOutputBlocked,
  type VoicePeerStats,
  voiceSameDeviceCount,
  voiceStats,
  voiceUnreachableCount,
} from './voice'
import {
  type MicPillArgs,
  micPillText,
  micPillTone,
  VOICE_OVERLAY_REFRESH_MS,
  VoiceOverlay,
  voiceOverlayText,
  voiceOverlayWanted,
} from './voice-overlay'
import { keyCap, MIC_KEY } from './voice-policy'

/**
 * The player-facing half of voice: one key, one pill, one toast, one dump.
 *
 * THE KEY. MIC_KEY (M) mutes and unmutes — or, for a player who entered silent,
 * turns the mic on (that press is the permission prompt, mid-game; rare now,
 * because the veil asks first — see mic-gate.ts). A ONE-SHOT taken off the input
 * action queue rather than read off the held-keys set, because a tap whose
 * keydown and keyup both land inside a single frame is invisible to per-frame
 * key sampling — the same reason interact.tsx takes 'KeyE' from the queue. We
 * run at priority -1 so the strip happens before the viewmodel's
 * consumeActions() drains it. The same press retries any output the browser
 * refused to play: a keystroke is the gesture autoplay wanted.
 *
 * THE PILL (voice-overlay.ts) is driven every frame and change-gated on its
 * inputs: nine scalars compared in place, no allocation, one DOM write per
 * actual change. It replaces the HUD's own 11 px voice chip, which this module
 * no longer drives.
 *
 * THE TOAST: "Alice is on voice" the moment a pair connects — the first proof
 * of a working call that does not need somebody to speak. Through the HUD's
 * existing presenceToast, feature-detected.
 *
 * THE DUMP: `?voiceDebug=1` (or `__bootsVoice.overlay(true)`) shows every
 * peer's link state inside the fullscreen game, refreshed twice a second with
 * getStats sampled alongside.
 */

/** Feature-detected HUD surface — same defensive idiom as driveChip's. */
type VoiceHud = {
  hint?: (id: string, text: string) => boolean
  presenceToast?: (text: string) => void
}

let overlayOn = false

/** Show or hide the debug dump (QA hook; `?voiceDebug=1` sets it at mount). */
export function setVoiceOverlay(on: boolean): void {
  overlayOn = on
}

/** The QA surface this component installs as `globalThis.__bootsVoice` while mounted. */
export type VoiceQa = {
  stats: () => Promise<VoicePeerStats[]>
  overlay: (on: boolean) => boolean
  localEcho: (on: boolean) => boolean
  pill: () => string
  resume: () => void
}

function emptyPill(): MicPillArgs {
  return {
    mic: 'off',
    talking: false,
    talkers: 0,
    peers: 0,
    connected: 0,
    excluded: false,
    unreachable: 0,
    sameDevice: 0,
    outputBlocked: false,
  }
}

function samePill(a: MicPillArgs, b: MicPillArgs): boolean {
  return (
    a.mic === b.mic &&
    a.talking === b.talking &&
    a.talkers === b.talkers &&
    a.peers === b.peers &&
    a.connected === b.connected &&
    a.excluded === b.excluded &&
    a.unreachable === b.unreachable &&
    a.sameDevice === b.sameDevice &&
    a.outputBlocked === b.outputBlocked
  )
}

function copyPill(from: MicPillArgs, to: MicPillArgs): void {
  to.mic = from.mic
  to.talking = from.talking
  to.talkers = from.talkers
  to.peers = from.peers
  to.connected = from.connected
  to.excluded = from.excluded
  to.unreachable = from.unreachable
  to.sameDevice = from.sameDevice
  to.outputBlocked = from.outputBlocked
}

/**
 * Peers in the game, for the chip's "is there anybody to talk to" decision.
 *
 * Counted from PRESENCE, not from the voice mesh: past the mesh cap somebody can
 * be standing in the lot with you and outside the call, and a chip claiming you
 * are alone while another builder walks past is worse than no chip.
 */
function gamePeerCount(): number {
  let count = 0
  for (const remote of getRemotes().values()) {
    if (remote.ph === 'game') count++
  }
  return count
}

export function VoiceControls() {
  const overlayRef = useRef<VoiceOverlay | null>(null)
  // Preallocated and mutated in place: the per-frame read fills `next`, and
  // only a change against `shown` builds a string and touches the DOM.
  const next = useRef<MicPillArgs>(emptyPill())
  const shown = useRef<MicPillArgs>(emptyPill())
  const nextDumpAt = useRef(0)
  const stats = useRef<VoicePeerStats[]>([])
  const statsBusy = useRef(false)

  useFrame(() => {
    const session = getSession()
    if (!session) return

    if (takeAction(session.input.state.actions, MIC_KEY)) {
      // Fire-and-forget: a first press awaits a permission dialog that can sit
      // open for as long as the player takes to read it, and the frame loop must
      // not be holding anything while that happens.
      void toggleMic()
      resumeVoiceOutputs()
    }

    const active = voiceActive()
    const a = next.current
    a.mic = micState()
    a.talking = selfTalking()
    a.peers = gamePeerCount()
    a.talkers = active ? talkingPeerCount() : 0
    a.connected = active ? voiceConnectedCount() : 0
    a.excluded = active && voiceExcluded()
    a.unreachable = active ? voiceUnreachableCount() : 0
    a.sameDevice = active ? voiceSameDeviceCount() : 0
    a.outputBlocked = active && voiceOutputBlocked()
    if (!samePill(a, shown.current)) {
      copyPill(a, shown.current)
      overlayRef.current?.pill(micPillText(a), micPillTone(a.mic, a.talking))
      if (a.mic === 'denied') {
        // Once per session (hud.hint is id-gated): the pill says "blocked", this
        // says what to do about it.
        ;(session.hud as unknown as VoiceHud).hint?.(
          'mic-denied',
          `mic blocked — allow it in the address bar, then press ${keyCap(MIC_KEY)}`,
        )
      }
    }

    if (overlayOn) {
      const now = Date.now()
      if (now >= nextDumpAt.current) {
        nextDumpAt.current = now + VOICE_OVERLAY_REFRESH_MS
        overlayRef.current?.debug(voiceOverlayText(voiceDebug(), voiceInternals(), stats.current))
        if (!statsBusy.current) {
          statsBusy.current = true
          void voiceStats()
            .then((sampled) => {
              stats.current = sampled
            })
            .catch(() => {})
            .finally(() => {
              statsBusy.current = false
            })
        }
      }
    } else if (nextDumpAt.current !== 0) {
      nextDumpAt.current = 0
      overlayRef.current?.debug(null)
    }
  }, -1)

  useEffect(() => {
    const session = getSession()
    if (!session) return
    // Into the fullscreen container, beside the HUD root — anything on
    // document.body is invisible once the container is fullscreen.
    const overlay = new VoiceOverlay()
    overlay.mount(session.container)
    overlayRef.current = overlay
    if (typeof location !== 'undefined' && voiceOverlayWanted(location.search)) overlayOn = true

    const hud = session.hud as unknown as VoiceHud
    const offVoice = onVoiceEvent((event) => {
      hud.presenceToast?.(
        event.type === 'connected'
          ? `${event.name} is on voice`
          : event.type === 'lost'
            ? `${event.name} — voice dropped`
            : `${event.name} — unreachable (no relay)`,
      )
    })

    // QA surface for the live harness: read the pill, sample getStats, toggle
    // the dump, hear a same-device peer anyway. Removed with the session.
    const qa: VoiceQa = {
      stats: () => voiceStats(),
      overlay: (on) => {
        setVoiceOverlay(on)
        return on
      },
      localEcho: (on) => {
        setVoiceLocalEcho(on)
        return on
      },
      pill: () => overlay.pillContent(),
      resume: () => resumeVoiceOutputs(),
    }
    const g = globalThis as Record<string, unknown>
    g.__bootsVoice = qa
    return () => {
      offVoice()
      overlay.unmount()
      if (overlayRef.current === overlay) overlayRef.current = null
      if (g.__bootsVoice === qa) delete g.__bootsVoice
    }
  }, [])

  return null
}
