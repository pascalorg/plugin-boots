import { describe, expect, test } from 'bun:test'
import {
  HINT_ATTR,
  HINT_EVENT_HOLD_MS,
  HINT_NAME_CAP,
  hintSuppressed,
  presenceEventLine,
  shouldStopOnCleanup,
  spectatorHintText,
  WATCH_POLL_MS,
} from './spectator-hint'

/**
 * The spectator layer's pure seams (spectator-hint.ts, re-exported by
 * spectator.tsx). The component itself needs a React tree + a DOM; everything
 * it DECIDES is pinned here: the pill copy, the join/leave line, the drop-in
 * handoff rule (do not stop on a phase flip to 'game'), and the
 * never-two-Jump-in-buttons suppression.
 */

describe('spectatorHintText', () => {
  test('nobody → null (no pill)', () => {
    expect(spectatorHintText([])).toBeNull()
  })

  test('one name is a sentence', () => {
    expect(spectatorHintText(['Alice'])).toBe('Alice is playing — ⏵ JUMP IN')
  })

  test('up to the cap the names are spelled out', () => {
    expect(HINT_NAME_CAP).toBe(3)
    expect(spectatorHintText(['Alice', 'Bob'])).toBe('Alice, Bob playing — ⏵ JUMP IN')
    expect(spectatorHintText(['Alice', 'Bob', 'Carol'])).toBe('Alice, Bob, Carol playing — ⏵ JUMP IN')
  })

  test('past the cap it is a count', () => {
    expect(spectatorHintText(['A', 'B', 'C', 'D'])).toBe('4 people playing — ⏵ JUMP IN')
  })

  test('every non-null variant carries the JUMP IN call to action', () => {
    for (const names of [['A'], ['A', 'B'], ['A', 'B', 'C', 'D', 'E']]) {
      expect(spectatorHintText(names)).toContain('JUMP IN')
    }
  })
})

describe('presenceEventLine', () => {
  test('joined / left', () => {
    expect(presenceEventLine({ type: 'join', name: 'Bob' })).toBe('Bob joined')
    expect(presenceEventLine({ type: 'leave', name: 'Bob' })).toBe('Bob left')
  })
})

describe('shouldStopOnCleanup — the seamless drop-in handoff', () => {
  test("a flip to 'game' keeps the adapter alive for startPresence to adopt", () => {
    expect(shouldStopOnCleanup('game')).toBe(false)
  })

  test('an editor-phase unmount tears the receive-only adapter down', () => {
    expect(shouldStopOnCleanup('editor')).toBe(true)
  })
})

describe('hintSuppressed — never two Jump-in buttons', () => {
  const doc = (present: Set<string>) => ({
    querySelector: (selectors: string) => {
      for (const sel of selectors.split(',')) if (present.has(sel.trim())) return {}
      return null
    },
  })

  test('hidden under the drop veil and beside the reentry pill', () => {
    expect(hintSuppressed(doc(new Set(['[data-boots-drop-veil]'])))).toBe(true)
    expect(hintSuppressed(doc(new Set(['[data-boots-reentry]'])))).toBe(true)
  })

  test('shown on a plain editor page', () => {
    expect(hintSuppressed(doc(new Set()))).toBe(false)
    // Our own marker never suppresses us.
    expect(hintSuppressed(doc(new Set([`[${HINT_ATTR}]`])))).toBe(false)
  })
})

describe('pacing constants', () => {
  test('poll is UI-rate, the event line holds as long as a HUD toast', () => {
    expect(WATCH_POLL_MS).toBe(400)
    expect(HINT_EVENT_HOLD_MS).toBe(2400)
    expect(HINT_ATTR).toBe('data-boots-spectator-hint')
  })
})
