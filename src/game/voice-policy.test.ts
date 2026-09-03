import { describe, expect, test } from 'bun:test'
import { DRAWN_FRESH_MS as PVP_DRAWN_FRESH_MS } from './pvp-damage'
import {
  acceptsListener,
  DEFAULT_ICE_SERVERS,
  DRAWN_FRESH_MS,
  iceHasRelay,
  keyCap,
  listenTargets,
  MAX_ACK_ENTRIES,
  MAX_ICE_CANDIDATES,
  MAX_ICE_CREDENTIAL_CHARS,
  MAX_ICE_SERVERS,
  MAX_ICE_URLS_PER_SERVER,
  MAX_LISTENERS_PER_PLAYER,
  MAX_SDP_CHARS,
  MAX_VOICE_PEERS,
  mergeIceServers,
  MIC_KEY,
  mixGain,
  nextSignalTarget,
  pickPeerPosition,
  proximityGain,
  readIceServers,
  readVoiceFrame,
  sdpIsAudioOnly,
  talkGate,
  trimSdpToBudget,
  VAD_CLOSE_RMS,
  VAD_HANG_MS,
  VAD_OPEN_RMS,
  VOICE_FAR_M,
  VOICE_NEAR_M,
  voiceOffererIsUs,
  voicePeersFor,
  voiceRoom,
  voiceShouldOffer,
} from './voice-policy'

/**
 * VOICE POLICY, headless.
 *
 * Everything here is a decision that fails SILENTLY in the real thing: a
 * validator that lets a video m-line through, a trim that keeps the candidates
 * that only work on a LAN, a mesh cap that is symmetric on paper and not in
 * fact. None of those throw, none of them log, and all of them look exactly
 * like "voice chat is flaky".
 */

/** A minimal but realistic audio-only offer. */
const AUDIO_SDP = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'c=IN IP4 0.0.0.0',
  'a=rtcp:9 IN IP4 0.0.0.0',
  'a=candidate:1 1 udp 2113937151 192.168.1.20 51234 typ host',
  'a=candidate:2 1 udp 1677729535 81.2.3.4 51234 typ srflx raddr 192.168.1.20 rport 51234',
  'a=mid:0',
  'a=sendrecv',
  'a=rtpmap:111 opus/48000/2',
  '',
].join('\r\n')

const withLines = (lines: string[]): string =>
  AUDIO_SDP.replace('a=mid:0', [...lines, 'a=mid:0'].join('\r\n'))

describe('sdpIsAudioOnly', () => {
  test('accepts one audio m-line', () => {
    expect(sdpIsAudioOnly(AUDIO_SDP)).toBe(true)
  })

  test('REFUSES video — a peer must not make our tab decode their camera', () => {
    expect(sdpIsAudioOnly(AUDIO_SDP.replace('m=audio 9', 'm=video 9'))).toBe(false)
    expect(sdpIsAudioOnly(`${AUDIO_SDP}m=video 9 UDP/TLS/RTP/SAVPF 96\r\n`)).toBe(false)
  })

  test('REFUSES a data channel — no file transfer, no NAT probing surface', () => {
    expect(sdpIsAudioOnly(`${AUDIO_SDP}m=application 9 DTLS/SCTP 5000\r\n`)).toBe(false)
  })

  test('refuses anything that is not an SDP at all', () => {
    for (const bad of ['', 'hello', 'V=0\r\nm=audio 9 x 111\r\n', null, 42, {}, []]) {
      expect(sdpIsAudioOnly(bad)).toBe(false)
    }
  })

  test('refuses an SDP with no media section', () => {
    expect(sdpIsAudioOnly('v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n')).toBe(false)
  })

  test('accepts bare-LF line endings (some stacks emit them)', () => {
    expect(sdpIsAudioOnly(AUDIO_SDP.replaceAll('\r\n', '\n'))).toBe(true)
  })

  test('caps candidate lines — every candidate is an address we will send to', () => {
    const one = 'a=candidate:1 1 udp 2113937151 10.0.0.1 1 typ host'
    expect(sdpIsAudioOnly(withLines(Array.from({ length: MAX_ICE_CANDIDATES - 2 }, () => one)))).toBe(
      true,
    )
    expect(sdpIsAudioOnly(withLines(Array.from({ length: MAX_ICE_CANDIDATES + 1 }, () => one)))).toBe(
      false,
    )
  })

  test('caps total length', () => {
    expect(sdpIsAudioOnly(`v=0\r\nm=audio 9 x 111\r\na=x:${'y'.repeat(MAX_SDP_CHARS)}`)).toBe(false)
  })
})

describe('readVoiceFrame', () => {
  const offer = { type: 'offer' as const, epoch: 1, sdp: AUDIO_SDP }

  test('a hello frame is just the version', () => {
    expect(readVoiceFrame({ v: 1 })).toEqual({ v: 1 })
  })

  test('normalizes a full frame and drops nothing it checked', () => {
    const frame = readVoiceFrame({
      v: 1,
      to: 'session_peer',
      sdp: offer,
      ack: { session_peer: 3 },
      talking: true,
      mode: 'proximity',
    })
    expect(frame).toEqual({
      v: 1,
      to: 'session_peer',
      sdp: offer,
      ack: { session_peer: 3 },
      talking: true,
      mode: 'proximity',
    })
  })

  test('the output is OURS, not the caller’s object', () => {
    const hostile: Record<string, unknown> = { v: 1, to: 'session_peer', talking: false }
    const frame = readVoiceFrame(hostile)
    expect(frame).not.toBe(hostile)
    // …and nothing we did not validate rode along.
    hostile.surprise = 'x'
    expect(Object.keys(frame ?? {}).sort()).toEqual(['talking', 'to', 'v'])
  })

  test('AN UNADDRESSED DESCRIPTION IS DROPPED', () => {
    // The bus has no addressing: `to` is the only thing that says a description
    // was meant for us. Without it every peer in the lobby would apply the same
    // offer at once and every one of those connections would be wrong.
    expect(readVoiceFrame({ v: 1, sdp: offer })).toBeNull()
  })

  test('refuses a wrong or missing protocol version', () => {
    expect(readVoiceFrame({ v: 2, to: 'session_peer' })).toBeNull()
    expect(readVoiceFrame({ to: 'session_peer' })).toBeNull()
  })

  test('refuses a description whose sdp is not audio-only', () => {
    expect(
      readVoiceFrame({
        v: 1,
        to: 'session_peer',
        sdp: { ...offer, sdp: `${AUDIO_SDP}m=video 9 x 96\r\n` },
      }),
    ).toBeNull()
  })

  test('refuses a bad epoch or a bad type', () => {
    for (const epoch of [0, -1, 1.5, Number.NaN, '1', null]) {
      expect(readVoiceFrame({ v: 1, to: 'p', sdp: { ...offer, epoch } })).toBeNull()
    }
    expect(readVoiceFrame({ v: 1, to: 'p', sdp: { ...offer, type: 'pranswer' } })).toBeNull()
  })

  test('refuses a session id that is empty or absurd', () => {
    expect(readVoiceFrame({ v: 1, to: '' })).toBeNull()
    expect(readVoiceFrame({ v: 1, to: 'x'.repeat(200) })).toBeNull()
    expect(readVoiceFrame({ v: 1, to: 7 })).toBeNull()
  })

  test('an ack map is bounded and filtered, not refused', () => {
    const ack: Record<string, unknown> = {}
    for (let i = 0; i < MAX_ACK_ENTRIES + 20; i++) ack[`session_${i}`] = i + 1
    ack.bad = 'nope'
    ack[''] = 4
    const frame = readVoiceFrame({ v: 1, ack })
    expect(Object.keys(frame?.ack ?? {}).length).toBe(MAX_ACK_ENTRIES)
    expect(frame?.ack?.bad).toBeUndefined()
  })

  test('refuses wrong types on the flags', () => {
    expect(readVoiceFrame({ v: 1, talking: 'yes' })).toBeNull()
    expect(readVoiceFrame({ v: 1, mode: 'whisper' })).toBeNull()
  })

  test('is total — no input throws', () => {
    const cyclic: Record<string, unknown> = { v: 1 }
    cyclic.self = cyclic
    for (const input of [null, undefined, 0, '', [], cyclic, new Map()]) {
      expect(() => readVoiceFrame(input)).not.toThrow()
    }
  })
})

describe('trimSdpToBudget', () => {
  const candidate = (type: string, n: number) =>
    `a=candidate:${n} 1 udp 2113937151 10.0.0.${n} ${1000 + n} typ ${type}`

  test('an SDP that fits is returned untouched', () => {
    expect(trimSdpToBudget(AUDIO_SDP, MAX_SDP_CHARS)).toBe(AUDIO_SDP)
  })

  test('KEEPS A REPRESENTATIVE OF EVERY TYPE, drops the interface spam', () => {
    // The realistic bloat: a laptop with Wi-Fi, Ethernet, a VPN and a container
    // bridge gathers one host candidate per interface, and all but a couple are
    // useless — while the single srflx line is what lets the call cross a NAT.
    const lines = [
      ...Array.from({ length: 20 }, (_, i) => candidate('host', i)),
      candidate('srflx', 90),
      candidate('relay', 91),
    ]
    const fat = withLines(lines)
    const trimmed = trimSdpToBudget(fat, fat.length - 400)
    expect(trimmed).not.toBeNull()
    expect(trimmed).toContain('typ srflx')
    expect(trimmed).toContain('typ relay')
    const hosts = (trimmed?.match(/typ host/g) ?? []).length
    expect(hosts).toBeGreaterThanOrEqual(1)
    expect(hosts).toBeLessThan(20)
    expect(trimmed!.length).toBeLessThanOrEqual(fat.length - 400)
  })

  test('trimming never disturbs a non-candidate line', () => {
    const fat = withLines(Array.from({ length: 30 }, (_, i) => candidate('host', i)))
    const trimmed = trimSdpToBudget(fat, fat.length - 600) ?? ''
    for (const line of ['v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=rtpmap:111 opus/48000/2']) {
      expect(trimmed).toContain(line)
    }
    // Order preserved: the m-line still precedes its attributes.
    expect(trimmed.indexOf('m=audio')).toBeLessThan(trimmed.indexOf('a=rtpmap:111'))
  })

  test('the result is still a valid audio-only description', () => {
    const fat = withLines(Array.from({ length: 30 }, (_, i) => candidate('host', i)))
    const trimmed = trimSdpToBudget(fat, 900)
    if (trimmed !== null) expect(sdpIsAudioOnly(trimmed)).toBe(true)
  })

  test('refuses rather than truncating when nothing will fit', () => {
    // A half-sent description is worse than an unsent one: the peer would apply
    // it, fail to connect, and have no reason to ask again.
    expect(trimSdpToBudget(AUDIO_SDP, 50)).toBeNull()
  })

  test('preserves the line ending the stack used', () => {
    const lf = withLines(Array.from({ length: 30 }, (_, i) => candidate('host', i))).replaceAll(
      '\r\n',
      '\n',
    )
    const trimmed = trimSdpToBudget(lf, lf.length - 500) ?? ''
    expect(trimmed).not.toContain('\r')
  })
})

describe('voiceOffererIsUs', () => {
  test('exactly one side of a pair offers', () => {
    expect(voiceOffererIsUs('session_a', 'session_b')).toBe(true)
    expect(voiceOffererIsUs('session_b', 'session_a')).toBe(false)
  })

  test('we never call ourselves', () => {
    expect(voiceOffererIsUs('session_a', 'session_a')).toBe(false)
  })

  test('every pair in a room agrees, with no round trip', () => {
    const ids = ['session_z', 'session_a', 'session_m', 'session_0', 'session_A']
    for (const x of ids) {
      for (const y of ids) {
        if (x === y) continue
        // Exactly one of the two believes it is the offerer — that is what
        // removes glare instead of recovering from it.
        expect(voiceOffererIsUs(x, y) !== voiceOffererIsUs(y, x)).toBe(true)
      }
    }
  })
})

describe('nextSignalTarget', () => {
  test('rotates through the pending peers', () => {
    const pending = ['a', 'b', 'c']
    expect(nextSignalTarget(pending, null)).toBe('a')
    expect(nextSignalTarget(pending, 'a')).toBe('b')
    expect(nextSignalTarget(pending, 'c')).toBe('a')
  })

  test('a peer that left does not stall the rotation', () => {
    expect(nextSignalTarget(['b', 'c'], 'a')).toBe('b')
  })

  test('nothing pending is nothing to send', () => {
    expect(nextSignalTarget([], null)).toBeNull()
    expect(nextSignalTarget([], 'a')).toBeNull()
  })

  test('a single peer is re-sent to, because frames are re-sent until acked', () => {
    expect(nextSignalTarget(['a'], 'a')).toBe('a')
  })
})

describe('proximityGain', () => {
  test('full inside NEAR, silent at FAR', () => {
    expect(proximityGain(0)).toBe(1)
    expect(proximityGain(VOICE_NEAR_M)).toBe(1)
    expect(proximityGain(VOICE_FAR_M)).toBe(0)
    expect(proximityGain(VOICE_FAR_M + 100)).toBe(0)
  })

  test('CONTINUOUS AT BOTH ENDS — a stepping gain is heard as a click', () => {
    expect(proximityGain(VOICE_NEAR_M + 0.001)).toBeCloseTo(1, 3)
    expect(proximityGain(VOICE_FAR_M - 0.001)).toBeCloseTo(0, 4)
  })

  test('monotone decreasing across the whole range', () => {
    let previous = Number.POSITIVE_INFINITY
    for (let d = 0; d <= VOICE_FAR_M + 5; d += 0.25) {
      const gain = proximityGain(d)
      expect(gain).toBeLessThanOrEqual(previous + 1e-12)
      expect(gain).toBeGreaterThanOrEqual(0)
      expect(gain).toBeLessThanOrEqual(1)
      previous = gain
    }
  })

  test('a non-finite distance is silence, never NaN', () => {
    // A NaN gain does not make one peer quiet: it poisons the WebAudio node and
    // silences that branch of the graph for the rest of the session.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(Number.isFinite(proximityGain(bad))).toBe(true)
    }
    expect(proximityGain(Number.NaN)).toBe(0)
  })
})

describe('mixGain', () => {
  test('squad is a party call — distance does not matter', () => {
    expect(mixGain('squad', 0)).toBe(1)
    expect(mixGain('squad', 500)).toBe(1)
  })

  test('proximity is the spatial mix', () => {
    expect(mixGain('proximity', 0)).toBe(1)
    expect(mixGain('proximity', VOICE_FAR_M)).toBe(0)
  })
})

describe('talkGate', () => {
  const gate = (rms: number, wasTalking: boolean, msSinceOverOpen = 10_000) =>
    talkGate({ rms, wasTalking, msSinceOverOpen })

  test('opens over the open threshold', () => {
    expect(gate(VAD_OPEN_RMS, false)).toBe(true)
    expect(gate(VAD_OPEN_RMS - 0.001, false)).toBe(false)
  })

  test('HYSTERESIS: it takes less to stay open than to open', () => {
    // One threshold makes the indicator strobe on every syllable.
    const between = (VAD_OPEN_RMS + VAD_CLOSE_RMS) / 2
    expect(gate(between, false)).toBe(false)
    expect(gate(between, true)).toBe(true)
  })

  test('the hang time carries a talker through the pause between words', () => {
    expect(gate(0, true, VAD_HANG_MS - 1)).toBe(true)
    expect(gate(0, true, VAD_HANG_MS)).toBe(false)
  })

  test('silence with no history is not talking', () => {
    expect(gate(0, false, 0)).toBe(false)
  })

  test('a non-finite level is not talking', () => {
    expect(gate(Number.NaN, true, 0)).toBe(false)
  })
})

describe('voiceRoom / voicePeersFor', () => {
  const roster = (n: number) =>
    Array.from({ length: n }, (_, i) => `session_${String(i).padStart(2, '0')}`)

  test('a two-person lobby is one connection each way', () => {
    expect(voicePeersFor('session_a', ['session_a', 'session_b'])).toEqual(['session_b'])
    expect(voicePeersFor('session_b', ['session_a', 'session_b'])).toEqual(['session_a'])
  })

  test('the cap is on the ROOM, so every pair agrees', () => {
    // The bug this shape exists to avoid: cap each peer's own list and A wants B
    // while B has no interest in A, leaving one half-open connection, no audio
    // and nothing logged. Checked over a roster well past the cap.
    const all = roster(MAX_VOICE_PEERS + 4)
    for (const me of all) {
      for (const peer of voicePeersFor(me, all)) {
        expect(voicePeersFor(peer, all)).toContain(me)
      }
    }
  })

  test('never more than the cap of connections', () => {
    const all = roster(MAX_VOICE_PEERS + 6)
    for (const me of all) {
      expect(voicePeersFor(me, all).length).toBeLessThanOrEqual(MAX_VOICE_PEERS - 1)
    }
  })

  test('past the cap the highest ids are outside voice entirely', () => {
    const all = roster(MAX_VOICE_PEERS + 2)
    const last = all[all.length - 1]!
    expect(voiceRoom(all)).not.toContain(last)
    expect(voicePeersFor(last, all)).toEqual([])
  })

  test('never ourselves, whatever the roster says', () => {
    expect(voicePeersFor('session_a', ['session_a', 'session_a', 'session_b'])).toEqual([
      'session_b',
    ])
  })

  test('junk ids are filtered, not fatal', () => {
    expect(voicePeersFor('session_a', ['session_a', '', 'session_b', 'x'.repeat(500)])).toEqual([
      'session_b',
    ])
  })

  test('roster order does not change the room', () => {
    const all = roster(MAX_VOICE_PEERS + 3)
    const shuffled = [...all].reverse()
    expect(voiceRoom(shuffled)).toEqual(voiceRoom(all))
  })
})

/**
 * THE ICE SEAM. A relay's credentials arrive from a host global or a same-origin
 * route — places we did not write — and whatever survives here is handed to the
 * browser as addresses it will send packets to. So the validator is total, both
 * vendor shapes are accepted, half a credential is no credential, and nothing
 * can make the STUN defaults disappear.
 */
describe('readIceServers', () => {
  const turn = { urls: 'turn:relay.example:3478', username: 'u', credential: 'p' }
  // What comes out is OURS: `urls` is always an array.
  const normalized = { urls: ['turn:relay.example:3478'], username: 'u', credential: 'p' }

  test('accepts a bare array (metered.ca) and both Cloudflare shapes', () => {
    expect(readIceServers([turn])).toEqual([normalized])
    expect(readIceServers({ iceServers: [turn] })).toEqual([normalized])
    expect(readIceServers({ iceServers: turn })).toEqual([normalized])
  })

  test('urls may be one string or a short array, all stun/turn', () => {
    const many = {
      urls: ['turn:relay.example:3478?transport=udp', 'turns:relay.example:5349?transport=tcp'],
      username: 'u',
      credential: 'p',
    }
    expect(readIceServers([many])).toEqual([many])
    expect(readIceServers([{ urls: ['stun:a.example', 'http://evil.example'] }])).toBeNull()
    expect(readIceServers([{ urls: 'ws://evil.example' }])).toBeNull()
    expect(readIceServers([{ urls: 'turn:relay.example:3478?transport=sctp', username: 'u', credential: 'p' }])).toBeNull()
    // Too many addresses is truncated, not thrown away: the first N, provider order.
    const flood = Array.from({ length: MAX_ICE_URLS_PER_SERVER + 3 }, (_, i) => `stun:s${i}.example`)
    expect(readIceServers([{ urls: flood }])).toEqual([{ urls: flood.slice(0, MAX_ICE_URLS_PER_SERVER) }])
  })

  test("the REAL Cloudflare answer — one object, eight urls — survives whole, relay and all", () => {
    // generate-ice-servers hands back a single server with every transport
    // (stun 3478/53, turn udp 3478/53, turn tcp 3478/80, turns 5349/443). This
    // is the shape the round-2 host route will forward; a per-server url cap
    // under 8 would drop the relay wholesale and the seam would be a no-op.
    const cloudflare = {
      iceServers: {
        urls: [
          'stun:stun.cloudflare.com:3478',
          'stun:stun.cloudflare.com:53',
          'turn:turn.cloudflare.com:3478?transport=udp',
          'turn:turn.cloudflare.com:53?transport=udp',
          'turn:turn.cloudflare.com:3478?transport=tcp',
          'turn:turn.cloudflare.com:80?transport=tcp',
          'turns:turn.cloudflare.com:5349?transport=tcp',
          'turns:turn.cloudflare.com:443?transport=tcp',
        ],
        username: 'g'.repeat(64),
        credential: 'c'.repeat(86),
      },
    }
    expect(MAX_ICE_URLS_PER_SERVER).toBeGreaterThanOrEqual(8)
    const read = readIceServers(cloudflare)
    expect(read).toEqual([cloudflare.iceServers])
    expect(iceHasRelay(read!)).toBe(true)
    expect(iceHasRelay(mergeIceServers(DEFAULT_ICE_SERVERS, read!))).toBe(true)
  })

  test('a relay WITHOUT both credential halves is dropped whole — the browser would throw on it', () => {
    // RTCPeerConnection({iceServers}) raises InvalidAccessError for a turn:/turns:
    // URL missing username or credential; passed through credential-less, one
    // such entry would kill every link. So it never reaches the browser.
    expect(readIceServers([{ urls: 'turn:r.example', username: 'u' }])).toBeNull()
    expect(readIceServers([{ urls: 'turn:r.example', credential: 'p' }])).toBeNull()
    expect(readIceServers([{ urls: 'turn:r.example', username: 1, credential: 'p' }])).toBeNull()
    expect(readIceServers([{ urls: 'turn:r.example', username: 'u', credential: 'x'.repeat(600) }])).toBeNull()
    expect(readIceServers([{ urls: ['stun:s.example', 'turns:r.example:443?transport=tcp'] }])).toBeNull()
    // The rest of the list is unaffected by one dropped relay.
    expect(readIceServers([{ urls: 'turn:r.example' }, { urls: 'stun:s.example' }])).toEqual([
      { urls: ['stun:s.example'] },
    ])
  })

  test('SIXTEEN urls on one server survive whole; the seventeenth is truncated, not fatal', () => {
    // A coturn behind two hostnames × (stun, turn udp, turn tcp, turns) × two
    // ports is sixteen addresses on one credential pair. Under the cap, nothing
    // is lost; over it, the tail goes and the relay stays.
    expect(MAX_ICE_URLS_PER_SERVER).toBe(16)
    const sixteen = Array.from({ length: 16 }, (_, i) =>
      i % 2 === 0 ? `turn:r${i}.example:3478?transport=udp` : `turns:r${i}.example:443?transport=tcp`,
    )
    const read = readIceServers([{ urls: sixteen, username: 'u', credential: 'p' }])
    expect(read).toEqual([{ urls: sixteen, username: 'u', credential: 'p' }])
    const seventeen = [...sixteen, 'stun:tail.example']
    expect(readIceServers([{ urls: seventeen, username: 'u', credential: 'p' }])).toEqual([
      { urls: sixteen, username: 'u', credential: 'p' },
    ])
  })

  test('credentials must be NON-EMPTY strings within the bound — empty is "missing"', () => {
    expect(readIceServers([{ urls: 'turn:r.example', username: '', credential: 'p' }])).toBeNull()
    expect(readIceServers([{ urls: 'turn:r.example', username: 'u', credential: '' }])).toBeNull()
    const long = 'x'.repeat(MAX_ICE_CREDENTIAL_CHARS)
    expect(readIceServers([{ urls: 'turn:r.example', username: long, credential: long }])).toEqual([
      { urls: ['turn:r.example'], username: long, credential: long },
    ])
    expect(readIceServers([{ urls: 'turn:r.example', username: `${long}x`, credential: 'p' }])).toBeNull()
  })

  test('ONE malformed entry costs that entry, never the list', () => {
    const good = { urls: 'turn:r.example:3478', username: 'u', credential: 'p' }
    const list = [
      { urls: ['stun:a.example', 'http://evil.example'] }, // one bad address condemns the entry
      { urls: 'turn:half.example', username: 'u' }, // half a credential pair
      { urls: 'turn:empty.example', username: '', credential: 'p' },
      'stun:not-an-object',
      null,
      good,
      { urls: 'stun:fine.example' },
    ]
    expect(readIceServers(list)).toEqual([
      { urls: ['turn:r.example:3478'], username: 'u', credential: 'p' },
      { urls: ['stun:fine.example'] },
    ])
    expect(readIceServers({ iceServers: list })).toEqual([
      { urls: ['turn:r.example:3478'], username: 'u', credential: 'p' },
      { urls: ['stun:fine.example'] },
    ])
  })

  test('the STUN fallback is untouched by any of this', () => {
    expect(readIceServers([...DEFAULT_ICE_SERVERS])).toEqual(
      DEFAULT_ICE_SERVERS.map((server) => ({ urls: [server.urls as string] })),
    )
    expect(iceHasRelay(DEFAULT_ICE_SERVERS)).toBe(false)
  })

  test('a STUN entry never needs credentials; half a pair on it is dropped, the entry kept', () => {
    expect(readIceServers([{ urls: 'stun:s.example', username: 'u' }])).toEqual([{ urls: ['stun:s.example'] }])
    expect(readIceServers([{ urls: 'stun:s.example', username: 'u', credential: 7 }])).toEqual([
      { urls: ['stun:s.example'] },
    ])
  })

  test('drops junk entries, truncates to the cap, null when nothing survives', () => {
    const list = Array.from({ length: MAX_ICE_SERVERS + 4 }, (_, i) => ({ urls: `stun:s${i}.example` }))
    expect(readIceServers(list)?.length).toBe(MAX_ICE_SERVERS)
    expect(readIceServers([null, 1, 'stun:x', {}, { urls: 7 }])).toBeNull()
    for (const input of [null, undefined, 0, '', 'turn:x', {}, { iceServers: 'turn:x' }]) {
      expect(readIceServers(input)).toBeNull()
    }
  })

  test('is total — a cyclic object does not throw', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.iceServers = cyclic
    expect(() => readIceServers(cyclic)).not.toThrow()
  })
})

describe('mergeIceServers', () => {
  test('base first, no duplicate URL sets, capped', () => {
    const extra = [{ urls: 'turn:r.example', username: 'u', credential: 'p' }, { ...DEFAULT_ICE_SERVERS[0]! }]
    const merged = mergeIceServers(DEFAULT_ICE_SERVERS, extra)
    expect(merged.slice(0, DEFAULT_ICE_SERVERS.length)).toEqual([...DEFAULT_ICE_SERVERS])
    expect(merged.length).toBe(DEFAULT_ICE_SERVERS.length + 1)
    expect(iceHasRelay(merged)).toBe(true)
    expect(iceHasRelay(DEFAULT_ICE_SERVERS)).toBe(false)
    const flood = Array.from({ length: 20 }, (_, i) => ({ urls: `stun:s${i}.example` }))
    expect(mergeIceServers(DEFAULT_ICE_SERVERS, flood).length).toBe(MAX_ICE_SERVERS)
  })

  test('the defaults are three STUN servers from two operators', () => {
    expect(DEFAULT_ICE_SERVERS.length).toBe(3)
    expect(readIceServers([...DEFAULT_ICE_SERVERS])?.length).toBe(3)
  })
})

/**
 * THE COUNT BUDGET. Our receiver refuses more than MAX_ICE_CANDIDATES lines, and
 * 24 lines are far under the character cap — so a description that fits on
 * length alone could still be dropped by the peer. The trim must squeeze the
 * count too, or adding a relay to the ICE set silences multi-interface laptops.
 */
describe('trimSdpToBudget squeezes the candidate COUNT, not only the length', () => {
  const candidate = (type: string, n: number) =>
    `a=candidate:${n} 1 udp 2113937151 10.0.0.${n} ${1000 + n} typ ${type}`

  test('30 candidates across 4 types under the char cap come back readable', () => {
    const lines: string[] = []
    for (let i = 0; i < 12; i++) lines.push(candidate('host', i))
    for (let i = 0; i < 8; i++) lines.push(candidate('srflx', 20 + i))
    for (let i = 0; i < 6; i++) lines.push(candidate('prflx', 40 + i))
    for (let i = 0; i < 4; i++) lines.push(candidate('relay', 60 + i))
    const fat = withLines(lines)
    expect(fat.length).toBeLessThan(MAX_SDP_CHARS)
    expect(sdpIsAudioOnly(fat)).toBe(false) // our own receiver would refuse it
    const trimmed = trimSdpToBudget(fat, MAX_SDP_CHARS)
    expect(trimmed).not.toBeNull()
    const kept = (trimmed?.match(/a=candidate:/g) ?? []).length
    expect(kept).toBeLessThanOrEqual(MAX_ICE_CANDIDATES)
    for (const type of ['host', 'srflx', 'prflx', 'relay']) expect(trimmed).toContain(`typ ${type}`)
    expect(sdpIsAudioOnly(trimmed)).toBe(true)
  })

  test('exactly the cap is left alone', () => {
    // AUDIO_SDP already carries two candidate lines of its own.
    const lines = Array.from({ length: MAX_ICE_CANDIDATES - 2 }, (_, i) => candidate('host', i))
    const sdp = withLines(lines)
    expect(trimSdpToBudget(sdp, MAX_SDP_CHARS)).toBe(sdp)
  })
})

describe('the mic key', () => {
  test('one constant, one caption', () => {
    expect(MIC_KEY).toBe('KeyM')
    expect(keyCap(MIC_KEY)).toBe('M')
    expect(keyCap('Digit4')).toBe('4')
  })
})

// ── Listeners ────────────────────────────────────────────────────────────────

describe('the listen flag on the wire', () => {
  test('optional, boolean, normalized; anything else refuses the frame', () => {
    expect(readVoiceFrame({ v: 1 })?.listen).toBeUndefined()
    expect(readVoiceFrame({ v: 1, listen: true })).toEqual({ v: 1, listen: true })
    expect(readVoiceFrame({ v: 1, listen: false })).toEqual({ v: 1, listen: false })
    expect(readVoiceFrame({ v: 1, listen: 'yes' })).toBeNull()
    expect(readVoiceFrame({ v: 1, listen: 1 })).toBeNull()
  })

  test('a frame a listener sends today reads on a validator that ignores the field', () => {
    // What an older pin does with `listen`: nothing. The rest of the frame must
    // still be exactly what it was, so the offer inside it is answered.
    const frame = readVoiceFrame({
      v: 1,
      listen: true,
      to: 'player',
      sdp: { type: 'offer', epoch: 1, sdp: AUDIO_SDP },
      talking: false,
    })
    expect(frame?.to).toBe('player')
    expect(frame?.sdp?.type).toBe('offer')
    expect(frame?.talking).toBe(false)
  })
})

describe('voiceShouldOffer — who calls whom when a listener is present', () => {
  test('a LISTENER always offers, whatever the ids sort as', () => {
    expect(voiceShouldOffer({ mySessionId: 'z', peerSessionId: 'a', meListening: true, peerInGame: true })).toBe(true)
    expect(voiceShouldOffer({ mySessionId: 'a', peerSessionId: 'z', meListening: true, peerInGame: true })).toBe(true)
    // …but never to itself.
    expect(voiceShouldOffer({ mySessionId: 'a', peerSessionId: 'a', meListening: true, peerInGame: true })).toBe(false)
  })

  test('a PLAYER never offers to a peer outside the game — that is a listener, and it will call', () => {
    expect(voiceShouldOffer({ mySessionId: 'a', peerSessionId: 'z', meListening: false, peerInGame: false })).toBe(false)
    expect(voiceShouldOffer({ mySessionId: 'z', peerSessionId: 'a', meListening: false, peerInGame: false })).toBe(false)
  })

  test('between players the total order stands, so exactly one side offers', () => {
    const ab = voiceShouldOffer({ mySessionId: 'a', peerSessionId: 'b', meListening: false, peerInGame: true })
    const ba = voiceShouldOffer({ mySessionId: 'b', peerSessionId: 'a', meListening: false, peerInGame: true })
    expect(ab).toBe(voiceOffererIsUs('a', 'b'))
    expect(ba).toBe(voiceOffererIsUs('b', 'a'))
    expect(ab !== ba).toBe(true)
  })

  test('a listener never offers AUDIO: the policy is one-directional by construction', () => {
    // The listener offers the connection; what it offers to SEND is nothing
    // (voice.ts negotiates its m-line recvonly). The two sides of a
    // listener/player pair therefore never both offer, and the player never
    // initiates — so a listener link can never be turned around into a sender
    // by the peer.
    expect(voiceShouldOffer({ mySessionId: 'viewer', peerSessionId: 'player', meListening: true, peerInGame: true })).toBe(true)
    expect(voiceShouldOffer({ mySessionId: 'player', peerSessionId: 'viewer', meListening: false, peerInGame: false })).toBe(false)
  })
})

describe('listenTargets — a listener hears the players’ room', () => {
  test('the same MAX_VOICE_PEERS lowest ids the players themselves form', () => {
    const players = ['g', 'c', 'a', 'e', 'b', 'f', 'd', 'h']
    expect(listenTargets(players)).toEqual(voiceRoom(players))
    expect(listenTargets(players).length).toBe(MAX_VOICE_PEERS)
    expect(listenTargets(players)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
  })

  test('junk and duplicates are filtered, an empty game is nobody to hear', () => {
    expect(listenTargets([])).toEqual([])
    expect(listenTargets(['a', 'a', '', 'x'.repeat(200)])).toEqual(['a'])
  })
})

describe('acceptsListener — a player carries a bounded number of listeners', () => {
  test('under the cap yes, at the cap no', () => {
    expect(MAX_LISTENERS_PER_PLAYER).toBeGreaterThan(0)
    for (let n = 0; n < MAX_LISTENERS_PER_PLAYER; n++) expect(acceptsListener(n)).toBe(true)
    expect(acceptsListener(MAX_LISTENERS_PER_PLAYER)).toBe(false)
    expect(acceptsListener(MAX_LISTENERS_PER_PLAYER + 5)).toBe(false)
  })
})

// ── Where a peer is ──────────────────────────────────────────────────────────

describe('pickPeerPosition — the voice fades where the eye sees the peer', () => {
  const snapshot = { x: 1, y: 2, z: 3 }
  const drawn = { drawnX: 10, drawnY: 20, drawnZ: 30, drawnAt: 1000 }

  test('a FRESH drawn body wins over the newest snapshot', () => {
    expect(pickPeerPosition(drawn, snapshot, 1000)).toEqual([10, 20, 30])
    expect(pickPeerPosition(drawn, snapshot, 1000 + DRAWN_FRESH_MS - 1)).toEqual([10, 20, 30])
  })

  test('a STALE drawn body yields to the snapshot — the avatar is not being drawn', () => {
    expect(pickPeerPosition(drawn, snapshot, 1000 + DRAWN_FRESH_MS)).toEqual([1, 2, 3])
    expect(pickPeerPosition(drawn, snapshot, 99_000)).toEqual([1, 2, 3])
  })

  test('never drawn (drawnAt 0) is the snapshot; neither is null', () => {
    const never = { ...drawn, drawnAt: 0 }
    expect(pickPeerPosition(never, snapshot, 0)).toEqual([1, 2, 3])
    expect(pickPeerPosition(never, null, 0)).toBeNull()
    expect(pickPeerPosition(drawn, null, 99_000)).toBeNull()
  })

  test('the freshness window is the rule the task states: strictly under 250 ms — and the SAME window PvP hit-reg uses', () => {
    expect(DRAWN_FRESH_MS).toBe(250)
    // Two modules answer "is the drawn body the picture anyone is looking at";
    // voice-policy is the pure half and cannot import pvp-damage's runtime, so
    // the value is pinned equal here instead. Change one, this fails.
    expect(DRAWN_FRESH_MS).toBe(PVP_DRAWN_FRESH_MS)
  })
})
