import { describe, expect, test } from 'bun:test'
import { dropProgress, shouldOfferDrop, shouldOfferReentry } from './drop-gate'

/**
 * The shareable-link gate: `?boots=drop` on the editor URL offers ONE
 * interstitial per page load, only while the plugin sits in editor phase.
 */
describe('drop gate (shareable game link)', () => {
  test('offers exactly on ?boots=drop in editor phase', () => {
    expect(shouldOfferDrop('?boots=drop', 'editor', false)).toBe(true)
    expect(shouldOfferDrop('?a=1&boots=drop&b=2', 'editor', false)).toBe(true)
  })
  test('never offers without the param, with other values, or mid-game', () => {
    expect(shouldOfferDrop('', 'editor', false)).toBe(false)
    expect(shouldOfferDrop('?boots=jump', 'editor', false)).toBe(false)
    expect(shouldOfferDrop('?boots=drop', 'game', false)).toBe(false)
  })
  test('one-shot: a consumed gate stays quiet (Esc must not nag)', () => {
    expect(shouldOfferDrop('?boots=drop', 'editor', true)).toBe(false)
  })
})

/**
 * Re-entry: the one-shot must not become a trap. On a shared link there is no
 * plugin rail — the lobby route registers no host panels — so once the gate is
 * consumed, leaving the game left a visitor with nothing to click (owner
 * report 2026-08-31). The pill is the way back, and it is the exact complement
 * of the gate: never both, always one of the two, on a drop link in editor
 * phase.
 */
describe('re-entry pill (Esc on a shared link is not a dead end)', () => {
  test('offers once the gate is consumed and we are back in editor phase', () => {
    expect(shouldOfferReentry('?boots=drop', 'editor', true)).toBe(true)
    expect(shouldOfferReentry('?a=1&boots=drop&b=2', 'editor', true)).toBe(true)
  })

  test('stays quiet before the gate is consumed — the gate itself is showing', () => {
    expect(shouldOfferReentry('?boots=drop', 'editor', false)).toBe(false)
  })

  test('never during the game', () => {
    expect(shouldOfferReentry('?boots=drop', 'game', true)).toBe(false)
  })

  test('only on a drop link — the owner in the editor has a real panel', () => {
    expect(shouldOfferReentry('', 'editor', true)).toBe(false)
    expect(shouldOfferReentry('?boots=jump', 'editor', true)).toBe(false)
  })

  test('gate and pill are mutually exclusive, and one always covers the case', () => {
    // The property that makes this a fix and not a second surface to reason
    // about: on a drop link in editor phase, exactly one of them is on.
    for (const consumed of [false, true]) {
      const gate = shouldOfferDrop('?boots=drop', 'editor', consumed)
      const pill = shouldOfferReentry('?boots=drop', 'editor', consumed)
      expect(gate !== pill, `consumed=${consumed}`).toBe(true)
    }
    // And off a drop link, neither ever shows.
    for (const consumed of [false, true]) {
      expect(shouldOfferDrop('', 'editor', consumed)).toBe(false)
      expect(shouldOfferReentry('', 'editor', consumed)).toBe(false)
    }
  })
})

describe('drop progress model (loader → one button)', () => {
  test('starts low, streams up with the node census, needs stability to finish', () => {
    expect(dropProgress(500, 0, 0)).toBeLessThan(0.2)
    const streaming = dropProgress(3000, 120, 0)
    expect(streaming).toBeGreaterThan(0.4)
    expect(streaming).toBeLessThan(1)
    expect(dropProgress(3000, 120, 4)).toBe(1)
  })
  test('the hard cap forces ready even if the census never stabilizes', () => {
    expect(dropProgress(12000, 3, 0)).toBe(1)
  })
  test('an EMPTY lobby scene reaches ready through stability alone', () => {
    // census 0 the whole way — the future infinite-grass lobby.
    expect(dropProgress(2000, 0, 4)).toBeLessThan(1) // stability alone isn't enough…
    expect(dropProgress(12000, 0, 4)).toBe(1) // …the cap guarantees the button
  })
})
