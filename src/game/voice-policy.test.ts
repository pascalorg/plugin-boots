import { describe, expect, test } from 'bun:test'
import {
  MAX_ACK_ENTRIES,
  MAX_ICE_CANDIDATES,
  MAX_SDP_CHARS,
  MAX_VOICE_PEERS,
  mixGain,
  nextSignalTarget,
  proximityGain,
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
