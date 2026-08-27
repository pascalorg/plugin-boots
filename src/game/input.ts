/**
 * Game input: pointer lock + capture-phase interception so the host editor
 * never sees a keystroke or click while the game runs (no tool hotkeys, no
 * selections, no camera zoom). Esc is deliberately NOT handled here — the
 * browser releases the pointer lock, and the session watches for that.
 */

export type GameInputState = {
  keys: Set<string>
  /** Accumulated look deltas since last consume (pixels). */
  lookX: number
  lookY: number
  firing: boolean
  altFiring: boolean
  /** One-shot queue of discrete actions (weapon slots, interact, cycle). */
  actions: string[]
}

const GAME_KEYS = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'Space',
  'ShiftLeft',
  'ShiftRight',
  'KeyE',
  'KeyQ',
  'KeyR',
  'KeyB',
  'KeyF',
  'KeyG',
  'KeyZ',
  'KeyX',
  'KeyC',
  'KeyV',
  'KeyU',
  'KeyI',
  'Digit1',
  'Digit2',
  'Digit3',
  'Digit4',
  'Digit5',
  'Digit6',
  'Digit7',
  'Tab',
])

export class GameInput {
  state: GameInputState = {
    keys: new Set(),
    lookX: 0,
    lookY: 0,
    firing: false,
    altFiring: false,
    actions: [],
  }

  /** Fallback exit path: with an engaged pointer lock the browser eats Esc
   * (releasing the lock, which the session watches); without one — lock
   * denied or already released — this fires instead. */
  onEscape: (() => void) | null = null

  /** Item-catalog latch (inventory.tsx): while set, every keydown routes to
   * onMenuKey instead of the game state and pointer/wheel events pass
   * through UNTOUCHED only inside the session container (the menu's home;
   * anything outside — host editor UI in a windowed session — stays
   * swallowed). The menu clears held keys/buttons when it opens, so
   * nothing sticks. */
  menuOpen = false
  onMenuKey: ((code: string) => void) | null = null

  private canvas: HTMLCanvasElement | null = null
  private detachFns: Array<() => void> = []
  private relockOnClick = false

  get pointerLocked(): boolean {
    return typeof document !== 'undefined' && document.pointerLockElement === this.canvas
  }

  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas
    const on = <K extends keyof WindowEventMap>(
      type: K,
      handler: (e: WindowEventMap[K]) => void,
    ) => {
      const wrapped = handler as EventListener
      window.addEventListener(type, wrapped, { capture: true })
      this.detachFns.push(() => window.removeEventListener(type, wrapped, { capture: true }))
    }

    // While the item catalog is open, pointer/wheel events belong to the
    // menu DOM — which lives INSIDE the session container. In a windowed
    // session (fullscreen denied/rejected) host editor UI outside the
    // container is still on screen; those events stay swallowed so the
    // editor never sees a click mid-game.
    const menuPasses = (e: Event): boolean => {
      const container = this.canvas?.parentElement
      return container != null && e.target instanceof Node && container.contains(e.target)
    }
    const menuGate = (e: Event): void => {
      if (menuPasses(e)) return
      e.preventDefault()
      e.stopImmediatePropagation()
    }

    on('keydown', (e) => {
      if (e.code === 'Escape' && !this.pointerLocked) {
        this.onEscape?.()
        return
      }
      if (this.menuOpen) {
        e.preventDefault()
        e.stopImmediatePropagation()
        this.onMenuKey?.(e.code)
        return
      }
      if (!GAME_KEYS.has(e.code)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      if (!this.state.keys.has(e.code)) {
        this.state.keys.add(e.code)
        this.state.actions.push(e.code)
      }
    })
    on('keyup', (e) => {
      if (this.menuOpen) {
        e.preventDefault()
        e.stopImmediatePropagation()
        return
      }
      if (!GAME_KEYS.has(e.code)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      this.state.keys.delete(e.code)
    })
    // Button state comes from the `buttons` BITMASK, synced on every mouse
    // event — per the Pointer Events spec, pressing a SECOND button while
    // one is held fires only a move event (no new pointerdown), so
    // down/up-only tracking loses "left-click while aiming" entirely (the
    // 2026-08-25 "can't fire while ADS" bug).
    const syncButtons = (buttons: number) => {
      this.state.firing = (buttons & 1) !== 0
      this.state.altFiring = (buttons & 2) !== 0
    }
    on('mousemove', (e) => {
      if (!this.pointerLocked) return
      e.stopImmediatePropagation()
      this.state.lookX += e.movementX
      this.state.lookY += e.movementY
      syncButtons(e.buttons)
    })
    on('pointerdown', (e) => {
      if (this.menuOpen) {
        menuGate(e)
        return
      }
      e.preventDefault()
      e.stopImmediatePropagation()
      if (!this.pointerLocked) {
        if (this.relockOnClick) this.requestLock()
        return
      }
      syncButtons(e.buttons)
    })
    on('pointerup', (e) => {
      if (this.menuOpen) {
        menuGate(e)
        return
      }
      e.preventDefault()
      e.stopImmediatePropagation()
      syncButtons(e.buttons)
    })
    // mousedown/mouseup DO fire per button (unlike pointerdown, which skips
    // secondary buttons while one is held) — they are the reliable
    // transition source when the mouse is perfectly still, e.g. a careful
    // ADS click ("multiple clicks per shot" bug, 2026-08-25).
    for (const type of ['mousedown', 'mouseup'] as const) {
      on(type, (e) => {
        if (this.menuOpen) {
          menuGate(e)
          return
        }
        e.preventDefault()
        e.stopImmediatePropagation()
        if (this.pointerLocked) syncButtons(e.buttons)
      })
    }
    for (const type of ['click', 'dblclick', 'contextmenu'] as const) {
      on(type, (e) => {
        if (this.menuOpen) {
          menuGate(e)
          return
        }
        e.preventDefault()
        e.stopImmediatePropagation()
      })
    }
    on('wheel', (e) => {
      if (this.menuOpen) {
        menuGate(e)
        return
      }
      e.preventDefault()
      e.stopImmediatePropagation()
      this.state.actions.push(e.deltaY > 0 ? 'WheelDown' : 'WheelUp')
    })

    this.relockOnClick = true
    this.requestLock()
  }

  requestLock(): void {
    // Some browsers return a promise that rejects (e.g. WrongDocumentError
    // right after fullscreen churn), others return undefined — swallow both.
    try {
      const result = this.canvas?.requestPointerLock?.() as unknown
      if (result instanceof Promise) result.catch(() => {})
    } catch {
      // ignore — relock-on-click will retry
    }
  }

  /** Read-and-clear the accumulated look delta. */
  consumeLook(): { dx: number; dy: number } {
    const dx = this.state.lookX
    const dy = this.state.lookY
    this.state.lookX = 0
    this.state.lookY = 0
    return { dx, dy }
  }

  /** Read-and-clear queued one-shot actions. */
  consumeActions(): string[] {
    const actions = this.state.actions
    this.state.actions = []
    return actions
  }

  detach(): void {
    this.relockOnClick = false
    this.menuOpen = false
    this.onMenuKey = null
    for (const fn of this.detachFns) fn()
    this.detachFns = []
    this.state.keys.clear()
    this.state.firing = false
    this.state.altFiring = false
    this.state.actions = []
    if (this.pointerLocked) document.exitPointerLock()
    this.canvas = null
  }
}
