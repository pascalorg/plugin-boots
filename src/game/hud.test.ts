import { describe, expect, test } from 'bun:test'
import { builderKeybarText, Hud, KEYBAR_DEFAULT } from './hud'

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

/**
 * Contextual micro-hints (owner: "it needs to be discreet"): the once-gate
 * runs BEFORE any DOM work, so it's pinnable headless — each id fires
 * exactly once per Hud instance (= per game session; session.ts builds a
 * fresh Hud every Jump-in), and hintSeen() consumes an id without showing
 * it (openItemMenu marks 'catalog' so the 20s nudge never fires for a
 * player who already found the catalog).
 */
describe('micro-hints fire once per session', () => {
  test('a hint id fires once, then never again — even with new text', () => {
    const hud = new Hud()
    expect(hud.hint('gun-aim', 'RMB to aim')).toBe(true)
    expect(hud.hint('gun-aim', 'RMB to aim')).toBe(false)
    expect(hud.hint('gun-aim', 'different text, same id')).toBe(false)
  })

  test('ids gate independently', () => {
    const hud = new Hud()
    expect(hud.hint('builder-keys', 'Z wall · X floor · C stairs · V roof')).toBe(true)
    expect(hud.hint('paint-close', 'hold close to write')).toBe(true)
    expect(hud.hint('builder-keys', 'again')).toBe(false)
    expect(hud.hint('paint-close', 'again')).toBe(false)
  })

  test('hintSeen suppresses an id without showing it (catalog-opened path)', () => {
    const hud = new Hud()
    hud.hintSeen('catalog')
    expect(hud.hint('catalog', 'I — place furniture')).toBe(false)
  })

  test('a fresh Hud (next session) shows every hint again', () => {
    const first = new Hud()
    expect(first.hint('gun-aim', 'RMB to aim')).toBe(true)
    const next = new Hud()
    expect(next.hint('gun-aim', 'RMB to aim')).toBe(true)
  })
})
