import { describe, expect, test } from 'bun:test'
import { dropProgress, shouldOfferDrop } from './drop-gate'

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
