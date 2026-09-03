import type { MicState, VoicePeerStats, voiceDebug, voiceInternals } from './voice'
import { keyCap, MAX_VOICE_PEERS, MIC_KEY } from './voice-policy'

/**
 * VOICE OVERLAY — the two things a player can SEE about the call: a mic pill
 * they cannot miss, and (on request) a monospace dump of every peer's link.
 *
 * Its own DOM, appended INTO the fullscreen container next to the HUD root, so
 * it renders in fullscreen (anything on document.body does not) without the Hud
 * class having to know about voice. The pure text builders are exported and
 * tested; the class only writes what they return, change-gated on the rendered
 * text so a talk gate flickering at 10 Hz costs no DOM write.
 *
 * The pill's job is to answer, at a glance: am I being heard, am I muted, was I
 * refused, are we connected, am I outside the call, is a peer unreachable, and
 * — the owner's own two-tab QA — why the other tab is silent.
 */

export type MicPillArgs = {
  mic: MicState
  /** Is OUR mic over the talk gate right now. */
  talking: boolean
  /** Peers talking right now. */
  talkers: number
  /** Peers in the game (from presence) — 0 means we are alone. */
  peers: number
  /** Peers whose connection is up. */
  connected: number
  /** We are past the room cap while others are in the game. */
  excluded: boolean
  /** Peers given up on. */
  unreachable: number
  /** Peers muted because they share this machine. */
  sameDevice: number
  /** A peer's stream sits on an element the browser refused to play. */
  outputBlocked: boolean
  /** Editor viewers listening to us (they have no avatar and no presence). */
  listeners?: number
}

const KEY = keyCap(MIC_KEY)

/**
 * PURE: the pill's text, or null to hide it. Alone with the mic off there is
 * nothing to offer and nobody to offer it to; every other state shows even
 * alone, because 'asking', 'denied' and 'unavailable' are the answer to the
 * prompt the player just saw, and 'live'/'muted' are what they chose.
 */
export function micPillText(args: MicPillArgs): string | null {
  const { mic, talking, talkers, peers } = args
  const listeners = args.listeners ?? 0
  if (args.excluded) return `OUTSIDE THE CALL (${MAX_VOICE_PEERS} MAX)`
  // Alone with the mic off and nobody listening there is nothing to say. A
  // LISTENER is somebody, though — being heard by a viewer with no avatar is
  // exactly the state a player should never be in unknowingly.
  if (peers <= 0 && mic === 'off' && listeners <= 0) return null
  let base: string
  switch (mic) {
    case 'asking':
      base = 'ALLOW THE MIC ↑'
      break
    case 'live':
      base = talking ? '● TALKING' : '● MIC ON'
      break
    case 'muted':
      base = `✕ MUTED — ${KEY} TO TALK`
      break
    case 'denied':
      base = 'MIC BLOCKED — LISTENING'
      break
    case 'unavailable':
      base = 'NO MIC — LISTENING'
      break
    default:
      base = `${KEY} — TALK`
  }
  const parts = [base]
  if (peers > 0 && mic !== 'asking') {
    if (args.connected > 0) parts.push(`${args.connected} ON VOICE`)
    else if (peers > args.unreachable + args.sameDevice) parts.push('CONNECTING…')
  }
  if (talkers > 0) parts.push(`${talkers} SPEAKING`)
  if (listeners > 0) parts.push(`${listeners} LISTENING FROM THE EDITOR`)
  if (args.unreachable > 0) parts.push(`${args.unreachable} UNREACHABLE`)
  if (args.sameDevice > 0) parts.push('SAME DEVICE — MUTED')
  if (args.outputBlocked) parts.push('SOUND BLOCKED — CLICK')
  return parts.join('  ·  ')
}

/** PURE: the pill's colour — green when heard, amber while asking, red when not. */
export function micPillTone(mic: MicState, talking: boolean): string {
  switch (mic) {
    case 'live':
      return talking ? '#a8ffab' : '#7ee081'
    case 'asking':
      return '#e8c229'
    case 'muted':
    case 'denied':
      return '#ff6b5e'
    default:
      return 'rgba(255,255,255,0.78)'
  }
}

// ── The listen pill (editor viewers) ─────────────────────────────────────────

export type ListenPillArgs = {
  /** A player's stream sits on an element the browser refused to play. */
  blocked: boolean
  /** Players whose connection to us is up. */
  connected: number
  /** Players talking right now. */
  talkers: number
  /** Players in the game (from presence). */
  players: number
}

export const LISTEN_BLOCKED_TEXT = '🔇 SOUND BLOCKED — CLICK TO HEAR THE PLAYERS'

/**
 * PURE: what an editor viewer who is LISTENING sees, or null for nothing.
 *
 * The one line that matters is the blocked one: a spectator page may never have
 * been clicked, and a browser that wants a gesture before it plays sound the
 * page did not start refuses every play() in silence — the viewer sees people
 * talk and hears nothing, with no idea a click would fix it. So that state is a
 * button. Otherwise a quiet status while a link is up ("LISTENING · 2 ON
 * VOICE · 1 SPEAKING"), and nothing at all before one is: "CONNECTING…" on a
 * page that never asked to connect is noise.
 */
export function listenPillText(args: ListenPillArgs): string | null {
  if (args.players <= 0) return null
  if (args.blocked) return LISTEN_BLOCKED_TEXT
  if (args.connected <= 0) return null
  const parts = [`🔈 LISTENING · ${args.connected} ON VOICE`]
  if (args.talkers > 0) parts.push(`${args.talkers} SPEAKING`)
  return parts.join('  ·  ')
}

/** Only the blocked state is actionable, so only it is a button. */
export function listenPillClickable(text: string | null): boolean {
  return text === LISTEN_BLOCKED_TEXT
}

/**
 * Body-level pill for the editor page (no fullscreen container exists there),
 * under the spectator hint. Change-gated on text; click calls `onResume`, which
 * is the gesture a refused autoplay was waiting for.
 */
export class ListenPill {
  private el: HTMLButtonElement | null = null
  private text = ''

  constructor(private readonly onResume: () => void) {}

  mount(): void {
    if (this.el || typeof document === 'undefined') return
    const el = document.createElement('button')
    el.type = 'button'
    el.dataset.bootsListenPill = '1'
    el.setAttribute('aria-label', 'Voice from the game')
    el.style.cssText =
      'position:fixed;left:50%;top:104px;transform:translateX(-50%);z-index:9996;display:none;' +
      `font:${FONT};letter-spacing:0.1em;white-space:nowrap;color:rgba(255,255,255,0.86);background:rgba(0,0,0,0.62);` +
      'border:none;border-radius:999px;padding:6px 12px;cursor:default;text-shadow:0 1px 3px rgba(0,0,0,0.7);' +
      'box-shadow:0 4px 14px rgba(0,0,0,0.3)'
    el.onclick = () => {
      this.onResume()
    }
    document.body.appendChild(el)
    this.el = el
  }

  set(text: string | null): void {
    const next = text ?? ''
    const el = this.el
    if (!el || next === this.text) return
    this.text = next
    el.textContent = next
    el.style.display = next ? 'block' : 'none'
    const clickable = listenPillClickable(text)
    el.style.cursor = clickable ? 'pointer' : 'default'
    el.style.color = clickable ? '#ffd7d2' : 'rgba(255,255,255,0.86)'
    el.style.background = clickable ? 'rgba(160,30,20,0.86)' : 'rgba(0,0,0,0.62)'
  }

  /** The current text — the QA hook reads it. */
  content(): string {
    return this.text
  }

  unmount(): void {
    this.el?.remove()
    this.el = null
    this.text = ''
  }
}

// ── The debug dump ───────────────────────────────────────────────────────────

export const VOICE_OVERLAY_REFRESH_MS = 500

/** `?voiceDebug=1` on the page URL shows the dump from the first frame. */
export function voiceOverlayWanted(search: string): boolean {
  return new URLSearchParams(search).get('voiceDebug') === '1'
}

type Debug = ReturnType<typeof voiceDebug>
type Internals = ReturnType<typeof voiceInternals>

/**
 * PURE: one header line, one line per peer, then the counters. Everything a
 * person chasing "connected but silent" needs, readable inside a fullscreen
 * game, sized for a phone.
 */
export function voiceOverlayText(
  debug: Debug,
  internals: Internals,
  stats: readonly VoicePeerStats[],
): string {
  const lines: string[] = []
  lines.push(
    `mic=${debug.mic} mode=${debug.mode}${debug.listen ? ' LISTEN' : ''} ice=${debug.ice.source}/${debug.ice.servers} relay=${debug.ice.relay} ` +
      `excluded=${debug.excluded} sameDevice=${debug.sameDevice} blocked=${debug.outputBlocked} ticks=${debug.ticks}`,
  )
  if (debug.peers.length === 0) lines.push('(no peers)')
  for (const peer of debug.peers) {
    const raw = internals.find((entry) => entry.sessionId === peer.sessionId)
    const stat = stats.find((entry) => entry.sessionId === peer.sessionId)
    const receiverMuted = raw?.receivers.map((receiver) => receiver.muted).join(',') ?? '?'
    const direction = raw?.transceivers.map((t) => t.currentDirection ?? t.direction).join(',') ?? '?'
    lines.push(
      `${peer.name} ${peer.state}/${peer.connection}/${peer.ice} step=${peer.step} gain=${peer.gain.toFixed(2)} ` +
        `talk=${peer.talking ? 't' : 'f'} acked=${peer.acked ? 't' : 'f'} pair=${stat?.pair ?? '?'} ` +
        `rx=${stat ? (stat.bytesReceived / 1024).toFixed(1) : '?'}kB lvl=${stat ? stat.audioLevel.toFixed(2) : '?'} ` +
        `rtt=${stat?.rttMs ?? '?'} dir=${direction} rxMuted=${receiverMuted}` +
        `${peer.sameDevice ? ' SAME-DEVICE' : ''}${peer.localRelay ? ' relay-cand' : ''}${peer.listener ? ' LISTENER' : ''} err=${peer.error ?? '-'}`,
    )
  }
  const c = debug.counters
  lines.push(
    `offers ${c.offersSent}/${c.offersApplied} answers ${c.answersSent}/${c.answersApplied} dropped=${c.dropped} ` +
      `notSent=${c.notSent} restarts=${c.restarts} given_up=${c.given_up} reaped=${c.reaped} threw=${c.threw} ` +
      `abandoned=${c.abandoned} tooLarge=${c.tooLarge} stalls=${c.stalls} pcFailed=${c.pcFailed}` +
      `${c.listenersRefused > 0 ? ` listenersRefused=${c.listenersRefused}` : ''}`,
  )
  if (debug.unreachable.length > 0) lines.push(`unreachable: ${debug.unreachable.join(' ')}`)
  return lines.join('\n')
}

// ── The DOM ──────────────────────────────────────────────────────────────────

const FONT = '600 12px/1.2 system-ui, -apple-system, sans-serif'

/** Where the pill sits: the HUD's muted top-left rail (chip 20, toast 40, this 60). */
const PILL_LEFT = '28px'
const PILL_TOP = '60px'
/** Phone HUD (hud.setCompact): under the relocated health/weapon/pip/paint stack. */
const PILL_LEFT_COMPACT = '14px'
const PILL_TOP_COMPACT = '198px'

export class VoiceOverlay {
  private root: HTMLDivElement | null = null
  private pillEl: HTMLDivElement | null = null
  private debugEl: HTMLPreElement | null = null
  private pillText = ''
  private pillTone = ''
  private debugText: string | null = null
  private pulseTimer: ReturnType<typeof setTimeout> | null = null

  /** Appended INTO the fullscreen container, beside the HUD root. */
  mount(container: HTMLElement): void {
    if (this.root || typeof document === 'undefined') return
    const root = document.createElement('div')
    root.dataset.bootsVoiceUi = '1'
    root.style.cssText =
      'position:absolute;inset:0;pointer-events:none;z-index:2147483646;user-select:none'
    const pill = document.createElement('div')
    pill.dataset.bootsMicPill = '1'
    pill.style.cssText =
      `position:absolute;left:${PILL_LEFT};top:${PILL_TOP};padding:5px 11px;border-radius:999px;background:rgba(0,0,0,0.55);` +
      `font:${FONT};letter-spacing:0.1em;white-space:nowrap;opacity:0;` +
      'transition:opacity 0.25s,transform 0.25s;transform-origin:left center;text-shadow:0 1px 3px rgba(0,0,0,0.7)'
    const debug = document.createElement('pre')
    debug.id = 'boots-voice-overlay'
    debug.dataset.bootsVoiceOverlay = '1'
    debug.style.cssText =
      'position:absolute;left:28px;bottom:120px;margin:0;font:11px/1.35 ui-monospace,Menlo,monospace;color:#cfe;' +
      'background:rgba(0,0,0,0.6);padding:8px 10px;border-radius:8px;pointer-events:none;max-width:46vw;' +
      'white-space:pre-wrap;display:none'
    root.append(pill, debug)
    container.appendChild(root)
    this.root = root
    this.pillEl = pill
    this.debugEl = debug
  }

  /** Change-gated on text; a text change pulses the pill so the eye is drawn. */
  pill(text: string | null, tone: string): void {
    const next = text ?? ''
    const el = this.pillEl
    if (!el) return
    if (tone !== this.pillTone) {
      this.pillTone = tone
      el.style.color = tone
    }
    if (next === this.pillText) return
    this.pillText = next
    el.textContent = next
    el.style.opacity = next ? '1' : '0'
    // Follow the HUD's phone layout without importing it: the HUD root marks it.
    const hud = this.root?.parentElement?.querySelector<HTMLElement>('#boots-hud')
    const compact = hud?.dataset.bootsHudCompact === '1'
    el.style.left = compact ? PILL_LEFT_COMPACT : PILL_LEFT
    el.style.top = compact ? PILL_TOP_COMPACT : PILL_TOP
    if (!next) return
    el.style.transform = 'scale(1.08)'
    if (this.pulseTimer) clearTimeout(this.pulseTimer)
    this.pulseTimer = setTimeout(() => {
      this.pulseTimer = null
      if (this.pillEl) this.pillEl.style.transform = ''
    }, 250)
  }

  /** The current pill text — the QA hook reads it. */
  pillContent(): string {
    return this.pillText
  }

  /** null hides the dump. */
  debug(text: string | null): void {
    if (text === this.debugText) return
    this.debugText = text
    const el = this.debugEl
    if (!el) return
    el.style.display = text === null ? 'none' : 'block'
    el.textContent = text ?? ''
  }

  unmount(): void {
    if (this.pulseTimer) clearTimeout(this.pulseTimer)
    this.pulseTimer = null
    this.root?.remove()
    this.root = null
    this.pillEl = null
    this.debugEl = null
    this.pillText = ''
    this.pillTone = ''
    this.debugText = null
  }
}
