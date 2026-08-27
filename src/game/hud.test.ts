import { describe, expect, test } from 'bun:test'
import { builderKeybarText, KEYBAR_DEFAULT } from './hud'

/**
 * Keybind-bar discoverability contract (owner QA 2026-08-27: "no ramp, no
 * roof" traced to the in-game bar never advertising the piece hotkeys): the
 * builder-mode bar must list every direct piece key + the Q cycle, and its
 * captions must follow the keyboard layout when one is resolvable.
 */

describe('builder keybind bar', () => {
  test('advertises every piece hotkey, the cycle, and the standing keys', () => {
    const bar = builderKeybarText()
    expect(bar).toContain('Z wall')
    expect(bar).toContain('X floor')
    expect(bar).toContain('C stairs')
    expect(bar).toContain('V roof')
    expect(bar).toContain('Q cycle')
    expect(bar).toContain('R rotate/shape')
    expect(bar).toContain('F edit')
    expect(bar).toContain('U undo')
    expect(bar).toContain('Esc exit')
  })

  test('captions follow the layout map (AZERTY prints its own caps)', () => {
    // input.ts matches e.code (PHYSICAL positions): on AZERTY the key at
    // KeyZ prints W and the key at KeyQ prints A — the bar must show what
    // is printed on the player's keyboard, not QWERTY letters.
    const azerty: Record<string, string> = { KeyZ: 'W', KeyQ: 'A' }
    const bar = builderKeybarText((code) => azerty[code] ?? code.replace('Key', ''))
    expect(bar).toContain('W wall')
    expect(bar).toContain('A cycle')
    expect(bar).toContain('C stairs')
    expect(bar).toContain('V roof')
  })

  test('the default bar is untouched (holstered contract)', () => {
    expect(KEYBAR_DEFAULT).toBe('Esc exit · G grenade · R rotate/shape · F edit · U undo · I catalog')
  })
})
