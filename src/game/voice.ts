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
  /** Their epoch we have acknowledged and they have seen — stops the resend. */
  ackedByThem: boolean
  state: PeerLinkState
  attempts: number
  startedAt: number
  talking: boolean
  talkingAt: number
  /** Last gain we wrote, so the tick does not touch the element needlessly. */
  gain: number
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
    ackedByThem: false,
    state: 'idle',
    attempts: 0,
    startedAt: state.clock,
    talking: false,
    talkingAt: 0,
    gain: -1,
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
      return
    }
    if (pc.connectionState === 'failed') restart(link, 'ice-failed')
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
  const { sessionId, attempts } = link
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
  if (fresh) fresh.attempts = attempts + 1
}

// ── Signalling ───────────────────────────────────────────────────────────────

async function makeOffer(link: PeerLink): Promise<void> {
  link.state = 'negotiating'
  link.startedAt = state.clock
  try {
    const offer = await link.pc.createOffer()
    await link.pc.setLocalDescription(offer)
    await gathered(link.pc)
    const sdp = link.pc.localDescription?.sdp
    if (!sdp) return
    const trimmed = trimSdpToBudget(sdp, MAX_SDP_CHARS)
    if (trimmed === null) {
      state.counters.tooLarge++
      return
    }
    link.epoch += 1
    link.outbound = { type: 'offer', epoch: link.epoch, sdp: trimmed }
  } catch {
    link.state = 'failed'
  }
}

async function makeAnswer(link: PeerLink, offer: VoiceDescription): Promise<void> {
  link.state = 'negotiating'
  link.startedAt = state.clock
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
    await link.pc.setRemoteDescription({ sdp: offer.sdp, type: 'offer' })
    state.counters.offersApplied++
    const answer = await link.pc.createAnswer()
    await link.pc.setLocalDescription(answer)
    await gathered(link.pc)
    const sdp = link.pc.localDescription?.sdp
    if (!sdp) return
    const trimmed = trimSdpToBudget(sdp, MAX_SDP_CHARS)
    if (trimmed === null) {
      state.counters.tooLarge++
      return
    }
    link.applied = offer.epoch
    // The answer carries the OFFER's epoch, so a late answer to a description
    // that has already been superseded is detectable instead of confusing.
    link.outbound = { type: 'answer', epoch: offer.epoch, sdp: trimmed }
    link.ackedByThem = false
  } catch {
    link.state = 'failed'
  }
}

function ackMap(): Record<string, number> {
  const ack: Record<string, number> = {}
  for (const link of state.peers.values()) {
    if (link.applied > 0) ack[link.sessionId] = link.applied
  }
  return ack
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
    if (description.epoch <= target.applied) {
      state.counters.dropped++ // an offer we already answered
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
  state.clock = now
  const me = localSessionId()
  if (me === null) return

  // 1. The roster: reap peers who left, open links to peers who arrived.
  const wanted = new Set(meshNow())
  for (const link of [...state.peers.values()]) {
    if (!wanted.has(link.sessionId)) closeLink(link)
  }
  for (const sessionId of wanted) {
    let link = state.peers.get(sessionId)
    if (!link) {
      link = makeLink(sessionId) ?? undefined
      if (!link) continue
      // Only the lower session id offers. The other side builds its link when
      // the offer lands, which is why this is not a deadlock.
      if (voiceOffererIsUs(me, sessionId)) void makeOffer(link)
      continue
    }
    // A negotiation that never completed: start it over, boundedly.
    if (
      link.state === 'negotiating' &&
      now - link.startedAt > NEGOTIATION_TIMEOUT_MS &&
      link.pc.connectionState !== 'connected'
    ) {
      restart(link, 'timeout')
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

  // 4. One signalling frame every SIGNAL_EVERY_TICKS, at most one description.
  if (state.ticks % SIGNAL_EVERY_TICKS === 0 && netAvailable()) publishSignal()
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
  }>
  unreachable: string[]
  counters: VoiceState['counters']
} {
  const peers = [...state.peers.values()].map((link) => ({
    applied: link.applied,
    attempts: link.attempts,
    connection: link.pc.connectionState,
    epoch: link.epoch,
    gain: link.gain,
    hasTrack: Boolean(link.element?.srcObject),
    ice: link.pc.iceConnectionState,
    name: participantName(getRemotes().get(link.sessionId)?.userId ?? ''),
    owed: link.outbound ? `${link.outbound.type}@${link.outbound.epoch}` : null,
    sessionId: link.sessionId,
    state: link.state,
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
    unreachable: [...state.unreachable],
  }
}

/** Test-only: forget everything, including the give-up list. */
export function resetVoice(): void {
  stopVoice()
  state.unreachable.clear()
  state.mode = 'squad'
  state.lastTarget = null
  state.counters = {
    answersApplied: 0,
    answersSent: 0,
    dropped: 0,
    given_up: 0,
    notSent: 0,
    offersApplied: 0,
    offersSent: 0,
    restarts: 0,
    tooLarge: 0,
  }
}
