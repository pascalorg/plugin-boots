import { useBoots } from '../store'

/**
 * DOM HUD, mounted INSIDE the fullscreen element (the canvas' parent) so it
 * survives `requestFullscreen`. Imperative updates (no React) — the hot
 * path pokes textContent/opacity directly.
 *
 * Damage-feel API:
 * - damageFlash(angle?) — directional hit feedback. `angle` is SCREEN-relative
 *   radians, 0 = hit from ahead, positive clockwise (π/2 = from the right).
 *   Lights the nearest screen edge(s) strongly; with no angle all four edges
 *   glow softly. Backward compatible with the old zero-arg call.
 * - Low-HP vignette: automatic. A persistent red vignette whose opacity tracks
 *   health (0 above 45hp → strong at 10hp) and pulses on a heartbeat whose
 *   rate rises as health falls. Driven from the store subscription; no work
 *   at all while healthy.
 * - Stagger overlay: automatic while `store.staggered` is true (set by
 *   player.tsx's stagger loop) — heavy red pulse + centered 'shake it off'.
 */

const FONT = "600 13px/1.2 system-ui, -apple-system, sans-serif"

/** Screen angles of the four edge-glow strips: top, right, bottom, left. */
const EDGE_ANGLES = [0, Math.PI / 2, Math.PI, -Math.PI / 2] as const

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
  private edgeEls: HTMLDivElement[] | null = null
  private lowHpEl: HTMLDivElement | null = null
  private staggerEl: HTMLDivElement | null = null
  private waveEl: HTMLDivElement | null = null
  private unsub: (() => void) | null = null
  private hitTimer: ReturnType<typeof setTimeout> | null = null
  private flashTimer: ReturnType<typeof setTimeout> | null = null
  private beatTimer: ReturnType<typeof setTimeout> | null = null
  private relaxTimer: ReturnType<typeof setTimeout> | null = null
  /** Low-HP severity 0..1 (0 above 45hp, 1 at ≤10hp) — set by the store sub. */
  private lowHp = 0
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

    // Directional damage: four edge-glow strips (top/right/bottom/left).
    const GLOW = 'rgba(255,25,25,0.9)'
    this.edgeEls = [
      el(
        `position:absolute;left:0;right:0;top:0;height:26%;background:linear-gradient(to bottom,${GLOW},rgba(255,25,25,0) 75%);opacity:0`,
      ),
      el(
        `position:absolute;top:0;bottom:0;right:0;width:26%;background:linear-gradient(to left,${GLOW},rgba(255,25,25,0) 75%);opacity:0`,
      ),
      el(
        `position:absolute;left:0;right:0;bottom:0;height:26%;background:linear-gradient(to top,${GLOW},rgba(255,25,25,0) 75%);opacity:0`,
      ),
      el(
        `position:absolute;top:0;bottom:0;left:0;width:26%;background:linear-gradient(to right,${GLOW},rgba(255,25,25,0) 75%);opacity:0`,
      ),
    ]

    // Persistent low-HP vignette — opacity follows health, pulses on a beat.
    this.lowHpEl = el(
      'position:absolute;inset:0;box-shadow:inset 0 0 160px 60px rgba(200,10,10,0.75);opacity:0;transition:opacity 0.4s',
    )

    // Stagger overlay — heavy red pulse + 'shake it off' while store.staggered.
    const staggerStyle = document.createElement('style')
    staggerStyle.textContent =
      '@keyframes boots-stagger{0%,100%{opacity:0.5}50%{opacity:0.95}}'
    root.appendChild(staggerStyle)
    this.staggerEl = el(
      'position:absolute;inset:0;display:none;background:radial-gradient(ellipse at center,rgba(120,0,0,0.2) 30%,rgba(200,15,15,0.85));animation:boots-stagger 0.5s ease-in-out infinite',
    )
    const staggerText = document.createElement('div')
    staggerText.style.cssText = `position:absolute;left:50%;top:38%;transform:translateX(-50%);color:#fff;font:${FONT};letter-spacing:0.22em;text-shadow:0 1px 4px rgba(0,0,0,0.9)`
    staggerText.textContent = 'shake it off'
    this.staggerEl.appendChild(staggerText)

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

      // Low-HP vignette severity: 0 above 45hp, ramping to 1 at 10hp.
      const lowHp = Math.min(1, Math.max(0, (45 - s.health) / 35))
      const wasLow = this.lowHp > 0
      this.lowHp = lowHp
      if (lowHp > 0 && !wasLow) {
        // A beat from a previous low spell may still be queued — restart clean.
        if (this.beatTimer) clearTimeout(this.beatTimer)
        this.beat()
      } else if (lowHp === 0 && wasLow && this.lowHpEl) {
        this.lowHpEl.style.transition = 'opacity 0.4s'
        this.lowHpEl.style.opacity = '0'
      }

      // Stagger overlay — `staggered` is set by player.tsx's stagger loop.
      if (this.staggerEl) this.staggerEl.style.display = s.staggered ? 'block' : 'none'
    }
    render()
    this.unsub = useBoots.subscribe(render)
  }

  /**
   * One heartbeat of the low-HP vignette: quick swell to a peak, slow relax
   * to a rest level, then re-arm. Rate and depth scale with severity. Chained
   * setTimeout (not setInterval) so the rate tracks health between beats;
   * self-terminates the moment severity returns to 0.
   */
  private beat = (): void => {
    this.beatTimer = null
    const el = this.lowHpEl
    if (!el || this.lowHp <= 0) return
    el.style.transition = 'opacity 0.08s'
    el.style.opacity = String(Math.min(1, 0.4 * this.lowHp + 0.35))
    if (this.relaxTimer) clearTimeout(this.relaxTimer)
    this.relaxTimer = setTimeout(() => {
      this.relaxTimer = null
      if (!this.lowHpEl) return
      this.lowHpEl.style.transition = 'opacity 0.45s'
      this.lowHpEl.style.opacity = String(this.lowHp <= 0 ? 0 : 0.4 * this.lowHp)
    }, 150)
    const bpm = 55 + this.lowHp * 75 // ~55bpm at the threshold → ~130 at 10hp
    this.beatTimer = setTimeout(this.beat, 60000 / bpm)
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

  /**
   * Directional damage flash. `angle` is screen-relative radians (0 = hit
   * from ahead, positive clockwise): the edge(s) facing the hit light up
   * strongly with a cosine falloff, so diagonal hits split across two edges.
   * No angle → all four edges glow softly (old zero-arg behavior).
   */
  damageFlash(angle?: number): void {
    const edges = this.edgeEls
    if (!edges) return
    for (let i = 0; i < 4; i++) {
      const edge = edges[i]
      if (!edge) continue
      let opacity: number
      if (angle === undefined) opacity = 0.4
      else {
        const facing = Math.cos(angle - EDGE_ANGLES[i]!)
        opacity = facing <= 0 ? 0 : Math.min(0.95, 0.15 + 0.85 * facing ** 1.6)
      }
      edge.style.transition = 'opacity 0.05s'
      edge.style.opacity = String(opacity)
    }
    if (this.flashTimer) clearTimeout(this.flashTimer)
    this.flashTimer = setTimeout(() => {
      this.flashTimer = null
      if (!this.edgeEls) return
      for (const edge of this.edgeEls) {
        edge.style.transition = 'opacity 0.5s'
        edge.style.opacity = '0'
      }
    }, 140)
  }

  unmount(): void {
    this.unsub?.()
    this.unsub = null
    this.promptOwner = null
    this.lowHp = 0
    if (this.hitTimer) clearTimeout(this.hitTimer)
    if (this.flashTimer) clearTimeout(this.flashTimer)
    if (this.beatTimer) clearTimeout(this.beatTimer)
    if (this.relaxTimer) clearTimeout(this.relaxTimer)
    this.hitTimer = this.flashTimer = this.beatTimer = this.relaxTimer = null
    this.root?.remove()
    this.root = null
    this.edgeEls = null
    this.lowHpEl = null
    this.staggerEl = null
  }
}
