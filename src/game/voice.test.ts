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
import { type LocalPose, startPresence, stopPresence } from './presence'
import type { PresenceFrame } from './presence-interp'
import {
  DISCONNECT_GRACE_MS,
  MAX_NEGOTIATION_ATTEMPTS,
  micState,
  NEGOTIATION_TIMEOUT_MS,
  PEER_ABSENT_MS,
  resetVoice,
  selfTalking,
  setVoiceMode,
  startVoice,
  stopVoice,
  talkingPeers,
  TALKING_STALE_MS,
  TICK_STALL_MS,
  voiceActive,
  voiceDebug,
  voiceMode,
  voiceTick,
} from './voice'
import { VOICE_FAR_M, VOICE_PROTOCOL, type VoiceFrame } from './voice-policy'

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

class FakePeerConnection {
  static made: FakePeerConnection[] = []
  static rejectSetRemote = false
  /** Accept setLocalDescription and hand back nothing — the silent abandon. */
  static swallowLocalDescription = false

  connectionState = 'new'
  iceConnectionState = 'new'
  iceGatheringState = 'complete'
  signalingState = 'stable'
  localDescription: { sdp: string; type: string } | null = null
  remoteDescriptions: Array<{ sdp: string; type: string }> = []
  closed = false
  rollbacks = 0
  transceivers: Array<{ direction: string; sender: FakeSender }> = []
  private listeners = new Map<string, Set<(event: unknown) => void>>()

  constructor(public config: { iceServers?: unknown[] }) {
    FakePeerConnection.made.push(this)
  }

  addTransceiver(kind: string, init: { direction: string }) {
    const sender: FakeSender = {
      track: null,
      replaced: [],
      replaceTrack: async (track: unknown) => {
        sender.track = track
        sender.replaced.push(track)
      },
    }
    const transceiver = { direction: init.direction, kind, sender }
    this.transceivers.push(transceiver)
    return transceiver
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
  FakePeerConnection.rejectSetRemote = false
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

  test('with nothing owed it stays on the heartbeat', async () => {
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
    voiceTick(1100)
    voiceTick(1200)
    expect(sent(bus).length).toBe(before)
    voiceTick(1300) // ticks % SIGNAL_EVERY_TICKS === 0
    expect(sent(bus).length).toBe(before + 1)
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
