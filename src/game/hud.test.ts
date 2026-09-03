import { describe, expect, test } from 'bun:test'
import {
  builderKeybarText,
  CHIP_NAME_CAP,
  hotbarModel,
  hotbarSignature,
  Hud,
  KEYBAR_DEFAULT,
  LOADING_TIP_INTERVAL_MS,
  LOADING_TIPS,
  PAINT_CAROUSEL_HOLD_MS,
  presenceChipText,
} from './hud'

/**
 * Keybind-bar discoverability contract (owner QA 2026-08-27: "no ramp, no
 * roof" traced to the in-game bar never advertising the piece hotkeys): the
 * builder-mode bar must list every direct piece key + the Q cycle, and its
 * captions must follow the keyboard layout when one is resolvable.
 */

describe('builder keybind bar', () => {
  test('advertises every piece hotkey, the cycle, and the standing keys', () => {
    const bar = builderKeybarText()
    // Z is the wall FAMILY key — a player who never presses Q must still be
    // told doors and windows exist (owner ask 2026-09-01).
    expect(bar).toContain('Z wall·door·window')
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
 * Weapon hotbar (owner ask: a discreet slot reminder so players stop
 * guessing the number keys): hotbarModel is the pure half — a chip is
 * 'available' iff pressing its key RIGHT NOW would switch to it, which is
 * viewmodel.tsx switchWeapon's exact gate (builder and paint are always
 * reachable regardless of `owned`; the G grenade is infinite; every gun
 * must be picked up first). hotbarSignature is the render loop's change
 * gate — chip styles rebuild only when it moves.
 */
describe('weapon hotbar model', () => {
  test('lists every slot chip in key order, G last', () => {
    const chips = hotbarModel({ weapon: 'knife', owned: ['knife'] })
    expect(chips.map((c) => `${c.key} ${c.label}`)).toEqual([
      '1 KNIFE',
      '2 PISTOL',
      '3 RIFLE',
      '4 BUILD',
      '5 MINIGUN',
      '6 HAMMER',
      '7 PAINT',
      'G GRENADE',
    ])
  })

  test('spawn loadout: knife active, tools + grenade reachable, guns locked', () => {
    const byId = Object.fromEntries(
      hotbarModel({ weapon: 'knife', owned: ['knife'] }).map((c) => [c.id, c.state]),
    )
    expect(byId.knife).toBe('active')
    // Digit4/Digit7 switch without an `owned` check (switchWeapon's gate).
    expect(byId.builder).toBe('available')
    expect(byId.paint).toBe('available')
    // G never checks anything — grenades are infinite.
    expect(byId.grenade).toBe('available')
    expect(byId.pistol).toBe('locked')
    expect(byId.rifle).toBe('locked')
    expect(byId.minigun).toBe('locked')
    expect(byId.hammer).toBe('locked')
  })

  test('picking a gun up unlocks its chip; holding it marks it active', () => {
    const owned = ['knife', 'rifle']
    const holdingKnife = hotbarModel({ weapon: 'knife', owned })
    expect(holdingKnife.find((c) => c.id === 'rifle')?.state).toBe('available')
    const holdingRifle = hotbarModel({ weapon: 'rifle', owned })
    expect(holdingRifle.find((c) => c.id === 'rifle')?.state).toBe('active')
    expect(holdingRifle.find((c) => c.id === 'knife')?.state).toBe('available')
  })

  test('holding a tool marks its chip active; G never reads active', () => {
    const holdingBuilder = hotbarModel({ weapon: 'builder', owned: ['knife'] })
    expect(holdingBuilder.find((c) => c.id === 'builder')?.state).toBe('active')
    // The grenade is a throw, not a hold — its chip can't go active.
    const all = hotbarModel({ weapon: 'knife', owned: ['knife'] })
    expect(all.find((c) => c.id === 'grenade')?.state).toBe('available')
  })

  test('signature moves exactly with (weapon, owned) reality', () => {
    const base = hotbarSignature(hotbarModel({ weapon: 'knife', owned: ['knife'] }))
    const repeat = hotbarSignature(hotbarModel({ weapon: 'knife', owned: ['knife'] }))
    expect(repeat).toBe(base) // unchanged state → no chip restyle
    const switched = hotbarSignature(hotbarModel({ weapon: 'builder', owned: ['knife'] }))
    expect(switched).not.toBe(base) // active chip moved
    const pickedUp = hotbarSignature(hotbarModel({ weapon: 'knife', owned: ['knife', 'pistol'] }))
    expect(pickedUp).not.toBe(base) // a chip unlocked
    // 'active' and 'available' must never collide in the signature alphabet.
    expect(switched.length).toBe(base.length)
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

/**
 * Entry veil, headless surface: the progress feed and the reveal callback
 * must be safe without a DOM (loadingProgress is feature-detected and the
 * driver can outlive a torn-down HUD by a frame). Everything visual lives
 * behind mount(); these pin the no-DOM contract only.
 */
describe('entry loading veil (headless contract)', () => {
  test('loadingProgress before mount is a safe no-op (no reveal fired)', () => {
    const hud = new Hud()
    let revealed = 0
    hud.onReveal = () => revealed++
    expect(() => hud.loadingProgress(0.5)).not.toThrow()
    expect(() => hud.loadingProgress(1, 'warm frames (3/20)')).not.toThrow()
    // No veil element exists — progress 1 must not fire the reveal gate.
    expect(revealed).toBe(0)
  })

  test('unmount clears onReveal without calling it (Esc mid-load exits clean)', () => {
    const hud = new Hud()
    let revealed = 0
    hud.onReveal = () => revealed++
    hud.unmount()
    expect(revealed).toBe(0)
    expect(hud.onReveal).toBeNull()
  })
})

/**
 * Loading-card control tips (the redesigned dedicated loading screen): the
 * rotating bottom line must teach REAL binds — movement, the depot gear-up,
 * the breaker, the four build pieces, the grenade + catalog keys — and pace
 * itself slow enough to read (~2.5 s per tip).
 */
describe('loading-card control tips', () => {
  test('4–6 tips covering the real controls', () => {
    expect(LOADING_TIPS.length).toBeGreaterThanOrEqual(4)
    expect(LOADING_TIPS.length).toBeLessThanOrEqual(6)
    const all = LOADING_TIPS.join(' | ')
    expect(all).toContain('WASD')
    expect(all).toContain('Space')
    expect(all).toContain('E ') // depot gear-up
    expect(all).toContain('breaker')
    expect(all).toContain('Z X C V')
    expect(all).toContain('G ') // grenade
    expect(all).toContain('I ') // catalog
  })

  test('rotation pace is a calm read (2–3s per tip)', () => {
    expect(LOADING_TIP_INTERVAL_MS).toBeGreaterThanOrEqual(2000)
    expect(LOADING_TIP_INTERVAL_MS).toBeLessThanOrEqual(3000)
  })
})

/**
 * Co-presence chrome (headless contract): the chip copy + pluralization
 * are pure (presenceChipText); the chip/toast methods must be safe with no
 * DOM (remote-players drives them feature-detected from the frame loop —
 * a torn-down HUD getting one more call is a no-op, never a crash).
 */
describe('co-presence chip + toasts', () => {
  test('presenceChipText: hidden at 0, singular at 1, plural above', () => {
    expect(presenceChipText(0)).toBeNull()
    expect(presenceChipText(-2)).toBeNull()
    expect(presenceChipText(1)).toBe('1 builder here')
    expect(presenceChipText(3)).toBe('3 builders here')
  })

  test('presenceChip and presenceToast are safe no-ops without a DOM', () => {
    const hud = new Hud()
    expect(() => hud.presenceChip(2)).not.toThrow()
    expect(() => hud.presenceChip(2)).not.toThrow() // change-gated repeat
    expect(() => hud.presenceChip(0)).not.toThrow()
    expect(() => hud.presenceChip(2, ['Alice', 'Bob'])).not.toThrow()
    expect(() => hud.presenceToast('Alice joined')).not.toThrow()
    expect(() => hud.unmount()).not.toThrow()
  })
})

/**
 * In-game ROSTER chip (see-each-other, 2026-09-02): with names the chip lists
 * who is in — the same label rule the spectator pill and the toasts use — and
 * past CHIP_NAME_CAP the rest is a "+N". The count-only copy is untouched
 * (remote-players.tsx still drives that on roster edges).
 */
describe('roster chip with names', () => {
  test('count-only copy is unchanged', () => {
    expect(presenceChipText(1, undefined)).toBe('1 builder here')
    expect(presenceChipText(2, [])).toBe('2 builders here')
  })

  test('one, a few, and the cap', () => {
    expect(CHIP_NAME_CAP).toBe(4)
    expect(presenceChipText(1, ['Alice'])).toBe('1 player: Alice')
    expect(presenceChipText(3, ['Alice', 'Bob', 'Carol'])).toBe('3 players: Alice, Bob, Carol')
    expect(presenceChipText(4, ['A', 'B', 'C', 'D'])).toBe('4 players: A, B, C, D')
    expect(presenceChipText(6, ['A', 'B', 'C', 'D', 'E', 'F'])).toBe('6 players: A, B, C, D +2')
  })

  test('the count is the truth when names lag behind it', () => {
    // A roster edge the names caller has not reported yet: the count says 3,
    // the names say 2 → the missing one is a "+1", never a lie of omission.
    expect(presenceChipText(3, ['Alice', 'Bob'])).toBe('3 players: Alice, Bob +1')
    expect(presenceChipText(0, ['Ghost'])).toBeNull()
  })

  test('Hud merge rule: a count-only call never downgrades a named chip at the same count', () => {
    // Drive the gate through a stub element: the class only touches
    // textContent + style.opacity.
    const hud = new Hud()
    const el = { textContent: '', style: { opacity: '0' } }
    ;(hud as unknown as { presenceChipEl: unknown }).presenceChipEl = el
    hud.presenceChip(1, ['Alice'])
    expect(el.textContent).toBe('1 player: Alice')
    hud.presenceChip(1) // remote-players' count-only edge, same count
    expect(el.textContent).toBe('1 player: Alice')
    hud.presenceChip(2) // an edge the names caller has not reported yet
    expect(el.textContent).toBe('2 builders here')
    hud.presenceChip(2, ['Alice', 'Bob'])
    expect(el.textContent).toBe('2 players: Alice, Bob')
    hud.presenceChip(0)
    expect(el.textContent).toBe('')
    expect(el.style.opacity).toBe('0')
    hud.presenceChip(1) // names were forgotten at 0
    expect(el.textContent).toBe('1 builder here')
  })

  test('a call before mount() is not latched: the first call after mount renders', () => {
    // game-root's presence effect can drive the chip before the HUD has an
    // element (and remote-players keeps driving it per frame after unmount).
    // The old body latched presenceChipText FIRST, so a pre-mount
    // '1 player: Alice' made the identical post-mount call a change-gated no-op
    // — a blank chip until the next roster edge.
    const hud = new Hud()
    hud.presenceChip(1, ['Alice']) // no element yet: swallowed, never latched
    expect((hud as unknown as { presenceChipText: string }).presenceChipText).toBe('')
    const el = { textContent: '', style: { opacity: '0' } }
    ;(hud as unknown as { presenceChipEl: unknown }).presenceChipEl = el
    hud.presenceChip(1, ['Alice'])
    expect(el.textContent).toBe('1 player: Alice')
    expect(el.style.opacity).toBe('1')
  })

  test('names handed in before mount() still enrich the first post-mount count-only call', () => {
    const hud = new Hud()
    hud.presenceChip(2, ['Alice', 'Bob'])
    const el = { textContent: '', style: { opacity: '0' } }
    ;(hud as unknown as { presenceChipEl: unknown }).presenceChipEl = el
    hud.presenceChip(2) // remote-players' count-only edge, same count
    expect(el.textContent).toBe('2 players: Alice, Bob')
  })

  test('after unmount() a late call is a no-op and the gate is reset', () => {
    const hud = new Hud()
    const el = { textContent: '', style: { opacity: '0' } }
    ;(hud as unknown as { presenceChipEl: unknown }).presenceChipEl = el
    hud.presenceChip(1, ['Alice'])
    expect(el.textContent).toBe('1 player: Alice')
    hud.unmount()
    expect((hud as unknown as { presenceChipText: string }).presenceChipText).toBe('')
    expect(() => hud.presenceChip(1, ['Alice'])).not.toThrow()
    expect(el.textContent).toBe('1 player: Alice') // untouched: nothing to write to
  })
})

/**
 * Paint color carousel (owner ask: "R switches to the next color in a
 * carousel"): a transient palette strip above the paint chip, shown on
 * every R cycle and faded after PAINT_CAROUSEL_HOLD_MS — the hotbar's
 * brighten-then-idle idiom. The visual half lives behind mount(); these
 * pin the pacing constant and the no-DOM contract (paint.tsx calls it
 * feature-detected from the frame loop).
 */
describe('paint color carousel (R-cycle readout)', () => {
  test('show-then-fade pace is a ~2s read', () => {
    expect(PAINT_CAROUSEL_HOLD_MS).toBeGreaterThanOrEqual(1500)
    expect(PAINT_CAROUSEL_HOLD_MS).toBeLessThanOrEqual(2500)
  })

  test('paintCarousel is a safe no-op without a DOM', () => {
    const hud = new Hud()
    expect(() => hud.paintCarousel(['#f4f4ef', '#26282c', '#8f959d'], 1)).not.toThrow()
    expect(() => hud.paintCarousel(['#f4f4ef', '#26282c', '#8f959d'], 2)).not.toThrow()
    expect(() => hud.unmount()).not.toThrow()
  })
})
