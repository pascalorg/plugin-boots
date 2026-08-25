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
  'Digit1',
  'Digit2',
  'Digit3',
  'Digit4',
  'Digit5',
  'Digit6',
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

    on('keydown', (e) => {
      if (e.code === 'Escape' && !this.pointerLocked) {
        this.onEscape?.()
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
      if (!GAME_KEYS.has(e.code)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      this.state.keys.delete(e.code)
    })
    on('mousemove', (e) => {
      if (!this.pointerLocked) return
      e.stopImmediatePropagation()
      this.state.lookX += e.movementX
      this.state.lookY += e.movementY
    })
    on('pointerdown', (e) => {
      e.preventDefault()
      e.stopImmediatePropagation()
      if (!this.pointerLocked) {
        if (this.relockOnClick) this.requestLock()
        return
      }
      if (e.button === 0) this.state.firing = true
      if (e.button === 2) this.state.altFiring = true
    })
    on('pointerup', (e) => {
      e.preventDefault()
      e.stopImmediatePropagation()
      if (e.button === 0) this.state.firing = false
      if (e.button === 2) this.state.altFiring = false
    })
    for (const type of ['click', 'dblclick', 'contextmenu', 'mousedown', 'mouseup'] as const) {
      on(type, (e) => {
        e.preventDefault()
        e.stopImmediatePropagation()
      })
    }
    on('wheel', (e) => {
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
