import { describe, expect, test } from 'bun:test'
import type { voiceDebug, voiceInternals, VoicePeerStats } from './voice'
import {
  LISTEN_BLOCKED_TEXT,
  ListenPill,
  type ListenPillArgs,
  listenPillClickable,
  listenPillText,
  type MicPillArgs,
  micPillText,
  micPillTone,
  VoiceOverlay,
  voiceOverlayText,
  voiceOverlayWanted,
} from './voice-overlay'
import { MAX_VOICE_PEERS } from './voice-policy'

/**
 * THE PILL. Testers must read at a glance: am I being heard, am I muted, was I
 * refused, are we connected, am I outside the call, is a peer unreachable, and
 * why the other tab on this laptop is silent. Each of those is one row here.
 */

const base: MicPillArgs = {
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

const pill = (over: Partial<MicPillArgs>) => micPillText({ ...base, ...over })

describe('micPillText', () => {
  test('alone with the mic off: nothing to offer, nobody to offer it to', () => {
    expect(pill({})).toBeNull()
  })

  test("alone, every OTHER state shows — it is the answer to the prompt they just saw", () => {
    expect(pill({ mic: 'asking' })).toBe('ALLOW THE MIC ↑')
    expect(pill({ mic: 'live' })).toBe('● MIC ON')
    expect(pill({ mic: 'live', talking: true })).toBe('● TALKING')
    expect(pill({ mic: 'muted' })).toBe('✕ MUTED — M TO TALK')
    expect(pill({ mic: 'denied' })).toBe('MIC BLOCKED — LISTENING')
    expect(pill({ mic: 'unavailable' })).toBe('NO MIC — LISTENING')
  })

  test('with company and the mic off, the key is the invitation', () => {
    expect(pill({ peers: 1 })).toBe('M — TALK  ·  CONNECTING…')
    expect(pill({ peers: 1, connected: 1 })).toBe('M — TALK  ·  1 ON VOICE')
  })

  test('connection state rides along: connecting, then N on voice', () => {
    expect(pill({ mic: 'live', peers: 2 })).toBe('● MIC ON  ·  CONNECTING…')
    expect(pill({ mic: 'live', peers: 2, connected: 2 })).toBe('● MIC ON  ·  2 ON VOICE')
    // While the browser is asking, nothing else competes for the eye.
    expect(pill({ mic: 'asking', peers: 2 })).toBe('ALLOW THE MIC ↑')
  })

  test('speaking, unreachable and same-device suffixes, in that order', () => {
    expect(pill({ mic: 'live', peers: 3, connected: 2, talkers: 1, unreachable: 1 })).toBe(
      '● MIC ON  ·  2 ON VOICE  ·  1 SPEAKING  ·  1 UNREACHABLE',
    )
    expect(pill({ mic: 'live', peers: 1, connected: 1, sameDevice: 1 })).toBe(
      '● MIC ON  ·  1 ON VOICE  ·  SAME DEVICE — MUTED',
    )
  })

  test('every peer unreachable or same-device: no CONNECTING… lie', () => {
    expect(pill({ mic: 'live', peers: 1, unreachable: 1 })).toBe('● MIC ON  ·  1 UNREACHABLE')
  })

  test('a refused autoplay says what to do', () => {
    expect(pill({ mic: 'live', peers: 1, connected: 1, outputBlocked: true })).toBe(
      '● MIC ON  ·  1 ON VOICE  ·  SOUND BLOCKED — CLICK',
    )
  })

  test('outside the call overrides everything', () => {
    expect(pill({ mic: 'live', peers: 7, excluded: true })).toBe(`OUTSIDE THE CALL (${MAX_VOICE_PEERS} MAX)`)
  })

  test('a viewer LISTENING from the editor is named, even to a player who is alone', () => {
    // A listener publishes no presence, so `peers` is 0 and nothing else on this
    // pill would mention them: being heard unknowingly is the state to avoid.
    expect(pill({ listeners: 1 })).toBe('M — TALK  ·  1 LISTENING FROM THE EDITOR')
    expect(pill({ mic: 'live', peers: 1, connected: 1, talkers: 1, listeners: 2 })).toBe(
      '● MIC ON  ·  1 ON VOICE  ·  1 SPEAKING  ·  2 LISTENING FROM THE EDITOR',
    )
    // Zero, or an older caller that does not pass the field, is the old pill.
    expect(pill({ listeners: 0 })).toBeNull()
    expect(pill({})).toBeNull()
  })
})

describe('micPillTone', () => {
  test('green when heard, brighter while talking, amber asking, red muted/denied, neutral otherwise', () => {
    expect(micPillTone('live', false)).toBe('#7ee081')
    expect(micPillTone('live', true)).toBe('#a8ffab')
    expect(micPillTone('asking', false)).toBe('#e8c229')
    expect(micPillTone('muted', false)).toBe('#ff6b5e')
    expect(micPillTone('denied', false)).toBe('#ff6b5e')
    expect(micPillTone('off', false)).toBe('rgba(255,255,255,0.78)')
    expect(micPillTone('unavailable', false)).toBe('rgba(255,255,255,0.78)')
  })
})

describe('voiceOverlayText', () => {
  type Debug = ReturnType<typeof voiceDebug>
  type Internals = ReturnType<typeof voiceInternals>

  const debug: Debug = {
    active: true,
    listen: false,
    mode: 'squad',
    mic: 'live',
    talking: false,
    supported: true,
    peers: [
      {
        sessionId: 'B-session',
        name: 'Bob',
        state: 'connected',
        connection: 'connected',
        ice: 'completed',
        epoch: 1,
        owed: null,
        applied: 1,
        gain: 1,
        talking: true,
        attempts: 0,
        hasTrack: true,
        step: 'offer:owed',
        error: null,
        absentMs: 0,
        acked: true,
        sameDevice: false,
        localRelay: false,
        listener: false,
      },
    ],
    unreachable: ['C-session'],
    ice: { source: 'default', servers: 3, relay: false },
    sameDevice: 0,
    excluded: false,
    outputBlocked: false,
    counters: {
      offersSent: 3,
      answersSent: 0,
      offersApplied: 0,
      answersApplied: 1,
      dropped: 2,
      tooLarge: 0,
      restarts: 0,
      given_up: 1,
      notSent: 0,
      abandoned: 0,
      threw: 0,
      reaped: 0,
      stalls: 0,
      pcFailed: 0,
      listenersRefused: 0,
    },
    ticks: 42,
  }
  const internals: Internals = [
    {
      sessionId: 'B-session',
      signaling: 'stable',
      connection: 'connected',
      ice: 'completed',
      transceivers: [{ mid: '0', direction: 'sendrecv', currentDirection: 'sendrecv' }],
      receivers: [{ kind: 'audio', muted: false, readyState: 'live' }],
      senders: [{ hasTrack: true, kind: 'audio', enabled: true }],
      elementHasStream: true,
      elementTracks: 1,
      elementPaused: false,
    },
  ]
  const stats: VoicePeerStats[] = [
    { sessionId: 'B-session', bytesReceived: 40960, bytesSent: 2048, audioLevel: 0.31, rttMs: 12, pair: 'host' },
  ]

  test('header, one line per peer, counters, the unreachable list', () => {
    const text = voiceOverlayText(debug, internals, stats)
    const lines = text.split('\n')
    expect(lines[0]).toContain('mic=live')
    expect(lines[0]).toContain('ice=default/3 relay=false')
    expect(lines[0]).toContain('sameDevice=0')
    expect(lines[0]).toContain('ticks=42')
    expect(lines[1]).toContain('Bob connected/connected/completed')
    expect(lines[1]).toContain('step=offer:owed')
    expect(lines[1]).toContain('talk=t')
    expect(lines[1]).toContain('acked=t')
    expect(lines[1]).toContain('pair=host')
    expect(lines[1]).toContain('rx=40.0kB')
    expect(lines[1]).toContain('lvl=0.31')
    expect(lines[1]).toContain('rtt=12')
    expect(lines[1]).toContain('dir=sendrecv')
    expect(lines[1]).toContain('rxMuted=false')
    expect(lines[2]).toContain('offers 3/0 answers 0/1 dropped=2')
    expect(lines[2]).toContain('given_up=1')
    expect(lines[3]).toBe('unreachable: C-session')
  })

  test('no stats yet reads as unknown, not as zero', () => {
    const text = voiceOverlayText(debug, [], [])
    expect(text).toContain('pair=? rx=?kB lvl=? rtt=?')
    expect(text).toContain('dir=? rxMuted=?')
  })

  test('same-device and relay flags are called out on the peer line', () => {
    const flagged: Debug = {
      ...debug,
      peers: [{ ...debug.peers[0]!, sameDevice: true, localRelay: true }],
    }
    const line = voiceOverlayText(flagged, internals, stats).split('\n')[1]
    expect(line).toContain('SAME-DEVICE')
    expect(line).toContain('relay-cand')
  })

  test('no peers says so', () => {
    expect(voiceOverlayText({ ...debug, peers: [], unreachable: [] }, [], []).split('\n')[1]).toBe('(no peers)')
  })

  test('a listen session, a listener peer and refused listeners are all visible', () => {
    const listening: Debug = {
      ...debug,
      listen: true,
      peers: [{ ...debug.peers[0]!, listener: true }],
      counters: { ...debug.counters, listenersRefused: 2 },
    }
    const lines = voiceOverlayText(listening, internals, stats).split('\n')
    expect(lines[0]).toContain('mode=squad LISTEN')
    expect(lines[1]).toContain('LISTENER')
    expect(lines[2]).toContain('listenersRefused=2')
    // Absent by default: the ordinary dump does not grow a field nobody hit.
    expect(voiceOverlayText(debug, internals, stats)).not.toContain('listenersRefused')
    expect(voiceOverlayText(debug, internals, stats).split('\n')[0]).not.toContain('LISTEN')
  })
})

describe('voiceOverlayWanted', () => {
  test('?voiceDebug=1 and nothing else', () => {
    expect(voiceOverlayWanted('?voiceDebug=1')).toBe(true)
    expect(voiceOverlayWanted('?boots=drop&voiceDebug=1')).toBe(true)
    expect(voiceOverlayWanted('?voiceDebug=0')).toBe(false)
    expect(voiceOverlayWanted('')).toBe(false)
  })
})

describe('VoiceOverlay without a document', () => {
  test('mount, pill, debug and unmount are all no-ops headless', () => {
    const overlay = new VoiceOverlay()
    expect(() => {
      overlay.mount({} as HTMLElement)
      overlay.pill('● MIC ON', '#7ee081')
      overlay.debug('x')
      overlay.unmount()
    }).not.toThrow()
    expect(overlay.pillContent()).toBe('')
  })
})

// ── The listen pill (editor viewers) ─────────────────────────────────────────

describe('listenPillText', () => {
  const quiet: ListenPillArgs = { blocked: false, connected: 0, talkers: 0, players: 0 }
  const listen = (over: Partial<ListenPillArgs>) => listenPillText({ ...quiet, ...over })

  test('nobody in the game: nothing at all', () => {
    expect(listen({})).toBeNull()
    expect(listen({ blocked: true })).toBeNull()
    expect(listen({ connected: 1 })).toBeNull()
  })

  test('a refused autoplay is THE line, and it wins over everything', () => {
    expect(listen({ players: 1, blocked: true })).toBe(LISTEN_BLOCKED_TEXT)
    expect(listen({ players: 2, blocked: true, connected: 2, talkers: 1 })).toBe(LISTEN_BLOCKED_TEXT)
    expect(LISTEN_BLOCKED_TEXT).toMatch(/CLICK/)
  })

  test('nothing before a link is up — no CONNECTING… on a page that never asked', () => {
    expect(listen({ players: 2 })).toBeNull()
  })

  test('a live link reads LISTENING · N ON VOICE, speakers appended', () => {
    expect(listen({ players: 2, connected: 2 })).toBe('🔈 LISTENING · 2 ON VOICE')
    expect(listen({ players: 2, connected: 1, talkers: 1 })).toBe('🔈 LISTENING · 1 ON VOICE  ·  1 SPEAKING')
  })

  test('only the blocked line is a button', () => {
    expect(listenPillClickable(LISTEN_BLOCKED_TEXT)).toBe(true)
    expect(listenPillClickable('🔈 LISTENING · 2 ON VOICE')).toBe(false)
    expect(listenPillClickable(null)).toBe(false)
  })
})

describe('ListenPill without a document', () => {
  test('mount, set, content and unmount are all no-ops headless', () => {
    let resumed = 0
    const pill = new ListenPill(() => {
      resumed++
    })
    expect(() => {
      pill.mount()
      pill.set(LISTEN_BLOCKED_TEXT)
      pill.set(null)
      pill.unmount()
    }).not.toThrow()
    expect(pill.content()).toBe('')
    expect(resumed).toBe(0)
  })
})
