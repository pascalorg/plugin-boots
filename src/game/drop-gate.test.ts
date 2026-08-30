import { describe, expect, test } from 'bun:test'
import { shouldOfferDrop } from './drop-gate'

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
