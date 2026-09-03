'use client'

import { useEffect, useRef, useState } from 'react'
import { useBoots } from '../store'
import { untilNet } from './net-retry'
import {
  getRemotes,
  getRosterVersion,
  onPresenceEvent,
  presenceDebug,
  startSpectating,
  stopSpectating,
} from './presence'
import { RemotePlayers } from './remote-players'
import { livePlayerNames, sameNames } from './roster-names'
import { enterGame } from './session'
import {
  HINT_ATTR,
  HINT_EVENT_HOLD_MS,
  hintSuppressed,
  presenceEventLine,
  shouldStopOnCleanup,
  spectatorHintText,
  WATCH_POLL_MS,
} from './spectator-hint'
import {
  resumeVoiceOutputs,
  setVoiceLocalEcho,
  startVoiceListen,
  stopVoiceListen,
  talkingPeerCount,
  voiceConnectedCount,
  voiceDebug,
  voiceInternals,
  voiceOutputBlocked,
  voiceStats,
} from './voice'
import { ListenPill, listenPillText } from './voice-overlay'

/**
 * SPECTATOR LAYER — the render side of "people looking at the project can see
 * the players live."
 *
 * BootsSystem mounts this in EDITOR phase. It is mutually exclusive with
 * ActiveGame, which owns RemotePlayers in GAME phase — a viewer who has NOT
 * dropped in still gets everyone's pose frames through a RECEIVE-ONLY presence
 * subscription (startSpectating publishes no avatar of its own), and renders
 * those exact avatars — movement, aim, firing — with the same <RemotePlayers/>
 * the players already see of each other.
 *
 * BIND RETRY. The host installs the collab bus asynchronously (after realtime
 * auth), so the first bind attempt often finds nothing. `untilNet` re-tries
 * every second until the bus is there — a viewer whose bus lands after the
 * plugin mounted still gets the small people the moment it does, instead of
 * never. Without a bus at all this costs one global read per second.
 *
 * SEAMLESS DROP-IN. When the viewer clicks JUMP IN the phase flips to 'game'
 * and this effect cleans up — but it does NOT stop spectating then: the
 * receive-only adapter (registry, subscription, tick) stays alive for
 * ActiveGame's startPresence to ADOPT, so nobody re-joins, no false "X joined"
 * toasts fire and no avatar re-scales in. Only a real unmount in editor phase
 * (canvas teardown, bus lost) tears the adapter down.
 *
 * HINT PILL. Nothing used to tell an editor viewer that a game was on. Now a
 * body-level pill — "Alice is playing — ⏵ JUMP IN" — names who is in, and one
 * click enters (the click is the gesture fullscreen/pointer-lock need). Hidden
 * whenever the drop veil or the reentry pill is up: never two Jump-in buttons.
 *
 * NO FRAME BOOSTER. The editor is NOT on-demand: its FrameLimiter is an
 * unconditional rAF loop advancing R3F at 50 fps (viewer/frame-limiter.tsx),
 * so the avatars animate without any help. The earlier FrameBooster here set
 * `renderPaused`, which STOPS that limiter and replaced it with an uncapped
 * display-rate loop — the owner's editor rendering at 120 Hz while friends
 * play. Gone.
 *
 * QA HANDLE. `globalThis.__bootsSpectator` (installed while this layer lives,
 * kept across a drop-in so a harness can read rosterVersion on both sides of
 * the flip): { bound, watching, names, rosterVersion, remotes, presence(),
 * snapshot() } — live getters over the presence registry, copies only.
 */

// The pure half (pill copy, event line, handoff rule, suppression) lives in
// spectator-hint.ts so it is testable without React/three; re-exported here.
export {
  HINT_ATTR,
  HINT_EVENT_HOLD_MS,
  HINT_NAME_CAP,
  hintSuppressed,
  presenceEventLine,
  shouldStopOnCleanup,
  spectatorHintText,
  WATCH_POLL_MS,
} from './spectator-hint'

// ── QA handle ────────────────────────────────────────────────────────────────

/** Whether startSpectating (or an adopted game session) holds the adapter. */
let boundToBus = false
let liveNames: readonly string[] = []

export type SpectatorSnapshot = {
  bound: boolean
  watching: boolean
  names: string[]
  rosterVersion: number
  remotes: ReturnType<typeof presenceDebug>['remotes']
  received: number
}

function snapshot(): SpectatorSnapshot {
  const debug = presenceDebug()
  return {
    bound: boundToBus,
    watching: liveNames.length > 0,
    names: [...liveNames],
    rosterVersion: getRosterVersion(),
    remotes: debug.remotes,
    received: debug.received,
  }
}

function installHandle(): void {
  const g = globalThis as Record<string, unknown>
  if (g.__bootsSpectator) return
  g.__bootsSpectator = {
    get bound() {
      return boundToBus
    },
    get watching() {
      return liveNames.length > 0
    },
    get names() {
      return [...liveNames]
    },
    get rosterVersion() {
      return getRosterVersion()
    },
    get remotes() {
      return presenceDebug().remotes
    },
    presence: presenceDebug,
    snapshot,
  }
}

function removeHandle(): void {
  delete (globalThis as Record<string, unknown>).__bootsSpectator
}

// ── The hint pill (body-level DOM, drop-gate idiom) ──────────────────────────

const FONT = 'system-ui, -apple-system, sans-serif'

function SpectatorHint({ text, event, hidden }: { text: string | null; event: string | null; hidden: boolean }) {
  const pillRef = useRef<HTMLButtonElement | null>(null)
  const labelRef = useRef<HTMLSpanElement | null>(null)
  const subRef = useRef<HTMLSpanElement | null>(null)
  const show = text !== null

  useEffect(() => {
    if (!show || typeof document === 'undefined') return
    // Body-level (not the canvas parent): the same reason the drop gate is —
    // a later enterGame fullscreens the canvas container and this must not
    // ride into the game. Top-centre, UNDER the editor's top toolbar (the
    // 3D/2D toggle and the display bar sit in the first ~48 px on /scene and
    // /editor — seen live 2026-09-02); clears the bottom-centre reentry pill
    // and the top-left floor selector.
    const pill = document.createElement('button')
    pill.type = 'button'
    pill.setAttribute('aria-label', 'Jump into the game')
    pill.setAttribute(HINT_ATTR, '')
    pill.style.cssText =
      `position:fixed;left:50%;top:58px;transform:translateX(-50%);z-index:9997;` +
      `font:700 14px/1 ${FONT};letter-spacing:0.08em;color:#0f1113;background:#e8c229;` +
      'border:none;border-radius:8px;padding:11px 22px;cursor:pointer;text-align:center;' +
      'box-shadow:0 6px 20px rgba(0,0,0,0.35)'
    const label = document.createElement('span')
    label.style.cssText = 'display:block;white-space:nowrap'
    const sub = document.createElement('span')
    sub.setAttribute('data-boots-spectator-event', '')
    sub.style.cssText = `display:none;font:500 11px/1.2 ${FONT};letter-spacing:0.06em;opacity:0.72;margin-top:5px;white-space:nowrap`
    pill.append(label, sub)
    // The click is the user gesture fullscreen and pointer lock require.
    pill.onclick = () => {
      enterGame()
    }
    document.body.appendChild(pill)
    pillRef.current = pill
    labelRef.current = label
    subRef.current = sub
    return () => {
      pill.remove()
      pillRef.current = null
      labelRef.current = null
      subRef.current = null
    }
  }, [show])

  useEffect(() => {
    const pill = pillRef.current
    if (!pill) return
    if (labelRef.current) labelRef.current.textContent = text ?? ''
    const sub = subRef.current
    if (sub) {
      sub.textContent = event ?? ''
      sub.style.display = event ? 'block' : 'none'
    }
    pill.style.display = hidden ? 'none' : 'block'
  }, [text, event, hidden])

  return null
}

// ── The layer ────────────────────────────────────────────────────────────────

const NO_NAMES: readonly string[] = []

export function SpectatorPlayers() {
  const phase = useBoots((s) => s.phase)
  const [bound, setBound] = useState(false)
  const [names, setNames] = useState<readonly string[]>(NO_NAMES)
  const [lastEvent, setLastEvent] = useState<string | null>(null)
  const [suppressed, setSuppressed] = useState(false)

  useEffect(() => {
    if (phase !== 'editor') return
    let live = true
    // A fresh editor pass never inherits a stale bound flag: after a game the
    // session's stopPresence closed the adapter, so we bind again from zero.
    boundToBus = false
    setBound(false)
    installHandle()
    const cancelRetry = untilNet(startSpectating, () => {
      boundToBus = true
      if (live) setBound(true)
    })
    const poll = () => {
      const fresh = livePlayerNames(getRemotes())
      if (!sameNames(fresh, liveNames)) {
        liveNames = fresh
        setNames(fresh)
      }
      // Same-value setState is a React bail-out, so this is free 2.5×/s.
      setSuppressed(typeof document !== 'undefined' && hintSuppressed(document))
    }
    poll()
    const timer = setInterval(poll, WATCH_POLL_MS)
    let eventTimer: ReturnType<typeof setTimeout> | null = null
    const offEvents = onPresenceEvent((event) => {
      setLastEvent(presenceEventLine(event))
      if (eventTimer) clearTimeout(eventTimer)
      eventTimer = setTimeout(() => {
        eventTimer = null
        setLastEvent(null)
      }, HINT_EVENT_HOLD_MS)
    })
    return () => {
      live = false
      cancelRetry()
      clearInterval(timer)
      if (eventTimer) clearTimeout(eventTimer)
      offEvents()
      if (shouldStopOnCleanup(useBoots.getState().phase)) {
        // Real unmount in editor phase: the receive-only owner closes shop.
        stopSpectating()
        boundToBus = false
        liveNames = NO_NAMES
        removeHandle()
      }
      // else: a drop-in. The adapter and the handle stay alive — ActiveGame's
      // startPresence adopts the registry intact (no reconnect, no re-join).
    }
  }, [phase])

  // ── LISTEN: the viewer HEARS the people they are watching ──────────────────
  //
  // A receive-only voice session (voice.ts startVoiceListen: no microphone,
  // recvonly links to the players' room) opens once there is somebody in the
  // game to hear and closes when the last of them leaves. It rides the presence
  // adapter above (`bound`) for its roster and signalling. On a drop-in it is
  // deliberately NOT stopped — the game's startVoice adopts the live links in
  // place (same connections, no gap in the audio), mirroring how startPresence
  // adopts the spectating registry; stopVoiceListen is a no-op after that.
  //
  // The pill: a spectator page may never have been clicked, and a browser that
  // wants a gesture before it plays sound the page did not start refuses every
  // play() in silence. voice.ts retries on its heartbeat; this shows the viewer
  // WHY it is quiet and gives them the click ("SOUND BLOCKED — CLICK TO HEAR
  // THE PLAYERS" → resumeVoiceOutputs). Otherwise a quiet "LISTENING · N ON
  // VOICE" under the hint. QA reads `globalThis.__bootsListen`.
  const watching = names.length > 0
  useEffect(() => {
    if (phase !== 'editor' || !bound || !watching) return
    if (!startVoiceListen()) return
    const pill = new ListenPill(() => resumeVoiceOutputs())
    pill.mount()
    const drive = () => {
      pill.set(
        listenPillText({
          blocked: voiceOutputBlocked(),
          connected: voiceConnectedCount(),
          talkers: talkingPeerCount(),
          players: liveNames.length,
        }),
      )
    }
    drive()
    const timer = setInterval(drive, WATCH_POLL_MS)
    const qa = {
      debug: voiceDebug,
      internals: voiceInternals,
      stats: voiceStats,
      pill: () => pill.content(),
      resume: () => resumeVoiceOutputs(),
      localEcho: (on: boolean) => {
        setVoiceLocalEcho(on)
        return on
      },
    }
    const g = globalThis as Record<string, unknown>
    g.__bootsListen = qa
    return () => {
      clearInterval(timer)
      pill.unmount()
      if (g.__bootsListen === qa) delete g.__bootsListen
      if (shouldStopOnCleanup(useBoots.getState().phase)) stopVoiceListen()
      // else: a drop-in — the game's startVoice has adopted (or will adopt) the
      // live links; stopping here would hang up on the people they can hear.
    }
  }, [phase, bound, watching])

  if (phase !== 'editor' || !bound) return null
  return (
    <>
      <RemotePlayers spectator />
      <SpectatorHint text={spectatorHintText(names)} event={lastEvent} hidden={suppressed} />
    </>
  )
}
