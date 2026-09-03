import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { GAME_KEYS } from './input'
import {
  AIM,
  AXIS_ON,
  BUTTONS,
  EXIT,
  FIRE,
  SLOT_WEAPON,
  WALK_BELOW,
  STICK_DEAD,
  STICK_RADIUS,
  stickKeys,
  stickVector,
  WEAPON_SLOTS,
  wantsTouchPlay,
} from './touch'

/**
 * THUMB CONTROLS, headless.
 *
 * The DOM half of touch.ts (rects, pressed styling, the window-capture lanes)
 * is proven in a real mobile browser by qa-boots-phone.mjs. What is pinned here
 * is everything that can be wrong WITHOUT looking wrong:
 *
 *  - the stick algebra: which keys a thumb offset stands for, and the two
 *    thresholds either side of it (nothing at rest, Shift at the rim);
 *  - the platform decision, which has to say yes to a phone and no to a
 *    touchscreen laptop being driven by a mouse;
 *  - and THE BUTTON TABLE'S AGREEMENT WITH THE GAME. A button that presses
 *    'KeyP' or selects 'Digit8' looks perfect and does nothing — there is no
 *    error, no log, just a control that never worked. So every code in the
 *    table is checked against input.ts's GAME_KEYS (the only codes the game
 *    accepts) and against the sources that consume them: viewmodel.tsx for the
 *    weapon digits, builder.tsx for the piece keys. Those are read as text on
 *    purpose — the mapping is what drifts, and a runtime test can only sample
 *    the paths it happens to walk.
 */

describe('stickVector', () => {
  test('a thumb at rest is centred', () => {
    expect(stickVector(0, 0)).toEqual({ nx: 0, ny: 0 })
  })

  test('screen-up is FORWARD (the y flip)', () => {
    const up = stickVector(0, -STICK_RADIUS)
    expect(up.ny).toBeCloseTo(1, 6)
    expect(up.nx).toBeCloseTo(0, 6)
    const down = stickVector(0, STICK_RADIUS)
    expect(down.ny).toBeCloseTo(-1, 6)
  })

  test('inside the ring it is proportional; outside it saturates', () => {
    expect(stickVector(STICK_RADIUS / 2, 0).nx).toBeCloseTo(0.5, 6)
    // Three ring-widths out is still exactly full deflection, direction kept.
    const far = stickVector(STICK_RADIUS * 3, -STICK_RADIUS * 3)
    expect(Math.hypot(far.nx, far.ny)).toBeCloseTo(1, 6)
    expect(far.nx).toBeCloseTo(Math.SQRT1_2, 6)
    expect(far.ny).toBeCloseTo(Math.SQRT1_2, 6)
  })

  test('a custom radius scales the whole ring', () => {
    expect(stickVector(20, 0, 40).nx).toBeCloseTo(0.5, 6)
  })
})

describe('stickKeys', () => {
  test('the deadzone holds NOTHING (a resting thumb must not walk)', () => {
    expect(stickKeys(0, 0)).toEqual({ codes: [], walk: false })
    expect(stickKeys(STICK_DEAD * 0.9, 0).codes).toEqual([])
  })

  test('cardinals are single keys', () => {
    expect(stickKeys(0, 1).codes).toEqual(['KeyW'])
    expect(stickKeys(0, -1).codes).toEqual(['KeyS'])
    expect(stickKeys(1, 0).codes).toEqual(['KeyD'])
    expect(stickKeys(-1, 0).codes).toEqual(['KeyA'])
  })

  test('a diagonal holds both — 45° is 0.707 per axis, over AXIS_ON', () => {
    expect(AXIS_ON).toBeLessThan(Math.SQRT1_2)
    const ne = stickKeys(Math.SQRT1_2, Math.SQRT1_2)
    expect(ne.codes.sort()).toEqual(['KeyD', 'KeyW'])
    const sw = stickKeys(-Math.SQRT1_2, -Math.SQRT1_2)
    expect(sw.codes.sort()).toEqual(['KeyA', 'KeyS'])
  })

  test('a small push past the deadzone still moves, on its dominant axis', () => {
    // Both axes under AXIS_ON but the vector is out of the deadzone: this is the
    // gap a naive per-axis threshold leaves — a visibly deflected stick and a
    // player standing still.
    const nudge = stickKeys(0.2, 0.22)
    expect(Math.hypot(0.2, 0.22)).toBeGreaterThan(STICK_DEAD)
    expect(nudge.codes).toEqual(['KeyW'])
    expect(stickKeys(0.26, 0.2).codes).toEqual(['KeyD'])
    expect(stickKeys(-0.3, -0.1).codes).toEqual(['KeyA'])
  })

  test('a gentle push walks, a firm push runs — never the other way round', () => {
    // Shift is WALK in the game; the first cut held it at the rim, so a phone
    // player who pushed harder went slower.
    expect(stickKeys(0, WALK_BELOW - 0.01).walk).toBe(true)
    expect(stickKeys(0, WALK_BELOW).walk).toBe(false)
    expect(stickKeys(0, 1).walk).toBe(false)
    // …and a full diagonal runs too (magnitude, not per-axis).
    expect(stickKeys(Math.SQRT1_2, Math.SQRT1_2).walk).toBe(false)
    // A nudge just past the dead zone still moves — and creeps.
    const nudge = stickKeys(0, 0.25)
    expect(nudge.codes).toEqual(['KeyW'])
    expect(nudge.walk).toBe(true)
  })
})

describe('wantsTouchPlay', () => {
  test('a phone gets thumbs: touch, coarse, no pointer lock', () => {
    expect(wantsTouchPlay({ maxTouchPoints: 5, coarsePointer: true, pointerLock: false })).toBe(true)
  })

  test('Android gets thumbs even though the API exists', () => {
    expect(wantsTouchPlay({ maxTouchPoints: 5, coarsePointer: true, pointerLock: true })).toBe(true)
  })

  test('a desktop never does', () => {
    expect(wantsTouchPlay({ maxTouchPoints: 0, coarsePointer: false, pointerLock: true })).toBe(
      false,
    )
  })

  test('A TOUCHSCREEN LAPTOP KEEPS THE KEYBOARD GAME', () => {
    // The regression this predicate exists to avoid: maxTouchPoints alone is
    // true on every Surface and touch-enabled MacBook-alike, and thumb controls
    // over a mouse-and-keyboard session would be a downgrade for the majority
    // of players.
    expect(wantsTouchPlay({ maxTouchPoints: 10, coarsePointer: false, pointerLock: true })).toBe(
      false,
    )
  })

  test('no touch point is disqualifying on its own', () => {
    expect(wantsTouchPlay({ maxTouchPoints: 0, coarsePointer: true, pointerLock: false })).toBe(
      false,
    )
  })
})

describe('the button table agrees with the game', () => {
  const specials = new Set([FIRE, AIM, EXIT])

  test('every button presses a code the game actually claims', () => {
    for (const spec of BUTTONS) {
      if (specials.has(spec.code)) continue
      expect(GAME_KEYS.has(spec.code)).toBe(true)
    }
    for (const slot of WEAPON_SLOTS) expect(GAME_KEYS.has(slot.code)).toBe(true)
  })

  test('the three specials are NOT key codes (they drive the mouse bits/exit)', () => {
    for (const code of specials) expect(GAME_KEYS.has(code)).toBe(false)
  })

  test('the hotbar covers all seven weapons, one slot each', () => {
    expect(WEAPON_SLOTS.length).toBe(7)
    const codes = WEAPON_SLOTS.map((s) => s.code)
    expect(new Set(codes).size).toBe(7)
    const weapons = codes.map((c) => SLOT_WEAPON[c])
    expect(weapons.every(Boolean)).toBe(true)
    expect(new Set(weapons).size).toBe(7)
  })

  test('two buttons never claim the same code at the same weapon', () => {
    // 'KeyR' is deliberately listed twice — TURN for the builder, COLOR for the
    // sprayer — and the weapon gate is the only thing keeping them apart. If
    // both ever became visible together the hit test would return whichever was
    // declared first, for both meanings.
    const weapons = ['knife', 'pistol', 'rifle', 'minigun', 'builder', 'hammer', 'paint']
    for (const weapon of weapons) {
      const live = BUTTONS.filter((b) => !b.weapons || b.weapons.includes(weapon))
      const codes = live.map((b) => b.code)
      expect(new Set(codes).size).toBe(codes.length)
    }
  })

  test('the weapon digits are the ones viewmodel.tsx switches on', () => {
    const src = readFileSync(new URL('./viewmodel.tsx', import.meta.url), 'utf8')
    for (const [code, weapon] of Object.entries(SLOT_WEAPON)) {
      // e.g. `else if (action === 'Digit5') switchWeapon('minigun')`
      const line = src
        .split('\n')
        .find((l) => l.includes(`action === '${code}'`) && l.includes('switchWeapon('))
      expect(line, `no switchWeapon line for ${code}`).toBeDefined()
      expect(line).toContain(`switchWeapon('${weapon}')`)
    }
  })

  test('the piece row is the builder’s own hotkey table', () => {
    const src = readFileSync(new URL('./builder.tsx', import.meta.url), 'utf8')
    for (const [code, piece] of [
      ['KeyZ', 'wall'],
      ['KeyX', 'floor'],
      ['KeyC', 'stairs'],
      ['KeyV', 'roof'],
    ] as const) {
      expect(src).toContain(`['${code}', '${piece}']`)
      const button = BUTTONS.find((b) => b.code === code)
      expect(button, `no touch button for ${code}`).toBeDefined()
      // The caption is the piece it places, so the table cannot drift silently.
      expect(piece.startsWith((button?.sub ?? '').toLowerCase())).toBe(true)
      expect(button?.weapons).toEqual(['builder'])
    }
  })

  test('FIRE is the biggest target on screen', () => {
    // Not cosmetic: a missed trigger is the whole game, and the fan around it
    // (JUMP/AIM/USE/NADE) is what a thumb hits instead when it is undersized.
    const fire = BUTTONS.find((b) => b.code === FIRE)
    expect(fire).toBeDefined()
    for (const other of BUTTONS) {
      if (other === fire) continue
      expect(other.size).toBeLessThan(fire!.size)
    }
  })

  test('the phone can reach the microphone', () => {
    // A phone has no M key. Without this button the whole voice layer is desktop
    // only, and "join my game" from a phone means joining in silence.
    const mic = BUTTONS.find((b) => b.code === 'KeyM')
    expect(mic, 'no touch button for KeyM').toBeDefined()
    expect(mic?.sub).toBe('MIC')
    // NOT weapon-gated: talking is not a tool, and a mic that vanishes when you
    // switch off the builder is a mic nobody trusts.
    expect(mic?.weapons).toBeUndefined()
    // 'tap' is what pushes the one-shot onto the action queue that
    // voice-controls.tsx reads; 'hold' would toggle on press and never release.
    expect(mic?.mode).toBe('tap')
  })

  test('the phone can move aimed furniture without borrowing the mic button', () => {
    const move = BUTTONS.find((b) => b.code === 'KeyL')
    expect(move, 'no touch button for KeyL').toBeDefined()
    expect(move?.sub).toBe('MOVE')
    expect(move?.mode).toBe('tap')
    expect(BUTTONS.find((b) => b.code === 'KeyM')?.sub).toBe('MIC')
  })

  test('the top-left session row does not stack its buttons on each other', () => {
    // EXIT / GEAR / MIC / MOVE share one row, hit-tested by rect with 6px of slop, and
    // the first match in declaration order wins — overlapping rects would make
    // one of them unpressable rather than looking wrong.
    const row = BUTTONS.filter((b) => /top:/.test(b.place) && /left:/.test(b.place))
      .map((b) => ({ left: Number(/left:\s*(\d+)px/.exec(b.place)?.[1] ?? Number.NaN), size: b.size }))
      .sort((a, b) => a.left - b.left)
    expect(row.length).toBeGreaterThanOrEqual(3)
    for (let i = 1; i < row.length; i++) {
      expect(row[i]!.left).toBeGreaterThanOrEqual(row[i - 1]!.left + row[i - 1]!.size)
    }
  })

  test('every button is placed, sized and reachable', () => {
    for (const spec of BUTTONS) {
      expect(spec.size).toBeGreaterThanOrEqual(42) // Apple's 44pt, near enough
      expect(spec.place.length).toBeGreaterThan(0)
      // Anchored to an edge — a centre-relative control would drift with the
      // viewport and land under the host's own chrome on a short screen.
      expect(/(^|;)(left|right):/.test(spec.place)).toBe(true)
      expect(/(bottom|top):/.test(spec.place)).toBe(true)
    }
  })
})

describe('compact HUD keeps clear of the thumbs', () => {
  // The first phone build painted the grenade pip on top of the FIRE button and
  // hid the health readout under the parked stick ring: hud.ts anchors both
  // stacks to the bottom corners, which is exactly where the controls now live.
  // Compact mode re-anchors them to the free top-left rail, and this pins that —
  // a re-anchor back to `bottom:` looks fine on a desktop and is unreadable on a
  // phone, which is the failure mode nobody notices in review.
  const hud = readFileSync(new URL('./hud.ts', import.meta.url), 'utf8')
  const table = hud.slice(hud.indexOf('const COMPACT'), hud.indexOf('for (const [el, css] of COMPACT)'))
  const anchors = [...table.matchAll(/'((?:left|right):[^']*)'/g)].map((m) => m[1] ?? '')

  test('the table moved every bottom-anchored readout', () => {
    // health, weapon, grenade pip, paint, paint carousel, hint, edit hint.
    expect(anchors.length).toBe(7)
    for (const css of anchors) {
      expect(css, `${css} still hugs a bottom edge`).not.toContain('bottom:')
      expect(css).toContain('top:')
    }
    // …and the code clears the mounted anchors first, or the element keeps its
    // original corner (over-constrained absolute positioning).
    expect(table.length).toBeGreaterThan(0)
    expect(hud).toContain("el.style.bottom = 'auto'")
    expect(hud).toContain("el.style.right = 'auto'")
  })

  test('nothing lands under the top-left session buttons', () => {
    const topLeft = BUTTONS.filter((b) => /top:/.test(b.place) && /left:/.test(b.place))
    expect(topLeft.length).toBeGreaterThan(0) // EXIT + GEAR
    const lowest = Math.max(
      ...topLeft.map((b) => Number(/top:\s*(?:calc\()?(\d+)px/.exec(b.place)?.[1] ?? 0) + b.size),
    )
    const tops = anchors.map((css) => Number(/top:\s*(\d+)px/.exec(css)?.[1] ?? Number.NaN))
    for (const top of tops) expect(top).toBeGreaterThanOrEqual(lowest)
  })

  test('the left rail stack does not overlap itself', () => {
    const rail = anchors
      .filter((css) => css.includes('left:14px'))
      .map((css) => Number(/top:\s*(\d+)px/.exec(css)?.[1]))
      .sort((a, b) => a! - b!)
    expect(rail.length).toBeGreaterThanOrEqual(5)
    for (let i = 1; i < rail.length; i++) {
      // A 20px readout plus leading; anything tighter is two lines on top of
      // each other on the one screen where they are the only readouts left.
      expect(rail[i]! - rail[i - 1]!).toBeGreaterThanOrEqual(24)
    }
  })
})

describe('input.ts stands down in thumb mode', () => {
  // The bug this guards: a touch reports `buttons & 1`, so the mouse lane would
  // read a stick nudge as the trigger held down for the whole session. These are
  // source-shape assertions because the alternative is a full DOM harness for a
  // one-line early return — and the Playwright phone run covers the behaviour.
  const src = readFileSync(new URL('./input.ts', import.meta.url), 'utf8')

  test('the button sync bails before writing either fire bit', () => {
    const at = src.indexOf('const syncButtons = (buttons: number) => {')
    expect(at).toBeGreaterThan(0)
    const body = src.slice(at, src.indexOf('}', at))
    expect(body.indexOf('if (this.touchMode) return')).toBeLessThan(body.indexOf('this.state.firing'))
  })

  test('mousemove stops accumulating look (iOS replays the drag as a mouse event)', () => {
    const at = src.indexOf("on('mousemove'")
    const body = src.slice(at, src.indexOf('})', at))
    expect(body.indexOf('if (this.touchMode) return')).toBeLessThan(body.indexOf('this.state.lookX'))
  })

  test('the lock is never requested', () => {
    expect(src).toContain('if (!this.touchMode) this.requestLock()')
    expect(src).toContain('if (!this.touchMode && !this.pointerLocked && this.relockOnClick)')
  })
})
