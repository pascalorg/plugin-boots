import { useBoots } from '../store'
import type { GameInput } from './input'

/**
 * TOUCH PLAY — the whole game from two thumbs.
 *
 * A phone has none of the three things the desktop entry path leans on: no
 * `Element.requestFullscreen` (iOS gives it to <video> only), no pointer lock,
 * and no keyboard. Boots survived all three (every call in session.ts is
 * optional-chained, and input.ts flows buttons and deltas whether or not the
 * lock ever engaged), so a phone DID enter the game — windowed, under the host
 * editor's chrome, with no way to look, walk or shoot. That is what the
 * cofounder's "nothing really like joining a game" screenshot was: a running
 * session nobody could steer.
 *
 * This module is the input source that was missing. It owns:
 *
 *  - A FLOATING LEFT STICK. The ring re-centres on the thumb that starts it
 *    (fixed-base sticks punish a thumb that lands 20 px off), and its vector is
 *    written as WASD membership rather than an analog axis — every movement
 *    consumer (player.tsx's fwd/side, the sprint gate, the stagger checks)
 *    keeps reading exactly what a keyboard produces, so nothing downstream
 *    learns that a phone exists. Past SPRINT_AT the stick also holds Shift.
 *  - DRAG TO LOOK, anywhere outside the stick zone and the buttons, scaled by
 *    LOOK_GAIN into `state.lookX/lookY` — the same accumulator mousemove feeds,
 *    drained by player.tsx through consumeLook().
 *  - BUTTONS that press real key codes. A 'tap' button adds its code to
 *    `state.keys` AND pushes it to `state.actions`, then releases on lift:
 *    that is precisely what input.ts's keydown/keyup pair does, which is why
 *    both consumer styles work from one button — interact.tsx takes the
 *    one-shot 'KeyE' out of the action queue, guntable.tsx reads
 *    `keys.has('KeyE')`, and builder.tsx edge-detects held F/R/U.
 *    FIRE and AIM instead drive the two mouse bits (`firing`/`altFiring`).
 *  - The build row (Q/Z/X/C/V/F/U) and the paint cycle (R), shown only while
 *    the store's weapon is the one they belong to, because a 390 px screen has
 *    no room for keys that do nothing.
 *
 * Everything is hit-tested by hand against the buttons' own rects on
 * `pointerdown`, and the listeners are window-capture: input.ts installs
 * capture-phase pointer handlers that `preventDefault` + `stopImmediatePropagation`
 * so the host editor never sees a click, and a listener on the same target and
 * phase only runs first if it registered first. THE TOUCH LAYER MUST THEREFORE
 * ATTACH BEFORE `input.attach()` — session.ts does, and the ordering is load
 * bearing enough that reversing it silently kills every control.
 *
 * The DOM is inert (`pointer-events:none` on the root and every child, pressed
 * styling applied in JS) for the same reason: the layer never competes with the
 * item catalog, which lives in the same container and needs its own taps. While
 * `input.menuOpen` is set the layer stands down completely and hides.
 *
 * Nothing here runs on a desktop: `touchPlayLikely()` demands a touch point AND
 * either a coarse pointer or a missing pointer-lock API, so a touchscreen laptop
 * driven by a mouse keeps the keyboard game.
 */

/** Knob travel, in px, from wherever the thumb landed. */
export const STICK_RADIUS = 58
/** Below this fraction of full deflection the stick is centred (no keys). */
export const STICK_DEAD = 0.18
/** At or past this fraction the stick also holds Shift. */
export const SPRINT_AT = 0.86
/** Per-axis fraction that counts as "pushed" — 45° gives 0.707, so a diagonal
 * lands both keys and a straight push lands exactly one. */
export const AXIS_ON = 0.38
/** Mouse-pixels of look per pixel of drag. */
export const LOOK_GAIN = 1.25
/** A tap holds its key at least this long, so a 20 ms stab still reads as a
 * press to consumers that sample `keys` once a frame. */
const TAP_HOLD_MS = 110

const MOVE_CODES = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft'] as const

/** Codes the two mouse bits stand in for; not key codes. */
export const FIRE = 'FIRE'
export const AIM = 'AIM'
export const EXIT = 'EXIT'

export type StickKeys = { codes: string[]; sprint: boolean }

/**
 * Stick vector → the key set a keyboard would be holding. `nx` is right-positive
 * and `ny` is FORWARD-positive (screen-up), both already normalised to -1..1.
 */
export function stickKeys(nx: number, ny: number): StickKeys {
  const mag = Math.hypot(nx, ny)
  if (mag < STICK_DEAD) return { codes: [], sprint: false }
  const codes: string[] = []
  if (ny >= AXIS_ON) codes.push('KeyW')
  if (ny <= -AXIS_ON) codes.push('KeyS')
  if (nx >= AXIS_ON) codes.push('KeyD')
  if (nx <= -AXIS_ON) codes.push('KeyA')
  // A push shorter than AXIS_ON on both axes still means "go that way": take
  // the dominant axis so the stick can never read as deflected-but-still.
  if (codes.length === 0) {
    if (Math.abs(ny) >= Math.abs(nx)) codes.push(ny > 0 ? 'KeyW' : 'KeyS')
    else codes.push(nx > 0 ? 'KeyD' : 'KeyA')
  }
  return { codes, sprint: mag >= SPRINT_AT }
}

/** Thumb offset from the stick origin → normalised vector, capped at the ring.
 * Screen-down is +dy, so forward comes out positive. */
export function stickVector(dx: number, dy: number, radius = STICK_RADIUS): { nx: number; ny: number } {
  const len = Math.hypot(dx, dy)
  if (len < 1e-6) return { nx: 0, ny: 0 }
  const scale = Math.min(len, radius) / radius / len
  return { nx: dx * scale, ny: -dy * scale }
}

export type TouchEnv = {
  maxTouchPoints: number
  coarsePointer: boolean
  /** Whether the browser exposes `requestPointerLock` on a canvas at all. */
  pointerLock: boolean
}

/**
 * Thumb controls or keyboard? A touch point is necessary but nowhere near
 * sufficient — every touchscreen laptop reports one while its owner uses a
 * mouse. What settles it is a COARSE pointer (a finger, per the media query) or
 * a browser with no pointer lock at all (iOS), because either way there is no
 * mouse to capture and the keyboard game cannot be played.
 */
export function wantsTouchPlay(env: TouchEnv): boolean {
  if (env.maxTouchPoints < 1) return false
  return env.coarsePointer || !env.pointerLock
}

/** wantsTouchPlay against the live browser. */
export function touchPlayLikely(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  return wantsTouchPlay({
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    coarsePointer: window.matchMedia?.('(pointer: coarse)')?.matches === true,
    pointerLock:
      typeof HTMLCanvasElement !== 'undefined' &&
      typeof HTMLCanvasElement.prototype.requestPointerLock === 'function',
  })
}

export type ButtonSpec = {
  code: string
  label: string
  sub?: string
  size: number
  /** Absolute placement, relative to the session container. */
  place: string
  /** 'hold' keeps the key/bit down until the thumb lifts. */
  mode: 'hold' | 'tap'
  /** Shown only while the store's weapon is one of these. */
  weapons?: readonly string[]
  accent?: string
}

const BUILD_TOOLS = ['builder'] as const
const PAINT_TOOLS = ['paint'] as const

/** Bottom offsets clear the home bar when the host opts into `viewport-fit`;
 * `env()` is 0 otherwise, which the base offsets already tolerate. */
const bottom = (px: number) => `bottom:calc(${px}px + env(safe-area-inset-bottom, 0px))`
const top = (px: number) => `top:calc(${px}px + env(safe-area-inset-top, 0px))`

export const BUTTONS: readonly ButtonSpec[] = [
  // Right thumb — the shooting hand.
  { code: FIRE, label: 'FIRE', size: 86, place: `right:16px;${bottom(24)}`, mode: 'hold', accent: '#ffcc33' },
  { code: 'Space', label: 'JUMP', size: 60, place: `right:108px;${bottom(38)}`, mode: 'hold' },
  { code: AIM, label: 'AIM', size: 52, place: `right:24px;${bottom(122)}`, mode: 'hold' },
  { code: 'KeyE', label: 'E', sub: 'USE', size: 52, place: `right:98px;${bottom(126)}`, mode: 'tap' },
  { code: 'KeyG', label: 'G', sub: 'NADE', size: 46, place: `right:30px;${bottom(188)}`, mode: 'tap' },
  // Left of the stick — build/paint modifiers, only while they mean something.
  { code: 'KeyQ', label: 'Q', sub: 'CYCLE', size: 44, place: `left:14px;${bottom(210)}`, mode: 'tap', weapons: BUILD_TOOLS },
  { code: 'KeyZ', label: 'Z', sub: 'WALL', size: 44, place: `left:66px;${bottom(210)}`, mode: 'tap', weapons: BUILD_TOOLS },
  { code: 'KeyX', label: 'X', sub: 'FLOOR', size: 44, place: `left:118px;${bottom(210)}`, mode: 'tap', weapons: BUILD_TOOLS },
  { code: 'KeyC', label: 'C', sub: 'STAIR', size: 44, place: `left:14px;${bottom(262)}`, mode: 'tap', weapons: BUILD_TOOLS },
  { code: 'KeyV', label: 'V', sub: 'ROOF', size: 44, place: `left:66px;${bottom(262)}`, mode: 'tap', weapons: BUILD_TOOLS },
  { code: 'KeyF', label: 'F', sub: 'EDIT', size: 44, place: `left:118px;${bottom(262)}`, mode: 'hold', weapons: BUILD_TOOLS },
  { code: 'KeyR', label: 'R', sub: 'TURN', size: 44, place: `left:14px;${bottom(314)}`, mode: 'tap', weapons: BUILD_TOOLS },
  { code: 'KeyU', label: 'U', sub: 'UNDO', size: 44, place: `left:66px;${bottom(314)}`, mode: 'tap', weapons: BUILD_TOOLS },
  { code: 'KeyR', label: 'R', sub: 'COLOR', size: 46, place: `left:14px;${bottom(210)}`, mode: 'tap', weapons: PAINT_TOOLS },
  // Top strip — session controls.
  { code: EXIT, label: '✕', sub: 'EXIT', size: 42, place: `left:12px;${top(12)}`, mode: 'tap' },
  { code: 'KeyI', label: 'I', sub: 'GEAR', size: 42, place: `left:62px;${top(12)}`, mode: 'tap' },
]

/** The weapon hotbar, tappable. Digit codes are what viewmodel.tsx consumes. */
export const WEAPON_SLOTS: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'Digit3', label: 'RIFLE' },
  { code: 'Digit2', label: 'PISTOL' },
  { code: 'Digit5', label: 'BIG' },
  { code: 'Digit4', label: 'BUILD' },
  { code: 'Digit6', label: 'HAMMER' },
  { code: 'Digit7', label: 'PAINT' },
  { code: 'Digit1', label: 'KNIFE' },
]

/** Which store weapon each slot selects — for the active highlight. */
export const SLOT_WEAPON: Record<string, string> = {
  Digit1: 'knife',
  Digit2: 'pistol',
  Digit3: 'rifle',
  Digit4: 'builder',
  Digit5: 'minigun',
  Digit6: 'hammer',
  Digit7: 'paint',
}

type Live = { spec: ButtonSpec; el: HTMLDivElement; releaseAt: number }

type Tracked =
  | { kind: 'stick' }
  | { kind: 'look'; x: number; y: number }
  | { kind: 'button'; live: Live }

export type TouchHooks = { onExit: () => void }

const BASE_BUTTON =
  'position:absolute;display:flex;flex-direction:column;align-items:center;justify-content:center;' +
  'border-radius:999px;background:rgba(16,18,20,0.44);border:1.5px solid rgba(255,255,255,0.30);' +
  'color:rgba(255,255,255,0.92);text-align:center;pointer-events:none;' +
  'box-shadow:0 2px 10px rgba(0,0,0,0.35);backface-visibility:hidden'

export class TouchControls {
  private root: HTMLDivElement | null = null
  private ring: HTMLDivElement | null = null
  private knob: HTMLDivElement | null = null
  private buttons: Live[] = []
  private slots: Array<{ code: string; el: HTMLDivElement }> = []
  private tracked = new Map<number, Tracked>()
  private stickOrigin = { x: 0, y: 0 }
  private detachFns: Array<() => void> = []
  private input: GameInput | null = null
  private hooks: TouchHooks | null = null
  private syncTimer: ReturnType<typeof setInterval> | null = null
  /** Sentinel: no real weapon id, so the first sync() always paints. */
  private weapon = ' '
  private standDown = false

  attach(container: HTMLElement, input: GameInput, hooks: TouchHooks): void {
    if (typeof document === 'undefined') return
    this.input = input
    this.hooks = hooks

    const root = document.createElement('div')
    root.dataset.bootsTouch = '1'
    root.style.cssText =
      'position:absolute;inset:0;z-index:2147483647;pointer-events:none;touch-action:none;' +
      'user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;' +
      "font:700 11px/1 system-ui,-apple-system,sans-serif;color:#fff"
    this.root = root

    // Stick ring — parked at the resting spot, moved to the thumb on contact.
    const ring = document.createElement('div')
    ring.style.cssText =
      `position:absolute;width:${STICK_RADIUS * 2}px;height:${STICK_RADIUS * 2}px;border-radius:999px;` +
      'border:2px solid rgba(255,255,255,0.22);background:rgba(12,14,16,0.24);' +
      'pointer-events:none;opacity:0.55;transition:opacity 120ms linear'
    const knob = document.createElement('div')
    knob.style.cssText =
      'position:absolute;width:52px;height:52px;border-radius:999px;left:50%;top:50%;' +
      'margin:-26px 0 0 -26px;background:rgba(255,255,255,0.30);' +
      'border:1.5px solid rgba(255,255,255,0.55);pointer-events:none'
    ring.appendChild(knob)
    root.appendChild(ring)
    this.ring = ring
    this.knob = knob
    this.parkRing()

    for (const spec of BUTTONS) {
      const el = document.createElement('div')
      el.dataset.bootsTouchButton = spec.code
      el.style.cssText =
        `${BASE_BUTTON};width:${spec.size}px;height:${spec.size}px;${spec.place};` +
        `border-color:${spec.accent ? 'rgba(255,204,51,0.62)' : 'rgba(255,255,255,0.30)'}`
      const label = document.createElement('div')
      label.textContent = spec.label
      label.style.cssText = `font-size:${spec.size >= 70 ? 15 : 13}px;letter-spacing:0.04em`
      el.appendChild(label)
      if (spec.sub) {
        const sub = document.createElement('div')
        sub.textContent = spec.sub
        sub.style.cssText = 'font-size:8px;opacity:0.62;margin-top:2px;letter-spacing:0.08em'
        el.appendChild(sub)
      }
      root.appendChild(el)
      this.buttons.push({ spec, el, releaseAt: 0 })
    }

    // Weapon hotbar, right edge — one tap per slot.
    const strip = document.createElement('div')
    strip.style.cssText =
      `position:absolute;right:6px;${top(64)};display:flex;flex-direction:column;gap:5px;pointer-events:none`
    for (const slot of WEAPON_SLOTS) {
      const el = document.createElement('div')
      el.dataset.bootsTouchButton = slot.code
      el.textContent = slot.label
      el.style.cssText =
        'position:relative;min-width:52px;padding:6px 7px;border-radius:7px;text-align:center;' +
        'background:rgba(16,18,20,0.44);border:1px solid rgba(255,255,255,0.22);' +
        'font-size:9px;letter-spacing:0.06em;pointer-events:none'
      strip.appendChild(el)
      this.slots.push({ code: slot.code, el })
      this.buttons.push({
        spec: { code: slot.code, label: slot.label, size: 0, place: '', mode: 'tap' },
        el,
        releaseAt: 0,
      })
    }
    root.appendChild(strip)

    container.appendChild(root)

    // Window capture, registered BEFORE input.attach — see the header.
    const on = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void) => {
      const wrapped = fn as EventListener
      window.addEventListener(type, wrapped, { capture: true })
      this.detachFns.push(() => window.removeEventListener(type, wrapped, { capture: true }))
    }
    on('pointerdown', (e) => this.onDown(e))
    on('pointermove', (e) => this.onMove(e))
    on('pointerup', (e) => this.onUp(e))
    on('pointercancel', (e) => this.onUp(e))

    // The container must not scroll, rubber-band or zoom under a thumb.
    const prevTouchAction = container.style.touchAction
    const prevOverscroll = document.body.style.overscrollBehavior
    container.style.touchAction = 'none'
    document.body.style.overscrollBehavior = 'none'
    this.detachFns.push(() => {
      container.style.touchAction = prevTouchAction
      document.body.style.overscrollBehavior = prevOverscroll
    })

    this.sync()
    this.syncTimer = setInterval(() => this.sync(), 140)
  }

  /** Weapon-conditional visibility, catalog stand-down, hotbar highlight, and
   * the minimum-hold release for taps that were shorter than a frame. */
  private sync(): void {
    const input = this.input
    if (!input || !this.root) return
    const menu = input.menuOpen === true
    if (menu !== this.standDown) {
      this.standDown = menu
      this.root.style.display = menu ? 'none' : ''
      if (menu) this.releaseAll()
    }
    if (menu) return

    const weapon = String((useBoots.getState() as { weapon?: string }).weapon ?? '')
    if (weapon !== this.weapon) {
      this.weapon = weapon
      for (const live of this.buttons) {
        if (!live.spec.weapons) continue
        live.el.style.display = live.spec.weapons.includes(weapon) ? '' : 'none'
      }
      for (const slot of this.slots) {
        const active = SLOT_WEAPON[slot.code] === weapon
        slot.el.style.background = active ? 'rgba(255,204,51,0.30)' : 'rgba(16,18,20,0.44)'
        slot.el.style.borderColor = active ? 'rgba(255,204,51,0.70)' : 'rgba(255,255,255,0.22)'
      }
    }

    const now = Date.now()
    for (const live of this.buttons) {
      if (live.releaseAt > 0 && now >= live.releaseAt) this.releaseButton(live)
    }
  }

  private parkRing(): void {
    const ring = this.ring
    if (!ring) return
    ring.style.left = '30px'
    ring.style.bottom = 'calc(96px + env(safe-area-inset-bottom, 0px))'
    ring.style.top = ''
    ring.style.opacity = '0.4'
    this.moveKnob(0, 0)
  }

  private moveKnob(dx: number, dy: number): void {
    if (this.knob) this.knob.style.transform = `translate(${dx}px, ${dy}px)`
  }

  /** The left-thumb half: left of centre, below the upper 42%. */
  private inStickZone(x: number, y: number): boolean {
    const w = window.innerWidth || 1
    const h = window.innerHeight || 1
    return x < w * 0.5 && y > h * 0.42
  }

  private buttonAt(x: number, y: number): Live | null {
    for (const live of this.buttons) {
      if (live.el.style.display === 'none') continue
      const r = live.el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) continue
      // A little slop: thumbs land wide, and a missed FIRE is the whole game.
      const pad = 6
      if (x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad) {
        return live
      }
    }
    return null
  }

  private pressButton(live: Live): void {
    const input = this.input
    if (!input) return
    const { spec } = live
    live.el.style.background = spec.accent ? 'rgba(255,204,51,0.34)' : 'rgba(255,255,255,0.26)'
    if (spec.code === EXIT) {
      this.hooks?.onExit()
      return
    }
    if (spec.code === FIRE) {
      input.state.firing = true
      return
    }
    if (spec.code === AIM) {
      input.state.altFiring = true
      return
    }
    // A real key press: held membership AND the one-shot action, exactly as
    // input.ts's keydown does, so both consumer styles see it.
    if (!input.state.keys.has(spec.code)) {
      input.state.keys.add(spec.code)
      input.state.actions.push(spec.code)
    }
    if (spec.mode === 'tap') live.releaseAt = Date.now() + TAP_HOLD_MS
  }

  private releaseButton(live: Live): void {
    const input = this.input
    live.releaseAt = 0
    live.el.style.background = 'rgba(16,18,20,0.44)'
    if (!input) return
    const { code } = live.spec
    if (code === FIRE) input.state.firing = false
    else if (code === AIM) input.state.altFiring = false
    else if (code !== EXIT) input.state.keys.delete(code)
    // The hotbar's active chip repaints on the next sync tick.
    this.weapon = ' '
  }

  private onDown(e: PointerEvent): void {
    const input = this.input
    if (!input || this.standDown || input.menuOpen) return
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return
    const live = this.buttonAt(e.clientX, e.clientY)
    if (live) {
      this.tracked.set(e.pointerId, { kind: 'button', live })
      this.pressButton(live)
      return
    }
    if (this.inStickZone(e.clientX, e.clientY)) {
      this.tracked.set(e.pointerId, { kind: 'stick' })
      this.stickOrigin = { x: e.clientX, y: e.clientY }
      const ring = this.ring
      if (ring) {
        ring.style.left = `${e.clientX - STICK_RADIUS}px`
        ring.style.top = `${e.clientY - STICK_RADIUS}px`
        ring.style.bottom = ''
        ring.style.opacity = '0.72'
      }
      this.applyStick(0, 0)
      return
    }
    this.tracked.set(e.pointerId, { kind: 'look', x: e.clientX, y: e.clientY })
  }

  private onMove(e: PointerEvent): void {
    const input = this.input
    const track = this.tracked.get(e.pointerId)
    if (!input || !track) return
    if (track.kind === 'stick') {
      this.applyStick(e.clientX - this.stickOrigin.x, e.clientY - this.stickOrigin.y)
      return
    }
    if (track.kind === 'look') {
      input.state.lookX += (e.clientX - track.x) * LOOK_GAIN
      input.state.lookY += (e.clientY - track.y) * LOOK_GAIN
      track.x = e.clientX
      track.y = e.clientY
      return
    }
    // A thumb that slides far off a held button releases it (a slip should not
    // leave FIRE stuck down).
    const r = track.live.el.getBoundingClientRect()
    const slop = 28
    if (
      e.clientX < r.left - slop ||
      e.clientX > r.right + slop ||
      e.clientY < r.top - slop ||
      e.clientY > r.bottom + slop
    ) {
      this.releaseButton(track.live)
      this.tracked.delete(e.pointerId)
    }
  }

  private onUp(e: PointerEvent): void {
    const track = this.tracked.get(e.pointerId)
    if (!track) return
    this.tracked.delete(e.pointerId)
    if (track.kind === 'stick') {
      this.clearMove()
      this.parkRing()
      return
    }
    if (track.kind === 'button') {
      const { live } = track
      // Honour the minimum hold so a stab still registers; sync() finishes it.
      if (live.spec.mode === 'tap' && live.releaseAt > Date.now()) return
      this.releaseButton(live)
    }
  }

  private applyStick(dx: number, dy: number): void {
    const input = this.input
    if (!input) return
    const { nx, ny } = stickVector(dx, dy)
    const { codes, sprint } = stickKeys(nx, ny)
    const keys = input.state.keys
    for (const code of MOVE_CODES) {
      const want = code === 'ShiftLeft' ? sprint : codes.includes(code)
      if (want) keys.add(code)
      else keys.delete(code)
    }
    const len = Math.hypot(dx, dy)
    const cap = len > STICK_RADIUS ? STICK_RADIUS / len : 1
    this.moveKnob(dx * cap, dy * cap)
    if (this.ring) this.ring.style.borderColor = sprint ? 'rgba(255,204,51,0.60)' : 'rgba(255,255,255,0.22)'
  }

  private clearMove(): void {
    const keys = this.input?.state.keys
    if (!keys) return
    for (const code of MOVE_CODES) keys.delete(code)
  }

  private releaseAll(): void {
    for (const live of this.buttons) if (live.releaseAt !== 0 || live.spec.mode === 'hold') this.releaseButton(live)
    this.clearMove()
    this.tracked.clear()
    this.parkRing()
  }

  detach(): void {
    if (this.syncTimer) clearInterval(this.syncTimer)
    this.syncTimer = null
    this.releaseAll()
    for (const fn of this.detachFns) fn()
    this.detachFns = []
    this.root?.remove()
    this.root = null
    this.ring = null
    this.knob = null
    this.buttons = []
    this.slots = []
    this.tracked.clear()
    this.input = null
    this.hooks = null
    this.weapon = ''
    this.standDown = false
  }
}
