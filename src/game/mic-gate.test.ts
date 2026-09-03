import { afterEach, describe, expect, test } from 'bun:test'
import type { CollabBus } from './net'
import {
  ASK_LABEL,
  beginEntry,
  cachedMicPermission,
  currentEntryPlan,
  noteMicPermission,
  planEntry,
  READY_LABEL,
  readMicPermission,
  voicePossible,
} from './mic-gate'
import { micState, OUTPUT_POOL_SIZE, resetVoice, saveMicPref } from './voice'

/**
 * THE MIC GATE. The prompt must be a click the player controls, must never open
 * inside enterGame's fullscreen sequence, must survive reloads as a choice, and
 * must never fire when there is nobody to talk to. Every branch of that is a
 * pure decision (planEntry) or a two-click flow against fakes (beginEntry).
 */

const g = globalThis as {
  __pascalCollabBus?: CollabBus
  RTCPeerConnection?: unknown
  MediaStream?: unknown
  Audio?: unknown
  navigator?: unknown
  localStorage?: unknown
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
  playCalls = 0
  constructor() {
    FakeAudio.made.push(this)
  }
  async play() {
    this.playCalls++
  }
  pause() {}
}

type FakeTrack = { kind: string; enabled: boolean; stopped: boolean; stop: () => void }

const media = {
  calls: 0,
  grant: true,
  hold: null as Promise<void> | null,
  /** The last track handed out, so a test can see it stopped. */
  track: null as FakeTrack | null,
}

function installWorld(): void {
  g.__pascalCollabBus = {
    version: 1,
    projectId: 'p',
    sessionId: 's',
    clientId: 'c',
    userId: 'u',
    publish: () => 'sent',
    subscribe: () => () => {},
    getParticipants: () => [],
    onParticipants: () => () => {},
  }
  g.RTCPeerConnection = class {}
  g.MediaStream = FakeMediaStream
  g.Audio = FakeAudio
  FakeAudio.made = []
  media.calls = 0
  media.grant = true
  media.hold = null
  media.track = null
  g.navigator = {
    mediaDevices: {
      getUserMedia: async () => {
        media.calls++
        if (media.hold) await media.hold
        if (!media.grant) throw new DOMException('nope', 'NotAllowedError')
        const track: FakeTrack = {
          kind: 'audio',
          enabled: true,
          stopped: false,
          stop() {
            track.stopped = true
          },
        }
        media.track = track
        return new FakeMediaStream([track])
      },
    },
  }
}

function fakeStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed))
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

function withStorage(storage: unknown): () => void {
  const real = Object.getOwnPropertyDescriptor(g, 'localStorage')
  Object.defineProperty(g, 'localStorage', { configurable: true, value: storage })
  return () => {
    if (real) Object.defineProperty(g, 'localStorage', real)
    else Object.defineProperty(g, 'localStorage', { configurable: true, value: undefined })
  }
}

type FakeUi = {
  labels: Array<{ text: string; busy: boolean }>
  entered: number
  setLabel: (text: string, busy: boolean) => void
  enter: () => void
}

function fakeUi(): FakeUi {
  const ui: FakeUi = {
    labels: [],
    entered: 0,
    setLabel: (text, busy) => ui.labels.push({ text, busy }),
    enter: () => {
      ui.entered++
    },
  }
  return ui
}

const settle = async (rounds = 8) => {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

afterEach(() => {
  resetVoice()
  noteMicPermission('unknown')
  delete g.__pascalCollabBus
  g.RTCPeerConnection = undefined
  g.MediaStream = undefined
  g.Audio = undefined
  g.navigator = undefined
})

describe('planEntry', () => {
  test('no voice possible → silent, whatever else is true', () => {
    for (const pref of ['on', 'off'] as const) {
      for (const permission of ['granted', 'prompt', 'denied', 'unknown'] as const) {
        expect(planEntry({ pref, permission, voicePossible: false })).toBe('enter-silent')
      }
    }
  })

  test("pref 'off' → silent; a denied browser → silent", () => {
    for (const permission of ['granted', 'prompt', 'denied', 'unknown'] as const) {
      expect(planEntry({ pref: 'off', permission, voicePossible: true })).toBe('enter-silent')
    }
    expect(planEntry({ pref: 'on', permission: 'denied', voicePossible: true })).toBe('enter-silent')
  })

  test('granted → mic in the same click; prompt or unknown → ask first', () => {
    expect(planEntry({ pref: 'on', permission: 'granted', voicePossible: true })).toBe('enter-with-mic')
    expect(planEntry({ pref: 'on', permission: 'prompt', voicePossible: true })).toBe('ask-first')
    expect(planEntry({ pref: 'on', permission: 'unknown', voicePossible: true })).toBe('ask-first')
  })
})

describe('readMicPermission', () => {
  test('the permissions API answers directly', async () => {
    for (const state of ['granted', 'prompt', 'denied'] as const) {
      g.navigator = {
        mediaDevices: { getUserMedia: async () => null },
        permissions: { query: async () => ({ state }) },
      }
      expect(await readMicPermission()).toBe(state)
    }
  })

  test('no descriptor (Firefox): a LABELLED input means granted before', async () => {
    g.navigator = {
      mediaDevices: {
        getUserMedia: async () => null,
        enumerateDevices: async () => [{ kind: 'audioinput', label: 'Built-in Microphone' }],
      },
      permissions: {
        query: async () => {
          throw new TypeError('no such permission')
        },
      },
    }
    expect(await readMicPermission()).toBe('granted')
  })

  test('unlabelled inputs, or no way to tell → unknown; no mediaDevices → denied', async () => {
    g.navigator = {
      mediaDevices: {
        getUserMedia: async () => null,
        enumerateDevices: async () => [{ kind: 'audioinput', label: '' }],
      },
    }
    expect(await readMicPermission()).toBe('unknown')
    g.navigator = { mediaDevices: { getUserMedia: async () => null } }
    expect(await readMicPermission()).toBe('unknown')
    g.navigator = {}
    expect(await readMicPermission()).toBe('denied')
    g.navigator = undefined
    expect(await readMicPermission()).toBe('denied')
  })
})

describe('beginEntry', () => {
  test('voicePossible needs the bus, WebRTC and a mic API', () => {
    installWorld()
    expect(voicePossible()).toBe(true)
    delete g.__pascalCollabBus
    expect(voicePossible()).toBe(false)
  })

  test('TWO CLICKS when the browser has to ask: the first is the prompt, the second enters', async () => {
    installWorld()
    noteMicPermission('prompt')
    expect(currentEntryPlan()).toBe('ask-first')
    const ui = fakeUi()

    beginEntry(ui)
    // The click became the dialog. The game is NOT entered — nothing can collide
    // with fullscreen — and the button says what is happening.
    expect(ui.labels).toEqual([{ text: ASK_LABEL, busy: true }])
    expect(ui.entered).toBe(0)
    expect(media.calls).toBe(1)
    expect(micState()).toBe('asking')
    await settle()
    expect(micState()).toBe('live')
    expect(ui.labels.at(-1)).toEqual({ text: READY_LABEL, busy: false })
    expect(cachedMicPermission()).toBe('granted')

    beginEntry(ui)
    expect(ui.entered).toBe(1)
    expect(media.calls).toBe(1) // the live track is reused, no second dialog
    expect(micState()).toBe('live')
  })

  test('ONE click when already granted: mic and entry in the same gesture', async () => {
    installWorld()
    noteMicPermission('granted')
    const ui = fakeUi()
    beginEntry(ui)
    expect(ui.entered).toBe(1)
    expect(ui.labels).toEqual([]) // nothing to explain
    expect(media.calls).toBe(1)
    expect(micState()).toBe('asking') // in flight, inside the click
    await settle()
    expect(micState()).toBe('live')
  })

  test("pref 'off' enters silently and never touches getUserMedia", () => {
    installWorld()
    noteMicPermission('granted')
    const restore = withStorage(fakeStorage({ 'boots.voice.mic.1': 'off' }))
    try {
      const ui = fakeUi()
      beginEntry(ui)
      expect(ui.entered).toBe(1)
      expect(media.calls).toBe(0)
      expect(micState()).toBe('off')
    } finally {
      restore()
    }
  })

  test('MIC OFF chosen AFTER the prompt brought the mic up: the track is let go, not carried in', async () => {
    // The veil lets the toggle flip while the button reads PLAY. Without the
    // release, the live track would ride into the game, be swapped into every
    // sender, and the pill would say MIC ON against an explicit off.
    installWorld()
    noteMicPermission('prompt')
    const restore = withStorage(fakeStorage())
    try {
      const ui = fakeUi()
      beginEntry(ui)
      await settle()
      expect(micState()).toBe('live')
      const track = media.track!
      saveMicPref('off')
      expect(currentEntryPlan()).toBe('enter-silent')
      beginEntry(ui)
      expect(ui.entered).toBe(1)
      expect(micState()).toBe('off')
      expect(track.stopped).toBe(true)
      expect(media.calls).toBe(1)
    } finally {
      restore()
    }
  })

  test('MIC OFF while the dialog is still open: the late grant is stopped, not kept', async () => {
    installWorld()
    noteMicPermission('prompt')
    const restore = withStorage(fakeStorage())
    let open: (() => void) | null = null
    media.hold = new Promise<void>((resolve) => {
      open = resolve
    })
    try {
      const ui = fakeUi()
      beginEntry(ui)
      expect(micState()).toBe('asking')
      saveMicPref('off')
      // Another entry surface (the sidebar, once it runs through beginEntry)
      // enters silently while the veil's dialog is still up.
      beginEntry(fakeUi())
      expect(micState()).toBe('off')
      open!()
      await settle()
      expect(media.track?.stopped).toBe(true)
      expect(micState()).toBe('off')
    } finally {
      restore()
    }
  })

  test('a denied mic is NOT cleared by a silent entry — the pill keeps its reason', async () => {
    installWorld()
    media.grant = false
    noteMicPermission('prompt')
    const ui = fakeUi()
    beginEntry(ui)
    await settle()
    expect(micState()).toBe('denied')
    beginEntry(ui)
    expect(ui.entered).toBe(1)
    expect(micState()).toBe('denied')
  })

  test('no bus: enter silently, no prompt — there is nobody to talk to', () => {
    installWorld()
    delete g.__pascalCollabBus
    noteMicPermission('prompt')
    const ui = fakeUi()
    beginEntry(ui)
    expect(ui.entered).toBe(1)
    expect(media.calls).toBe(0)
  })

  test('a refusal is learned: the next click enters silently, listening', async () => {
    installWorld()
    media.grant = false
    noteMicPermission('prompt')
    const ui = fakeUi()
    beginEntry(ui)
    expect(ui.entered).toBe(0)
    await settle()
    expect(cachedMicPermission()).toBe('denied')
    expect(micState()).toBe('denied')
    expect(ui.labels.at(-1)).toEqual({ text: READY_LABEL, busy: false })
    beginEntry(ui)
    expect(ui.entered).toBe(1)
    expect(media.calls).toBe(1)
    expect(micState()).toBe('denied') // the pill will say MIC BLOCKED — LISTENING
  })

  test('the outputs are primed in EVERY plan — hearing does not depend on speaking', () => {
    installWorld()
    noteMicPermission('granted')
    const restore = withStorage(fakeStorage({ 'boots.voice.mic.1': 'off' }))
    try {
      beginEntry(fakeUi())
      expect(FakeAudio.made.length).toBe(OUTPUT_POOL_SIZE)
      expect(FakeAudio.made.every((element) => element.playCalls === 1)).toBe(true)
    } finally {
      restore()
    }
  })
})
