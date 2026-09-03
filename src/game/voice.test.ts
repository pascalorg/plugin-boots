import { afterEach, describe, expect, test } from 'bun:test'
import {
  type CollabBus,
  type CollabBusMessage,
  type CollabParticipant,
  ingestBusMessage,
  NET_PROTOCOL,
  resetNetIdentity,
  resetNetKinds,
  startNet,
  stopNet,
} from './net'
import { getRemotes, type LocalPose, startPresence, startSpectating, stopPresence, stopSpectating } from './presence'
import type { PresenceFrame } from './presence-interp'
import {
  DISCONNECT_GRACE_MS,
  enableMic,
  enableMicIfAlreadyPermitted,
  ICE_SERVERS_GLOBAL,
  loadMicPref,
  MAX_NEGOTIATION_ATTEMPTS,
  MIC_PREF_KEY,
  micState,
  NEGOTIATION_TIMEOUT_MS,
  onVoiceEvent,
  OUTPUT_POOL_SIZE,
  PEER_ABSENT_MS,
  prefetchIceServers,
  primeVoiceOutputs,
  releaseMic,
  resetVoice,
  SAME_DEVICE_CHANNEL,
  SAME_DEVICE_STALE_MS,
  selfTalking,
  setMicLevelSource,
  setVoiceIceServers,
  setVoiceLocalEcho,
  setVoiceMode,
  startVoice,
  startVoiceListen,
  stopVoice,
  stopVoiceListen,
  talkingPeerCount,
  talkingPeers,
  TALKING_STALE_MS,
  TICK_STALL_MS,
  toggleMic,
  type VoiceEvent,
  voiceActive,
  voiceConnectedCount,
  voiceDebug,
  voiceExcluded,
  voiceListenerCount,
  voiceMode,
  voiceOutputBlocked,
  voiceSameDeviceCount,
  voiceStats,
  voiceTick,
} from './voice'
import {
  DEFAULT_ICE_SERVERS,
  DRAWN_FRESH_MS,
  iceHasRelay,
  MAX_LISTENERS_PER_PLAYER,
  MAX_VOICE_PEERS,
  VAD_OPEN_RMS,
  VOICE_FAR_M,
  VOICE_PROTOCOL,
  type VoiceFrame,
  voiceOffererIsUs,
} from './voice-policy'

/**
 * VOICE, RUNTIME. voice-policy.test.ts owns the decisions; this owns the state
 * machine that carries them out, against a scripted WebRTC stack.
 *
 * What is worth pinning here is everything that fails as SILENCE. A mesh that
 * never opens a link, two peers that both offer and deadlock, an answer applied
 * to the wrong epoch, a description counted as sent that the host coalesced
 * away, a mic track that never reaches the sender, a peer that leaves with its
 * audio element still playing — none of those throw, none log, and every one of
 * them is indistinguishable in the room from "voice chat doesn't work".
 *
 * SESSION IDS ARE CHOSEN, NOT ARBITRARY. We are 'session-me'. 'session-a' sorts
 * BELOW us, so that peer is the offerer and we answer; 'session-z' sorts above,
 * so we offer. Both directions are exercised because they are different code.
 */

// ── The bus (same shape as net.test.ts's) ────────────────────────────────────

type FakeBus = CollabBus & {
  publishes: Array<{ pluginId: string; event: string; data: unknown }>
  publishResult: 'sent' | 'deferred' | 'suppressed'
  participants: CollabParticipant[]
}

const g = globalThis as {
  __pascalCollabBus?: CollabBus
  RTCPeerConnection?: unknown
  MediaStream?: unknown
  Audio?: unknown
  navigator?: unknown
}

function installBus(): FakeBus {
  const bus: FakeBus = {
    version: 1,
    projectId: 'lobby',
    sessionId: 'session-me',
    clientId: 'client-me',
    userId: 'user-me',
    publishes: [],
    publishResult: 'sent',
    participants: [],
    publish(pluginId, event, data) {
      bus.publishes.push({ pluginId, event, data })
      return bus.publishResult
    },
    subscribe() {
      return () => {}
    },
    getParticipants() {
      return bus.participants
    },
    onParticipants() {
      return () => {}
    },
  }
  g.__pascalCollabBus = bus
  return bus
}

/** Every voice frame this session put on the wire, newest last. */
function sent(bus: FakeBus): VoiceFrame[] {
  return bus.publishes
    .filter((p) => p.event === 'boots/voice')
    .map((p) => (p.data as { data: VoiceFrame }).data)
}

/** The newest frame carrying a description for `to`, if any. */
function lastDescriptionTo(bus: FakeBus, to: string): VoiceFrame | null {
  const withSdp = sent(bus).filter((f) => f.to === to && f.sdp)
  return withSdp[withSdp.length - 1] ?? null
}

// ── The scripted WebRTC stack ────────────────────────────────────────────────

const SDP = (kind: string) =>
  [
    'v=0',
    'o=- 1 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    `m=audio 9 UDP/TLS/RTP/SAVPF 111`,
    'c=IN IP4 0.0.0.0',
    'a=candidate:1 1 udp 2113937151 192.168.1.9 5000 typ host',
    `a=mid:0`,
    `a=${kind}`,
    'a=rtpmap:111 opus/48000/2',
    '',
  ].join('\r\n')

type FakeSender = {
  track: unknown
  replaced: unknown[]
  replaceTrack: (track: unknown) => Promise<void>
}

type FakeTransceiver = {
  direction: string
  kind: string
  /** null until an m-line is associated with it — the crux of the answerer bug. */
  mid: string | null
  currentDirection: string | null
  sender: FakeSender
  stopped: boolean
  stop: () => void
}

function makeSender(): FakeSender {
  const sender: FakeSender = {
    track: null,
    replaced: [],
    replaceTrack: async (track: unknown) => {
      sender.track = track
      sender.replaced.push(track)
    },
  }
  return sender
}

class FakePeerConnection {
  static made: FakePeerConnection[] = []
  static rejectSetRemote = false
  /** Throw from the constructor on any relay URL — the browser refusing a set. */
  static refuseRelay = false
  /** Accept setLocalDescription and hand back nothing — the silent abandon. */
  static swallowLocalDescription = false
  /**
   * Hold every negotiation at createAnswer until this resolves.
   *
   * The real thing spends seconds here (createAnswer, setLocalDescription, then
   * the whole ICE gather), and that window is where the resend loop lands. The
   * fake resolves in a microtask, so without a gate no test can put two copies of
   * one offer inside the same negotiation — the exact shape of the bug.
   */
  static holdAnswer: Promise<void> | null = null

  connectionState = 'new'
  iceConnectionState = 'new'
  iceGatheringState = 'complete'
  signalingState = 'stable'
  localDescription: { sdp: string; type: string } | null = null
  remoteDescriptions: Array<{ sdp: string; type: string }> = []
  closed = false
  rollbacks = 0
  transceivers: FakeTransceiver[] = []
  private listeners = new Map<string, Set<(event: unknown) => void>>()

  constructor(public config: { iceServers?: unknown[] }) {
    if (FakePeerConnection.refuseRelay && iceHasRelay((config.iceServers ?? []) as RTCIceServer[])) {
      throw new DOMException('refused', 'InvalidAccessError')
    }
    FakePeerConnection.made.push(this)
  }

  addTransceiver(kind: string, init: { direction: string }) {
    const transceiver: FakeTransceiver = {
      currentDirection: null,
      direction: init.direction,
      kind,
      // NOT ASSOCIATED WITH AN M-LINE, and it will not be. A transceiver we asked
      // for is a request for an m-line of our own; only ones created by addTrack
      // are recycled for an incoming offer's m-line.
      mid: null,
      sender: makeSender(),
      stop() {
        this.stopped = true
      },
      stopped: false,
    }
    this.transceivers.push(transceiver)
    return transceiver
  }

  getTransceivers() {
    return this.transceivers
  }

  addEventListener(type: string, handler: (event: unknown) => void) {
    const set = this.listeners.get(type) ?? new Set()
    set.add(handler)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, handler: (event: unknown) => void) {
    this.listeners.get(type)?.delete(handler)
  }

  emit(type: string, event: unknown = {}) {
    for (const handler of this.listeners.get(type) ?? []) handler(event)
  }

  async createOffer() {
    return { sdp: SDP('sendrecv'), type: 'offer' }
  }

  async createAnswer() {
    if (FakePeerConnection.holdAnswer) await FakePeerConnection.holdAnswer
    return { sdp: SDP('sendrecv'), type: 'answer' }
  }

  async setLocalDescription(description: { sdp?: string; type: string }) {
    if (description.type === 'rollback') {
      this.rollbacks++
      this.signalingState = 'stable'
      this.localDescription = null
      return
    }
    this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable'
    if (FakePeerConnection.swallowLocalDescription) return
    this.localDescription = { sdp: description.sdp ?? SDP(description.type), type: description.type }
  }

  async setRemoteDescription(description: { sdp: string; type: string }) {
    if (FakePeerConnection.rejectSetRemote) throw new Error('SDP rejected')
    this.remoteDescriptions.push(description)
    this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable'
    if (description.type !== 'offer') return
    // The spec's implicit transceiver, faithfully including the part that broke
    // the call: an m-line the application did not ask for arrives RECVONLY.
    if (this.transceivers.some((transceiver) => transceiver.mid === '0')) return
    this.transceivers.push({
      currentDirection: 'recvonly',
      direction: 'recvonly',
      kind: 'audio',
      mid: '0',
      sender: makeSender(),
      stop() {
        this.stopped = true
      },
      stopped: false,
    })
  }

  /** Pretend the ICE agent connected and a track arrived. */
  goLive() {
    this.connectionState = 'connected'
    this.iceConnectionState = 'connected'
    this.emit('connectionstatechange')
    this.emit('track', { streams: [new FakeMediaStream([{ kind: 'audio' }])], track: { kind: 'audio' } })
  }

  close() {
    this.closed = true
    this.connectionState = 'closed'
  }
}

class FakeMediaStream {
  constructor(public tracks: unknown[] = []) {}
  getAudioTracks() {
    return this.tracks
  }
  getTracks() {
    return this.tracks
  }
}

class FakeAudio {
  static made: FakeAudio[] = []
  srcObject: unknown = null
  autoplay = false
  volume = 1
  paused = true
  playCalls = 0
  constructor() {
    FakeAudio.made.push(this)
  }
  async play() {
    this.playCalls++
    this.paused = false
  }
  pause() {
    this.paused = true
  }
}

type FakeTrack = { kind: string; enabled: boolean; stopped: boolean; stop: () => void }

function makeTrack(): FakeTrack {
  const track: FakeTrack = {
    kind: 'audio',
    enabled: true,
    stopped: false,
    stop: () => {
      track.stopped = true
    },
  }
  return track
}

type MicScript = {
  grant: boolean
  permission: string
  track: FakeTrack | null
}

const mic: MicScript = { grant: true, permission: 'prompt', track: null }

function installWebRtc(): void {
  FakePeerConnection.made = []
  FakePeerConnection.holdAnswer = null
  FakePeerConnection.rejectSetRemote = false
  FakePeerConnection.refuseRelay = false
  FakePeerConnection.swallowLocalDescription = false
  FakeAudio.made = []
  g.RTCPeerConnection = FakePeerConnection
  g.MediaStream = FakeMediaStream
  g.Audio = FakeAudio
  mic.grant = true
  mic.permission = 'prompt'
  mic.track = null
  g.navigator = {
    mediaDevices: {
      getUserMedia: async () => {
        if (!mic.grant) throw new Error('NotAllowedError')
        mic.track = makeTrack()
        return new FakeMediaStream([mic.track])
      },
    },
    permissions: {
      query: async () => ({ state: mic.permission }),
    },
  }
}

// ── Presence plumbing ────────────────────────────────────────────────────────

const localPose: LocalPose = {
  ph: 'game',
  x: 0,
  y: 0,
  z: 0,
  yaw: 0,
  pitch: 0,
  w: 'ar15',
  s: 0,
  g: true,
  st: false,
  f: 0,
}

function poseFrame(over: Partial<PresenceFrame> = {}): PresenceFrame {
  return {
    v: 1,
    ph: 'game',
    p: [0, 0, 0],
    yaw: 0,
    pitch: 0,
    w: 'ar15',
    s: 0,
    g: true,
    st: false,
    f: 0,
    ...over,
  }
}

/** Put a peer in the presence registry, in a phase, at a distance. */
function seePeer(sessionId: string, over: Partial<PresenceFrame> = {}, sentAt = 1000): void {
  const message: CollabBusMessage = {
    event: 'pose',
    data: { v: NET_PROTOCOL, kind: 'pose', seq: nextSeq(sessionId), data: poseFrame(over) },
    sessionId,
    clientId: `client-${sessionId}`,
    userId: `user-${sessionId}`,
    sentAt,
  }
  ingestBusMessage(message)
}

const seqs = new Map<string, number>()
function nextSeq(sessionId: string): number {
  const next = (seqs.get(sessionId) ?? 0) + 1
  seqs.set(sessionId, next)
  return next
}

/** A voice frame arriving from a peer. */
function hearVoice(sessionId: string, frame: VoiceFrame): void {
  ingestBusMessage({
    event: 'boots/voice',
    data: { v: NET_PROTOCOL, kind: 'boots/voice', seq: nextSeq(`${sessionId}-voice`), data: frame },
    sessionId,
    clientId: `client-${sessionId}`,
    userId: `user-${sessionId}`,
    sentAt: 1000,
  })
}

/**
 * Advance the clock to `to` in steps a RUNNING page would take.
 *
 * A single `voiceTick` fifteen seconds after the last one is not a fast-forward
 * as far as the module is concerned — it is the signature of a page that was
 * frozen, and the module deliberately credits that time back rather than reaping
 * every peer for silence it was not listening for. So a test about a deadline has
 * to let time pass the way time passes.
 */
function runUntil(to: number, from: number, step = 900): void {
  for (let at = from + step; at < to; at += step) voiceTick(at)
  voiceTick(to)
}

/** Let the queued microtasks (createOffer/createAnswer chains) finish. */
const settle = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

function boot(): FakeBus {
  const bus = installBus()
  installWebRtc()
  startNet()
  startPresence(() => localPose)
  startVoice({ getLocalPosition: () => [0, 0, 0] })
  return bus
}

const peer = (sessionId: string) => voiceDebug().peers.find((p) => p.sessionId === sessionId)

afterEach(() => {
  resetVoice()
  stopVoice()
  stopPresence()
  stopSpectating()
  stopNet()
  resetNetKinds()
  resetNetIdentity()
  seqs.clear()
  delete g.__pascalCollabBus
  g.RTCPeerConnection = undefined
  g.MediaStream = undefined
  g.Audio = undefined
  g.navigator = undefined
})

// ── The flag-off guarantee ───────────────────────────────────────────────────

describe('voice costs nothing when it cannot work', () => {
  test('NO BUS: startVoice is false and not one peer connection is constructed', () => {
    installWebRtc()
    expect(startVoice({ getLocalPosition: () => [0, 0, 0] })).toBe(false)
    expect(voiceActive()).toBe(false)
    expect(FakePeerConnection.made.length).toBe(0)
  })

  test('NO WEBRTC: startVoice is false with a perfectly good bus', () => {
    installBus()
    startNet()
    g.RTCPeerConnection = undefined
    expect(startVoice({ getLocalPosition: () => [0, 0, 0] })).toBe(false)
    expect(voiceDebug().supported).toBe(false)
  })

  test('a tick before start does nothing', () => {
    installBus()
    installWebRtc()
    startNet()
    expect(() => voiceTick(1000)).not.toThrow()
    expect(voiceDebug().peers).toEqual([])
  })
})

// ── Who ends up in the mesh ──────────────────────────────────────────────────

describe('the mesh is the people in the GAME', () => {
  test('a peer in a game session gets a link; a peer in the editor does not', () => {
    boot()
    seePeer('session-a')
    seePeer('session-editor', { ph: 'editor' })
    voiceTick(1000)
    expect(voiceDebug().peers.map((p) => p.sessionId)).toEqual(['session-a'])
  })

  test('a peer who leaves the game takes its link AND its audio element with it', async () => {
    boot()
    seePeer('session-z')
    voiceTick(1000)
    await settle()
    FakePeerConnection.made[0]!.goLive()
    const element = FakeAudio.made[0]!
    expect(element.srcObject).not.toBeNull()

    // 'editor' is presence's explicit exit — the peer pressed Esc. The teardown
    // waits out PEER_ABSENT_MS, because at this level leaving and a lost
    // presence frame look the same and only one of them should cost a handshake.
    seePeer('session-z', { ph: 'editor' }, 1100)
    runUntil(1200 + PEER_ABSENT_MS, 1000)
    expect(voiceDebug().peers).toEqual([])
    expect(FakePeerConnection.made[0]!.closed).toBe(true)
    // Left playing, a departed peer's stream is a voice in an empty room.
    expect(element.paused).toBe(true)
    expect(element.srcObject).toBeNull()
  })

  test('the transceiver is sendrecv from the start, so the mic needs no renegotiation', () => {
    boot()
    seePeer('session-a')
    voiceTick(1000)
    expect(FakePeerConnection.made[0]!.transceivers).toEqual([
      expect.objectContaining({ direction: 'sendrecv', kind: 'audio' }),
    ])
  })
})

// ── Negotiation ──────────────────────────────────────────────────────────────

describe('exactly one side offers', () => {
  test('WE offer to the higher session id, and the frame is addressed', async () => {
    const bus = boot()
    seePeer('session-z')
    voiceTick(1000)
    await settle()
    voiceTick(1100)
    voiceTick(1200)
    voiceTick(1300)
    voiceTick(1400) // 4th tick — publishSignal
    const frame = lastDescriptionTo(bus, 'session-z')
    expect(frame?.sdp?.type).toBe('offer')
    expect(frame?.sdp?.epoch).toBe(1)
    expect(voiceDebug().counters.offersSent).toBeGreaterThan(0)
  })

  test('we do NOT offer to the lower session id — we wait for theirs', async () => {
    const bus = boot()
    seePeer('session-a')
    for (let t = 0; t < 8; t++) voiceTick(1000 + t * 100)
    await settle()
    for (let t = 0; t < 8; t++) voiceTick(2000 + t * 100)
    expect(lastDescriptionTo(bus, 'session-a')).toBeNull()
    expect(voiceDebug().counters.offersSent).toBe(0)
  })

  test('their offer is answered with the OFFER’s epoch', async () => {
    const bus = boot()
    seePeer('session-a')
    voiceTick(1000)
    hearVoice('session-a', {
      v: VOICE_PROTOCOL,
      to: 'session-me',
      sdp: { type: 'offer', epoch: 7, sdp: SDP('sendrecv') },
    })
    await settle()
    for (let t = 0; t < 4; t++) voiceTick(1100 + t * 100)
    const frame = lastDescriptionTo(bus, 'session-a')
    expect(frame?.sdp?.type).toBe('answer')
    // The offer's epoch, not a fresh one: that is what makes a late answer to a
    // superseded offer detectable instead of merely confusing.
    expect(frame?.sdp?.epoch).toBe(7)
    expect(voiceDebug().counters.offersApplied).toBe(1)
    expect(peer('session-a')?.applied).toBe(7)
  })

  test('an offer addressed to SOMEBODY ELSE is not ours to answer', async () => {
    boot()
    seePeer('session-a')
    voiceTick(1000)
    hearVoice('session-a', {
      v: VOICE_PROTOCOL,
      to: 'session-someone-else',
      sdp: { type: 'offer', epoch: 1, sdp: SDP('sendrecv') },
    })
    await settle()
    expect(FakePeerConnection.made[0]!.remoteDescriptions).toEqual([])
  })

  test('applying their answer clears what we owe them', async () => {
    boot()
    seePeer('session-z')
    voiceTick(1000)
    await settle()
    expect(peer('session-z')?.owed).toBe('offer@1')
    hearVoice('session-z', {
      v: VOICE_PROTOCOL,
      to: 'session-me',
      sdp: { type: 'answer', epoch: 1, sdp: SDP('sendrecv') },
    })
    await settle()
    expect(voiceDebug().counters.answersApplied).toBe(1)
    expect(peer('session-z')?.owed).toBeNull()
  })

  test('an answer to a SUPERSEDED offer is dropped, not applied', async () => {
    boot()
    seePeer('session-z')
    voiceTick(1000)
    await settle()
    hearVoice('session-z', {
      v: VOICE_PROTOCOL,
      to: 'session-me',
      sdp: { type: 'answer', epoch: 99, sdp: SDP('sendrecv') },
    })
    await settle()
    expect(voiceDebug().counters.answersApplied).toBe(0)
    expect(voiceDebug().counters.dropped).toBe(1)
    expect(peer('session-z')?.owed).toBe('offer@1')
  })

  test('a rejected answer restarts the pair instead of leaving it half-open', async () => {
    boot()
    seePeer('session-z')
    voiceTick(1000)
    await settle()
    FakePeerConnection.rejectSetRemote = true
    hearVoice('session-z', {
      v: VOICE_PROTOCOL,
      to: 'session-me',
      sdp: { type: 'answer', epoch: 1, sdp: SDP('sendrecv') },
    })
    await settle()
    expect(voiceDebug().counters.restarts).toBe(1)
    expect(FakePeerConnection.made[0]!.closed).toBe(true)
  })
})

describe('a peer missing from the roster has not necessarily left', () => {
  /**
   * The failure this pins was the whole reason two browsers in one room could not
   * hear each other, and it never once looked like itself: presence dropped the
   * remote for a beat, the tick closed the link, the next tick built a new one
   * from zero, and the readouts showed a pair that kept starting a handshake and
   * never finishing — which is exactly what an unreachable peer looks like.
   */
  test('a roster flicker does NOT destroy the connection', async () => {
    boot()
    seePeer('session-z')
    voiceTick(1000)
    await settle()
    expect(peer('session-z')?.owed).toBe('offer@1')
    expect(FakePeerConnection.made.length).toBe(1)

    // Gone from the roster, then back a tick later.
    seePeer('session-z', { ph: 'editor' })
    voiceTick(1100)
    expect(voiceDebug().peers.length).toBe(1)
    expect(voiceDebug().counters.reaped).toBe(0)
    expect(peer('session-z')?.absentMs).toBeGreaterThan(0)

    seePeer('session-z')
    voiceTick(1200)
    // The SAME connection, with the epoch and the owed description intact — one
    // RTCPeerConnection for the whole episode is the assertion that matters,
    // because a second one means the candidates were thrown away.
    expect(FakePeerConnection.made.length).toBe(1)
    expect(peer('session-z')?.owed).toBe('offer@1')
    expect(peer('session-z')?.absentMs).toBe(0)
  })

  test('a peer who really left is reaped once the grace period runs out', async () => {
    boot()
    seePeer('session-z')
    voiceTick(1000)
    await settle()

    seePeer('session-z', { ph: 'editor' })
    runUntil(1000 + PEER_ABSENT_MS, 1000)
    expect(voiceDebug().peers.length).toBe(1) // still inside the grace period
    voiceTick(1000 + PEER_ABSENT_MS + 1)
    expect(voiceDebug().peers.length).toBe(0)
    expect(voiceDebug().counters.reaped).toBe(1)
  })

  test('an owed description still goes out to a peer inside its grace period', async () => {
    const bus = boot()
    seePeer('session-z')
    voiceTick(1000)
    await settle()
    seePeer('session-z', { ph: 'editor' })
    voiceTick(1100)
    // Their absence may be the very loss that swallowed our offer, so the resend
    // has to keep going — stopping it turns a hiccup into a dead pair.
    expect(lastDescriptionTo(bus, 'session-z')?.sdp?.epoch).toBe(1)
  })
})

describe('a call outlives the presence roster', () => {
  /**
   * Presence rides the render loop; voice rides an interval. A window that is
   * behind another one therefore stops publishing poses entirely while its voice
   * frames keep arriving — measured at ~5 s of pose silence in a two-tab QA run,
   * well past the 3 s staleness sweep. Liveness for a CALL has to come from the
   * call, or alt-tabbing hangs up on somebody who is still talking.
   */
  test('a voice frame from them keeps the link alive with no presence at all', async () => {
    boot()
    seePeer('session-z')
    voiceTick(1000)
    await settle()
    // An established call, which is the case that matters: somebody clicks
    // another window twenty seconds into a conversation.
    FakePeerConnection.made[0]!.goLive()
    seePeer('session-z', { ph: 'editor' }) // out of the roster entirely

    // Well past PEER_ABSENT_MS, but they are still on the wire.
    for (let at = 1100; at <= 20_000; at += 500) {
      hearVoice('session-z', { v: VOICE_PROTOCOL, talking: false })
      voiceTick(at)
    }
    expect(voiceDebug().peers.length).toBe(1)
    expect(voiceDebug().counters.reaped).toBe(0)
    expect(FakePeerConnection.made.length).toBe(1)
  })

  test('silence on BOTH channels is what actually ends the link', async () => {
    boot()
    seePeer('session-z')
    voiceTick(1000)
    await settle()
    seePeer('session-z', { ph: 'editor' })
    runUntil(1000 + PEER_ABSENT_MS + 1, 1000)
    expect(voiceDebug().peers.length).toBe(0)
    expect(voiceDebug().counters.reaped).toBe(1)
  })
})

describe('a page that was frozen does not blame its peers', () => {
  /**
   * Every deadline in this module is `now - thenSomething > limit`, and all of
   * them assume the interval that measures them has been running. A backgrounded
   * tab breaks that assumption completely: Chromium can suspend the whole page,
   * so the tick that arrives on resume carries thirty seconds of clock the module
   * never watched. Read literally, that one tick says every peer went silent,
   * every handshake timed out and everybody stopped talking — all at once, all
   * wrong, because nothing was listening.
   *
   * So an over-long gap is credited back to every deadline the link owns: the
   * page missed the time, the peers did not spend it. What still counts is time
   * the page was actually awake for, which is why each of these ends by proving
   * the deadline fires normally afterwards. The credit forgives the freeze, not
   * the peer.
   */
  test('the first tick back reaps nobody', async () => {
    boot()
    seePeer('session-z')
    voiceTick(1000)
    await settle()
    FakePeerConnection.made[0]!.goLive()
    seePeer('session-z', { ph: 'editor' }) // out of the roster

    // Thirty seconds in ONE tick — the signature of a suspended page, not of a
    // room that emptied.
    voiceTick(31_000)
    expect(voiceDebug().counters.stalls).toBe(1)
    expect(voiceDebug().counters.reaped).toBe(0)
    expect(voiceDebug().peers.length).toBe(1)

    // …and somebody who really did leave is still reaped, on the time the page
    // was awake for.
    runUntil(31_000 + PEER_ABSENT_MS + 1, 31_000)
    expect(voiceDebug().counters.reaped).toBe(1)
  })

  test('a stall is not the peer ignoring our offer', async () => {
    boot()
    seePeer('session-z')
    voiceTick(1000)
    await settle()
    // Nobody answered, but the negotiation deadline elapsed while the page was
    // asleep. Restarting here would throw away a handshake that never got its
    // chance — and, since the peer's answer is on the way, would deadlock the
    // pair on the epoch it was answering.
    voiceTick(1000 + NEGOTIATION_TIMEOUT_MS * 2 + 500)
    expect(voiceDebug().counters.stalls).toBe(1)
    expect(voiceDebug().counters.restarts).toBe(0)
    expect(FakePeerConnection.made.length).toBe(1)
  })

  test('a peer who was talking is not silenced by the clock', async () => {
    boot()
    seePeer('session-z')
    voiceTick(1000)
    await settle()
    FakePeerConnection.made[0]!.goLive()
    hearVoice('session-z', { v: VOICE_PROTOCOL, talking: true })
    expect(talkingPeers()).toEqual(['session-z'])

    voiceTick(20_000)
    expect(talkingPeers()).toEqual(['session-z'])

    // The dot above their head still goes out on time once we are watching.
    runUntil(20_000 + TALKING_STALE_MS + 200, 20_000)
    expect(talkingPeers()).toEqual([])
  })

  test('an ordinary tick is not a stall', () => {
    boot()
    seePeer('session-z')
    // A gap under the threshold is the normal jitter of a busy frame; only a
    // gap an interval could not have produced counts.
    runUntil(4000, 1000, TICK_STALL_MS - 200)
    expect(voiceDebug().counters.stalls).toBe(0)
  })
})

describe('a connection that WAS up and fell over', () => {
  test("'disconnected' is given a grace period, then the pair is rebuilt", async () => {
    boot()
    seePeer('session-z')
    voiceTick(1000)
    await settle()
    const pc = FakePeerConnection.made[0]!
    pc.goLive()
    expect(peer('session-z')?.state).toBe('connected')

    pc.connectionState = 'disconnected'
    pc.emit('connectionstatechange')
    voiceTick(2000)
    // ICE often recovers on its own, so this window is deliberate.
    expect(voiceDebug().counters.restarts).toBe(0)
    runUntil(2000 + DISCONNECT_GRACE_MS + 1, 2000)
    expect(voiceDebug().counters.restarts).toBe(1)
    expect(FakePeerConnection.made.length).toBe(2)
  })

  test('a connection that heals inside the window is left alone', async () => {
    boot()
    seePeer('session-z')
    voiceTick(1000)
    await settle()
    const pc = FakePeerConnection.made[0]!
    pc.goLive()
    pc.connectionState = 'disconnected'
    pc.emit('connectionstatechange')
    voiceTick(2000)
    pc.connectionState = 'connected'
    pc.emit('connectionstatechange')
    runUntil(2000 + DISCONNECT_GRACE_MS + 1, 2000)
    expect(voiceDebug().counters.restarts).toBe(0)
    expect(FakePeerConnection.made.length).toBe(1)
  })

  test('reconnecting REFUNDS the attempt budget', async () => {
    boot()
    seePeer('session-z')
    voiceTick(1000)
    await settle()
    const pc = FakePeerConnection.made[0]!
    pc.goLive()

    // Drop it, let the tick rebuild it, and connect again — as a long session on
    // a flaky network does. The budget exists for "we cannot reach this peer at
    // all"; spending it on recoveries wrote off pairs that kept proving they
    // worked, and the give-up list is permanent for the session.
    pc.connectionState = 'disconnected'
    pc.emit('connectionstatechange')
    runUntil(2000 + DISCONNECT_GRACE_MS + 1, 1000)
    await settle()
    expect(peer('session-z')?.attempts).toBe(1)
    const rebuilt = FakePeerConnection.made[1]!
    rebuilt.goLive()
    expect(peer('session-z')?.attempts).toBe(0)
    expect(voiceDebug().unreachable).toEqual([])
  })
})

describe('a rebuilt link is a CONTINUATION, not a fresh start', () => {
  /**
   * These four tests are the whole reason two real browsers could not hear each
   * other. Each one on its own reads like an edge case; together they are the
   * deadlock: our first offer is epoch 1, they answer and record it, we restart
   * for any reason at all, and every check that exists to protect this protocol
   * then fires on the wrong side of the truth.
   */
  test('the epoch KEEPS COUNTING across a restart', async () => {
    const bus = boot()
    seePeer('session-z')
    voiceTick(1000)
    await settle()
    expect(peer('session-z')?.owed).toBe('offer@1')

    // Any restart at all. A rejected answer is the cheapest one to script.
    FakePeerConnection.rejectSetRemote = true
    hearVoice('session-z', {
      v: VOICE_PROTOCOL,
      to: 'session-me',
      sdp: { type: 'answer', epoch: 1, sdp: SDP('sendrecv') },
    })
    await settle()
    expect(voiceDebug().counters.restarts).toBe(1)

    // The rebuilt link re-offers — as epoch 2. Starting again at 1 is what made
    // the far side drop it as "an offer we already answered".
    FakePeerConnection.rejectSetRemote = false
    voiceTick(1100)
    await settle()
    voiceTick(1200)
    expect(peer('session-z')?.owed).toBe('offer@2')
    expect(lastDescriptionTo(bus, 'session-z')?.sdp?.epoch).toBe(2)
  })

  test('their answer to the DEAD offer no longer matches the live one', async () => {
    boot()
    seePeer('session-z')
    voiceTick(1000)
    await settle()

    FakePeerConnection.rejectSetRemote = true
    hearVoice('session-z', {
      v: VOICE_PROTOCOL,
      to: 'session-me',
      sdp: { type: 'answer', epoch: 1, sdp: SDP('sendrecv') },
    })
    await settle()
    FakePeerConnection.rejectSetRemote = false
    voiceTick(1100)
    await settle()

    // Their resend of the OLD answer arrives at the NEW connection. With the
    // epoch carried forward this is recognisably stale; without it, the numbers
    // matched, the wrong description went into a live connection, it rejected,
    // and that produced another restart — the loop.
    hearVoice('session-z', {
      v: VOICE_PROTOCOL,
      to: 'session-me',
      sdp: { type: 'answer', epoch: 1, sdp: SDP('sendrecv') },
    })
    await settle()
    expect(voiceDebug().counters.answersApplied).toBe(0)
    expect(voiceDebug().counters.restarts).toBe(1)
    expect(peer('session-z')?.owed).toBe('offer@2')
  })

  test('a link that ended in an EXCEPTION is picked back up by the tick', async () => {
    boot()
    seePeer('session-a') // below us: they offer, we answer
    voiceTick(1000)
    FakePeerConnection.rejectSetRemote = true
    hearVoice('session-a', {
      v: VOICE_PROTOCOL,
      to: 'session-me',
      sdp: { type: 'offer', epoch: 1, sdp: SDP('sendrecv') },
    })
    await settle()
    expect(peer('session-a')?.state).toBe('failed')
    expect(peer('session-a')?.step).toBe('answer:threw')
    expect(peer('session-a')?.error).toContain('SDP rejected')
    expect(voiceDebug().counters.threw).toBe(1)

    // The timeout branch only ever looked at 'negotiating', so before this
    // existed a single caught exception meant silence for the rest of the
    // session with the whole attempt budget unspent.
    FakePeerConnection.rejectSetRemote = false
    voiceTick(1100)
    expect(voiceDebug().counters.restarts).toBe(1)
    expect(peer('session-a')?.state).toBe('idle')
  })

  test('a description the browser never hands back is COUNTED, not silent', async () => {
    boot()
    seePeer('session-z')
    FakePeerConnection.swallowLocalDescription = true
    voiceTick(1000)
    await settle()
    expect(voiceDebug().counters.abandoned).toBe(1)
    expect(peer('session-z')?.step).toBe('offer:no-sdp')
    expect(peer('session-z')?.owed).toBeNull()
  })
})

describe('patience, and where it runs out', () => {
  test('a handshake with ICE in flight is given twice as long', async () => {
    boot()
    seePeer('session-z')
    voiceTick(1000)
    await settle()
    const pc = FakePeerConnection.made[0]!
    // A live path to the other machine, waiting on one more description. Killing
    // this at the base deadline throws away the expensive half of the handshake
    // — and in a two-peer call does it exactly when the answer is in flight,
    // because both sides started their clocks together.
    pc.iceConnectionState = 'checking'
    runUntil(1000 + NEGOTIATION_TIMEOUT_MS + 1, 1000)
    expect(voiceDebug().counters.restarts).toBe(0)
    runUntil(1000 + NEGOTIATION_TIMEOUT_MS * 2 + 1, 1000 + NEGOTIATION_TIMEOUT_MS + 1)
    expect(voiceDebug().counters.restarts).toBe(1)
  })

  test('a handshake that heard NOTHING is restarted on the base deadline', async () => {
    boot()
    seePeer('session-z')
    voiceTick(1000)
    await settle()
    runUntil(1000 + NEGOTIATION_TIMEOUT_MS + 1, 1000)
    expect(voiceDebug().counters.restarts).toBe(1)
  })
})

describe('a pending description does not wait for the heartbeat', () => {
  test('an owed offer goes out on the very next tick', async () => {
    const bus = boot()
    seePeer('session-z')
    voiceTick(1000) // builds the link and starts the offer
    await settle() // the offer becomes owed
    voiceTick(1100) // ONE tick later, not four
    const frame = lastDescriptionTo(bus, 'session-z')
    expect(frame?.sdp?.epoch).toBe(1)
    expect(voiceDebug().counters.offersSent).toBe(1)
  })

  test('with nothing owed it stays on the heartbeat — after ONE prompt ack', async () => {
    const bus = boot()
    seePeer('session-z')
    voiceTick(1000)
    await settle()
    hearVoice('session-z', {
      v: VOICE_PROTOCOL,
      to: 'session-me',
      sdp: { type: 'answer', epoch: 1, sdp: SDP('sendrecv') },
    })
    await settle()
    expect(peer('session-z')?.owed).toBeNull()
    const before = sent(bus).length
    // Applying their answer earned them an ack, and until it lands they re-send
    // that answer every tick: it goes out on the NEXT tick, not the heartbeat.
    voiceTick(1100)
    expect(sent(bus).length).toBe(before + 1)
    expect(sent(bus).at(-1)?.ack).toEqual({ 'session-z': 1 })
    // Then nothing changes, so nothing goes out until the heartbeat.
    voiceTick(1200)
    expect(sent(bus).length).toBe(before + 1)
    voiceTick(1300) // ticks % SIGNAL_EVERY_TICKS === 0
    expect(sent(bus).length).toBe(before + 2)
  })
})

describe('the answerer has to SEND, not only receive', () => {
  /**
   * THE BUG THAT MADE HALF A CALL. Two real browsers connected, both reported a
   * healthy pair with a live sender, and only one of them could be heard.
   *
   * WebRTC recycles an existing transceiver for an incoming m-line only when that
   * transceiver came from `addTrack`; one created with `addTransceiver` is a
   * request for an m-line of our own. So the answerer held two — its own, which
   * had no m-line and could never get one because an answer cannot add m-lines,
   * and the one the offer implicitly created, which the spec defines as
   * **recvonly**. Its answer said "I only receive". That was accurate, and it was
   * the whole problem: the offerer's transceiver settled at `sendonly` and its
   * receiver track stayed muted for the rest of the session.
   *
   * Nothing threw. No counter moved. The fake models the recvonly implicit
   * transceiver precisely so this can never come back silently.
   */
  const anOffer = { epoch: 1, sdp: SDP('sendrecv'), type: 'offer' as const }

  test('the transceiver the offer created is turned into sendrecv', async () => {
    boot()
    seePeer('session-a') // below us, so they offer and we answer
    voiceTick(1000)
    await settle()
    hearVoice('session-a', { v: VOICE_PROTOCOL, sdp: anOffer, to: 'session-me' })
    await settle()

    const pc = FakePeerConnection.made[0]!
    const associated = pc.transceivers.find((transceiver) => transceiver.mid !== null)
    expect(associated?.direction).toBe('sendrecv')
    expect(peer('session-a')?.owed).toBe('answer@1')
  })

  test('the mic goes into the sender that has the m-line', async () => {
    boot()
    const { enableMic } = await import('./voice')
    await enableMic()
    seePeer('session-a')
    voiceTick(1000)
    await settle()
    hearVoice('session-a', { v: VOICE_PROTOCOL, sdp: anOffer, to: 'session-me' })
    await settle()

    const pc = FakePeerConnection.made[0]!
    const associated = pc.transceivers.find((transceiver) => transceiver.mid !== null)
    // A track on the orphan is a track on nothing: it is attached to no m-line,
    // so nobody is sent it, and the readouts all look correct anyway.
    expect(associated?.sender.track).toBe(mic.track)
  })

  test('a mic enabled LATER lands on the adopted sender', async () => {
    boot()
    seePeer('session-a')
    voiceTick(1000)
    await settle()
    hearVoice('session-a', { v: VOICE_PROTOCOL, sdp: anOffer, to: 'session-me' })
    await settle()
    const { enableMic } = await import('./voice')
    expect(await enableMic()).toBe('live')

    const pc = FakePeerConnection.made[0]!
    const associated = pc.transceivers.find((transceiver) => transceiver.mid !== null)
    expect(associated?.sender.track).toBe(mic.track)
  })

  test('the orphan is stopped, so it cannot demand an m-line later', async () => {
    boot()
    seePeer('session-a')
    voiceTick(1000)
    await settle()
    hearVoice('session-a', { v: VOICE_PROTOCOL, sdp: anOffer, to: 'session-me' })
    await settle()

    const pc = FakePeerConnection.made[0]!
    const orphans = pc.transceivers.filter((transceiver) => transceiver.mid === null)
    expect(orphans.length).toBe(1)
    expect(orphans[0]!.stopped).toBe(true)
  })

  test('the OFFERER keeps the transceiver it made — nothing to adopt', async () => {
    boot()
    seePeer('session-z') // above us, so we offer
    voiceTick(1000)
    await settle()
    const pc = FakePeerConnection.made[0]!
    // Our own m-line, our own sender: this side was never the broken one.
    expect(pc.transceivers.length).toBe(1)
    expect(pc.transceivers[0]!.direction).toBe('sendrecv')
    expect(pc.transceivers[0]!.stopped).toBe(false)
  })
})

describe('one negotiation at a time, per pair', () => {
  /**
   * SIGNALLING HERE IS A RESEND LOOP, and every stage of a handshake is an await.
   * The offerer publishes the same description every tick until it is
   * acknowledged — which cannot happen until the answerer has finished
   * createAnswer, setLocalDescription and the full ICE gather, seconds later. So
   * the answerer sees ten or thirty copies of an offer it is already in the
   * middle of answering, and `applied` — written at the very END of that
   * sequence — cannot stop it starting a fresh negotiation for every one.
   *
   * What that produced was not a failure anybody could see: both ends reported a
   * connected pair, and the local answer that happened to survive the
   * interleaving belonged to no offer the other side still held. Media in one
   * direction only, with every readout green.
   */
  test('the same offer arriving many times is answered once', async () => {
    boot()
    seePeer('session-a') // below us, so they are the offerer and we answer
    voiceTick(1000)
    await settle()

    let release = () => {}
    FakePeerConnection.holdAnswer = new Promise<void>((resolve) => {
      release = () => resolve()
    })
    const offer = { epoch: 1, sdp: SDP('sendrecv'), type: 'offer' as const }
    for (let tick = 0; tick < 10; tick++) {
      hearVoice('session-a', { v: VOICE_PROTOCOL, sdp: offer, to: 'session-me' })
      await settle(2)
    }
    release()
    FakePeerConnection.holdAnswer = null
    await settle()

    expect(voiceDebug().counters.offersApplied).toBe(1)
    expect(voiceDebug().counters.dropped).toBe(9)
    // One connection, one remote offer on it. Nine `setRemoteDescription` calls
    // on a connection mid-negotiation is what a one-way call is made of.
    expect(FakePeerConnection.made.length).toBe(1)
    expect(FakePeerConnection.made[0]!.remoteDescriptions.length).toBe(1)
    expect(peer('session-a')?.owed).toBe('answer@1')
  })

  test('a NEW offer is still answered once the first one has settled', async () => {
    boot()
    seePeer('session-a')
    voiceTick(1000)
    await settle()
    hearVoice('session-a', {
      v: VOICE_PROTOCOL,
      sdp: { epoch: 1, sdp: SDP('sendrecv'), type: 'offer' },
      to: 'session-me',
    })
    await settle()
    // Their link was rebuilt and they are offering again — the guard is about
    // duplicates of one description, never about refusing the next one.
    hearVoice('session-a', {
      v: VOICE_PROTOCOL,
      sdp: { epoch: 2, sdp: SDP('sendrecv'), type: 'offer' },
      to: 'session-me',
    })
    await settle()
    expect(voiceDebug().counters.offersApplied).toBe(2)
    expect(peer('session-a')?.owed).toBe('answer@2')
  })

  test('a duplicate ANSWER does not tear down the call it belongs to', async () => {
    boot()
    seePeer('session-z') // above us, so we offer
    voiceTick(1000)
    await settle()
    const answer = { epoch: 1, sdp: SDP('sendrecv'), type: 'answer' as const }
    // Two copies inside one microtask turn: their resend loop runs until we ack,
    // and we only stop owing the offer when the first application resolves. The
    // second setRemoteDescription rejects on a real stack, and the rejection path
    // restarts the pair — so the punishment for their patience was our hanging up.
    hearVoice('session-z', { v: VOICE_PROTOCOL, sdp: answer, to: 'session-me' })
    hearVoice('session-z', { v: VOICE_PROTOCOL, sdp: answer, to: 'session-me' })
    await settle()
    expect(voiceDebug().counters.answersApplied).toBe(1)
    expect(voiceDebug().counters.restarts).toBe(0)
    expect(FakePeerConnection.made.length).toBe(1)
    // The offer is acknowledged by having been answered, so it stops being sent.
    expect(peer('session-z')?.owed).toBe(null)
  })
})

describe('glare — both ends offered', () => {
  test('the pair’s OWNER keeps its offer and ignores theirs', async () => {
    boot()
    seePeer('session-z') // above us, so we are the offerer
    voiceTick(1000)
    await settle()
    const pc = FakePeerConnection.made[0]!
    expect(pc.signalingState).toBe('have-local-offer')

    hearVoice('session-z', {
      v: VOICE_PROTOCOL,
      to: 'session-me',
      sdp: { type: 'offer', epoch: 1, sdp: SDP('sendrecv') },
    })
    await settle()
    // Ours stands. Handing this connection their offer would have thrown and
    // failed the pair for the rest of the session.
    expect(pc.remoteDescriptions).toEqual([])
    expect(pc.rollbacks).toBe(0)
    expect(peer('session-z')?.owed).toBe('offer@1')
    expect(voiceDebug().counters.dropped).toBe(1)
  })

  test('the other side ROLLS BACK and answers, so the pair still connects', async () => {
    boot()
    seePeer('session-a') // below us, so THEY own the pair
    voiceTick(1000)
    await settle()
    // Force the state the ordering says we should never be in (a peer on an
    // older build, or a link rebuilt while their offer was in flight).
    const pc = FakePeerConnection.made[0]!
    await pc.setLocalDescription({ sdp: SDP('sendrecv'), type: 'offer' })
    expect(pc.signalingState).toBe('have-local-offer')

    hearVoice('session-a', {
      v: VOICE_PROTOCOL,
      to: 'session-me',
      sdp: { type: 'offer', epoch: 3, sdp: SDP('sendrecv') },
    })
    await settle()
    expect(pc.rollbacks).toBe(1)
    expect(pc.remoteDescriptions.map((d) => d.type)).toEqual(['offer'])
    expect(peer('session-a')?.owed).toBe('answer@3')
  })
})

describe('a coalesced frame is not a sent frame', () => {
  test('a deferred publish is counted and the description is NOT marked sent', async () => {
    const bus = boot()
    bus.publishResult = 'deferred'
    seePeer('session-z')
    voiceTick(1000)
    await settle()
    for (let t = 0; t < 4; t++) voiceTick(1100 + t * 100)
    // The host kept somebody else's payload for this event inside its window.
    expect(voiceDebug().counters.notSent).toBeGreaterThan(0)
    expect(voiceDebug().counters.offersSent).toBe(0)
    // The offer is STILL owed, so the next tick carries it again. This is the
    // whole reason signalling is non-trickle and idempotent.
    expect(peer('session-z')?.owed).toBe('offer@1')

    bus.publishResult = 'sent'
    voiceTick(2000)
    // Epoch 1 either way: what goes back on the wire is the SAME description,
    // not a renegotiation, which is what makes a swallowed frame survivable.
    expect(lastDescriptionTo(bus, 'session-z')?.sdp?.epoch).toBe(1)
    expect(voiceDebug().counters.offersSent).toBeGreaterThan(0)
  })

  test('an acknowledged description stops being re-sent', async () => {
    const bus = boot()
    seePeer('session-a')
    voiceTick(1000)
    hearVoice('session-a', {
      v: VOICE_PROTOCOL,
      to: 'session-me',
      sdp: { type: 'offer', epoch: 2, sdp: SDP('sendrecv') },
    })
    await settle()
    for (let t = 0; t < 4; t++) voiceTick(1100 + t * 100)
    // An owed description repeats on every tick until it is acked, so the count
    // here is a number of ATTEMPTS, not of distinct answers — the assertion that
    // matters is the one below, that the ack ends them.
    const attempts = voiceDebug().counters.answersSent
    expect(attempts).toBeGreaterThan(0)
    const onWire = sent(bus).filter((f) => f.sdp).length

    // Their ack of OUR answer epoch: they have it, stop.
    hearVoice('session-a', { v: VOICE_PROTOCOL, ack: { 'session-me': 2 } })
    for (let t = 0; t < 8; t++) voiceTick(2000 + t * 100)
    expect(voiceDebug().counters.answersSent).toBe(attempts)
    expect(sent(bus).filter((f) => f.sdp).length).toBe(onWire)
  })

  test('we advertise what we have applied, so they can stop re-sending too', async () => {
    const bus = boot()
    seePeer('session-a')
    voiceTick(1000)
    hearVoice('session-a', {
      v: VOICE_PROTOCOL,
      to: 'session-me',
      sdp: { type: 'offer', epoch: 4, sdp: SDP('sendrecv') },
    })
    await settle()
    for (let t = 0; t < 4; t++) voiceTick(1100 + t * 100)
    expect(sent(bus).at(-1)?.ack).toEqual({ 'session-a': 4 })
  })
})

describe('a pair that cannot connect is given up on, countably', () => {
  test('a negotiation that never completes restarts, then stops', async () => {
    boot()
    seePeer('session-z')
    let now = 1000
    voiceTick(now)
    await settle()
    // Two ticks per attempt: one notices the timeout and rebuilds the link, the
    // next offers on the fresh one. Bounded well above what it should need.
    for (let attempt = 0; attempt < (MAX_NEGOTIATION_ATTEMPTS + 2) * 2; attempt++) {
      const next = now + NEGOTIATION_TIMEOUT_MS + 200
      runUntil(next, now)
      now = next
      await settle()
    }
    const debug = voiceDebug()
    // Bounded: with STUN only some pairs genuinely cannot reach each other, and
    // retrying forever would burn a connection every fifteen seconds in silence.
    expect(debug.counters.restarts).toBe(MAX_NEGOTIATION_ATTEMPTS - 1)
    expect(debug.counters.given_up).toBe(1)
    expect(debug.unreachable).toEqual(['session-z'])
    expect(debug.peers).toEqual([])

    // …and it is not re-attempted on the next tick.
    seePeer('session-z', {}, now + 100)
    voiceTick(now + 200)
    expect(voiceDebug().peers).toEqual([])
  })

  test('an ICE failure restarts the pair', async () => {
    boot()
    seePeer('session-z')
    voiceTick(1000)
    await settle()
    const pc = FakePeerConnection.made[0]!
    pc.connectionState = 'failed'
    pc.emit('connectionstatechange')
    expect(voiceDebug().counters.restarts).toBe(1)
    expect(FakePeerConnection.made.length).toBe(2)
  })
})

// ── Hearing ──────────────────────────────────────────────────────────────────

describe('levels', () => {
  test('squad is a party call: full volume however far away they are', async () => {
    boot()
    seePeer('session-z', { p: [0, 0, VOICE_FAR_M * 3] })
    voiceTick(1000)
    await settle()
    FakePeerConnection.made[0]!.goLive()
    voiceTick(1100)
    expect(FakeAudio.made[0]!.volume).toBe(1)
  })

  test('proximity follows distance, and a peer past FAR is silent', async () => {
    boot()
    seePeer('session-z', { p: [0, 0, 1] })
    voiceTick(1000)
    await settle()
    FakePeerConnection.made[0]!.goLive()
    setVoiceMode('proximity')
    voiceTick(1100)
    const near = FakeAudio.made[0]!.volume
    expect(near).toBe(1)

    seePeer('session-z', { p: [0, 0, VOICE_FAR_M + 10] }, 1200)
    voiceTick(1300)
    expect(FakeAudio.made[0]!.volume).toBe(0)
  })

  test('a refused autoplay heals on a later tick', async () => {
    boot()
    seePeer('session-z')
    voiceTick(1000)
    await settle()
    FakePeerConnection.made[0]!.goLive()
    const element = FakeAudio.made[0]!
    element.pause()
    const before = element.playCalls
    setVoiceMode('proximity') // forces the next tick to rewrite the level
    voiceTick(1100)
    expect(element.playCalls).toBeGreaterThan(before)
  })
})

describe('who is talking', () => {
  test('a peer’s talking flag is read even before the audio connects', () => {
    boot()
    seePeer('session-a')
    voiceTick(1000)
    hearVoice('session-a', { v: VOICE_PROTOCOL, talking: true })
    expect(talkingPeers(1000)).toEqual(['session-a'])
  })

  test('their flag goes STALE — a peer whose frames stopped is not still talking', () => {
    boot()
    seePeer('session-a')
    voiceTick(1000)
    hearVoice('session-a', { v: VOICE_PROTOCOL, talking: true })
    const at = 1000 // the clock the tick above advanced to
    expect(talkingPeers(at + TALKING_STALE_MS - 1)).toEqual(['session-a'])
    // Otherwise a peer who crashed mid-sentence keeps a lit ring forever.
    expect(talkingPeers(at + TALKING_STALE_MS + 1)).toEqual([])
  })

  test('with no mic we are never talking', () => {
    boot()
    seePeer('session-a')
    voiceTick(1000)
    expect(selfTalking()).toBe(false)
    expect(micState()).toBe('off')
  })
})

// ── The microphone ───────────────────────────────────────────────────────────

describe('the microphone is optional in every direction', () => {
  test('DENIED: the mesh still forms, so a refused mic means listen-only', async () => {
    boot()
    mic.grant = false
    const { enableMic } = await import('./voice')
    expect(await enableMic()).toBe('denied')
    seePeer('session-z')
    voiceTick(1000)
    await settle()
    // The link is there and it is sendrecv — they will be audible to us.
    expect(voiceDebug().peers.length).toBe(1)
    expect(voiceDebug().mic).toBe('denied')
  })

  test('no getUserMedia at all is "unavailable", not a crash', async () => {
    boot()
    g.navigator = {}
    const { enableMic } = await import('./voice')
    expect(await enableMic()).toBe('unavailable')
  })

  test('the mic swaps into EXISTING senders with no second handshake', async () => {
    const bus = boot()
    seePeer('session-z')
    voiceTick(1000)
    await settle()
    for (let t = 0; t < 4; t++) voiceTick(1100 + t * 100)

    const { enableMic } = await import('./voice')
    expect(await enableMic()).toBe('live')
    const sender = FakePeerConnection.made[0]!.transceivers[0]!.sender
    expect(sender.replaced.length).toBe(1)
    expect(sender.track).toBe(mic.track)

    // NO NEW EPOCH. `replaceTrack` is exactly the API that avoids renegotiating,
    // and a second handshake mid-firefight is an audible gap. The peer is still
    // unacked here so the same description keeps going out on the heartbeat —
    // what must not appear is a SECOND one.
    for (let t = 0; t < 8; t++) voiceTick(2000 + t * 100)
    expect(peer('session-z')?.epoch).toBe(1)
    const epochs = new Set(sent(bus).filter((f) => f.sdp).map((f) => `${f.sdp?.type}@${f.sdp?.epoch}`))
    expect([...epochs]).toEqual(['offer@1'])
  })

  test('a peer joining AFTER the mic is live gets the track on its first link', async () => {
    boot()
    const { enableMic } = await import('./voice')
    await enableMic()
    seePeer('session-z')
    voiceTick(1000)
    await settle()
    expect(FakePeerConnection.made[0]!.transceivers[0]!.sender.track).toBe(mic.track)
  })

  test('mute keeps the device and the call; unmute needs no new permission', async () => {
    boot()
    const { enableMic, setMicMuted } = await import('./voice')
    await enableMic()
    setMicMuted(true)
    expect(micState()).toBe('muted')
    expect(mic.track?.enabled).toBe(false)
    expect(mic.track?.stopped).toBe(false)
    expect(selfTalking()).toBe(false)
    setMicMuted(false)
    expect(micState()).toBe('live')
    expect(mic.track?.enabled).toBe(true)
  })

  test('toggle acquires first, then mutes and unmutes', async () => {
    boot()
    const { toggleMic } = await import('./voice')
    expect(await toggleMic()).toBe('live')
    expect(await toggleMic()).toBe('muted')
    expect(await toggleMic()).toBe('live')
  })

  test('a mic already permitted is enabled WITHOUT a prompt', async () => {
    boot()
    const { enableMicIfAlreadyPermitted } = await import('./voice')
    mic.permission = 'granted'
    expect(await enableMicIfAlreadyPermitted()).toBe('live')
  })

  test('a mic not yet permitted is NOT prompted for at session start', async () => {
    boot()
    const { enableMicIfAlreadyPermitted } = await import('./voice')
    mic.permission = 'prompt'
    // A permission dialog appearing as somebody drops into a firefight is worse
    // than no voice: they click the wrong button and it is denied for good.
    expect(await enableMicIfAlreadyPermitted()).toBe('off')
    expect(mic.track).toBeNull()
  })

  test('a browser with no permissions API does not prompt either', async () => {
    boot()
    g.navigator = { mediaDevices: { getUserMedia: async () => new FakeMediaStream([makeTrack()]) } }
    const { enableMicIfAlreadyPermitted } = await import('./voice')
    expect(await enableMicIfAlreadyPermitted()).toBe('off')
  })

  test('the backstop stops at a release that lands DURING its permission read', async () => {
    // game-root calls this on bind; Esc in the first ~100 ms (or the auto-exit
    // when fullscreen is refused) runs stopVoice → releaseMic while the
    // permissions.query is still pending. Without the epoch check the grant
    // that follows would be a hot mic in the editor with nothing to release it.
    boot()
    let answer: ((status: { state: string }) => void) | null = null
    let asked = 0
    g.navigator = {
      mediaDevices: {
        getUserMedia: async () => {
          asked++
          mic.track = makeTrack()
          return new FakeMediaStream([mic.track])
        },
      },
      permissions: {
        query: () =>
          new Promise<{ state: string }>((resolve) => {
            answer = resolve
          }),
      },
    }
    const { enableMicIfAlreadyPermitted } = await import('./voice')
    const pending = enableMicIfAlreadyPermitted()
    await settle()
    stopVoice()
    answer!({ state: 'granted' })
    expect(await pending).toBe('off')
    expect(asked).toBe(0)
    expect(micState()).toBe('off')
    expect(mic.track).toBeNull()
  })
})

// ── Leaving ──────────────────────────────────────────────────────────────────

describe('stopVoice', () => {
  test('RELEASES THE MICROPHONE — the recording indicator must go out', async () => {
    boot()
    const { enableMic } = await import('./voice')
    await enableMic()
    const track = mic.track!
    stopVoice()
    expect(track.stopped).toBe(true)
    expect(micState()).toBe('off')
  })

  test('closes every connection and stops publishing', async () => {
    const bus = boot()
    seePeer('session-z')
    voiceTick(1000)
    await settle()
    stopVoice()
    expect(FakePeerConnection.made.every((pc) => pc.closed)).toBe(true)
    expect(voiceActive()).toBe(false)
    const before = bus.publishes.length
    voiceTick(2000)
    expect(bus.publishes.length).toBe(before)
  })

  test('stopping twice, or before starting, is not an error', () => {
    expect(() => {
      stopVoice()
      stopVoice()
    }).not.toThrow()
  })

  test('a session can be re-entered', async () => {
    boot()
    seePeer('session-z')
    voiceTick(1000)
    await settle()
    stopVoice()
    expect(startVoice({ getLocalPosition: () => [0, 0, 0] })).toBe(true)
    seePeer('session-z', {}, 1100)
    voiceTick(1200)
    await settle()
    expect(voiceDebug().peers.length).toBe(1)
  })
})

/**
 * The mode is a PREFERENCE and has to outlive the page.
 *
 * Somebody picks proximity because they are working at opposite ends of a house;
 * if that resets on every reload they will pick it twice and then stop bothering.
 * The write also must not be able to break the mode change itself — a browser in
 * private mode throws on the storage, and a call that switched correctly must not
 * be undone by the bookkeeping that records it.
 */
describe('voice mode persistence', () => {
  const globals = globalThis as { localStorage?: unknown }
  const KEY = 'boots.voice.mode.1'

  function fakeStorage(over: Partial<Storage> = {}): Storage {
    const map = new Map<string, string>()
    return {
      clear: () => map.clear(),
      getItem: (key: string) => map.get(key) ?? null,
      key: (index: number) => [...map.keys()][index] ?? null,
      get length() {
        return map.size
      },
      removeItem: (key: string) => map.delete(key),
      setItem: (key: string, value: string) => void map.set(key, value),
      ...over,
    } as Storage
  }

  function withStorage(storage: unknown, run: () => void): void {
    const real = Object.getOwnPropertyDescriptor(globals, 'localStorage')
    Object.defineProperty(globals, 'localStorage', { configurable: true, value: storage })
    try {
      run()
    } finally {
      if (real) Object.defineProperty(globals, 'localStorage', real)
      else Object.defineProperty(globals, 'localStorage', { configurable: true, value: undefined })
    }
  }

  test('choosing a mode writes it down', () => {
    const storage = fakeStorage()
    withStorage(storage, () => {
      setVoiceMode('proximity')
      expect(storage.getItem(KEY)).toBe('proximity')
      expect(voiceMode()).toBe('proximity')
      setVoiceMode('squad')
      expect(storage.getItem(KEY)).toBe('squad')
    })
  })

  test('a storage that refuses to be written does not lose the mode change', () => {
    // Safari in private mode, an embedded webview with storage off, a full quota.
    const hostile = fakeStorage({
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    })
    withStorage(hostile, () => {
      expect(() => setVoiceMode('proximity')).not.toThrow()
      expect(voiceMode()).toBe('proximity')
    })
  })

  test('no storage at all is not an error either', () => {
    withStorage(undefined, () => {
      expect(() => setVoiceMode('squad')).not.toThrow()
      expect(voiceMode()).toBe('squad')
    })
  })
})

// ── The mic, on the veil ─────────────────────────────────────────────────────

/**
 * The prompt is a STATE, the release is UNCONDITIONAL, the choice is REMEMBERED.
 * Every one of these was a way to end up with a hot microphone nobody asked for
 * — the browser's red dot lit after Esc — or a second dialog under the first.
 */
describe('the mic dialog is a state', () => {
  type Nav = { mediaDevices: { getUserMedia: () => Promise<unknown> } }

  test("'asking' synchronously, 'live' once granted, and the track is in every sender", async () => {
    boot()
    seePeer('session-z')
    voiceTick(1000)
    await settle()
    const pending = enableMic()
    expect(micState()).toBe('asking')
    expect(await pending).toBe('live')
    expect(FakePeerConnection.made[0]!.transceivers[0]!.sender.track).toBe(mic.track)
  })

  test('a press while the dialog is open starts NO second prompt', async () => {
    boot()
    const nav = g.navigator as Nav
    let calls = 0
    const real = nav.mediaDevices.getUserMedia
    nav.mediaDevices.getUserMedia = async () => {
      calls++
      return real()
    }
    const first = enableMic()
    expect(await toggleMic()).toBe('asking')
    expect(await enableMic()).toBe('asking')
    expect(await first).toBe('live')
    expect(calls).toBe(1)
  })

  test('released BEFORE the grant resolves: the late track is stopped, no leak', async () => {
    boot()
    const nav = g.navigator as Nav
    let grant!: () => void
    const gate = new Promise<void>((resolve) => {
      grant = resolve
    })
    nav.mediaDevices.getUserMedia = async () => {
      await gate
      mic.track = makeTrack()
      return new FakeMediaStream([mic.track])
    }
    const pending = enableMic()
    expect(micState()).toBe('asking')
    stopVoice() // Esc while the dialog is still up
    grant()
    expect(await pending).toBe('off')
    expect(mic.track?.stopped).toBe(true)
    expect(micState()).toBe('off')
  })

  test('stopVoice with NO active call still releases a live mic (the old leak)', async () => {
    installBus()
    installWebRtc()
    // No startNet, no startVoice: the veil acquired a mic for a call that never began.
    expect(await enableMic()).toBe('live')
    expect(voiceActive()).toBe(false)
    stopVoice()
    expect(mic.track?.stopped).toBe(true)
    expect(micState()).toBe('off')
  })

  test('releaseMic pulls the track out of every sender', async () => {
    boot()
    await enableMic()
    seePeer('session-z')
    voiceTick(1000)
    await settle()
    const sender = FakePeerConnection.made[0]!.transceivers[0]!.sender
    expect(sender.track).toBe(mic.track)
    releaseMic()
    await settle()
    expect(sender.track).toBeNull()
    expect(micState()).toBe('off')
  })

  test('no input device reads unavailable, a refusal reads denied', async () => {
    boot()
    const nav = g.navigator as Nav
    nav.mediaDevices.getUserMedia = async () => {
      throw new DOMException('no device', 'NotFoundError')
    }
    expect(await enableMic()).toBe('unavailable')
    releaseMic()
    nav.mediaDevices.getUserMedia = async () => {
      throw new DOMException('nope', 'NotAllowedError')
    }
    expect(await enableMic()).toBe('denied')
  })
})

describe('the mic preference', () => {
  const globals = globalThis as { localStorage?: unknown }

  function fakeStorage(): Storage {
    const map = new Map<string, string>()
    return {
      clear: () => map.clear(),
      getItem: (key: string) => map.get(key) ?? null,
      key: (index: number) => [...map.keys()][index] ?? null,
      get length() {
        return map.size
      },
      removeItem: (key: string) => map.delete(key),
      setItem: (key: string, value: string) => void map.set(key, value),
    } as Storage
  }

  async function withStorage(storage: unknown, run: () => Promise<void>): Promise<void> {
    const real = Object.getOwnPropertyDescriptor(globals, 'localStorage')
    Object.defineProperty(globals, 'localStorage', { configurable: true, value: storage })
    try {
      await run()
    } finally {
      if (real) Object.defineProperty(globals, 'localStorage', real)
      else Object.defineProperty(globals, 'localStorage', { configurable: true, value: undefined })
    }
  }

  test('missing or garbage reads ON — everyone talks by default', async () => {
    const storage = fakeStorage()
    await withStorage(storage, async () => {
      expect(loadMicPref()).toBe('on')
      storage.setItem(MIC_PREF_KEY, 'maybe')
      expect(loadMicPref()).toBe('on')
      storage.setItem(MIC_PREF_KEY, 'off')
      expect(loadMicPref()).toBe('off')
    })
  })

  test('an explicit toggle is remembered: on, off, on', async () => {
    const storage = fakeStorage()
    await withStorage(storage, async () => {
      boot()
      expect(await toggleMic()).toBe('live')
      expect(storage.getItem(MIC_PREF_KEY)).toBe('on')
      expect(await toggleMic()).toBe('muted')
      expect(storage.getItem(MIC_PREF_KEY)).toBe('off')
      expect(await toggleMic()).toBe('live')
      expect(storage.getItem(MIC_PREF_KEY)).toBe('on')
    })
  })

  test('a DENIAL writes nothing — a refused dialog is not a preference', async () => {
    const storage = fakeStorage()
    await withStorage(storage, async () => {
      boot()
      mic.grant = false
      expect(await toggleMic()).toBe('denied')
      expect(storage.getItem(MIC_PREF_KEY)).toBeNull()
    })
  })

  test("the session-start backstop honours 'off' even when the browser would allow it", async () => {
    const storage = fakeStorage()
    await withStorage(storage, async () => {
      boot()
      mic.permission = 'granted'
      storage.setItem(MIC_PREF_KEY, 'off')
      expect(await enableMicIfAlreadyPermitted()).toBe('off')
      expect(mic.track).toBeNull()
    })
  })
})

// ── Signals that do not wait for the heartbeat ───────────────────────────────

describe('a talk EDGE goes out on the tick it happens', () => {
  test('the gate opening publishes at once, off-heartbeat, with talking:true; closing too', async () => {
    const bus = boot()
    await enableMic()
    let rms = 0
    setMicLevelSource(() => rms)
    seePeer('session-z')
    voiceTick(1000) // tick 1
    await settle()
    hearVoice('session-z', {
      v: VOICE_PROTOCOL,
      to: 'session-me',
      sdp: { type: 'answer', epoch: 1, sdp: SDP('sendrecv') },
    })
    await settle()
    voiceTick(1100) // tick 2: the prompt ack
    voiceTick(1200) // tick 3: quiet
    const before = sent(bus).length
    rms = VAD_OPEN_RMS * 2
    voiceTick(1300) // tick 4 would be a heartbeat anyway — skip to a non-heartbeat tick
    voiceTick(1400) // tick 5: still talking, nothing new
    const afterOpen = sent(bus).length
    expect(sent(bus).at(-1)?.talking).toBe(true)
    expect(selfTalking()).toBe(true)
    // Nothing changed on tick 5, so tick 4's frame is the last one.
    expect(afterOpen).toBe(before + 1)
    rms = 0
    // The gate hangs for VAD_HANG_MS after the level drops; run it out.
    voiceTick(1900) // tick 6: hang time over → talking false → edge → publish
    expect(selfTalking()).toBe(false)
    expect(sent(bus).length).toBe(afterOpen + 1)
    expect(sent(bus).at(-1)?.talking).toBe(false)
    voiceTick(2000) // tick 7: nothing
    expect(sent(bus).length).toBe(afterOpen + 1)
  })
})

// ── Events ───────────────────────────────────────────────────────────────────

describe('voice events', () => {
  test('one connected per link, one lost when a live pair is rebuilt, none during stopVoice', async () => {
    boot()
    const events: VoiceEvent[] = []
    const off = onVoiceEvent((event) => events.push(event))
    seePeer('session-z')
    voiceTick(1000)
    await settle()
    const pc = FakePeerConnection.made[0]!
    pc.goLive()
    pc.goLive() // a second 'connected' from the same connection is not news
    expect(events.filter((e) => e.type === 'connected').length).toBe(1)
    expect(events[0]?.sessionId).toBe('session-z')
    expect(voiceConnectedCount()).toBe(1)

    pc.connectionState = 'disconnected'
    pc.emit('connectionstatechange')
    runUntil(1100 + DISCONNECT_GRACE_MS + 200, 1000)
    expect(events.filter((e) => e.type === 'lost').length).toBe(1)
    expect(voiceConnectedCount()).toBe(0)

    FakePeerConnection.made[1]!.goLive()
    expect(events.filter((e) => e.type === 'connected').length).toBe(2)
    const count = events.length
    stopVoice()
    expect(events.length).toBe(count)
    off()
  })

  test('giving up on a peer is announced once', async () => {
    boot()
    const events: VoiceEvent[] = []
    onVoiceEvent((event) => events.push(event))
    seePeer('session-z')
    let now = 1000
    voiceTick(now)
    await settle()
    for (let attempt = 0; attempt < (MAX_NEGOTIATION_ATTEMPTS + 2) * 2; attempt++) {
      const next = now + NEGOTIATION_TIMEOUT_MS + 200
      runUntil(next, now)
      now = next
      await settle()
    }
    expect(voiceDebug().unreachable).toEqual(['session-z'])
    expect(events.filter((e) => e.type === 'unreachable').length).toBe(1)
    expect(events.filter((e) => e.type === 'lost').length).toBe(0) // never connected
  })
})

// ── Outputs ──────────────────────────────────────────────────────────────────

describe('primed outputs', () => {
  test('the click primes a pool; a peer’s track lands on a primed element, not a new one', async () => {
    boot()
    primeVoiceOutputs()
    expect(FakeAudio.made.length).toBe(OUTPUT_POOL_SIZE)
    expect(FakeAudio.made.every((element) => element.playCalls > 0)).toBe(true)
    primeVoiceOutputs() // idempotent
    expect(FakeAudio.made.length).toBe(OUTPUT_POOL_SIZE)
    seePeer('session-z')
    voiceTick(1000)
    await settle()
    FakePeerConnection.made[0]!.goLive()
    expect(FakeAudio.made.length).toBe(OUTPUT_POOL_SIZE)
    expect(FakeAudio.made.some((element) => element.srcObject !== null)).toBe(true)
  })

  test('a paused element with a stream is re-played on the heartbeat, with no gain change', async () => {
    boot()
    seePeer('session-z')
    voiceTick(1000) // 1
    await settle()
    FakePeerConnection.made[0]!.goLive()
    voiceTick(1100) // 2: writes the gain
    const element = FakeAudio.made[0]!
    element.pause()
    const before = element.playCalls
    voiceTick(1200) // 3: not a heartbeat, gain unchanged → left alone
    expect(element.playCalls).toBe(before)
    expect(voiceOutputBlocked()).toBe(true)
    voiceTick(1300) // 4: heartbeat → retry
    expect(element.playCalls).toBe(before + 1)
    expect(voiceOutputBlocked()).toBe(false)
  })

  test('a zero gain is ALSO a mute (iOS ignores volume)', async () => {
    boot()
    seePeer('session-z', { p: [0, 0, VOICE_FAR_M + 10] })
    voiceTick(1000)
    await settle()
    FakePeerConnection.made[0]!.goLive()
    setVoiceMode('proximity')
    voiceTick(1100)
    const element = FakeAudio.made[0]! as FakeAudio & { muted?: boolean }
    expect(element.volume).toBe(0)
    expect(element.muted).toBe(true)
    setVoiceMode('squad')
    voiceTick(1200)
    expect(element.muted).toBe(false)
  })
})

// ── Same device ──────────────────────────────────────────────────────────────

class FakeBroadcastChannel {
  static all = new Set<FakeBroadcastChannel>()
  onmessage: ((event: { data: unknown }) => void) | null = null
  constructor(public name: string) {
    FakeBroadcastChannel.all.add(this)
  }
  postMessage(data: unknown): void {
    for (const other of FakeBroadcastChannel.all) {
      if (other !== this && other.name === this.name) other.onmessage?.({ data })
    }
  }
  close(): void {
    FakeBroadcastChannel.all.delete(this)
  }
}

describe('two tabs in one browser', () => {
  const bc = globalThis as { BroadcastChannel?: unknown }
  const realChannel = bc.BroadcastChannel

  function withFakeChannel(run: () => void): void {
    FakeBroadcastChannel.all.clear()
    bc.BroadcastChannel = FakeBroadcastChannel
    try {
      run()
    } finally {
      bc.BroadcastChannel = realChannel
    }
  }

  test('a peer heard on the beacon is mixed at ZERO and the count says so', async () => {
    let other!: FakeBroadcastChannel
    let element!: FakeAudio & { muted?: boolean }
    let pcs!: FakePeerConnection[]
    withFakeChannel(() => {
      boot()
      other = new FakeBroadcastChannel(SAME_DEVICE_CHANNEL)
    })
    seePeer('session-z')
    voiceTick(1000)
    await settle()
    pcs = FakePeerConnection.made
    pcs[0]!.goLive()
    voiceTick(1100)
    element = FakeAudio.made[0]!
    expect(element.volume).toBe(1)
    expect(voiceSameDeviceCount()).toBe(0)

    // The other tab announces itself: same browser, same speakers.
    other.postMessage({ v: 1, sessionId: 'session-z' })
    voiceTick(1200)
    expect(element.volume).toBe(0)
    expect(element.muted).toBe(true)
    expect(voiceSameDeviceCount()).toBe(1)
    expect(peer('session-z')?.sameDevice).toBe(true)
    expect(voiceDebug().sameDevice).toBe(1)

    // A QA run that wants to hear it anyway.
    setVoiceLocalEcho(true)
    voiceTick(1300)
    expect(element.volume).toBe(1)
    expect(voiceSameDeviceCount()).toBe(0)
    setVoiceLocalEcho(false)
    voiceTick(1400)
    expect(element.volume).toBe(0)

    // The beacon goes stale when the other tab stops sending.
    runUntil(1400 + SAME_DEVICE_STALE_MS + 1000, 1400)
    expect(element.volume).toBe(1)
    expect(voiceSameDeviceCount()).toBe(0)
  })

  test('we announce OURSELVES on the heartbeat; junk on the channel is ignored', async () => {
    let other!: FakeBroadcastChannel
    withFakeChannel(() => {
      boot()
      other = new FakeBroadcastChannel(SAME_DEVICE_CHANNEL)
    })
    const heard: unknown[] = []
    other.onmessage = (event) => heard.push(event.data)
    seePeer('session-z')
    for (let t = 0; t < 4; t++) voiceTick(1000 + t * 100)
    expect(heard).toContainEqual({ v: 1, sessionId: 'session-me' })
    await settle()
    for (const junk of [null, 'x', { v: 2, sessionId: 'session-z' }, { v: 1 }, { v: 1, sessionId: 7 }]) {
      other.postMessage(junk)
    }
    voiceTick(1500)
    expect(voiceSameDeviceCount()).toBe(0)
  })

  test('a shared clientId is the belt to the beacon’s braces', async () => {
    boot()
    // The peer's frames arrive stamped with OUR clientId (a host that mints one
    // per browser rather than per tab).
    ingestBusMessage({
      event: 'pose',
      data: { v: NET_PROTOCOL, kind: 'pose', seq: nextSeq('session-z'), data: poseFrame() },
      sessionId: 'session-z',
      clientId: 'client-me',
      userId: 'user-session-z',
      sentAt: 1000,
    })
    voiceTick(1000)
    await settle()
    FakePeerConnection.made[0]!.goLive()
    voiceTick(1100)
    expect(FakeAudio.made[0]!.volume).toBe(0)
    expect(voiceSameDeviceCount()).toBe(1)
  })

  test('no BroadcastChannel at all is not an error', () => {
    const saved = bc.BroadcastChannel
    bc.BroadcastChannel = undefined
    try {
      expect(() => boot()).not.toThrow()
      seePeer('session-z')
      expect(() => voiceTick(1000)).not.toThrow()
    } finally {
      bc.BroadcastChannel = saved
    }
  })
})

// ── The room cap ─────────────────────────────────────────────────────────────

describe('outside the call', () => {
  test('the 7th of 7 knows it is excluded; the 6th does not', () => {
    boot()
    // Six ids that sort BELOW 'session-me' fill the room without us.
    const lower = ['session-a', 'session-b', 'session-c', 'session-d', 'session-e', 'session-f']
    expect(lower.length).toBe(MAX_VOICE_PEERS)
    for (const id of lower.slice(0, MAX_VOICE_PEERS - 1)) seePeer(id)
    voiceTick(1000)
    expect(voiceExcluded()).toBe(false)
    expect(voiceDebug().peers.length).toBe(MAX_VOICE_PEERS - 1)
    seePeer(lower[MAX_VOICE_PEERS - 1]!, {}, 1100)
    voiceTick(1200)
    expect(voiceExcluded()).toBe(true)
    expect(voiceDebug().excluded).toBe(true)
  })

  test('alone, or with a room that has space, we are not excluded', () => {
    boot()
    voiceTick(1000)
    expect(voiceExcluded()).toBe(false)
    seePeer('session-z')
    voiceTick(1100)
    expect(voiceExcluded()).toBe(false)
  })
})

// ── ICE ──────────────────────────────────────────────────────────────────────

describe('the ICE seam', () => {
  const turn = { urls: 'turn:relay.example:3478', username: 'u', credential: 'p' }
  const normalized = { urls: ['turn:relay.example:3478'], username: 'u', credential: 'p' }
  const ice = globalThis as Record<string, unknown> & { location?: unknown; fetch?: unknown }

  test('defaults: three STUN servers, no relay', () => {
    boot()
    seePeer('session-z')
    voiceTick(1000)
    expect(FakePeerConnection.made[0]!.config.iceServers).toEqual([...DEFAULT_ICE_SERVERS])
    expect(voiceDebug().ice).toEqual({ source: 'default', servers: 3, relay: false })
  })

  test('a host global is merged OVER the defaults, validated', () => {
    ice[ICE_SERVERS_GLOBAL] = [turn]
    try {
      boot()
      seePeer('session-z')
      voiceTick(1000)
      expect(FakePeerConnection.made[0]!.config.iceServers).toEqual([...DEFAULT_ICE_SERVERS, normalized])
      expect(voiceDebug().ice).toEqual({ source: 'host', servers: 4, relay: true })
    } finally {
      delete ice[ICE_SERVERS_GLOBAL]
    }
  })

  test('a set the browser refuses falls back to the defaults IN THE SAME TICK, counted', () => {
    // The validator is the first line; this is the second. A relay entry the
    // browser will not take must not turn `if (!link) continue` into a silent
    // death for every peer, and must not be re-adopted on the next prefetch.
    ice[ICE_SERVERS_GLOBAL] = [turn]
    try {
      boot() // installs a fresh fake stack, so the refusal is scripted after it
      FakePeerConnection.refuseRelay = true
      expect(voiceDebug().ice.source).toBe('host')
      seePeer('session-z')
      voiceTick(1000)
      expect(FakePeerConnection.made.length).toBe(1)
      expect(FakePeerConnection.made[0]!.config.iceServers).toEqual([...DEFAULT_ICE_SERVERS])
      expect(voiceDebug().ice).toEqual({ source: 'default', servers: 3, relay: false })
      expect(voiceDebug().counters.pcFailed).toBe(1)
      expect(voiceDebug().peers.length).toBe(1)
      // The host global is still there; it is not taken again this session.
      prefetchIceServers()
      expect(voiceDebug().ice.source).toBe('default')
      // An explicit set is a new decision and is tried again.
      setVoiceIceServers([turn])
      expect(voiceDebug().ice.source).toBe('set')
    } finally {
      delete ice[ICE_SERVERS_GLOBAL]
    }
  })

  test('a garbage host global leaves the defaults alone', () => {
    ice[ICE_SERVERS_GLOBAL] = [{ urls: 'http://evil.example' }, 'turn:x']
    try {
      boot()
      seePeer('session-z')
      voiceTick(1000)
      expect(FakePeerConnection.made[0]!.config.iceServers).toEqual([...DEFAULT_ICE_SERVERS])
      expect(voiceDebug().ice.source).toBe('default')
    } finally {
      delete ice[ICE_SERVERS_GLOBAL]
    }
  })

  test('the same-origin credentials route feeds the NEXT link', async () => {
    const realFetch = ice.fetch
    const realLocation = ice.location
    let url: unknown = null
    ice.location = { protocol: 'http:' }
    ice.fetch = async (input: unknown) => {
      url = input
      return { ok: true, json: async () => ({ iceServers: [turn] }) }
    }
    try {
      boot() // startVoice fires the fetch
      await settle()
      seePeer('session-z')
      voiceTick(1000)
      expect(url).toBe('/api/plugins/boots/turn')
      expect(FakePeerConnection.made[0]!.config.iceServers).toEqual([...DEFAULT_ICE_SERVERS, normalized])
      expect(voiceDebug().ice).toEqual({ source: 'fetched', servers: 4, relay: true })
    } finally {
      ice.fetch = realFetch
      ice.location = realLocation
    }
  })

  test('a 404 or a rejected fetch keeps the defaults and throws nothing', async () => {
    const realFetch = ice.fetch
    const realLocation = ice.location
    ice.location = { protocol: 'http:' }
    ice.fetch = async () => ({ ok: false, json: async () => ({}) })
    try {
      boot()
      await settle()
      seePeer('session-z')
      voiceTick(1000)
      expect(FakePeerConnection.made[0]!.config.iceServers).toEqual([...DEFAULT_ICE_SERVERS])
      resetVoice()
      stopNet()
      ice.fetch = async () => {
        throw new Error('offline')
      }
      expect(() => boot()).not.toThrow()
      await settle()
      seePeer('session-z')
      voiceTick(1000)
      expect(FakePeerConnection.made.at(-1)!.config.iceServers).toEqual([...DEFAULT_ICE_SERVERS])
      expect(voiceDebug().ice.source).toBe('default')
    } finally {
      ice.fetch = realFetch
      ice.location = realLocation
    }
  })

  test('setVoiceIceServers validates too, and outranks the fetch', () => {
    boot()
    setVoiceIceServers([turn])
    seePeer('session-z')
    voiceTick(1000)
    expect(FakePeerConnection.made[0]!.config.iceServers).toEqual([...DEFAULT_ICE_SERVERS, normalized])
    expect(voiceDebug().ice.source).toBe('set')
    setVoiceIceServers([{ urls: 'ws://nope' }])
    expect(voiceDebug().ice.source).toBe('default')
  })
})

// ── getStats ─────────────────────────────────────────────────────────────────

describe('voiceStats', () => {
  test('a stack without getStats yields nothing and throws nothing', async () => {
    boot()
    seePeer('session-z')
    voiceTick(1000)
    await settle()
    expect(await voiceStats()).toEqual([])
  })

  test('reads bytes, level, RTT and the selected pair’s local candidate type', async () => {
    boot()
    seePeer('session-z')
    voiceTick(1000)
    await settle()
    const pc = FakePeerConnection.made[0]! as FakePeerConnection & { getStats?: () => Promise<unknown> }
    pc.getStats = async () =>
      new Map<string, unknown>([
        ['in', { type: 'inbound-rtp', kind: 'audio', bytesReceived: 20480, audioLevel: 0.4 }],
        ['out', { type: 'outbound-rtp', kind: 'audio', bytesSent: 1024 }],
        ['lc', { type: 'local-candidate', id: 'lc', candidateType: 'srflx' }],
        ['pair-old', { type: 'candidate-pair', state: 'failed', localCandidateId: 'lc' }],
        ['pair', { type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'lc', currentRoundTripTime: 0.032 }],
      ])
    expect(await voiceStats()).toEqual([
      { sessionId: 'session-z', bytesReceived: 20480, bytesSent: 1024, audioLevel: 0.4, rttMs: 32, pair: 'srflx' },
    ])
  })
})

describe('talkingPeerCount', () => {
  test('matches talkingPeers without the array', () => {
    boot()
    seePeer('session-a')
    voiceTick(1000)
    hearVoice('session-a', { v: VOICE_PROTOCOL, talking: true })
    expect(talkingPeerCount(1000)).toBe(1)
    expect(talkingPeerCount(1000 + TALKING_STALE_MS + 1)).toBe(0)
  })
})

// ── Listening from the editor ────────────────────────────────────────────────

/** A viewer: the receive-only presence adapter, then the receive-only call. */
function bootListener(): FakeBus {
  const bus = installBus()
  installWebRtc()
  startNet()
  startSpectating()
  expect(startVoiceListen()).toBe(true)
  return bus
}

const recvonlyOffer = (epoch = 1) => ({ epoch, sdp: SDP('recvonly'), type: 'offer' as const })
const anAnswer = (epoch: number, direction = 'sendonly') => ({ epoch, sdp: SDP(direction), type: 'answer' as const })

describe('listening from the editor', () => {
  /**
   * An editor viewer who has not jumped in should HEAR the players. The whole
   * point of this block is that nothing about a listener can leak sound the
   * other way: no microphone is asked for, no track reaches a sender, every
   * m-line it negotiates is recvonly. And because a listener publishes no
   * presence, it must be the one to call.
   */
  test('needs the bus and WebRTC like everything else, and allocates nothing without them', () => {
    installWebRtc()
    expect(startVoiceListen()).toBe(false)
    installBus()
    startNet()
    g.RTCPeerConnection = undefined
    expect(startVoiceListen()).toBe(false)
    expect(voiceDebug().listen).toBe(false)
    expect(voiceActive()).toBe(false)
  })

  test('OFFERS TO EVERY PLAYER whatever the ids sort as, RECVONLY, and says listen:true', async () => {
    const bus = bootListener()
    seePeer('session-a') // sorts BELOW us: a player would wait for their offer
    seePeer('session-z')
    voiceTick(1000)
    await settle()
    for (let t = 1; t <= 8; t++) voiceTick(1000 + t * 100)
    expect(lastDescriptionTo(bus, 'session-a')?.sdp?.type).toBe('offer')
    expect(lastDescriptionTo(bus, 'session-z')?.sdp?.type).toBe('offer')
    expect(FakePeerConnection.made.length).toBe(2)
    for (const pc of FakePeerConnection.made) {
      expect(pc.transceivers).toEqual([expect.objectContaining({ direction: 'recvonly', kind: 'audio' })])
      expect(pc.transceivers[0]!.sender.track).toBeNull()
    }
    expect(sent(bus).length).toBeGreaterThan(0)
    expect(sent(bus).every((frame) => frame.listen === true)).toBe(true)
    expect(voiceDebug().listen).toBe(true)
  })

  test('a live mic in a listener’s hand is not a voice in the call: no frame ever says talking', async () => {
    // The veil's ask-first click acquires the mic while the button still reads
    // PLAY — a listener can hold a live track for minutes. It is on no sender,
    // so a `talking: true` from it would light 'N SPEAKING' on the players' pill
    // for a viewer nobody can hear.
    const bus = bootListener()
    seePeer('session-z')
    voiceTick(1000)
    await settle()
    expect(await enableMic()).toBe('live')
    setMicLevelSource(() => VAD_OPEN_RMS * 2)
    for (let t = 1; t <= 8; t++) voiceTick(1000 + t * 100)
    expect(selfTalking()).toBe(false)
    expect(sent(bus).some((frame) => frame.talking === true)).toBe(false)
    // The handover makes it a voice: the same mic, now on a sender, opens the gate.
    expect(startVoice({ getLocalPosition: () => [0, 0, 0] })).toBe(true)
    voiceTick(1900)
    expect(selfTalking()).toBe(true)
    expect(sent(bus).at(-1)?.talking).toBe(true)
  })

  test('never asks for the microphone; a mic acquired on the veil is NOT put on any sender', async () => {
    bootListener()
    seePeer('session-z')
    voiceTick(1000)
    await settle()
    expect(mic.track).toBeNull() // no getUserMedia happened
    // The veil's JUMP IN click acquires the mic a moment BEFORE the game starts,
    // while we are still listening. It must wait for the handover.
    expect(await enableMic()).toBe('live')
    expect(FakePeerConnection.made[0]!.transceivers[0]!.sender.replaced).toEqual([])
  })

  test('a player who offers to a listener (glare after a restart) gets a recvonly answer', async () => {
    bootListener()
    seePeer('session-a')
    voiceTick(1000)
    await settle()
    await enableMic()
    hearVoice('session-a', { v: VOICE_PROTOCOL, sdp: { epoch: 1, sdp: SDP('sendrecv'), type: 'offer' }, to: 'session-me' })
    await settle()
    const pc = FakePeerConnection.made[0]!
    const associated = pc.transceivers.find((transceiver) => transceiver.mid !== null)
    expect(associated?.direction).toBe('recvonly')
    expect(associated?.sender.track).toBeNull()
    expect(peer('session-a')?.owed).toBe('answer@1')
  })

  test('hears the ROOM the players form — capped like the players are, never "excluded"', () => {
    bootListener()
    const ids = ['session-a', 'session-b', 'session-c', 'session-d', 'session-e', 'session-f', 'session-g']
    for (const id of ids) seePeer(id)
    voiceTick(1000)
    expect(voiceDebug().peers.map((p) => p.sessionId).sort()).toEqual(ids.slice(0, MAX_VOICE_PEERS))
    expect(voiceExcluded()).toBe(false)
  })

  test('mixes FLAT even in proximity mode — a viewer has no body to be far from', async () => {
    bootListener()
    setVoiceMode('proximity')
    seePeer('session-z', { p: [0, 0, VOICE_FAR_M * 3] })
    voiceTick(1000)
    await settle()
    FakePeerConnection.made[0]!.goLive()
    voiceTick(1100)
    expect(FakeAudio.made[0]!.volume).toBe(1)
  })

  test('a peer who leaves the game is dropped by the listener too', async () => {
    bootListener()
    seePeer('session-z')
    voiceTick(1000)
    await settle()
    seePeer('session-z', { ph: 'editor' }, 1100)
    runUntil(1200 + PEER_ABSENT_MS, 1000)
    expect(voiceDebug().peers).toEqual([])
  })

  test('stopVoiceListen ends the listen session; startVoiceListen is idempotent', () => {
    bootListener()
    expect(startVoiceListen()).toBe(true)
    seePeer('session-z')
    voiceTick(1000)
    stopVoiceListen()
    expect(voiceActive()).toBe(false)
    expect(voiceDebug().listen).toBe(false)
    expect(FakePeerConnection.made[0]!.closed).toBe(true)
  })

  test('a game session already owns the call: startVoiceListen is a no-op on it', () => {
    boot()
    expect(startVoiceListen()).toBe(true)
    expect(voiceDebug().listen).toBe(false)
    stopVoiceListen() // not ours to stop
    expect(voiceActive()).toBe(true)
  })
})

describe('a player with a listener', () => {
  test('an offer from OUTSIDE the roster is answered — and the peer is marked a listener', async () => {
    boot()
    voiceTick(1000)
    hearVoice('viewer-1', { v: VOICE_PROTOCOL, listen: true, sdp: recvonlyOffer(), to: 'session-me' })
    await settle()
    expect(peer('viewer-1')?.listener).toBe(true)
    expect(peer('viewer-1')?.owed).toBe('answer@1')
    // We SEND on that pair: the adopted m-line is sendrecv on our side, so the
    // answer to their recvonly offer is sendonly and they hear us.
    const pc = FakePeerConnection.made[0]!
    expect(pc.transceivers.find((transceiver) => transceiver.mid !== null)?.direction).toBe('sendrecv')
  })

  test('a listener is kept alive by its frames and NEVER offered to — not even after a restart', async () => {
    const bus = boot()
    voiceTick(1000)
    hearVoice('viewer-1', { v: VOICE_PROTOCOL, listen: true, sdp: recvonlyOffer(), to: 'session-me' })
    await settle()
    FakePeerConnection.made[0]!.goLive()
    voiceTick(1100)
    expect(peer('viewer-1')?.state).toBe('connected')
    // We sort below the viewer: were it a PLAYER, the idle-link repair would offer.
    expect(voiceOffererIsUs('session-me', 'viewer-1')).toBe(true)
    // ICE fails; the pair is rebuilt as an idle link. The viewer's heartbeats
    // (listen:true, no description) keep it in the roster-less grace forever.
    const pc = FakePeerConnection.made[0]!
    pc.connectionState = 'failed'
    pc.emit('connectionstatechange')
    let at = 1200
    for (let i = 0; i < 12; i++, at += 400) {
      hearVoice('viewer-1', { v: VOICE_PROTOCOL, listen: true })
      voiceTick(at)
      await settle()
    }
    expect(peer('viewer-1')).toBeDefined()
    expect(peer('viewer-1')?.listener).toBe(true)
    expect(voiceDebug().counters.offersSent).toBe(0)
    expect(lastDescriptionTo(bus, 'viewer-1')?.sdp?.type ?? 'answer').toBe('answer')
    // The viewer's next offer is what repairs the pair.
    hearVoice('viewer-1', { v: VOICE_PROTOCOL, listen: true, sdp: recvonlyOffer(2), to: 'session-me' })
    await settle()
    expect(peer('viewer-1')?.owed).toBe('answer@2')
  })

  test('MAX_LISTENERS_PER_PLAYER: one more offer is not answered, and it is counted', async () => {
    boot()
    voiceTick(1000)
    for (let i = 0; i < MAX_LISTENERS_PER_PLAYER; i++) {
      hearVoice(`viewer-${i}`, { v: VOICE_PROTOCOL, listen: true, sdp: recvonlyOffer(), to: 'session-me' })
    }
    await settle()
    expect(voiceDebug().peers.length).toBe(MAX_LISTENERS_PER_PLAYER)
    hearVoice('viewer-x', { v: VOICE_PROTOCOL, listen: true, sdp: recvonlyOffer(), to: 'session-me' })
    await settle()
    expect(voiceDebug().peers.length).toBe(MAX_LISTENERS_PER_PLAYER)
    expect(voiceDebug().peers.some((p) => p.sessionId === 'viewer-x')).toBe(false)
    expect(voiceDebug().counters.listenersRefused).toBe(1)
    // A PLAYER is never refused by the listener cap.
    seePeer('session-a', {}, 1100)
    voiceTick(1200)
    hearVoice('session-a', { v: VOICE_PROTOCOL, sdp: { epoch: 1, sdp: SDP('sendrecv'), type: 'offer' }, to: 'session-me' })
    await settle()
    expect(peer('session-a')?.owed).toBe('answer@1')
    expect(peer('session-a')?.listener).toBe(false)
  })

  test('an offerer whose presence frame was merely LATE is a player again the tick it shows up', async () => {
    boot()
    voiceTick(1000)
    hearVoice('session-z', { v: VOICE_PROTOCOL, sdp: { epoch: 1, sdp: SDP('sendrecv'), type: 'offer' }, to: 'session-me' })
    await settle()
    expect(peer('session-z')?.listener).toBe(true) // not in the roster: assumed a listener
    seePeer('session-z', {}, 1100)
    voiceTick(1200)
    expect(peer('session-z')?.listener).toBe(false)
  })
})

describe('dropping in is a HANDOVER, not a hang-up', () => {
  /**
   * The viewer was hearing the players from the editor and clicks JUMP IN. The
   * game's startVoice finds the listen session active and must adopt it: same
   * RTCPeerConnection (the audio keeps flowing), m-line flipped to sendrecv, the
   * mic the veil acquired put on the sender, and a fresh offer ONE EPOCH ABOVE
   * anything the far side has recorded, so it renegotiates instead of dropping
   * the offer as a duplicate.
   */
  test('startVoice adopts a CONNECTED listen link in place and re-offers sendrecv', async () => {
    const bus = bootListener()
    seePeer('session-z')
    voiceTick(1000)
    await settle()
    const pc = FakePeerConnection.made[0]!
    pc.transceivers[0]!.mid = '0' // the offer/answer associated our m-line
    pc.goLive()
    hearVoice('session-z', { v: VOICE_PROTOCOL, sdp: anAnswer(1), to: 'session-me' })
    await settle()
    voiceTick(1100)
    expect(peer('session-z')?.state).toBe('connected')
    expect(peer('session-z')?.applied).toBe(1)

    await enableMic() // the veil's click, a moment before the game
    expect(startVoice({ getLocalPosition: () => [0, 0, 0] })).toBe(true)
    await settle()

    expect(voiceDebug().listen).toBe(false)
    expect(voiceActive()).toBe(true)
    expect(FakePeerConnection.made.length).toBe(1) // no new connection was built
    expect(pc.closed).toBe(false)
    expect(pc.transceivers[0]!.direction).toBe('sendrecv')
    expect(pc.transceivers[0]!.sender.track).toBe(mic.track)
    expect(peer('session-z')?.owed).toBe('offer@2')
    // The renegotiation goes out at once, and no longer as a listener.
    voiceTick(1200)
    const frame = lastDescriptionTo(bus, 'session-z')
    expect(frame?.sdp).toEqual(expect.objectContaining({ type: 'offer', epoch: 2 }))
    expect(frame?.listen).toBeUndefined()
    // Their answer lands on the live connection: connected again, no restart.
    hearVoice('session-z', { v: VOICE_PROTOCOL, sdp: anAnswer(2, 'sendrecv'), to: 'session-me' })
    await settle()
    voiceTick(1300)
    expect(peer('session-z')?.state).toBe('connected')
    expect(voiceConnectedCount()).toBe(1)
    expect(voiceDebug().counters.restarts).toBe(0)
    // The game owns the call now: the spectator's cleanup cannot hang it up.
    stopVoiceListen()
    expect(voiceActive()).toBe(true)
  })

  test('a link still mid-handshake at the handover is rebuilt as a player link, not stacked — ONE EPOCH UP', async () => {
    bootListener()
    seePeer('session-z')
    voiceTick(1000)
    await settle() // recvonly offer@1 owed, nothing connected
    expect(startVoice({ getLocalPosition: () => [0, 0, 0] })).toBe(true)
    await settle()
    expect(FakePeerConnection.made[0]!.closed).toBe(true)
    expect(FakePeerConnection.made.length).toBe(2)
    expect(FakePeerConnection.made[1]!.transceivers[0]!.direction).toBe('sendrecv')
    // ABOVE the offer that was in flight: the far side may already have applied
    // it, and would drop a second epoch 1 as a duplicate on every tick.
    expect(peer('session-z')?.owed).toBe('offer@2')
    voiceTick(1100)
    await settle()
    expect(FakePeerConnection.made.length).toBe(2) // the tick did not build a third
  })

  test('a mid-handshake link whose offer WAS ANSWERED is rebuilt above that epoch — and we offer, whatever the ids sort as', async () => {
    // The listener offered epoch 1 to 'session-a'; the answer landed (applied on
    // both sides) but ICE never reached 'connected' — the viewer clicked JUMP IN
    // two seconds after the pill appeared. A rebuilt link that started at zero
    // would offer epoch 1 again, dropped by the far side as a duplicate on every
    // tick; and since 'session-a' sorts BELOW us, a player link would sit
    // waiting for ITS offer while it holds an answer to a connection we closed.
    bootListener()
    seePeer('session-a')
    voiceTick(1000)
    await settle()
    hearVoice('session-a', { v: VOICE_PROTOCOL, sdp: anAnswer(1), to: 'session-me' })
    await settle()
    expect(peer('session-a')?.applied).toBe(1)
    expect(peer('session-a')?.state).toBe('negotiating')
    const stale = FakePeerConnection.made[0]!
    expect(startVoice({ getLocalPosition: () => [0, 0, 0] })).toBe(true)
    await settle()
    expect(stale.closed).toBe(true)
    expect(FakePeerConnection.made.length).toBe(2)
    expect(FakePeerConnection.made[1]!.transceivers[0]!.direction).toBe('sendrecv')
    expect(voiceOffererIsUs('session-me', 'session-a')).toBe(false) // the ordering would have had us wait
    expect(peer('session-a')?.owed).toBe('offer@2')
    // Their stale answer@1, still being re-sent, no longer matches and is dropped.
    const dropped = voiceDebug().counters.dropped
    hearVoice('session-a', { v: VOICE_PROTOCOL, sdp: anAnswer(1), to: 'session-me' })
    await settle()
    expect(voiceDebug().counters.dropped).toBe(dropped + 1)
    expect(peer('session-a')?.owed).toBe('offer@2')
    // Their answer to the live offer completes the rebuilt pair.
    hearVoice('session-a', { v: VOICE_PROTOCOL, sdp: anAnswer(2, 'sendrecv'), to: 'session-me' })
    await settle()
    expect(peer('session-a')?.owed).toBeNull()
    expect(peer('session-a')?.applied).toBe(2)
    expect(voiceDebug().counters.restarts).toBe(0)
  })

  test('the listener’s give-up list does not follow it into the game', async () => {
    // A viewer refused past a player's listener cap is never answered: four
    // timeouts later it has written that player off — AS A LISTENER. Dropping
    // in, it is a player the room wants; a fresh startVoice would start clean,
    // and so must the handover, or that pair is silent for the whole game.
    bootListener()
    seePeer('session-z')
    let now = 1000
    voiceTick(now)
    await settle()
    for (let attempt = 0; attempt < (MAX_NEGOTIATION_ATTEMPTS + 2) * 2; attempt++) {
      const next = now + NEGOTIATION_TIMEOUT_MS + 200
      runUntil(next, now)
      now = next
      await settle()
    }
    expect(voiceDebug().unreachable).toEqual(['session-z'])
    expect(voiceDebug().peers).toEqual([])
    expect(startVoice({ getLocalPosition: () => [0, 0, 0] })).toBe(true)
    expect(voiceDebug().unreachable).toEqual([])
    seePeer('session-z', {}, now + 50)
    voiceTick(now + 100)
    await settle()
    expect(peer('session-z')?.listener).toBe(false)
    expect(peer('session-z')?.owed).toBe('offer@1')
  })

  test('a former ANSWERER offers ABOVE the epoch the far side applied from us', async () => {
    // The player (lower id) offered to the listener — we answered epoch 3, so
    // the far side holds applied=3 for us. Re-using 1 would be dropped forever.
    bootListener()
    seePeer('session-a')
    voiceTick(1000)
    await settle()
    hearVoice('session-a', { v: VOICE_PROTOCOL, sdp: { epoch: 3, sdp: SDP('sendrecv'), type: 'offer' }, to: 'session-me' })
    await settle()
    const pc = FakePeerConnection.made[0]!
    pc.goLive()
    hearVoice('session-a', { v: VOICE_PROTOCOL, ack: { 'session-me': 3 } })
    voiceTick(1100)
    expect(peer('session-a')?.applied).toBe(3)
    expect(startVoice({ getLocalPosition: () => [0, 0, 0] })).toBe(true)
    await settle()
    expect(peer('session-a')?.owed).toBe('offer@4')
    expect(pc.transceivers.find((transceiver) => transceiver.mid !== null)?.direction).toBe('sendrecv')
  })

  test('the PLAYER side of a handover: the re-offer is answered on the live connection and reads connected again', async () => {
    boot()
    voiceTick(1000)
    hearVoice('viewer-1', { v: VOICE_PROTOCOL, listen: true, sdp: recvonlyOffer(1), to: 'session-me' })
    await settle()
    const pc = FakePeerConnection.made[0]!
    pc.goLive()
    hearVoice('viewer-1', { v: VOICE_PROTOCOL, listen: true, ack: { 'session-me': 1 } })
    voiceTick(1100)
    expect(peer('viewer-1')?.state).toBe('connected')
    // They dropped in: a sendrecv offer, one epoch up, no listen flag.
    hearVoice('viewer-1', { v: VOICE_PROTOCOL, sdp: { epoch: 2, sdp: SDP('sendrecv'), type: 'offer' }, to: 'session-me' })
    await settle()
    expect(peer('viewer-1')?.owed).toBe('answer@2')
    // A renegotiation on a live connection never reads as disconnected: the pair
    // can hear each other the whole way through it (negotiationState).
    expect(peer('viewer-1')?.state).toBe('connected')
    hearVoice('viewer-1', { v: VOICE_PROTOCOL, ack: { 'session-me': 2 } })
    voiceTick(1200)
    expect(peer('viewer-1')?.state).toBe('connected')
    expect(pc.closed).toBe(false)
    expect(voiceDebug().counters.restarts).toBe(0)
  })
})

describe('a full room does not grow by a handover', () => {
  /**
   * A listener is outside the roster and never counts against the room, so a
   * full room happily carries one. The moment it drops in it IS in the roster —
   * and past the cap. Both sides used to keep the pair: the players' frames
   * refreshed its links (proof of life), the sendrecv re-offer was answered, and
   * a 7th person was two-way in a 6-person call with its own pill reading
   * OUTSIDE THE CALL and the players' still counting it as a listener.
   */
  test('PLAYER side: the listener is closed the tick its presence lands, and its re-sent offer is not answered', async () => {
    boot() // 'session-me'; five ids below us fill the room WITH us
    for (const id of ['session-a', 'session-b', 'session-c', 'session-d', 'session-e']) seePeer(id)
    voiceTick(1000)
    await settle()
    expect(voiceDebug().peers.length).toBe(MAX_VOICE_PEERS - 1)
    hearVoice('session-v', { v: VOICE_PROTOCOL, listen: true, sdp: recvonlyOffer(1), to: 'session-me' })
    await settle()
    const viewerPc = FakePeerConnection.made[MAX_VOICE_PEERS - 1]!
    viewerPc.goLive()
    voiceTick(1100)
    expect(voiceListenerCount()).toBe(1)
    expect(voiceDebug().peers.length).toBe(MAX_VOICE_PEERS)
    // It drops in: presence says 'game', the room says no.
    seePeer('session-v', {}, 1200)
    voiceTick(1300)
    expect(peer('session-v')).toBeUndefined()
    expect(viewerPc.closed).toBe(true)
    expect(voiceListenerCount()).toBe(0)
    expect(voiceDebug().peers.length).toBe(MAX_VOICE_PEERS - 1)
    // Its sendrecv re-offer, still being re-sent, does not build a link per tick.
    const made = FakePeerConnection.made.length
    const dropped = voiceDebug().counters.dropped
    hearVoice('session-v', { v: VOICE_PROTOCOL, sdp: { epoch: 2, sdp: SDP('sendrecv'), type: 'offer' }, to: 'session-me' })
    await settle()
    expect(FakePeerConnection.made.length).toBe(made)
    expect(peer('session-v')).toBeUndefined()
    expect(voiceDebug().counters.dropped).toBe(dropped + 1)
  })

  test('EXCLUDED side: the viewer hangs up on the players it was hearing — OUTSIDE THE CALL is now true', async () => {
    bootListener()
    const room = ['session-a', 'session-b', 'session-c', 'session-d', 'session-e', 'session-f']
    for (const id of room) seePeer(id)
    voiceTick(1000)
    await settle()
    expect(voiceDebug().peers.length).toBe(MAX_VOICE_PEERS)
    FakePeerConnection.made[0]!.goLive() // one pair live: the handover would have kept it
    voiceTick(1100)
    expect(voiceConnectedCount()).toBe(1)
    expect(startVoice({ getLocalPosition: () => [0, 0, 0] })).toBe(true)
    await settle()
    expect(voiceDebug().peers).toEqual([])
    expect(FakePeerConnection.made.length).toBe(MAX_VOICE_PEERS) // nothing rebuilt, nothing re-offered
    expect(FakePeerConnection.made.every((pc) => pc.closed)).toBe(true)
    voiceTick(1200)
    expect(voiceExcluded()).toBe(true)
    expect(voiceDebug().peers).toEqual([])
  })
})

describe('the proximity mix follows the DRAWN body', () => {
  test('fresh drawn position wins over the snapshot; a stale one yields to it', async () => {
    boot()
    seePeer('session-z', { p: [0, 0, 1] })
    voiceTick(1000)
    await settle()
    FakePeerConnection.made[0]!.goLive()
    setVoiceMode('proximity')
    voiceTick(1100)
    expect(FakeAudio.made[0]!.volume).toBe(1) // the snapshot is a metre away
    // The renderer draws the peer far away (interpolation lag, a teleport in
    // flight): the voice follows the picture.
    const remote = getRemotes().get('session-z')!
    remote.drawnX = 0
    remote.drawnY = 0
    remote.drawnZ = VOICE_FAR_M + 10
    remote.drawnAt = 1200
    voiceTick(1200)
    expect(FakeAudio.made[0]!.volume).toBe(0)
    // Nothing drawn for a while (culled, hidden tab): back to the snapshot.
    voiceTick(1200 + DRAWN_FRESH_MS + 100)
    expect(FakeAudio.made[0]!.volume).toBe(1)
  })
})

describe('voiceListenerCount', () => {
  test('counts CONNECTED listeners only — the pill must not claim an audience mid-handshake', async () => {
    boot()
    voiceTick(1000)
    expect(voiceListenerCount()).toBe(0)
    hearVoice('viewer-1', { v: VOICE_PROTOCOL, listen: true, sdp: recvonlyOffer(), to: 'session-me' })
    await settle()
    expect(voiceListenerCount()).toBe(0) // answering, not connected
    FakePeerConnection.made[0]!.goLive()
    voiceTick(1100)
    expect(voiceListenerCount()).toBe(1)
    // A player on the same call is not a listener.
    seePeer('session-z', {}, 1100)
    voiceTick(1200)
    await settle()
    FakePeerConnection.made[1]!.goLive()
    voiceTick(1300)
    expect(voiceConnectedCount()).toBe(2)
    expect(voiceListenerCount()).toBe(1)
  })
})
