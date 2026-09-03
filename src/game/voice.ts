import { sharedAudioContext } from './audio'
import {
  localSessionId,
  netAvailable,
  netBus,
  type NetMessage,
  onFrame,
  publishFrame,
  registerFrameKind,
} from './net'
import { browserPendingStorage } from './pending-store'
import { getRemotes, participantName } from './presence'
import { latestSnapshot } from './presence-interp'
import {
  acceptsListener,
  DEFAULT_ICE_SERVERS,
  iceHasRelay,
  isVoiceMode,
  listenTargets,
  MAX_SDP_CHARS,
  MAX_SESSION_ID_CHARS,
  MAX_VOICE_PEERS,
  mergeIceServers,
  mixGain,
  nextSignalTarget,
  pickPeerPosition,
  readIceServers,
  readVoiceFrame,
  talkGate,
  trimSdpToBudget,
  VAD_OPEN_RMS,
  VOICE_KIND,
  VOICE_PROTOCOL,
  type VoiceDescription,
  type VoiceFrame,
  type VoiceMode,
  voiceOffererIsUs,
  voicePeersFor,
  voiceRoom,
  voiceShouldOffer,
} from './voice-policy'

/**
 * VOICE — the runtime. A full-mesh WebRTC audio call between the people in one
 * Boots session, signalled over the collaboration bus.
 *
 * Every policy decision this module needs lives in voice-policy.ts (pure,
 * tested). What is here is the part that only exists in a browser: microphone
 * permission, RTCPeerConnection lifecycle, the per-peer output, and the tick
 * that keeps distances and levels current.
 *
 * ── FEATURE-DETECTED FOUR TIMES OVER ────────────────────────────────────────
 * No bus (solo app, older host, `:3002`, host flag off) → `startVoice` returns
 * false and nothing is allocated. No `RTCPeerConnection` → same. No
 * `getUserMedia` → the mesh still forms and you can HEAR everyone, you just
 * cannot speak. Permission denied → identical, and the state says so. There is
 * no configuration in which failing to get voice costs the game anything.
 *
 * ── THE MIC IS ASKED FOR ON THE VEIL, NEVER MID-ENTRY ───────────────────────
 * enterGame() fires requestFullscreen and the pointer lock, and it EXITS the
 * game the moment either is lost. A permission bubble opening inside that
 * sequence can end the very first Jump In. So the mic is acquired BEFORE the
 * game is entered — by the click on the drop veil / re-entry pill (mic-gate.ts):
 * in the same click when the browser already said yes, in a preceding click
 * ("ALLOW THE MIC ↑" → "⏵ PLAY") when it has to ask. The choice persists as a
 * preference (`loadMicPref`), the mic is released unconditionally when the game
 * ends (`releaseMic`, first line of `stopVoice`), and an acquisition that
 * outlives the session that asked for it is stopped by an epoch check.
 *
 * ── WHO IS IN THE CALL ──────────────────────────────────────────────────────
 * The peers currently in a Boots session, taken from the presence registry —
 * not the whole project roster. Somebody sitting in the editor is not in your
 * game and is not running this module, so calling them would leave an offer
 * nobody can ever answer. Using presence also means voice needs no discovery
 * traffic of its own: the pose stream already says who is here.
 *
 * ── HEARING WITHOUT WEBAUDIO, AND WHY ───────────────────────────────────────
 * Each peer's stream plays through its own `HTMLAudioElement` and distance is
 * applied to `element.volume`. That is deliberately the boring path: piping a
 * REMOTE WebRTC stream through a `MediaStreamAudioSourceNode` is a well-known
 * silence on iOS Safari, and a spatialized call that is mute on the phone the
 * cofounder is holding is worth less than a flat one that works. The mic
 * analyser DOES use WebAudio, because a LOCAL getUserMedia stream through
 * WebAudio is sound everywhere.
 *
 * The honest limitation that leaves: iOS treats `volume` as read-only, so on an
 * iPhone 'proximity' mixes flat. 'squad' — the default, and what "talk to each
 * other like we are on a call" asks for — is unaffected.
 *
 * ── THE RELAY SEAM ──────────────────────────────────────────────────────────
 * STUN alone cannot connect two peers behind NATs that both refuse traversal
 * (a phone on LTE against a laptop is the everyday case). A relay needs
 * short-lived credentials, and credentials never belong in a plugin bundle, so
 * this module takes them from two validated, feature-detected sources: a host
 * global (`__pascalIceServers`) and a same-origin route the host may serve
 * (`/api/plugins/boots/turn`, minted server-side, fetched once per hour). Both
 * pass through `readIceServers`; either failing keeps the STUN defaults, which
 * is exactly today's behaviour. Peers that still cannot be reached are given up
 * on countably (`given_up`), the pill says "N UNREACHABLE", and the overlay
 * shows `ice=<source>/<n> relay=<bool>` so a silent pair is a readable one.
 *
 * ── TWO TABS ON ONE MACHINE ─────────────────────────────────────────────────
 * The owner's own QA is two tabs in one browser, and those two tabs share one
 * pair of speakers and one microphone: played out loud, each hears itself
 * through the other with a delay. The host's `clientId` is minted PER TAB so
 * it cannot say "same machine"; a BroadcastChannel beacon can — same origin,
 * same browser profile — so peers heard on it are mixed at zero gain and the
 * pill SAYS so ("SAME DEVICE — MUTED"). `setVoiceLocalEcho(true)` restores the
 * audio for a test that wants to hear it.
 *
 * ── LISTENING FROM THE EDITOR ───────────────────────────────────────────────
 * An editor viewer who has not jumped in sees the players (spectator.tsx) and,
 * since this section, HEARS them: `startVoiceListen` runs the same module in
 * LISTEN mode — no microphone is ever asked for or attached, every transceiver
 * is RECVONLY, and the mesh is the players' own room (listenTargets). The
 * listener OFFERS to each player (a player cannot want a peer that publishes
 * no presence — see voiceShouldOffer), flags its frames `listen: true`, and the
 * player side answers as it always has answered an unknown offerer, capped at
 * MAX_LISTENERS_PER_PLAYER. Dropping in is a HANDOVER, not a restart: the game's
 * `startVoice` finds the listen session active and adopts it — same links, same
 * connections, same audio — flips every live transceiver to sendrecv, attaches
 * the mic, and re-offers one epoch up so the far side renegotiates in place.
 * Nothing the viewer was hearing stops.
 */

// ── Tuning ───────────────────────────────────────────────────────────────────

/** Gains, levels and the talk gate are re-evaluated this often (ms). */
export const VOICE_TICK_MS = 100
/** One signalling frame every this many ticks (see nextSignalTarget). */
export const SIGNAL_EVERY_TICKS = 4
/** How long to gather ICE before sending what we have (non-trickle, ms). */
export const ICE_GATHER_MS = 2500
/** A negotiation that has not connected by now is restarted (ms). */
export const NEGOTIATION_TIMEOUT_MS = 15_000
/** Restarts before a peer is given up on as unreachable. */
export const MAX_NEGOTIATION_ATTEMPTS = 4
/** Remote `talking` older than this reads as quiet (their frames stopped). */
export const TALKING_STALE_MS = 1200
/**
 * How long a peer may be MISSING FROM PRESENCE before their link is torn down.
 *
 * Presence is a best-effort stream over a coalescing bus: a remote can vanish
 * from the roster for a few frames because their publish lost a window, because
 * their tab was throttled mid-stride, or because interpolation ran out of
 * snapshots — none of which means they left the game. Reaping on the first tick
 * that fails to mention them is what turned this into churn instead of a call:
 * a closed link takes the RTCPeerConnection, the gathered candidates, the epoch
 * and the applied watermark with it, so the pair starts from zero on BOTH sides
 * and never gets the ~4 s it needs to finish. It looks exactly like a handshake
 * that keeps failing, which is the most expensive kind of thing to read wrong.
 *
 * Longer than any plausible gap, far shorter than a session. The cost of being
 * wrong the other way is a silent audio element for a moment after somebody
 * really has left.
 */
export const PEER_ABSENT_MS = 4000
/** An established connection sitting 'disconnected' this long is rebuilt (ms). */
export const DISCONNECT_GRACE_MS = 5000
/**
 * A gap between ticks longer than this means THIS PAGE stopped running, not that
 * anything happened to anybody else (ms).
 *
 * A hidden tab, a laptop lid, a long garbage collection: the interval simply does
 * not fire, and when it fires again the clock has jumped. Every deadline in this
 * module is a difference against that clock, so a jump makes all of them expire
 * at once — the peers get reaped for silence during a window in which we were not
 * listening, and their frames, queued behind this very callback, arrive a
 * millisecond too late to save them. Nothing about that is the peers' fault, and
 * the fix is to credit the lost time back rather than to spend it accusing them.
 */
export const TICK_STALL_MS = 1000

// ── ICE ──────────────────────────────────────────────────────────────────────

/** A host may hand us ICE servers here (a relay with credentials) — validated, never trusted. */
export const ICE_SERVERS_GLOBAL = '__pascalIceServers'
/**
 * Same-origin route that mints short-lived relay credentials SERVER-SIDE (the
 * plugin never sees a key). A 404 means "this host has no relay", which keeps
 * the STUN defaults and is not an error.
 */
export const RELAY_CREDENTIALS_PATH = '/api/plugins/boots/turn'
export const RELAY_FETCH_TIMEOUT_MS = 2500
/** Fetched credentials are good for their TTL (an hour); refresh before it. */
export const ICE_CACHE_MS = 50 * 60_000
/** A failed fetch (404, offline) is not retried sooner than this. */
export const ICE_RETRY_MS = 60_000

export type IceSource = 'default' | 'host' | 'fetched' | 'set'

let iceServers: RTCIceServer[] = [...DEFAULT_ICE_SERVERS]
let iceSource: IceSource = 'default'
let iceFetchedAt = 0
let iceFailedAt = 0
let iceFetchInFlight = false
/**
 * Set when `new RTCPeerConnection({ iceServers })` threw on a non-default set:
 * the validator let something through the browser would not take. The link is
 * rebuilt on the defaults on the spot (makeLink) and the host global / route are
 * not adopted again this session — re-adopting the same set would fail the same
 * way on the next tick, forever. An explicit `setVoiceIceServers` clears it.
 */
let iceRefused = false

/**
 * Point voice at a relay (TURN) when there is one. Validated like every other
 * source; garbage leaves the defaults in place. Takes effect on new peers.
 */
export function setVoiceIceServers(servers: RTCIceServer[]): void {
  const read = readIceServers(servers)
  iceServers = read ? mergeIceServers(DEFAULT_ICE_SERVERS, read) : [...DEFAULT_ICE_SERVERS]
  iceSource = read ? 'set' : 'default'
  iceRefused = false
}

/** The set the next RTCPeerConnection will be built with. */
export function voiceIceServers(): readonly RTCIceServer[] {
  return iceServers
}

function adoptHostIceServers(): boolean {
  const read = readIceServers((globalThis as Record<string, unknown>)[ICE_SERVERS_GLOBAL])
  if (!read) return false
  iceServers = mergeIceServers(DEFAULT_ICE_SERVERS, read)
  iceSource = 'host'
  return true
}

/**
 * Resolve the ICE set: an explicit `setVoiceIceServers` wins, then the host
 * global, then the same-origin credentials route — fire-and-forget, cached,
 * every failure silent. Called from the veil click (seconds before the first
 * link is built, so the first offer already carries the relay) and again from
 * `startVoice`. `makeLink` reads `iceServers` at construction, so a fetch that
 * lands late still benefits every restart.
 */
export function prefetchIceServers(now = Date.now()): void {
  if (iceSource === 'set' || iceRefused) return
  if (adoptHostIceServers()) return
  if (iceSource === 'fetched' && now - iceFetchedAt < ICE_CACHE_MS) return
  if (iceFailedAt !== 0 && now - iceFailedAt < ICE_RETRY_MS) return
  if (iceFetchInFlight) return
  if (typeof fetch !== 'function' || typeof location === 'undefined') return
  if (!/^https?:$/.test(location.protocol)) return
  iceFetchInFlight = true
  let signal: AbortSignal | undefined
  try {
    signal = AbortSignal.timeout?.(RELAY_FETCH_TIMEOUT_MS)
  } catch {
    signal = undefined
  }
  fetch(RELAY_CREDENTIALS_PATH, { credentials: 'same-origin', signal })
    .then((res) => (res.ok ? res.json() : null))
    .then((body: unknown) => {
      const read = readIceServers(body)
      if (!read) {
        iceFailedAt = Date.now()
        return
      }
      // An explicit set or a host global that appeared meanwhile outranks us.
      if (iceSource === 'set' || iceSource === 'host') return
      iceServers = mergeIceServers(DEFAULT_ICE_SERVERS, read)
      iceSource = 'fetched'
      iceFetchedAt = Date.now()
    })
    .catch(() => {
      iceFailedAt = Date.now()
    })
    .finally(() => {
      iceFetchInFlight = false
    })
}

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * 'asking' is the permission dialog being open: set synchronously before the
 * getUserMedia await so a second press (or a second entry path) cannot start a
 * second prompt, and so the pill can say what is happening.
 */
export type MicState = 'off' | 'asking' | 'live' | 'muted' | 'denied' | 'unavailable'

/** The player's standing choice — asked for on the veil, remembered across reloads. */
export type MicPref = 'on' | 'off'

export type PeerLinkState = 'idle' | 'negotiating' | 'connected' | 'failed'

/** Something the HUD may want to say the moment it happens (voice-controls.tsx). */
export type VoiceEvent = {
  type: 'connected' | 'lost' | 'unreachable'
  sessionId: string
  name: string
}

type PeerLink = {
  sessionId: string
  pc: RTCPeerConnection
  /** The transceiver's sender — `replaceTrack` swaps the mic in with NO
   * renegotiation, which is why the mic can be enabled mid-call for free. */
  sender: RTCRtpSender | null
  element: HTMLAudioElement | null
  /** Epoch of the description we owe them / last sent. */
  epoch: number
  /** The description still to deliver, or null once they have it. */
  outbound: VoiceDescription | null
  /** Newest epoch we have applied FROM them (what we put in `ack`). */
  applied: number
  /**
   * ONE NEGOTIATION AT A TIME, PER PAIR — the epoch currently being answered or
   * applied, marked BEFORE the first `await` and cleared when it settles.
   *
   * `applied` cannot do this job: it is written at the END of the handshake,
   * after ICE gathering, seconds later. In between, the offerer re-sends the same
   * description every tick until it is acknowledged, so the answerer used to see
   * ten or thirty copies of an offer it had not finished answering and start a
   * whole new negotiation for each — every one of them a `setRemoteDescription`
   * on a connection already mid-flight. The last local answer to survive that
   * interleaving then belonged to no offer the other side was still holding,
   * which is a connected pair with media in one direction.
   */
  busy: number
  /** Their epoch we have acknowledged and they have seen — stops the resend. */
  ackedByThem: boolean
  state: PeerLinkState
  attempts: number
  startedAt: number
  /** Last tick this peer was in the roster — the grace period is measured off it. */
  seenAt: number
  /** When an established connection went 'disconnected' (0 = it has not). */
  droppedAt: number
  talking: boolean
  talkingAt: number
  /** Last gain we wrote, so the tick does not touch the element needlessly. */
  gain: number
  /**
   * HOW FAR THE HANDSHAKE GOT, as a label — the one field that turns "voice
   * doesn't work" into a place to look.
   *
   * Every step of a negotiation is an `await` on a browser API, and the two ways
   * one of them ends badly are indistinguishable from outside: an await that
   * never settles and an await that settled into a silent `return` both leave a
   * link sitting in `'negotiating'` with nothing owed. `state` cannot tell them
   * apart because it is the same value for both, and neither logs anything.
   *
   * So each stage stamps this on the way past. A stuck link reads as the stage it
   * is stuck IN; a link that gave up reads as the reason it gave up.
   */
  step: string
  /** Whatever a caught negotiation error said, for the same reason. */
  error: string | null
  /** Heard on the same-device beacon (or same clientId): mixed at zero gain. */
  sameDevice: boolean
  /**
   * THE PEER is a listener: it offered to us from outside the game roster, or
   * its frames say `listen: true`. We never offer to a listener (its next offer
   * is what repairs the pair) and it counts against MAX_LISTENERS_PER_PLAYER.
   * Cleared the tick the session shows up in the game roster — a player whose
   * presence frame arrived after its offer is a player.
   */
  listener: boolean
}

type VoiceState = {
  active: boolean
  /**
   * LISTEN MODE (startVoiceListen): we are an editor viewer hearing the game.
   * No mic is attached to any sender, every transceiver is recvonly, we offer
   * to every player in the room, and `startVoice` adopts us in place on drop-in.
   */
  listen: boolean
  mode: VoiceMode
  timer: ReturnType<typeof setInterval> | null
  offFrame: (() => void) | null
  getLocalPosition: (() => readonly [number, number, number]) | null
  peers: Map<string, PeerLink>
  /** Peers we have given up on — kept so we do not loop on them. */
  unreachable: Set<string>
  mic: MediaStream | null
  micState: MicState
  micTrack: MediaStreamTrack | null
  analyser: AnalyserNode | null
  /**
   * Exactly the buffer type this browser's AnalyserNode wants to be handed —
   * spelled off the method rather than as a bare `Float32Array`, because newer
   * TS libs parameterise typed arrays by their backing buffer and a plain
   * `Float32Array` widens to `ArrayBufferLike`, which `getFloatTimeDomainData`
   * then refuses. Deriving it means this line does not need editing again when
   * the lib changes its mind.
   */
  analyserBuffer: Parameters<AnalyserNode['getFloatTimeDomainData']>[0] | null
  micSource: MediaStreamAudioSourceNode | null
  talking: boolean
  /** The talk flag the last SENT frame carried — an edge publishes at once. */
  lastSentTalking: boolean
  /**
   * Something the next frame should carry NOW rather than on the heartbeat: a
   * talk edge, or an ack we just earned. The heartbeat is right for a flag that
   * has not changed and wrong for one that has — 400 ms is how long the peer
   * keeps re-sending an answer we already applied, and how long a mouth moves
   * before its ring lights.
   */
  signalDirty: boolean
  /** True for the duration of stopVoice, so teardown emits no 'lost' events. */
  stopping: boolean
  /** Peers currently mixed at zero because they share this machine. */
  sameDevice: number
  /** We are in a game with others but outside the voice room (past the cap). */
  excluded: boolean
  lastOverOpenAt: number
  ticks: number
  /**
   * ONE CLOCK for the whole module, advanced by `voiceTick(now)`.
   *
   * Every deadline here — the negotiation timeout, the talking-staleness window
   * — is a difference between a stamp taken when something started and the time
   * the tick is comparing it against. Taking one of those from `Date.now()` and
   * the other from the tick's argument makes the difference meaningless, so the
   * timeout either never fires or fires immediately, and the peer that needed a
   * restart sits there silent. Reading them both from here also means a test can
   * fast-forward fifteen seconds without waiting fifteen seconds.
   *
   * Frames ingested between ticks are stamped with the previous tick's value, so
   * these stamps are up to VOICE_TICK_MS old. Both windows are an order of
   * magnitude longer than that.
   */
  clock: number
  lastTarget: string | null
  /** Clock reading of the previous tick, to notice that this page was frozen. */
  lastTickAt: number
  /** Observability — every one of these is a silent failure otherwise. */
  counters: {
    offersSent: number
    answersSent: number
    offersApplied: number
    answersApplied: number
    dropped: number
    tooLarge: number
    restarts: number
    given_up: number
    /**
     * Frames the transport did NOT put on the wire — coalesced away, oversized,
     * or published with no bus. Harmless on its own (every frame is idempotent
     * and re-sent on the heartbeat) and the first thing to look at when a peer
     * takes several seconds to connect, so it is counted rather than ignored.
     */
    notSent: number
    /**
     * A description the browser agreed to make and then did not hand back — the
     * `localDescription` was empty after `setLocalDescription` resolved. Nothing
     * threw, so this is invisible without a counter, and the peer waits for a
     * frame that will never be built until the negotiation times out.
     */
    abandoned: number
    /** Negotiations that ended in a caught exception (see `link.error`). */
    threw: number
    /**
     * Links torn down because the peer stayed out of the roster past
     * PEER_ABSENT_MS. One per person who left is the healthy reading; a number
     * that climbs during a call is presence churn eating the handshake, and
     * without it that failure is indistinguishable from a peer who cannot be
     * reached — same silence, same empty connection state, opposite fix.
     */
    reaped: number
    /**
     * Ticks that arrived after a gap long enough to mean this page was not
     * running. Expected to be non-zero in any real session — somebody switches
     * windows — and worth seeing, because the alternative reading of the same
     * event is "every peer went silent at once".
     */
    stalls: number
    /**
     * `new RTCPeerConnection` threw. With a validated ICE set this should never
     * happen; when it does, the link falls back to the default set (makeLink)
     * and this is the only trace of it.
     */
    pcFailed: number
    /**
     * Offers from listeners we did not answer because we already carry
     * MAX_LISTENERS_PER_PLAYER of them. The listener sees a timeout and gives
     * up countably on its side; this is the matching number on ours.
     */
    listenersRefused: number
  }
}

/**
 * Where the mode lives between visits. It is a PREFERENCE, not session state:
 * somebody who picked proximity because they are building on opposite ends of a
 * house did not pick it for one page load, and re-picking it every reload is the
 * kind of small friction that ends with the feature unused.
 *
 * One key for the whole browser rather than one per project, because the choice
 * is about how the person likes to be heard, not about the building.
 */
const MODE_KEY = 'boots.voice.mode.1'

function loadMode(): VoiceMode {
  const stored = browserPendingStorage()?.getItem(MODE_KEY)
  // Anything unrecognised — a hand-edited value, a mode a newer build wrote —
  // falls back to the default rather than being trusted into the state.
  return isVoiceMode(stored) ? stored : 'squad'
}

/**
 * The mic PREFERENCE, same reasoning as the mode: the owner wants everyone
 * talking by default, so missing or garbage reads 'on'; a player who switched
 * it off on the veil or muted in-game is not asked again on the next visit.
 * Written ONLY on an explicit choice — never on a denial, because a first-time
 * refusal must not become a permanent opt-out (see toggleMic).
 */
export const MIC_PREF_KEY = 'boots.voice.mic.1'

export function loadMicPref(): MicPref {
  const stored = browserPendingStorage()?.getItem(MIC_PREF_KEY)
  return stored === 'off' ? 'off' : 'on'
}

export function saveMicPref(pref: MicPref): void {
  try {
    browserPendingStorage()?.setItem(MIC_PREF_KEY, pref)
  } catch {
    // A refusing storage costs the memory of the choice, not the choice.
  }
}

const state: VoiceState = {
  active: false,
  listen: false,
  mode: loadMode(),
  timer: null,
  offFrame: null,
  getLocalPosition: null,
  peers: new Map(),
  unreachable: new Set(),
  mic: null,
  micState: 'off',
  micTrack: null,
  analyser: null,
  analyserBuffer: null,
  micSource: null,
  talking: false,
  lastSentTalking: false,
  signalDirty: false,
  stopping: false,
  sameDevice: 0,
  excluded: false,
  lastOverOpenAt: 0,
  ticks: 0,
  clock: 0,
  lastTarget: null,
  lastTickAt: 0,
  counters: {
    offersSent: 0,
    answersSent: 0,
    offersApplied: 0,
    answersApplied: 0,
    dropped: 0,
    tooLarge: 0,
    restarts: 0,
    given_up: 0,
    notSent: 0,
    abandoned: 0,
    threw: 0,
    reaped: 0,
    stalls: 0,
    pcFailed: 0,
    listenersRefused: 0,
  },
}

// ── Capability ───────────────────────────────────────────────────────────────

export function voiceSupported(): boolean {
  return typeof globalThis.RTCPeerConnection === 'function'
}

export function micSupported(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia)
}

// ── Output elements ──────────────────────────────────────────────────────────

/** Elements primed in the entry click — one per possible peer. */
export const OUTPUT_POOL_SIZE = MAX_VOICE_PEERS
/**
 * One silent 16-bit mono sample at 44.1 kHz — 46 bytes, RIFF size 38, a `data`
 * chunk of 2 bytes: the smallest thing an element can play(). It carries a
 * REAL sample on purpose: a WAV whose data chunk is empty is refused by some
 * decoders (play() rejects NotSupportedError), and a refused play() is no
 * gesture unlock at all.
 */
const SILENT_WAV =
  'data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQIAAAAAAA=='
const outputPool: HTMLAudioElement[] = []

/**
 * PRIME THE OUTPUTS INSIDE THE GESTURE. Safari — iOS above all — lets an
 * HTMLAudioElement play a stream later only if THAT ELEMENT was played once by
 * a user gesture; a peer's track arriving seconds after the click lands on an
 * element the browser has never seen, and play() is refused in silence. So the
 * entry click (mic-gate.ts, before any preference branch) creates the pool and
 * play()s a silent sample through each; attachRemote hands those out. Everyone
 * gets this, mic on or off: hearing does not depend on speaking.
 */
export function primeVoiceOutputs(): void {
  if (typeof Audio !== 'function') return
  while (outputPool.length < OUTPUT_POOL_SIZE) {
    let element: HTMLAudioElement
    try {
      element = new Audio(SILENT_WAV)
    } catch {
      return
    }
    try {
      const played = element.play()
      if (played && typeof played.catch === 'function') played.catch(() => {})
    } catch {
      // A stack whose play() throws synchronously: the element is still usable.
    }
    outputPool.push(element)
  }
}

function takeOutput(): HTMLAudioElement | null {
  const pooled = outputPool.pop()
  if (pooled) return pooled
  if (typeof Audio !== 'function') return null
  try {
    return new Audio()
  } catch {
    return null
  }
}

function returnOutput(element: HTMLAudioElement): void {
  element.pause()
  element.srcObject = null
  if (outputPool.length < OUTPUT_POOL_SIZE) outputPool.push(element)
}

// ── Same-device beacon ───────────────────────────────────────────────────────

export const SAME_DEVICE_CHANNEL = 'boots.voice.same-device.1'
/** A beacon rides every heartbeat (400 ms); this many ms without one and the tab is gone. */
export const SAME_DEVICE_STALE_MS = 3000

let sameDeviceChannel: BroadcastChannel | null = null
/** sessionId → clock reading of the last beacon heard from it. */
const sameDeviceSeen = new Map<string, number>()
let localEcho = false

function openSameDeviceBeacon(me: string): void {
  closeSameDeviceBeacon()
  if (typeof BroadcastChannel !== 'function') return
  try {
    const channel = new BroadcastChannel(SAME_DEVICE_CHANNEL)
    channel.onmessage = (event: MessageEvent) => {
      const data = event.data as { v?: unknown; sessionId?: unknown } | null
      if (!data || typeof data !== 'object' || data.v !== 1) return
      const sessionId = data.sessionId
      if (typeof sessionId !== 'string' || sessionId.length === 0) return
      if (sessionId.length > MAX_SESSION_ID_CHARS || sessionId === me) return
      sameDeviceSeen.set(sessionId, state.clock)
    }
    sameDeviceChannel = channel
  } catch {
    sameDeviceChannel = null
  }
}

function closeSameDeviceBeacon(): void {
  try {
    sameDeviceChannel?.close()
  } catch {
    // Already closed.
  }
  sameDeviceChannel = null
  sameDeviceSeen.clear()
}

function sendSameDeviceBeacon(me: string): void {
  try {
    sameDeviceChannel?.postMessage({ v: 1, sessionId: me })
  } catch {
    // A closed channel — nothing to say to nobody.
  }
}

function isSameDevice(sessionId: string): boolean {
  if (localEcho) return false
  const heardAt = sameDeviceSeen.get(sessionId)
  if (heardAt !== undefined && state.clock - heardAt <= SAME_DEVICE_STALE_MS) return true
  // Belt to the beacon's braces: a host that mints one clientId per browser.
  const bus = netBus()
  const remote = getRemotes().get(sessionId)
  return bus !== null && remote !== undefined && remote.clientId === bus.clientId
}

/**
 * Hear same-machine peers anyway (a QA run that wants audio out of two tabs).
 * Off by default: two tabs on one laptop played out loud is feedback.
 */
export function setVoiceLocalEcho(on: boolean): void {
  localEcho = on
  for (const link of state.peers.values()) link.gain = -1
}

// ── Events ───────────────────────────────────────────────────────────────────

const voiceListeners = new Set<(event: VoiceEvent) => void>()

/** Subscribe to connected / lost / unreachable per peer. Returns the unsubscribe. */
export function onVoiceEvent(handler: (event: VoiceEvent) => void): () => void {
  voiceListeners.add(handler)
  return () => {
    voiceListeners.delete(handler)
  }
}

function peerName(sessionId: string): string {
  const remote = getRemotes().get(sessionId)
  return remote?.nick || participantName(remote?.userId ?? '')
}

function emitVoiceEvent(type: VoiceEvent['type'], sessionId: string): void {
  if (voiceListeners.size === 0) return
  const event: VoiceEvent = { type, sessionId, name: peerName(sessionId) }
  for (const handler of [...voiceListeners]) {
    try {
      handler(event)
    } catch {
      // A listener's bug is not the call's problem.
    }
  }
}

// ── Peer lifecycle ───────────────────────────────────────────────────────────

/** Wait for ICE gathering, then give up and send what we have (see header). */
function gathered(pc: RTCPeerConnection): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      resolve()
      return
    }
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      pc.removeEventListener('icegatheringstatechange', onChange)
      pc.removeEventListener('icecandidate', onCandidate)
      resolve()
    }
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') finish()
    }
    // A null candidate is end-of-candidates and is more reliable across engines
    // than the state change; the timer covers the stacks that emit neither.
    const onCandidate = (event: Event) => {
      if ((event as RTCPeerConnectionIceEvent).candidate === null) finish()
    }
    const timer = setTimeout(finish, ICE_GATHER_MS)
    pc.addEventListener('icegatheringstatechange', onChange)
    pc.addEventListener('icecandidate', onCandidate)
  })
}

function attachRemote(link: PeerLink, stream: MediaStream): void {
  if (link.element) {
    link.element.srcObject = stream
    return
  }
  // Primed in the entry click when there was one (see primeVoiceOutputs); a
  // fresh element otherwise. Never in the DOM: a floating element plays fine and
  // cannot be styled, clicked or scrolled away by the host page.
  const element = takeOutput()
  if (!element) return
  element.srcObject = stream
  element.autoplay = true
  element.muted = false
  element.volume = state.mode === 'squad' ? 1 : 0
  void element.play().catch(() => {
    // Autoplay refusal. Entry to a session is a click, so by the time a peer's
    // track arrives the page is nearly always allowed to play audio; when it is
    // not, the heartbeat retries play() until one attempt after an input lands.
  })
  link.element = element
  // The tick writes the real level (same-device, proximity) on its next pass.
  link.gain = -1
}

/** The direction we negotiate: a listener only ever receives. */
function ourDirection(): RTCRtpTransceiverDirection {
  return state.listen ? 'recvonly' : 'sendrecv'
}

/** Sessions in the game roster right now (a player, as opposed to a listener). */
function peerInGame(sessionId: string): boolean {
  return getRemotes().get(sessionId)?.ph === 'game'
}

function listenerLinkCount(): number {
  let count = 0
  for (const link of state.peers.values()) if (link.listener) count++
  return count
}

function makeLink(sessionId: string, listener = false): PeerLink | null {
  let pc: RTCPeerConnection
  try {
    pc = new RTCPeerConnection({ iceServers })
  } catch {
    // The browser refused the configuration (a relay entry it will not take).
    // Counted — the tick's `if (!link) continue` is otherwise a silent death
    // for every peer — and, when the set was not ours, rebuilt on the defaults
    // in the same tick so the pair does not lose a round to it.
    state.counters.pcFailed++
    if (iceSource === 'default') return null
    iceServers = [...DEFAULT_ICE_SERVERS]
    iceSource = 'default'
    iceRefused = true
    try {
      pc = new RTCPeerConnection({ iceServers })
    } catch {
      return null
    }
  }
  const link: PeerLink = {
    sessionId,
    pc,
    sender: null,
    element: null,
    epoch: 0,
    outbound: null,
    applied: 0,
    busy: 0,
    ackedByThem: false,
    state: 'idle',
    attempts: 0,
    startedAt: state.clock,
    seenAt: state.clock,
    droppedAt: 0,
    talking: false,
    talkingAt: 0,
    gain: -1,
    step: 'new',
    error: null,
    sameDevice: false,
    listener,
  }
  // ONE sendrecv audio transceiver, created before any description exists.
  // Negotiating the send direction up front is what lets the mic be enabled
  // later with `replaceTrack` and no second handshake — the alternative is a
  // renegotiation in the middle of a firefight. A LISTENER's is recvonly, and
  // no track ever touches its sender: the answer to a recvonly offer can only
  // be sendonly, so a listener cannot be heard even by accident.
  try {
    const transceiver = pc.addTransceiver('audio', { direction: ourDirection() })
    link.sender = transceiver.sender
    if (state.micTrack && !state.listen) void transceiver.sender.replaceTrack(state.micTrack).catch(() => {})
  } catch {
    // Very old stacks: fall back to whatever a track add gives us.
    if (state.micTrack && !state.listen) {
      try {
        link.sender = pc.addTrack(state.micTrack, new MediaStream([state.micTrack]))
      } catch {
        link.sender = null
      }
    }
  }
  pc.addEventListener('track', (event) => {
    const stream = event.streams[0] ?? new MediaStream([event.track])
    attachRemote(link, stream)
  })
  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'connected') {
      // The moment a pair is up is the one thing worth announcing: until now the
      // only proof of a working call was somebody speaking.
      if (link.state !== 'connected') emitVoiceEvent('connected', sessionId)
      link.state = 'connected'
      link.droppedAt = 0
      // THE ATTEMPT BUDGET IS FOR "CANNOT CONNECT", NOT FOR "HAS BEEN CONNECTED".
      // Without this, a pair that reconnects after every network hiccup spends
      // one attempt each time and is eventually written off as unreachable —
      // having demonstrably been reachable, repeatedly.
      link.attempts = 0
      return
    }
    if (pc.connectionState === 'failed') {
      restart(link, 'ice-failed')
      return
    }
    // 'disconnected' is not a verdict: ICE says the selected pair stopped
    // responding, and it often recovers on its own within a second or two. But
    // nothing here used to look at it again, so a call that dropped once stayed
    // dropped for the rest of the session — state 'connected', connectionState
    // 'disconnected', silence, and no counter moving. The tick gives it
    // DISCONNECT_GRACE_MS to heal and then rebuilds.
    if (pc.connectionState === 'disconnected' && link.droppedAt === 0) {
      link.droppedAt = state.clock
    }
  })
  state.peers.set(sessionId, link)
  return link
}

function closeLink(link: PeerLink): void {
  try {
    link.pc.close()
  } catch {
    // A closed connection closing again is not a problem worth a branch.
  }
  if (link.element) {
    returnOutput(link.element)
    link.element = null
  }
  state.peers.delete(link.sessionId)
}

/** Tear a link down and start over, unless this peer has used up its attempts. */
function restart(link: PeerLink, _why: string): void {
  const { sessionId, attempts, epoch } = link
  // A pair that WAS up and is being rebuilt is news; a pair that never
  // connected is not (its outcome is 'connected' or 'unreachable', below).
  if (link.state === 'connected' && !state.stopping) emitVoiceEvent('lost', sessionId)
  closeLink(link)
  if (attempts + 1 >= MAX_NEGOTIATION_ATTEMPTS) {
    // Given up ON PURPOSE and countably. Without a relay, some pairs genuinely
    // cannot reach each other; retrying forever would burn a connection attempt
    // every fifteen seconds for the rest of the session and still be silent.
    state.unreachable.add(sessionId)
    state.counters.given_up++
    emitVoiceEvent('unreachable', sessionId)
    return
  }
  state.counters.restarts++
  // A listener stays a listener across the rebuild: we must still not offer to it.
  const fresh = makeLink(sessionId, link.listener)
  if (!fresh) return
  fresh.attempts = attempts + 1
  /**
   * THE EPOCH SURVIVES THE CONNECTION. It numbers descriptions for this PAIR,
   * not for this `RTCPeerConnection`, and starting a rebuilt link back at 0 was
   * a deadlock with no error anywhere:
   *
   * our first offer is epoch 1, they answer it and record `applied = 1`. We
   * restart — a timeout, a failed ICE — and offer again as epoch 1. Now BOTH
   * checks that exist to protect this protocol fire on the wrong side of the
   * truth: they see `epoch <= applied` and drop our new offer as one they have
   * already answered, so they never answer again; and their old answer, still
   * being re-sent, matches our new offer's epoch exactly, so we hand a
   * description built for a dead connection to a live one, `setRemoteDescription`
   * rejects it, and we restart — which produces epoch 1 again. Four rounds of
   * that and the pair is written off as unreachable, having been perfectly
   * reachable the whole time.
   *
   * Carrying the number forward makes every one of those checks correct again:
   * a newer offer is always a larger epoch, and a stale answer never matches.
   */
  fresh.epoch = epoch
}

// ── Signalling ───────────────────────────────────────────────────────────────

/**
 * An error as a short string. Name AND message, because the name alone
 * (`InvalidStateError`) does not say which state, and the message alone is not
 * always there. Bounded, since this is read in a debug dump, not thrown again.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 160)
  return String(error).slice(0, 160)
}

/**
 * A RENEGOTIATION DOES NOT UN-CONNECT A PAIR. `state` answers "can these two
 * hear each other"; a second offer/answer on a connection that is already up (a
 * listener dropping in and flipping its m-line to sendrecv) never takes the media
 * down, and `connectionstatechange` will not fire 'connected' a second time — so
 * writing 'negotiating' here would leave the pair reading disconnected forever
 * while it was audibly working, and would hand it to the negotiation timeout,
 * whose cure (tear the connection down) is worse than anything it could fix.
 */
function negotiationState(link: PeerLink): PeerLinkState {
  return link.pc.connectionState === 'connected' ? 'connected' : 'negotiating'
}

async function makeOffer(link: PeerLink): Promise<void> {
  link.state = negotiationState(link)
  link.startedAt = state.clock
  link.error = null
  try {
    link.step = 'offer:create'
    const offer = await link.pc.createOffer()
    link.step = 'offer:local'
    await link.pc.setLocalDescription(offer)
    link.step = 'offer:gather'
    await gathered(link.pc)
    const sdp = link.pc.localDescription?.sdp
    if (!sdp) {
      // Agreed to make a description, then handed back nothing. Nothing threw,
      // so without the counter this peer just waits out the timeout in silence.
      link.step = 'offer:no-sdp'
      state.counters.abandoned++
      return
    }
    const trimmed = trimSdpToBudget(sdp, MAX_SDP_CHARS)
    if (trimmed === null) {
      link.step = 'offer:too-large'
      state.counters.tooLarge++
      return
    }
    // ABOVE ANYTHING THEY HAVE SEEN FROM US. `epoch` counts the offers we made;
    // `applied` is the newest epoch we took from THEM — and when they were the
    // offerer, the answer they applied from us carried that same number. A side
    // that answered and now offers (a listener dropping in, a glare loser after
    // a restart) would otherwise re-use an epoch the far side has already
    // recorded as applied, and its offer would be dropped as a duplicate forever.
    link.epoch = Math.max(link.epoch, link.applied) + 1
    link.outbound = { type: 'offer', epoch: link.epoch, sdp: trimmed }
    link.step = 'offer:owed'
  } catch (error) {
    link.state = 'failed'
    link.step = 'offer:threw'
    link.error = describeError(error)
    state.counters.threw++
  }
}

/**
 * ADOPT THE TRANSCEIVER THE OFFER CREATED, AND MAKE IT SEND.
 *
 * This is the whole reason two real browsers connected and only one of them could
 * hear anything. WebRTC only recycles an existing transceiver for an incoming
 * m-line when that transceiver was created by `addTrack`; one we created with
 * `addTransceiver` is understood as a request for an m-line of OUR OWN. So the
 * answerer ended up holding two: the one it made up front, unassociated with any
 * m-line and unable to acquire one (an answer cannot add m-lines), and the one
 * the offer implicitly created — which the spec defines as **recvonly**.
 *
 * The answer therefore said "I only receive", and it was true. Both ends reported
 * a connected pair with a live sender; the offerer's transceiver settled at
 * `sendonly` and its receiver track stayed muted forever. Nothing threw, nothing
 * retried, and one person in the call could not be heard at all.
 *
 * So before answering, point the associated transceiver at 'sendrecv', move our
 * sender to it — the one `replaceTrack` will be called on when the mic comes up —
 * and stop the orphan so it cannot demand an m-line in some later negotiation.
 */
function adoptAssociatedTransceiver(link: PeerLink): void {
  const transceivers = link.pc.getTransceivers?.() ?? []
  // Audio-only module, so the first m-line is ours; `mid` is what says a
  // transceiver has one at all.
  const associated = transceivers.find((transceiver) => transceiver.mid !== null)
  if (!associated) return
  try {
    associated.direction = ourDirection()
  } catch {
    // A stack that refuses the assignment leaves the pair receive-only rather
    // than failing it — half a call beats none.
  }
  link.sender = associated.sender
  if (state.micTrack && !state.listen) void associated.sender.replaceTrack(state.micTrack).catch(() => {})
  for (const transceiver of transceivers) {
    if (transceiver === associated || transceiver.mid !== null) continue
    try {
      transceiver.stop?.()
    } catch {
      // Old stacks without stop(): an unassociated transceiver is inert here
      // anyway, because we never offer again on a connection we answered on.
    }
  }
}

async function makeAnswer(link: PeerLink, offer: VoiceDescription): Promise<void> {
  link.state = negotiationState(link)
  link.startedAt = state.clock
  // Claimed synchronously: every line below is an await, and the offerer is
  // re-sending this same description every tick until we acknowledge it.
  link.busy = offer.epoch
  try {
    if (link.pc.signalingState === 'have-local-offer') {
      // We are answering a peer we had also offered to. Handing an offer to a
      // connection that is already holding one of ours throws, which would fail
      // this pair permanently, so drop ours first. Only ever reached by the side
      // the ordering says should NOT have offered (see ingest) — the other side
      // keeps its offer, so exactly one description survives per pair.
      await link.pc.setLocalDescription({ type: 'rollback' })
    }
    // Ours is superseded either way: they are the offerer for this negotiation.
    link.outbound = null
    link.step = 'answer:remote'
    await link.pc.setRemoteDescription({ sdp: offer.sdp, type: 'offer' })
    state.counters.offersApplied++
    // BEFORE createAnswer: the direction the answer advertises is read off the
    // transceiver, and the one the offer just created only receives.
    adoptAssociatedTransceiver(link)
    link.step = 'answer:create'
    const answer = await link.pc.createAnswer()
    link.step = 'answer:local'
    await link.pc.setLocalDescription(answer)
    link.step = 'answer:gather'
    await gathered(link.pc)
    const sdp = link.pc.localDescription?.sdp
    if (!sdp) {
      link.step = 'answer:no-sdp'
      state.counters.abandoned++
      return
    }
    const trimmed = trimSdpToBudget(sdp, MAX_SDP_CHARS)
    if (trimmed === null) {
      link.step = 'answer:too-large'
      state.counters.tooLarge++
      return
    }
    link.applied = offer.epoch
    state.signalDirty = true // our ack map just changed
    // The answer carries the OFFER's epoch, so a late answer to a description
    // that has already been superseded is detectable instead of confusing.
    link.outbound = { type: 'answer', epoch: offer.epoch, sdp: trimmed }
    link.ackedByThem = false
    link.step = 'answer:owed'
  } catch (error) {
    link.state = 'failed'
    link.step = 'answer:threw'
    link.error = describeError(error)
    state.counters.threw++
  } finally {
    // Released whatever happened: an answer that fell over must not lock the pair
    // out of answering the next copy of the offer, and `applied` — which is only
    // written on success — is what stops a duplicate being answered twice.
    if (link.busy === offer.epoch) link.busy = 0
  }
}

function ackMap(): Record<string, number> {
  const ack: Record<string, number> = {}
  for (const link of state.peers.values()) {
    if (link.applied > 0) ack[link.sessionId] = link.applied
  }
  return ack
}

/** Is any peer still waiting on a description from us? */
function anythingOwed(): boolean {
  for (const link of state.peers.values()) {
    if (link.outbound !== null && !link.ackedByThem) return true
  }
  return false
}

/** Publish one frame: at most one peer's description, plus our own flags. */
function publishSignal(): void {
  const owed: string[] = []
  for (const link of state.peers.values()) {
    if (link.outbound !== null && !link.ackedByThem) owed.push(link.sessionId)
  }
  const target = nextSignalTarget(owed, state.lastTarget)
  state.lastTarget = target
  const frame: VoiceFrame = { v: VOICE_PROTOCOL, mode: state.mode, talking: state.talking }
  if (state.listen) frame.listen = true
  const ack = ackMap()
  if (Object.keys(ack).length > 0) frame.ack = ack
  let carriedDescription = false
  if (target !== null) {
    const link = state.peers.get(target)
    if (link?.outbound) {
      frame.to = target
      frame.sdp = link.outbound
      carriedDescription = true
    }
  }
  const outcome = publishFrame(VOICE_KIND, frame)
  // 'deferred' and 'suppressed' MEAN THE FRAME IS GONE — the host keeps only the
  // latest payload per event inside its window. Counting the description as sent
  // before knowing that would make `offersSent` a lie and hide exactly the
  // condition non-trickle signalling exists to survive.
  if (outcome !== 'sent') {
    state.counters.notSent++
    return
  }
  // What went out is what they now know: an edge or an ack is no longer owed.
  state.lastSentTalking = state.talking
  state.signalDirty = false
  if (!carriedDescription) return
  if (frame.sdp?.type === 'offer') state.counters.offersSent++
  else state.counters.answersSent++
}

function ingest(msg: NetMessage<VoiceFrame>): void {
  const me = localSessionId()
  if (me === null) return
  const from = msg.sessionId
  const frame = msg.data
  const link = state.peers.get(from)

  // A FRAME FROM THEM IS THE PROOF OF LIFE, not the presence roster.
  //
  // Presence rides the render loop, so a peer whose window is behind another one
  // stops publishing poses entirely and drops out of the roster after a few
  // seconds — while their voice frames, which ride an interval, keep arriving the
  // whole time. Reaping the link on the roster alone therefore hangs up on
  // somebody who is still plainly there and still talking to us over this very
  // channel. This one line is why alt-tabbing no longer ends the call.
  if (link) link.seenAt = state.clock

  // Their flags are useful even before a connection exists — that is what the
  // HUD's "who is talking" reads, and it costs nothing.
  if (link && frame.talking !== undefined) {
    link.talking = frame.talking
    link.talkingAt = state.clock
  }
  // A peer that SAYS it is a listener is one, whatever the roster says.
  if (link && frame.listen === true) link.listener = true

  // Did they acknowledge the description we are still re-sending?
  if (link?.outbound && frame.ack?.[me] === link.outbound.epoch) link.ackedByThem = true

  if (!frame.sdp || frame.to !== me) return

  const description = frame.sdp
  if (description.type === 'offer') {
    // We are the answerer for this pair. A peer that offers when the ordering
    // says we should have is answered anyway rather than deadlocked: the total
    // order exists to avoid glare, and refusing here would turn a peer running
    // a different build into permanent silence.
    let target = link
    if (!target) {
      if (state.unreachable.has(from)) return
      // An offerer we have no roster entry for is a LISTENER (or a player whose
      // presence frame is a beat behind its offer — the tick reclassifies that
      // one the moment it shows up). Listeners are capped per player: past the
      // cap the offer is simply not answered, and counted.
      const listener = frame.listen === true || !peerInGame(from)
      if (listener && !acceptsListener(listenerLinkCount())) {
        state.counters.listenersRefused++
        return
      }
      // A PLAYER the room does not pair us with (past the cap, or we are) is
      // not answered either: the tick closes such a link on its next pass, and
      // answering each re-send in between would build and tear down a
      // connection every 100 ms until the offerer's deadline. Its re-sends are
      // free to us, and the roster converges on both sides the same way.
      if (!listener && !meshNow().includes(from)) {
        state.counters.dropped++
        return
      }
      target = makeLink(from, listener) ?? undefined
      if (!target) return
    }
    if (description.epoch <= target.applied || description.epoch === target.busy) {
      // Already answered, or being answered right now — the resend loop means we
      // see the same offer many times before our answer is ever acknowledged.
      state.counters.dropped++
      return
    }
    // GLARE. Both ends offered — a build mismatch, or a link rebuilt at the
    // moment their offer was in flight. Resolved by the SAME total order that
    // assigns the offerer, so both sides reach the same verdict with no round
    // trip: whoever owns the pair keeps its own offer and ignores the other's;
    // the other rolls its offer back and answers. Deciding it any other way
    // (newest wins, first wins) leaves two half-open connections and silence.
    if (target.pc.signalingState === 'have-local-offer' && voiceOffererIsUs(me, from)) {
      state.counters.dropped++
      return
    }
    void makeAnswer(target, description)
    return
  }

  // An answer only means something to the side that offered it.
  if (!link || !link.outbound || link.outbound.type !== 'offer') {
    state.counters.dropped++
    return
  }
  if (description.epoch !== link.outbound.epoch) {
    state.counters.dropped++ // an answer to a superseded offer
    return
  }
  if (link.busy === description.epoch) {
    // The same hazard from the other end: the answerer re-sends until we ack, and
    // `outbound` is only cleared once this promise resolves. A second
    // `setRemoteDescription` for an answer already being applied rejects, and the
    // rejection path RESTARTS the pair — tearing down a call that was working.
    state.counters.dropped++
    return
  }
  link.busy = description.epoch
  link.pc
    .setRemoteDescription({ sdp: description.sdp, type: 'answer' })
    .then(() => {
      state.counters.answersApplied++
      link.applied = description.epoch
      // Applying the answer IS the acknowledgement: stop re-sending the offer.
      link.outbound = null
      // And TELL them on the next tick, not the next heartbeat: until our ack
      // lands they re-send that answer every 100 ms and we drop every copy.
      state.signalDirty = true
    })
    .catch(() => {
      restart(link, 'answer-rejected')
    })
    .finally(() => {
      if (link.busy === description.epoch) link.busy = 0
    })
}

// ── The microphone ───────────────────────────────────────────────────────────

function attachAnalyser(stream: MediaStream): void {
  const ctx = sharedAudioContext()
  if (!ctx) return
  try {
    const source = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    // NOT connected to any destination. This branch exists to MEASURE the mic;
    // routing it to the speakers would be feedback into whatever the laptop
    // microphone can hear, which is the game.
    source.connect(analyser)
    state.micSource = source
    state.analyser = analyser
    state.analyserBuffer = new Float32Array(analyser.fftSize)
  } catch {
    // No analyser means no voice-activity indicator; the call still works.
    state.analyser = null
  }
}

/**
 * THE EPOCH OF THE MICROPHONE. Bumped by every release; an acquisition that
 * resolves under a different epoch than it started with belongs to a session
 * that has already ended (Esc before the dialog was answered, a page leaving
 * the veil) and is stopped on the spot instead of becoming a hot mic nobody
 * asked for.
 */
let micEpoch = 0

/**
 * Let the microphone go — UNCONDITIONALLY. Runs first in stopVoice and from the
 * veil's cleanup: the recording indicator must go out whether or not a call was
 * ever active, and the old `if (!state.active) return` in front of the track
 * loop was exactly the mic leak this exists to close.
 */
export function releaseMic(): void {
  micEpoch++
  try {
    state.micSource?.disconnect()
  } catch {
    // A source on a closed context.
  }
  state.micSource = null
  state.analyser = null
  state.analyserBuffer = null
  for (const track of state.mic?.getTracks() ?? []) track.stop()
  state.mic = null
  state.micTrack = null
  state.micState = 'off'
  state.talking = false
  for (const link of state.peers.values()) {
    if (link.sender) void link.sender.replaceTrack(null).catch(() => {})
  }
}

function isNoDeviceError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : ''
  return name === 'NotFoundError' || name === 'OverconstrainedError'
}

/**
 * Ask for the microphone. Must be called from a user gesture the first time, or
 * the browser refuses without prompting.
 *
 * Idempotent — a second call while the dialog is open returns 'asking' and
 * starts NO second prompt — and safe to call when there is no bus or no peer:
 * the track is swapped into every existing sender with `replaceTrack`, so
 * enabling the mic mid-call costs no renegotiation.
 */
export async function enableMic(): Promise<MicState> {
  if (!micSupported()) {
    state.micState = 'unavailable'
    return state.micState
  }
  if (state.micTrack) {
    state.micTrack.enabled = true
    state.micState = 'live'
    return state.micState
  }
  if (state.micState === 'asking') return state.micState
  state.micState = 'asking'
  const epoch = micEpoch
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: true,
        // The three that decide whether a game voice call is usable: without
        // echo cancellation everyone hears themselves through everyone else,
        // and without suppression a fan is a second player.
        echoCancellation: true,
        noiseSuppression: true,
      },
      video: false,
    })
    if (epoch !== micEpoch) {
      // Released while the dialog was open: whoever asked is gone.
      for (const track of stream.getTracks()) track.stop()
      return state.micState
    }
    const track = stream.getAudioTracks()[0] ?? null
    if (!track) {
      state.micState = 'unavailable'
      return state.micState
    }
    state.mic = stream
    state.micTrack = track
    state.micState = 'live'
    attachAnalyser(stream)
    // NOT WHILE LISTENING. The veil acquires the mic a click before the game
    // starts, and if the viewer was listening in the editor that click lands
    // while the links are still recvonly. The track waits here; the handover
    // (adoptListen) puts it on every sender the moment the game owns the call.
    if (!state.listen) {
      for (const link of state.peers.values()) {
        if (link.sender) void link.sender.replaceTrack(track).catch(() => {})
      }
    }
    return state.micState
  } catch (error) {
    if (epoch !== micEpoch) return state.micState
    // Denied, or no input device. Either way we can still HEAR the room.
    state.micState = isNoDeviceError(error) ? 'unavailable' : 'denied'
    return state.micState
  }
}

/** Mute without giving up the device (the peers get silence, we keep the call). */
export function setMicMuted(muted: boolean): void {
  if (!state.micTrack) return
  state.micTrack.enabled = !muted
  state.micState = muted ? 'muted' : 'live'
  if (muted) state.talking = false
}

export function micState(): MicState {
  return state.micState
}

/**
 * Toggle: acquires on the first press, then mutes and unmutes. An explicit
 * choice, so it is REMEMBERED — 'on' when the mic came up or was unmuted, 'off'
 * when it was muted. A denial writes nothing: a refused dialog is not a
 * preference, and must not silence every future visit.
 */
export async function toggleMic(): Promise<MicState> {
  if (state.micState === 'asking') return state.micState
  if (!state.micTrack) {
    const result = await enableMic()
    if (result === 'live') saveMicPref('on')
    return result
  }
  setMicMuted(state.micState === 'live')
  saveMicPref(state.micState === 'live' ? 'on' : 'off')
  return state.micState
}

/**
 * Turn the mic on WITHOUT prompting, but only if permission was already given
 * and the player has not switched the mic off.
 *
 * @deprecated The veil preflight (mic-gate.ts) acquires the mic before the game
 * is entered. This remains as the backstop for entry paths that have no veil
 * (the sidebar's Jump in) and is idempotent against a mic the veil already
 * brought up.
 */
export async function enableMicIfAlreadyPermitted(): Promise<MicState> {
  if (!micSupported()) return 'unavailable'
  if (loadMicPref() === 'off') return state.micState
  // The permission read is an await with nothing holding the device yet, so a
  // release in that window (Esc in the first ~100 ms, the auto-exit when
  // fullscreen is refused) would otherwise be followed by an acquisition in a
  // NEW epoch: a hot mic in the editor with nothing left to release it.
  const epoch = micEpoch
  try {
    const status = await navigator.permissions?.query({
      name: 'microphone' as PermissionName,
    })
    if (status?.state !== 'granted') return state.micState
  } catch {
    // Firefox has no 'microphone' permission descriptor. Not prompting is the
    // conservative answer: the HUD still offers the key.
    return state.micState
  }
  if (epoch !== micEpoch) return state.micState
  return enableMic()
}

/** Test seam: an RMS source in place of the analyser (bun has no WebAudio). */
let micLevelSource: (() => number) | null = null
export function setMicLevelSource(read: (() => number) | null): void {
  micLevelSource = read
}

function readMicLevel(): number {
  if (micLevelSource) return micLevelSource()
  const analyser = state.analyser
  const buffer = state.analyserBuffer
  if (!analyser || !buffer) return 0
  analyser.getFloatTimeDomainData(buffer)
  let sum = 0
  for (let i = 0; i < buffer.length; i++) sum += buffer[i]! * buffer[i]!
  return Math.sqrt(sum / buffer.length)
}

// ── Mode ─────────────────────────────────────────────────────────────────────

export function setVoiceMode(mode: VoiceMode): void {
  state.mode = mode
  // Force the next tick to rewrite every level.
  for (const link of state.peers.values()) link.gain = -1
  try {
    browserPendingStorage()?.setItem(MODE_KEY, mode)
  } catch {
    // A full or refusing quota must not cost the mode change itself — the
    // running call already switched above.
  }
}

export function voiceMode(): VoiceMode {
  return state.mode
}

export function toggleVoiceMode(): VoiceMode {
  setVoiceMode(state.mode === 'squad' ? 'proximity' : 'squad')
  return state.mode
}

// ── The tick ─────────────────────────────────────────────────────────────────

function distanceTo(sessionId: string): number {
  const local = state.getLocalPosition?.()
  const remote = getRemotes().get(sessionId)
  if (!local || !remote) return Number.POSITIVE_INFINITY
  // The DRAWN body when the renderer is drawing it, the newest snapshot
  // otherwise — the voice fades where the eye sees the peer, not where the
  // wire last put them (pickPeerPosition).
  const at = pickPeerPosition(remote, latestSnapshot(remote.ring), state.clock)
  if (!at) return Number.POSITIVE_INFINITY
  return Math.hypot(local[0] - at[0], local[1] - at[1], local[2] - at[2])
}

/** The sessions we should be in a call with, right now. */
function meshNow(): string[] {
  const me = localSessionId()
  if (me === null) return []
  if (state.listen) {
    // A listener hears the players' room and is never "outside the call": it
    // was never in the roster the room is cut from.
    const players: string[] = []
    for (const [sessionId, remote] of getRemotes()) {
      if (remote.ph === 'game' && sessionId !== me) players.push(sessionId)
    }
    state.excluded = false
    return listenTargets(players).filter((id) => !state.unreachable.has(id))
  }
  const inGame: string[] = [me]
  for (const [sessionId, remote] of getRemotes()) {
    if (remote.ph === 'game') inGame.push(sessionId)
  }
  // Past the room cap, and not in it: the pill says so instead of the player
  // wondering why a lot full of people is silent.
  state.excluded = inGame.length > 1 && !voiceRoom(inGame).includes(me)
  return voicePeersFor(me, inGame).filter((id) => !state.unreachable.has(id))
}

export function voiceTick(now: number): void {
  if (!state.active) return
  state.ticks++
  const previous = state.lastTickAt
  state.lastTickAt = now
  state.clock = now
  // A FROZEN PAGE DOES NOT GET TO BLAME ITS PEERS. If the gap since the last tick
  // is far longer than the tick interval, this page was not running, so none of
  // the elapsed time is evidence about anybody else — give it back to every
  // deadline that would otherwise expire the instant we wake up. Without this, a
  // hidden tab hangs up on the whole room on its first tick back, having spent
  // the outage not listening.
  if (previous !== 0 && now - previous > TICK_STALL_MS) {
    const stall = now - previous - VOICE_TICK_MS
    state.counters.stalls++
    state.lastOverOpenAt += stall
    for (const link of state.peers.values()) {
      link.seenAt += stall
      link.startedAt += stall
      link.talkingAt += stall
      if (link.droppedAt !== 0) link.droppedAt += stall
    }
    for (const [sessionId, heardAt] of sameDeviceSeen) sameDeviceSeen.set(sessionId, heardAt + stall)
  }
  const me = localSessionId()
  if (me === null) return

  // 1. The roster: reap peers who left, open links to peers who arrived.
  //
  // A PEER MISSING FROM THE ROSTER HAS NOT NECESSARILY LEFT. Presence is a
  // lossy stream, so it is normal for a remote to be absent from a tick or two;
  // closing the link on the first of them destroyed the connection, the gathered
  // candidates, the epoch and the applied watermark, and both sides then began
  // again from zero — over and over, never getting the few seconds a handshake
  // needs. Two browsers in the same room read as two unreachable machines.
  const wanted = new Set(meshNow())
  for (const link of [...state.peers.values()]) {
    if (wanted.has(link.sessionId)) {
      link.seenAt = now
      // In the game roster now: whatever it looked like when it first offered,
      // this is a player, and the repair below may offer to it.
      link.listener = false
      continue
    }
    // IN THE GAME ROSTER, YET NOT WANTED: the room cap says no — this peer is
    // past it, or we are. That is a verdict, not a flicker (the peer is right
    // there in presence), and it is the one case the frames-as-proof-of-life
    // rule in `ingest` would otherwise hold open for the rest of the session: a
    // listener who dropped into a FULL room stayed two-way connected to every
    // player it had been hearing, its own pill reading OUTSIDE THE CALL and
    // theirs still counting it as a listener; a player evicted by a lower id
    // joining kept hearing a room its pill said it was outside of.
    if (peerInGame(link.sessionId)) {
      state.counters.reaped++
      closeLink(link)
      continue
    }
    if (now - link.seenAt <= PEER_ABSENT_MS) continue
    state.counters.reaped++
    closeLink(link)
  }
  for (const sessionId of wanted) {
    if (state.peers.has(sessionId)) continue
    const link = makeLink(sessionId)
    if (!link) continue
    // Among players only the lower session id offers; the other side builds its
    // link when the offer lands, which is why this is not a deadlock. A
    // listener offers to everyone — nobody can offer to a peer they cannot see.
    if (
      voiceShouldOffer({
        mySessionId: me,
        peerSessionId: sessionId,
        meListening: state.listen,
        peerInGame: true,
      })
    ) {
      void makeOffer(link)
    }
  }

  // 1b. Repair, over EVERY link rather than only the ones the roster currently
  //     mentions — a link inside its absence grace period is exactly the one most
  //     likely to need help, and skipping it leaves the pair frozen in whatever
  //     half-state the dropout caught it in until presence comes back.
  for (const link of [...state.peers.values()]) {
    const sessionId = link.sessionId
    // A connection that WAS up and fell over. ICE 'disconnected' often heals by
    // itself, so it gets a grace period; past that the pair is rebuilt. Until
    // this branch existed a single blip meant that pair was silent for the rest
    // of the session with `state` still cheerfully reading 'connected'.
    if (link.droppedAt !== 0 && link.pc.connectionState === 'connected') {
      link.droppedAt = 0
    } else if (link.droppedAt !== 0 && now - link.droppedAt > DISCONNECT_GRACE_MS) {
      restart(link, 'dropped')
      continue
    }
    // A negotiation that never completed: start it over, boundedly.
    //
    // PATIENCE DEPENDS ON WHETHER ANYTHING IS HAPPENING. A link whose ICE is
    // checking or already up has a live path to the other machine and is waiting
    // on one more description; tearing that down at the same deadline as a link
    // that never heard anything throws away the expensive half of the handshake
    // — and, in a two-peer call, does it at exactly the moment the answer is in
    // flight, because both sides started their clocks together. The doubled
    // deadline still fires: a path that is up but never finishes DTLS is dead,
    // it just gets the benefit of the doubt first.
    const iceMoving =
      link.pc.iceConnectionState === 'checking' ||
      link.pc.iceConnectionState === 'connected' ||
      link.pc.iceConnectionState === 'completed'
    const patience = iceMoving ? NEGOTIATION_TIMEOUT_MS * 2 : NEGOTIATION_TIMEOUT_MS
    if (
      link.state === 'negotiating' &&
      now - link.startedAt > patience &&
      link.pc.connectionState !== 'connected'
    ) {
      restart(link, 'timeout')
      continue
    }
    // A negotiation that ENDED badly. Every `catch` in the signalling path lands
    // here, and until this branch existed such a link was never touched again:
    // the timeout above only looks at `'negotiating'`, so one rejected
    // createAnswer meant that pair was silent for the rest of the session with a
    // full attempt budget unspent. `restart` is bounded, so this cannot spin.
    if (link.state === 'failed') {
      restart(link, 'failed')
      continue
    }
    // An idle link on our side of the ordering never got its offer out (the
    // publish was coalesced away, or the mesh grew after we built the link).
    // Never to a listener: its own next offer is what repairs that pair.
    if (
      link.state === 'idle' &&
      link.outbound === null &&
      voiceShouldOffer({
        mySessionId: me,
        peerSessionId: sessionId,
        meListening: state.listen,
        peerInGame: !link.listener,
      })
    ) {
      void makeOffer(link)
    }
  }

  // 2. Our own talk state, off the mic analyser. NEVER WHILE LISTENING: the
  //    veil's ask-first click can leave a listener holding a live mic for as long
  //    as the PLAY button sits there, and that track is on no sender — a
  //    `talking: true` in its frames would light 'N SPEAKING' on the players'
  //    pill for a viewer nobody can hear.
  if (state.micState === 'live' && !state.listen) {
    const rms = readMicLevel()
    // The SAME threshold the gate opens on — the hang time is "time since the
    // level was last loud enough to open", so a second copy of the number here
    // would silently desynchronise the two halves of the gate.
    if (rms >= VAD_OPEN_RMS) state.lastOverOpenAt = now
    state.talking = talkGate({
      msSinceOverOpen: now - state.lastOverOpenAt,
      rms,
      wasTalking: state.talking,
    })
  } else {
    state.talking = false
  }
  // An EDGE goes out on this tick, not the heartbeat: 400 ms between a mouth
  // moving and its ring lighting is the difference between "it works" and
  // "is it working?"; the hang-off would otherwise last TALKING_STALE_MS.
  if (state.talking !== state.lastSentTalking) state.signalDirty = true

  const heartbeat = state.ticks % SIGNAL_EVERY_TICKS === 0

  // 3. Levels. Written only on change, so a squad call touches nothing — except
  //    the heartbeat's play() retry on an element that is still paused, which is
  //    how a refused autoplay heals once the player has clicked something.
  let sameDevice = 0
  for (const link of state.peers.values()) {
    const same = isSameDevice(link.sessionId)
    link.sameDevice = same
    if (same) sameDevice++
    // A listener has no body to measure from, so it hears the room flat.
    const gain = same ? 0 : mixGain(state.listen ? 'squad' : state.mode, distanceTo(link.sessionId))
    const element = link.element
    if (Math.abs(gain - link.gain) < 0.01) {
      if (heartbeat && element && element.paused && element.srcObject) {
        void element.play().catch(() => {})
      }
      continue
    }
    link.gain = gain
    if (element) {
      element.volume = Math.min(1, Math.max(0, gain))
      // iOS treats `volume` as read-only; `muted` is honoured everywhere, so a
      // zero gain is ALSO a mute and silence is silence on the phone too.
      element.muted = gain <= 0.001
      if (element.paused) void element.play().catch(() => {})
    }
  }
  state.sameDevice = sameDevice

  // 4. One signalling frame: every tick while a description is owed or a flag
  //    changed, otherwise every SIGNAL_EVERY_TICKS as a heartbeat. At most one
  //    description either way.
  //
  //    The heartbeat rate is right for what a heartbeat carries — a talk flag and
  //    an ack map that have not changed — and wrong for a handshake, where it is
  //    pure added latency on every hop, twice per round trip, on top of ICE
  //    gathering. A pair that cannot finish inside the negotiation deadline gets
  //    restarted, and a restart is far more expensive than the frames saved by
  //    waiting. So while anything is owed, this runs at the tick.
  if (netAvailable() && (heartbeat || state.signalDirty || anythingOwed())) {
    publishSignal()
  }
  // The same-device beacon rides the heartbeat: "I am session X, in this browser".
  if (heartbeat) sendSameDeviceBeacon(me)
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

/** What startVoice and startVoiceListen share: the transport, the beacon, the tick. */
function openVoice(listen: boolean, getLocalPosition: VoiceState['getLocalPosition']): boolean {
  if (!netAvailable() || !voiceSupported()) return false
  state.active = true
  state.listen = listen
  state.getLocalPosition = getLocalPosition
  state.ticks = 0
  state.clock = Date.now()
  state.lastTarget = null
  state.lastSentTalking = false
  state.signalDirty = false
  state.sameDevice = 0
  state.excluded = false
  state.unreachable.clear()
  prefetchIceServers()
  const me = localSessionId()
  if (me !== null) {
    openSameDeviceBeacon(me)
    sendSameDeviceBeacon(me)
  }
  registerFrameKind<VoiceFrame>(VOICE_KIND, readVoiceFrame)
  state.offFrame = onFrame<VoiceFrame>(VOICE_KIND, ingest)
  state.timer = setInterval(() => voiceTick(Date.now()), VOICE_TICK_MS)
  return true
}

/**
 * THE HANDOVER. The viewer who was listening just dropped in: the same module
 * keeps running, and the links it holds are kept — same RTCPeerConnections, same
 * ICE, same elements, so nothing the viewer was hearing stops. What changes is
 * the direction: every live m-line is flipped to sendrecv, the mic (acquired on
 * the veil, waiting) goes onto its sender, and a fresh offer one epoch up asks
 * the far side to renegotiate in place — its answerer path already adopts the
 * associated transceiver as sendrecv (adoptAssociatedTransceiver), so a pin that
 * has never heard of listeners completes this handshake correctly.
 *
 * A link that had NOT connected yet is rebuilt instead, HERE, as a player link:
 * it was mid-handshake as a recvonly offer, and stacking a second offer on a
 * first still in flight is a restart with extra steps. No audio was flowing on
 * it, so nothing is lost — but the PAIR's numbering is, unless it comes along
 * exactly as in `restart`: the far side may already have applied our epoch-1
 * offer (it answered; only ICE had not landed), and a rebuilt link that started
 * back at zero re-offered epoch 1, which the far side dropped as a duplicate on
 * every tick until a deadline fired. And WE offer, whatever the ids sort as: we
 * were this pair's offerer as a listener, so the far side holds no offer of its
 * own to glare with — only an answer to a connection we just closed, which it
 * would otherwise keep re-sending until its own timeout if it sorts as the
 * players' offerer and we sat waiting for it.
 *
 * THE GIVE-UP LIST WAS THE LISTENER'S. A viewer refused past a player's listener
 * cap (never answered, four timeouts) or failed by ICE from the editor wrote
 * those players off — as a listener. As a player it is somebody the room wants
 * and the players will offer to, and a fresh startVoice would have started
 * clean; carrying the list over made those pairs silent for the whole game with
 * no counter moving. Cleared for the same reason openVoice clears it.
 */
function adoptListen(getLocalPosition: VoiceState['getLocalPosition']): void {
  state.listen = false
  state.getLocalPosition = getLocalPosition
  state.excluded = false
  state.unreachable.clear()
  // The room WE are in now, as a player — a listener heard the players' room
  // from outside it; dropping into one that is already full puts us past the
  // cap, and a link to a player the room does not pair us with is closed here
  // rather than flipped to sendrecv and closed by the tick a beat later.
  const wanted = new Set(meshNow())
  for (const link of [...state.peers.values()]) {
    if (peerInGame(link.sessionId) && !wanted.has(link.sessionId)) {
      closeLink(link)
      continue
    }
    if (link.state !== 'connected' || link.pc.connectionState !== 'connected') {
      const { sessionId, epoch, applied } = link
      closeLink(link)
      const fresh = makeLink(sessionId)
      if (!fresh) continue
      fresh.epoch = Math.max(epoch, applied)
      void makeOffer(fresh)
      continue
    }
    // The m-line's transceiver — ours from addTransceiver when we offered, the
    // adopted one when a player offered to us. A connected link always has one;
    // the first transceiver is the fallback for a stack that never reports mids.
    const transceivers = link.pc.getTransceivers?.() ?? []
    const associated = transceivers.find((transceiver) => transceiver.mid !== null) ?? transceivers[0] ?? null
    if (associated) {
      try {
        associated.direction = 'sendrecv'
      } catch {
        // A stack that refuses the assignment: the re-offer below still goes out
        // and the pair stays as it was — hearing, not speaking — rather than dying.
      }
      link.sender = associated.sender
    }
    if (link.sender && state.micTrack) void link.sender.replaceTrack(state.micTrack).catch(() => {})
    link.outbound = null
    link.ackedByThem = false
    void makeOffer(link)
  }
}

/**
 * Open the voice layer for this session. Returns false — having done nothing at
 * all — with no bus or no WebRTC. Finding a LISTEN session active (the viewer
 * was hearing the game from the editor) adopts it in place: see adoptListen.
 */
export function startVoice(args: {
  getLocalPosition: () => readonly [number, number, number]
}): boolean {
  if (state.active) {
    if (state.listen) adoptListen(args.getLocalPosition)
    return true
  }
  return openVoice(false, args.getLocalPosition)
}

/**
 * HEAR THE GAME WITHOUT BEING IN IT. For the editor viewer: receive-only links
 * to the players' room, no microphone, flat mix. Idempotent, and a no-op while a
 * game session owns the call (that session hears everything already). Returns
 * false — having allocated nothing — with no bus or no WebRTC.
 */
export function startVoiceListen(): boolean {
  if (state.active) return true
  return openVoice(true, null)
}

/**
 * Stop listening. A NO-OP once the viewer has dropped in: the game session owns
 * the call then (`listen` is false) and its own stopVoice is the only thing
 * allowed to end it — mirroring how stopSpectating yields to stopPresence.
 */
export function stopVoiceListen(): void {
  if (!state.active || !state.listen) return
  stopVoice()
}

/**
 * Close it. The MICROPHONE IS RELEASED, deliberately: leaving a game must turn
 * the browser's recording indicator off, or the next thing the player does is
 * check whether we are still listening.
 */
export function stopVoice(): void {
  // ABOVE the active check, on purpose: a mic acquired on the veil for a call
  // that never started (no bus, no WebRTC, Esc during loading) is still a mic.
  releaseMic()
  if (!state.active) return
  state.active = false
  state.listen = false
  state.stopping = true
  if (state.timer !== null) clearInterval(state.timer)
  state.timer = null
  state.offFrame?.()
  state.offFrame = null
  for (const link of [...state.peers.values()]) closeLink(link)
  state.peers.clear()
  state.stopping = false
  closeSameDeviceBeacon()
  state.sameDevice = 0
  state.excluded = false
  state.getLocalPosition = null
}

export function voiceActive(): boolean {
  return state.active
}

/** Are we transmitting right now? */
export function selfTalking(): boolean {
  return state.talking
}

/**
 * Is this one peer talking right now? A map lookup, for the per-avatar frame
 * check — `talkingPeers()` allocates an array, and twelve avatars each calling
 * it every frame is 720 throwaway arrays a second for one boolean apiece.
 */
export function isPeerTalking(sessionId: string, now = state.clock): boolean {
  const link = state.peers.get(sessionId)
  if (!link || !link.talking) return false
  return now - link.talkingAt <= TALKING_STALE_MS
}

/** Session ids whose last frame said they were talking, recently enough. */
export function talkingPeers(now = state.clock): string[] {
  const out: string[] = []
  for (const link of state.peers.values()) {
    if (link.talking && now - link.talkingAt <= TALKING_STALE_MS) out.push(link.sessionId)
  }
  return out
}

/** How many peers are talking — the per-frame pill read, without the array. */
export function talkingPeerCount(now = state.clock): number {
  let count = 0
  for (const link of state.peers.values()) {
    if (link.talking && now - link.talkingAt <= TALKING_STALE_MS) count++
  }
  return count
}

/** In a game with others, but outside the voice room (past MAX_VOICE_PEERS). */
export function voiceExcluded(): boolean {
  return state.excluded
}

/** Peers mixed at zero gain because they share this machine (see the header). */
export function voiceSameDeviceCount(): number {
  return state.sameDevice
}

export function voiceUnreachableCount(): number {
  return state.unreachable.size
}

/**
 * How many editor viewers are LISTENING to us right now.
 *
 * Worth a number on the pill rather than nothing: a listener publishes no
 * presence, so somebody hearing the game is otherwise completely invisible to
 * the people in it — which is both a courtesy problem and, the first time
 * anybody notices, a "who was that" problem.
 */
export function voiceListenerCount(): number {
  let count = 0
  for (const link of state.peers.values()) {
    if (link.listener && link.state === 'connected') count++
  }
  return count
}

/** Links whose RTCPeerConnection is up right now — the "we are connected" number. */
export function voiceConnectedCount(): number {
  let count = 0
  for (const link of state.peers.values()) {
    if (link.state === 'connected') count++
  }
  return count
}

/**
 * Is a peer's stream sitting on a PAUSED element? That is a refused autoplay —
 * the browser wants a gesture before it will play sound this page did not start
 * — and the pill can say "click" instead of the player hearing nothing.
 */
export function voiceOutputBlocked(): boolean {
  for (const link of state.peers.values()) {
    if (link.element?.srcObject && link.element.paused) return true
  }
  return false
}

/** Retry every paused output now (call from a gesture handler). */
export function resumeVoiceOutputs(): void {
  for (const link of state.peers.values()) {
    const element = link.element
    if (element?.srcObject && element.paused) void element.play().catch(() => {})
  }
}

export type VoicePeerStats = {
  sessionId: string
  bytesReceived: number
  bytesSent: number
  /** Inbound audio level 0..1 as the receiver measures it (0 when the stack has none). */
  audioLevel: number
  rttMs: number | null
  /** The local candidate type of the selected pair: host | srflx | prflx | relay. */
  pair: string | null
}

/**
 * The numbers behind "connected but silent": bytes actually arriving, the
 * receiver's own level, the round trip and WHICH path won (`relay` is the one
 * that says the TURN seam is doing its job). Feature-detected per connection;
 * a stack without getStats yields nothing rather than throwing.
 */
export async function voiceStats(): Promise<VoicePeerStats[]> {
  const out: VoicePeerStats[] = []
  for (const link of [...state.peers.values()]) {
    const pc = link.pc as RTCPeerConnection & { getStats?: () => Promise<RTCStatsReport> }
    if (typeof pc.getStats !== 'function') continue
    let report: RTCStatsReport
    try {
      report = await pc.getStats()
    } catch {
      continue
    }
    const row: VoicePeerStats = {
      sessionId: link.sessionId,
      bytesReceived: 0,
      bytesSent: 0,
      audioLevel: 0,
      rttMs: null,
      pair: null,
    }
    const localTypes = new Map<string, string>()
    let selected: Record<string, unknown> | null = null
    report.forEach((entry: unknown) => {
      const s = entry as Record<string, unknown>
      if (s.type === 'inbound-rtp' && s.kind === 'audio') {
        if (typeof s.bytesReceived === 'number') row.bytesReceived += s.bytesReceived
        if (typeof s.audioLevel === 'number') row.audioLevel = Math.max(row.audioLevel, s.audioLevel)
      } else if (s.type === 'outbound-rtp' && s.kind === 'audio') {
        if (typeof s.bytesSent === 'number') row.bytesSent += s.bytesSent
      } else if (s.type === 'local-candidate') {
        if (typeof s.id === 'string' && typeof s.candidateType === 'string') {
          localTypes.set(s.id, s.candidateType)
        }
      } else if (s.type === 'candidate-pair') {
        const usable = s.state === 'succeeded' || s.nominated === true
        if (usable && (selected === null || s.nominated === true)) selected = s
      }
    })
    if (selected !== null) {
      const chosen = selected as Record<string, unknown>
      if (typeof chosen.currentRoundTripTime === 'number') {
        row.rttMs = Math.round(chosen.currentRoundTripTime * 1000)
      }
      if (typeof chosen.localCandidateId === 'string') {
        row.pair = localTypes.get(chosen.localCandidateId) ?? null
      }
    }
    out.push(row)
  }
  return out
}

/** One line per peer plus the counters — the QA dump behind `__boots.voice`. */
export function voiceDebug(): {
  active: boolean
  /** Running as an editor viewer's receive-only listen session. */
  listen: boolean
  mode: VoiceMode
  mic: MicState
  talking: boolean
  supported: boolean
  peers: Array<{
    sessionId: string
    name: string
    state: PeerLinkState
    connection: string
    ice: string
    epoch: number
    owed: string | null
    applied: number
    gain: number
    talking: boolean
    attempts: number
    hasTrack: boolean
    step: string
    error: string | null
    /**
     * How long this peer has been missing from the presence roster (ms, 0 while
     * present). A link inside its grace period looks idle in every other field,
     * so without this the reason it is not negotiating is invisible.
     */
    absentMs: number
    /**
     * Has the peer acknowledged what `owed` names? An answerer keeps its answer in
     * `outbound` for the whole session, so `owed` alone reads as a description
     * still going out every tick long after it landed — which is what made a
     * healthy call look like a stuck one in the two-browser dump.
     */
    acked: boolean
    /** Mixed at zero because this peer is a tab in the same browser. */
    sameDevice: boolean
    /** Did OUR description carry a relay candidate — is the TURN seam live for this pair. */
    localRelay: boolean
    /** This peer is a listener (an editor viewer hearing us): we never offer to it. */
    listener: boolean
  }>
  unreachable: string[]
  /** Where the ICE set came from, how big it is, and whether it has a relay. */
  ice: { source: IceSource; servers: number; relay: boolean }
  /** Same-machine peers, currently muted (see voiceSameDeviceCount). */
  sameDevice: number
  /** Outside the voice room (past the cap) while others are in the game. */
  excluded: boolean
  /** A peer's stream is on an element the browser refused to play. */
  outputBlocked: boolean
  counters: VoiceState['counters']
  /**
   * How many times the tick has run. Two readings a known wall-time apart say
   * whether the tick is running at all — a browser that has throttled a hidden
   * tab's timers starves every deadline in this module at once, and without this
   * number that reads as "the peer never answered".
   */
  ticks: number
} {
  const peers = [...state.peers.values()].map((link) => ({
    absentMs: Math.max(0, state.clock - link.seenAt),
    acked: link.ackedByThem,
    applied: link.applied,
    attempts: link.attempts,
    connection: link.pc.connectionState,
    epoch: link.epoch,
    gain: link.gain,
    hasTrack: Boolean(link.element?.srcObject),
    ice: link.pc.iceConnectionState,
    name: participantName(getRemotes().get(link.sessionId)?.userId ?? ''),
    owed: link.outbound ? `${link.outbound.type}@${link.outbound.epoch}` : null,
    error: link.error,
    sessionId: link.sessionId,
    state: link.state,
    step: link.step,
    talking: link.talking,
    sameDevice: link.sameDevice,
    localRelay: /typ relay/.test(link.pc.localDescription?.sdp ?? ''),
    listener: link.listener,
  }))
  return {
    active: state.active,
    listen: state.listen,
    counters: { ...state.counters },
    mic: state.micState,
    mode: state.mode,
    peers,
    supported: voiceSupported(),
    talking: state.talking,
    ticks: state.ticks,
    unreachable: [...state.unreachable],
    ice: { source: iceSource, servers: iceServers.length, relay: iceHasRelay(iceServers) },
    sameDevice: state.sameDevice,
    excluded: state.excluded,
    outputBlocked: voiceOutputBlocked(),
  }
}

/**
 * THE RAW WEBRTC STATE, per peer — for one-way audio and nothing else.
 *
 * `voiceDebug` answers "did the handshake finish"; this answers the question that
 * comes next and cannot be seen from there: media is negotiated per DIRECTION, so
 * a pair can be perfectly connected while one side's m-line came back `recvonly`,
 * or while a receiver exists whose track is muted and will never produce a sample.
 * Both look exactly like a working call from the outside and exactly like a broken
 * one to the person wearing headphones.
 *
 * Deliberately raw and unshaped: it is read by a human chasing a specific class of
 * bug, not by the HUD.
 */
export function voiceInternals(): Array<{
  sessionId: string
  signaling: string
  connection: string
  ice: string
  transceivers: Array<{ mid: string | null; direction: string; currentDirection: string | null }>
  receivers: Array<{ kind: string; muted: boolean; readyState: string }>
  senders: Array<{ hasTrack: boolean; kind: string | null; enabled: boolean | null }>
  elementHasStream: boolean
  elementTracks: number
  elementPaused: boolean | null
}> {
  const out: ReturnType<typeof voiceInternals> = []
  for (const link of state.peers.values()) {
    const stream = link.element?.srcObject
    out.push({
      sessionId: link.sessionId,
      signaling: link.pc.signalingState,
      connection: link.pc.connectionState,
      ice: link.pc.iceConnectionState,
      transceivers: (link.pc.getTransceivers?.() ?? []).map((transceiver) => ({
        mid: transceiver.mid,
        direction: transceiver.direction,
        currentDirection: transceiver.currentDirection,
      })),
      receivers: (link.pc.getReceivers?.() ?? [])
        .filter((receiver) => receiver.track)
        .map((receiver) => ({
          kind: receiver.track.kind,
          muted: receiver.track.muted,
          readyState: receiver.track.readyState,
        })),
      senders: (link.pc.getSenders?.() ?? []).map((sender) => ({
        hasTrack: Boolean(sender.track),
        kind: sender.track?.kind ?? null,
        enabled: sender.track ? sender.track.enabled : null,
      })),
      elementHasStream: Boolean(stream),
      elementTracks:
        stream instanceof MediaStream ? stream.getTracks().filter((t) => t.kind === 'audio').length : 0,
      elementPaused: link.element ? link.element.paused : null,
    })
  }
  return out
}

/** Test-only: forget everything, including the give-up list. */
export function resetVoice(): void {
  stopVoice()
  state.unreachable.clear()
  state.listen = false
  state.mode = 'squad'
  state.lastTarget = null
  iceServers = [...DEFAULT_ICE_SERVERS]
  iceSource = 'default'
  iceFetchedAt = 0
  iceFailedAt = 0
  iceFetchInFlight = false
  iceRefused = false
  localEcho = false
  micLevelSource = null
  outputPool.length = 0
  voiceListeners.clear()
  state.counters = {
    abandoned: 0,
    answersApplied: 0,
    answersSent: 0,
    dropped: 0,
    given_up: 0,
    notSent: 0,
    offersApplied: 0,
    offersSent: 0,
    pcFailed: 0,
    reaped: 0,
    restarts: 0,
    stalls: 0,
    threw: 0,
    tooLarge: 0,
    listenersRefused: 0,
  }
}
