import { useBoots } from '../store'

/**
 * DOM HUD, mounted INSIDE the fullscreen element (the canvas' parent) so it
 * survives `requestFullscreen`. Imperative updates (no React) — the hot
 * path pokes textContent/opacity directly.
 */

const FONT = "600 13px/1.2 system-ui, -apple-system, sans-serif"

const WEAPON_LABEL: Record<string, string> = {
  knife: 'KNIFE',
  pistol: 'PISTOL',
  rifle: 'RIFLE',
  builder: 'BUILD',
}

export class Hud {
  private root: HTMLDivElement | null = null
  private weaponEl: HTMLDivElement | null = null
  private healthEl: HTMLDivElement | null = null
  private promptEl: HTMLDivElement | null = null
  private hitmarkerEl: HTMLDivElement | null = null
  private vignetteEl: HTMLDivElement | null = null
  private waveEl: HTMLDivElement | null = null
  private unsub: (() => void) | null = null
  private hitTimer: ReturnType<typeof setTimeout> | null = null
  /** Which system's text the prompt line currently shows (see prompt()). */
  private promptOwner: string | null = null

  mount(container: HTMLElement): void {
    const root = document.createElement('div')
    root.id = 'boots-hud'
    root.style.cssText =
      'position:absolute;inset:0;pointer-events:none;z-index:2147483646;user-select:none;font-family:system-ui'
    this.root = root

    const el = (css: string, text = ''): HTMLDivElement => {
      const div = document.createElement('div')
      div.style.cssText = css
      div.textContent = text
      root.appendChild(div)
      return div
    }

    // Crosshair — four ticks + dot, tactical-shooter style but ours.
    const cross = el('position:absolute;left:50%;top:50%;width:0;height:0')
    for (const [x, y, w, h] of [
      [-1, -9, 2, 6],
      [-1, 3, 2, 6],
      [-9, -1, 6, 2],
      [3, -1, 6, 2],
    ] as const) {
      const tick = document.createElement('div')
      tick.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;background:rgba(80,255,120,0.9);box-shadow:0 0 2px rgba(0,0,0,0.8)`
      cross.appendChild(tick)
    }

    this.hitmarkerEl = el(
      'position:absolute;left:50%;top:50%;width:0;height:0;opacity:0;transition:opacity 0.12s',
    )
    for (const rot of [45, 135, 225, 315]) {
      const arm = document.createElement('div')
      arm.style.cssText = `position:absolute;left:-1px;top:-14px;width:2px;height:8px;background:#fff;transform:rotate(${rot}deg);transform-origin:1px 14px`
      this.hitmarkerEl.appendChild(arm)
    }

    this.vignetteEl = el(
      'position:absolute;inset:0;box-shadow:inset 0 0 140px 40px rgba(255,30,30,0.55);opacity:0;transition:opacity 0.25s',
    )

    this.weaponEl = el(
      `position:absolute;right:28px;bottom:24px;color:#fff;font:${FONT};font-size:15px;letter-spacing:0.12em;text-shadow:0 1px 3px rgba(0,0,0,0.8);text-align:right`,
    )
    this.healthEl = el(
      `position:absolute;left:28px;bottom:24px;color:#fff;font:${FONT};font-size:20px;text-shadow:0 1px 3px rgba(0,0,0,0.8)`,
    )
    this.waveEl = el(
      `position:absolute;left:50%;top:20px;transform:translateX(-50%);color:#fff;font:${FONT};letter-spacing:0.1em;text-shadow:0 1px 3px rgba(0,0,0,0.8)`,
    )
    this.promptEl = el(
      `position:absolute;left:50%;bottom:96px;transform:translateX(-50%);color:#fff;font:${FONT};background:rgba(0,0,0,0.5);padding:6px 12px;border-radius:6px;opacity:0`,
    )
    el(
      `position:absolute;left:50%;bottom:28px;transform:translateX(-50%);padding:8px 16px;border-radius:999px;background:rgba(0,0,0,0.55);color:#fff;font:${FONT};letter-spacing:0.04em`,
      'Esc to exit',
    )

    container.appendChild(root)

    const render = () => {
      const s = useBoots.getState()
      if (this.weaponEl) {
        const label = WEAPON_LABEL[s.weapon] ?? s.weapon.toUpperCase()
        this.weaponEl.textContent = s.weapon === 'builder' ? `${label} · ${s.buildPiece.toUpperCase()} (Q)` : label
      }
      if (this.healthEl) this.healthEl.textContent = `♥ ${Math.max(0, Math.round(s.health))}`
    }
    render()
    this.unsub = useBoots.subscribe(render)
  }

  /**
   * Interaction prompt, shared by several systems (gun table, doors…).
   * Showing text is last-writer-wins and records `owner`; clearing only
   * takes effect while that same owner still holds the line, so a stale
   * `prompt(null, 'doors')` can't blank the gun table's text (and vice
   * versa). Single-arg callers all share the 'default' owner (old
   * behavior).
   */
  prompt(text: string | null, owner = 'default'): void {
    if (!this.promptEl) return
    if (text) {
      this.promptOwner = owner
      this.promptEl.textContent = text
      this.promptEl.style.opacity = '1'
      return
    }
    if (this.promptOwner !== null && this.promptOwner !== owner) return
    this.promptOwner = null
    this.promptEl.textContent = ''
    this.promptEl.style.opacity = '0'
  }

  wave(text: string | null): void {
    if (this.waveEl) this.waveEl.textContent = text ?? ''
  }

  hitmarker(): void {
    if (!this.hitmarkerEl) return
    this.hitmarkerEl.style.opacity = '1'
    if (this.hitTimer) clearTimeout(this.hitTimer)
    this.hitTimer = setTimeout(() => {
      if (this.hitmarkerEl) this.hitmarkerEl.style.opacity = '0'
    }, 90)
  }

  damageFlash(): void {
    if (!this.vignetteEl) return
    this.vignetteEl.style.opacity = '1'
    setTimeout(() => {
      if (this.vignetteEl) this.vignetteEl.style.opacity = '0'
    }, 220)
  }

  unmount(): void {
    this.unsub?.()
    this.unsub = null
    this.promptOwner = null
    if (this.hitTimer) clearTimeout(this.hitTimer)
    this.root?.remove()
    this.root = null
  }
}
