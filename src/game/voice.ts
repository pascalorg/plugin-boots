import { sharedAudioContext } from './audio'
import {
  localSessionId,
  netAvailable,
  type NetMessage,
  onFrame,
  publishFrame,
  registerFrameKind,
} from './net'
import { browserPendingStorage } from './pending-store'
import { getRemotes, participantName } from './presence'
import { latestSnapshot } from './presence-interp'
import {
  isVoiceMode,
  MAX_SDP_CHARS,
  mixGain,
  nextSignalTarget,
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
 * ── NO TURN SERVER ──────────────────────────────────────────────────────────
 * STUN only, so two peers behind NATs that both refuse to be traversed cannot
 * connect. There is no infrastructure here to fix that and pretending otherwise
 * would hide it: `voiceDebug().failed` counts those peers, and the HUD says
 * "voice unreachable" rather than sitting silent. `setVoiceIceServers` is the
 * seam for a relay when there is one.
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

let iceServers: RTCIceServer[] = [
  // Public STUN. Enough to discover a reflexive candidate, which is what makes
  // two ordinary home connections reach each other.
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

/** Point voice at a relay (TURN) when there is one. Takes effect on new peers. */
export function setVoiceIceServers(servers: RTCIceServer[]): void {
  iceServers = servers
}

// ── Types ────────────────────────────────────────────────────────────────────

export type MicState = 'off' | 'live' | 'muted' | 'denied' | 'unavailable'

export type PeerLinkState = 'idle' | 'negotiating' | 'connected' | 'failed'

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
}

type VoiceState = {
  active: boolean
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

const state: VoiceState = {
  active: false,
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
  },
}

// ── Capability ───────────────────────────────────────────────────────────────

export function voiceSupported(): boolean {
  return typeof globalThis.RTCPeerConnection === 'function'
}

function micSupported(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia)
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
  const element = new Audio()
  element.srcObject = stream
  element.autoplay = true
  // Never in the DOM: a floating element plays fine and cannot be styled,
  // clicked or scrolled away by the host page.
  element.volume = state.mode === 'squad' ? 1 : 0
  void element.play().catch(() => {
    // Autoplay refusal. Entry to a session is a click, so by the time a peer's
    // track arrives the page is nearly always allowed to play audio; when it is
    // not, the next tick's play() attempt after any input succeeds.
  })
  link.element = element
}

function makeLink(sessionId: string): PeerLink | null {
  let pc: RTCPeerConnection
  try {
    pc = new RTCPeerConnection({ iceServers })
  } catch {
    return null
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
  }
  // ONE sendrecv audio transceiver, created before any description exists.
  // Negotiating the send direction up front is what lets the mic be enabled
  // later with `replaceTrack` and no second handshake — the alternative is a
  // renegotiation in the middle of a firefight.
  try {
    const transceiver = pc.addTransceiver('audio', { direction: 'sendrecv' })
    link.sender = transceiver.sender
    if (state.micTrack) void transceiver.sender.replaceTrack(state.micTrack).catch(() => {})
  } catch {
    // Very old stacks: fall back to whatever a track add gives us.
    if (state.micTrack) {
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
    link.element.pause()
    link.element.srcObject = null
    link.element = null
  }
  state.peers.delete(link.sessionId)
}

/** Tear a link down and start over, unless this peer has used up its attempts. */
function restart(link: PeerLink, _why: string): void {
  const { sessionId, attempts, epoch } = link
  closeLink(link)
  if (attempts + 1 >= MAX_NEGOTIATION_ATTEMPTS) {
    // Given up ON PURPOSE and countably. With STUN only, some pairs genuinely
    // cannot reach each other; retrying forever would burn a connection attempt
    // every fifteen seconds for the rest of the session and still be silent.
    state.unreachable.add(sessionId)
    state.counters.given_up++
    return
  }
  state.counters.restarts++
  const fresh = makeLink(sessionId)
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

async function makeOffer(link: PeerLink): Promise<void> {
  link.state = 'negotiating'
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
    link.epoch += 1
    link.outbound = { type: 'offer', epoch: link.epoch, sdp: trimmed }
    link.step = 'offer:owed'
  } catch (error) {
    link.state = 'failed'
    link.step = 'offer:threw'
    link.error = describeError(error)
    state.counters.threw++
  }
}

async function makeAnswer(link: PeerLink, offer: VoiceDescription): Promise<void> {
  link.state = 'negotiating'
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
      target = makeLink(from) ?? undefined
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
 * Ask for the microphone. Must be called from a user gesture the first time, or
 * the browser refuses without prompting.
 *
 * Idempotent, and safe to call when there is no bus or no peer: the track is
 * swapped into every existing sender with `replaceTrack`, so enabling the mic
 * mid-call costs no renegotiation.
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
    const track = stream.getAudioTracks()[0] ?? null
    if (!track) {
      state.micState = 'unavailable'
      return state.micState
    }
    state.mic = stream
    state.micTrack = track
    state.micState = 'live'
    attachAnalyser(stream)
    for (const link of state.peers.values()) {
      if (link.sender) void link.sender.replaceTrack(track).catch(() => {})
    }
    return state.micState
  } catch {
    // Denied, or no input device. Either way we can still HEAR the room.
    state.micState = 'denied'
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

/** Toggle: acquires on the first press, then mutes and unmutes. */
export async function toggleMic(): Promise<MicState> {
  if (!state.micTrack) return enableMic()
  setMicMuted(state.micState === 'live')
  return state.micState
}

/**
 * Turn the mic on WITHOUT prompting, but only if permission was already given.
 * Called at session start so the second session onward is seamless — a
 * permission dialog appearing mid-firefight is worse than no voice at all.
 */
export async function enableMicIfAlreadyPermitted(): Promise<MicState> {
  if (!micSupported()) return 'unavailable'
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
  return enableMic()
}

function readMicLevel(): number {
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
  const snapshot = latestSnapshot(remote.ring)
  if (!snapshot) return Number.POSITIVE_INFINITY
  return Math.hypot(local[0] - snapshot.x, local[1] - snapshot.y, local[2] - snapshot.z)
}

/** The sessions we should be in a call with, right now. */
function meshNow(): string[] {
  const me = localSessionId()
  if (me === null) return []
  const inGame: string[] = [me]
  for (const [sessionId, remote] of getRemotes()) {
    if (remote.ph === 'game') inGame.push(sessionId)
  }
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
    // Only the lower session id offers. The other side builds its link when
    // the offer lands, which is why this is not a deadlock.
    if (voiceOffererIsUs(me, sessionId)) void makeOffer(link)
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
    if (link.state === 'idle' && link.outbound === null && voiceOffererIsUs(me, sessionId)) {
      void makeOffer(link)
    }
  }

  // 2. Our own talk state, off the mic analyser.
  if (state.micState === 'live') {
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

  // 3. Levels. Written only on change, so a squad call touches nothing.
  for (const link of state.peers.values()) {
    const gain = mixGain(state.mode, distanceTo(link.sessionId))
    if (Math.abs(gain - link.gain) < 0.01) continue
    link.gain = gain
    if (link.element) {
      link.element.volume = Math.min(1, Math.max(0, gain))
      // A refused autoplay heals here: by now the player has clicked something.
      if (link.element.paused) void link.element.play().catch(() => {})
    }
  }

  // 4. One signalling frame: every tick while a description is owed, otherwise
  //    every SIGNAL_EVERY_TICKS as a heartbeat. At most one description either
  //    way.
  //
  //    The heartbeat rate is right for what a heartbeat carries — a talk flag and
  //    an ack map — and wrong for a handshake, where it is pure added latency on
  //    every hop, twice per round trip, on top of ICE gathering. A pair that
  //    cannot finish inside the negotiation deadline gets restarted, and a
  //    restart is far more expensive than the frames saved by waiting. So while
  //    anything is owed, this runs at the tick.
  if (netAvailable() && (state.ticks % SIGNAL_EVERY_TICKS === 0 || anythingOwed())) {
    publishSignal()
  }
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

/**
 * Open the voice layer for this session. Returns false — having done nothing at
 * all — with no bus or no WebRTC.
 */
export function startVoice(args: {
  getLocalPosition: () => readonly [number, number, number]
}): boolean {
  if (state.active) return true
  if (!netAvailable() || !voiceSupported()) return false
  state.active = true
  state.getLocalPosition = args.getLocalPosition
  state.ticks = 0
  state.clock = Date.now()
  state.lastTarget = null
  state.unreachable.clear()
  registerFrameKind<VoiceFrame>(VOICE_KIND, readVoiceFrame)
  state.offFrame = onFrame<VoiceFrame>(VOICE_KIND, ingest)
  state.timer = setInterval(() => voiceTick(Date.now()), VOICE_TICK_MS)
  return true
}

/**
 * Close it. The MICROPHONE IS RELEASED, deliberately: leaving a game must turn
 * the browser's recording indicator off, or the next thing the player does is
 * check whether we are still listening.
 */
export function stopVoice(): void {
  if (!state.active) return
  state.active = false
  if (state.timer !== null) clearInterval(state.timer)
  state.timer = null
  state.offFrame?.()
  state.offFrame = null
  for (const link of [...state.peers.values()]) closeLink(link)
  state.peers.clear()
  state.micSource?.disconnect()
  state.micSource = null
  state.analyser = null
  state.analyserBuffer = null
  for (const track of state.mic?.getTracks() ?? []) track.stop()
  state.mic = null
  state.micTrack = null
  state.micState = 'off'
  state.talking = false
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

/** One line per peer plus the counters — the QA dump behind `__boots.voice`. */
export function voiceDebug(): {
  active: boolean
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
  }>
  unreachable: string[]
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
  }))
  return {
    active: state.active,
    counters: { ...state.counters },
    mic: state.micState,
    mode: state.mode,
    peers,
    supported: voiceSupported(),
    talking: state.talking,
    ticks: state.ticks,
    unreachable: [...state.unreachable],
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
  state.mode = 'squad'
  state.lastTarget = null
  state.counters = {
    abandoned: 0,
    answersApplied: 0,
    answersSent: 0,
    dropped: 0,
    given_up: 0,
    notSent: 0,
    offersApplied: 0,
    offersSent: 0,
    reaped: 0,
    restarts: 0,
    stalls: 0,
    threw: 0,
    tooLarge: 0,
  }
}
