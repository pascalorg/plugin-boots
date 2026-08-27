import { useBoots } from '../store'
import { heartbeatBpm, setHeartbeatPulseListener } from './audio'
import type { TargetResult } from './grid'

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
 *   health (0 above 45hp → strong at 10hp) and pulses on a heartbeat paced by
 *   audio.ts's heartbeatBpm(health) — the SAME mapping the audible lub-dub
 *   uses, so red pulse and sound never drift. Driven from the store
 *   subscription; no work at all while healthy.
 * - beatPulse(delayMs) — phase lock: retimes the next visual beat to land
 *   `delayMs` from now. mount() registers it with audio.ts's
 *   setHeartbeatPulseListener, so every scheduled audible lub re-times the
 *   vignette pulse onto the sound; if audio is silent/unavailable the beat
 *   keeps self-timing at heartbeatBpm(health) as a fallback.
 * - Stagger overlay: automatic while `store.staggered` is true (set by
 *   player.tsx's stagger loop) — heavy red pulse + centered 'shake it off'.
 *   Painted UNDER the directional edge-glow strips (DOM order) so damage
 *   flashes stay readable during a stagger.
 * - editHint(text | null) — persistent mode-hint line for the builder's F
 *   edit mode ('F done · LMB carve · RMB reset'), on its OWN element above
 *   the shared prompt() line so door/table prompts never clobber it. Last
 *   write wins; null hides it. Cleared automatically on unmount.
 * - ghostStatus(reason | null, owner?) — tiny build-ghost status line just
 *   under the crosshair while the builder is active. Feed it the failing
 *   `TargetResult.reason` from grid.ts's resolveTargetSlot each frame
 *   ('unsupported' → 'needs support', 'occupied' → 'occupied',
 *   'out-of-reach' → 'too far'); 'ok' or null blanks it. Owner-keyed like
 *   prompt() (show = last-writer-wins, clear only while that owner holds
 *   the line) and change-gated, so per-frame calls are free while the
 *   reason holds. Wired caller: builder.tsx's grid-locked ghost frame loop —
 *   `hud.ghostStatus?.(target.valid ? null : target.reason, 'builder')`,
 *   the FULL failing reason of grid.resolveTargetSlot's TargetResult (all
 *   three can occur now; the vocabulary stays the grid.ts alias).
 * - grenadePip(readyFraction) — bottom-right dot + 'G' label above the
 *   weapon line. 0 = just thrown (dim), ramps brighter across the 5s
 *   cooldown, ≥1 = ready (full bright, dot turns green). grenade.tsx
 *   drives it per frame from grenadeCooldownLeft()/GRENADE_COOLDOWN
 *   (guarded: `hud.grenadePip?.(f)`); writes are change-gated so per-frame
 *   calls are free while the value holds.
 * - setAds(v) — aim-down-sights crosshair morph, v in 0..1: the four
 *   crosshair ticks fade OUT and a small center dot fades IN as v→1.
 *   viewmodel.tsx drives it per frame from playerRig.ads (guarded:
 *   `hud.setAds?.(v)`); change-gated like grenadePip.
 */

const FONT = "600 13px/1.2 system-ui, -apple-system, sans-serif"

/** Screen angles of the four edge-glow strips: top, right, bottom, left. */
const EDGE_ANGLES = [0, Math.PI / 2, Math.PI, -Math.PI / 2] as const

/** Build-ghost reason, aliased from grid.ts so the two can never drift. */
export type GhostReason = TargetResult['reason']

const GHOST_REASON_LABEL: Record<Exclude<GhostReason, 'ok'>, string> = {
  unsupported: 'needs support',
  occupied: 'occupied',
  'out-of-reach': 'too far',
}

const WEAPON_LABEL: Record<string, string> = {
  knife: 'KNIFE',
  pistol: 'PISTOL',
  rifle: 'RIFLE',
  minigun: 'THE BIG ONE',
  builder: 'BUILD',
  hammer: 'HAMMER',
  paint: 'PAINT',
}

export class Hud {
  private root: HTMLDivElement | null = null
  private weaponEl: HTMLDivElement | null = null
  private healthEl: HTMLDivElement | null = null
  private promptEl: HTMLDivElement | null = null
  private editHintEl: HTMLDivElement | null = null
  private ghostStatusEl: HTMLDivElement | null = null
  private hitmarkerEl: HTMLDivElement | null = null
  private edgeEls: HTMLDivElement[] | null = null
  private lowHpEl: HTMLDivElement | null = null
  private staggerEl: HTMLDivElement | null = null
  private waveEl: HTMLDivElement | null = null
  private pipEl: HTMLDivElement | null = null
  private pipDotEl: HTMLDivElement | null = null
  private paintEl: HTMLDivElement | null = null
  private paintDotEl: HTMLDivElement | null = null
  private crossTicksEl: HTMLDivElement | null = null
  private crossDotEl: HTMLDivElement | null = null
  private unsub: (() => void) | null = null
  private hitTimer: ReturnType<typeof setTimeout> | null = null
  private flashTimer: ReturnType<typeof setTimeout> | null = null
  private beatTimer: ReturnType<typeof setTimeout> | null = null
  private relaxTimer: ReturnType<typeof setTimeout> | null = null
  /** Low-HP severity 0..1 (0 above 45hp, 1 at ≤10hp) — set by the store sub. */
  private lowHp = 0
  /** Last health seen by the store sub — feeds heartbeatBpm() in beat(). */
  private health = 100
  /** Which system's text the prompt line currently shows (see prompt()). */
  private promptOwner: string | null = null
  /** Which system's reason the ghost-status line shows (see ghostStatus()). */
  private ghostOwner: string | null = null
  /** Last ghostStatus() reason written (change gate; per-frame calls are free). */
  private lastGhostReason: GhostReason | null = null
  /** Last grenadePip() fraction written (change gate; -1 = never). */
  private pipF = -1
  /** Last setAds() value written (change gate; -1 = never). */
  private lastAds = -1

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

    // Crosshair — four ticks (hip) that ADS morphs into a lone center dot:
    // setAds(v) cross-fades ticks (1-v) against the dot (v).
    const cross = el('position:absolute;left:50%;top:50%;width:0;height:0')
    this.crossTicksEl = cross
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
    // ADS center dot — sibling of the tick group so the two fade freely.
    this.crossDotEl = el(
      'position:absolute;left:50%;top:50%;width:3px;height:3px;margin:-1.5px 0 0 -1.5px;border-radius:50%;background:rgba(80,255,120,0.95);box-shadow:0 0 2px rgba(0,0,0,0.8);opacity:0',
    )
    // Build-ghost status — a tiny line just under the crosshair, only shown
    // while the builder's ghost is red ('needs support' / 'occupied' /
    // 'too far'). Red-tinted to match the invalid ghost.
    this.ghostStatusEl = el(
      `position:absolute;left:50%;top:50%;transform:translate(-50%,16px);color:rgba(255,120,120,0.95);font:${FONT};font-size:11px;letter-spacing:0.1em;text-shadow:0 1px 3px rgba(0,0,0,0.85);white-space:nowrap;opacity:0;transition:opacity 0.1s`,
    )

    this.hitmarkerEl = el(
      'position:absolute;left:50%;top:50%;width:0;height:0;opacity:0;transition:opacity 0.12s',
    )
    for (const rot of [45, 135, 225, 315]) {
      const arm = document.createElement('div')
      arm.style.cssText = `position:absolute;left:-1px;top:-14px;width:2px;height:8px;background:#fff;transform:rotate(${rot}deg);transform-origin:1px 14px`
      this.hitmarkerEl.appendChild(arm)
    }

    // Stagger overlay — heavy red pulse + 'shake it off' while store.staggered.
    // Created BEFORE the edge-glow strips on purpose: siblings paint in DOM
    // order, so directional damage flashes render on top of this wash and
    // stay readable mid-stagger (its edge alpha is also kept below theirs).
    const staggerStyle = document.createElement('style')
    staggerStyle.textContent =
      '@keyframes boots-stagger{0%,100%{opacity:0.45}50%{opacity:0.8}}'
    root.appendChild(staggerStyle)
    this.staggerEl = el(
      'position:absolute;inset:0;display:none;background:radial-gradient(ellipse at center,rgba(120,0,0,0.2) 30%,rgba(200,15,15,0.75));animation:boots-stagger 0.5s ease-in-out infinite',
    )
    const staggerText = document.createElement('div')
    staggerText.style.cssText = `position:absolute;left:50%;top:38%;transform:translateX(-50%);color:#fff;font:${FONT};letter-spacing:0.22em;text-shadow:0 1px 4px rgba(0,0,0,0.9)`
    staggerText.textContent = 'shake it off'
    this.staggerEl.appendChild(staggerText)

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

    this.weaponEl = el(
      `position:absolute;right:28px;bottom:24px;color:#fff;font:${FONT};font-size:15px;letter-spacing:0.12em;text-shadow:0 1px 3px rgba(0,0,0,0.8);text-align:right;white-space:nowrap`,
    )
    // Grenade-ready pip — dot + 'G' just above the weapon line. Starts in
    // the READY state (green, full bright): grenade cooldown begins at 0.
    this.pipEl = el(
      `position:absolute;right:28px;bottom:50px;display:flex;align-items:center;gap:5px;color:#fff;font:${FONT};font-size:11px;letter-spacing:0.08em;text-shadow:0 1px 3px rgba(0,0,0,0.8);opacity:1`,
    )
    this.pipDotEl = document.createElement('div')
    this.pipDotEl.style.cssText =
      'width:8px;height:8px;border-radius:50%;background:rgba(80,255,120,0.95);box-shadow:0 0 3px rgba(0,0,0,0.8)'
    this.pipEl.appendChild(this.pipDotEl)
    const pipLabel = document.createElement('span')
    pipLabel.textContent = 'G'
    this.pipEl.appendChild(pipLabel)
    // Paint swatch — current spray color above the grenade pip, hidden until
    // the sprayer is drawn (see paintSwatch()).
    this.paintEl = el(
      `position:absolute;right:28px;bottom:76px;display:none;align-items:center;gap:6px;color:#fff;font:${FONT};font-size:11px;letter-spacing:0.08em;text-shadow:0 1px 3px rgba(0,0,0,0.8)`,
    )
    this.paintDotEl = document.createElement('div')
    this.paintDotEl.style.cssText =
      'width:10px;height:10px;border-radius:3px;border:1px solid rgba(255,255,255,0.7)'
    this.paintEl.appendChild(this.paintDotEl)
    this.paintEl.appendChild(document.createElement('span'))
    // Change gates start from the mounted visual state (pip ready, hip ADS 0)
    // so the first driven frame diffs against what's actually on screen.
    this.pipF = 1
    this.lastAds = 0
    this.healthEl = el(
      `position:absolute;left:28px;bottom:24px;color:#fff;font:${FONT};font-size:20px;text-shadow:0 1px 3px rgba(0,0,0,0.8)`,
    )
    // white-space:nowrap matters: with left:50% the shrink-to-fit width is
    // only half the viewport, so the long '⚠ AI robot zombies incoming — N'
    // countdown would wrap on narrow windows without it. ~300px at 13px —
    // fits a one-line render down to well under 640px-wide canvases.
    this.waveEl = el(
      `position:absolute;left:50%;top:20px;transform:translateX(-50%);color:#fff;font:${FONT};letter-spacing:0.1em;text-shadow:0 1px 3px rgba(0,0,0,0.8);white-space:nowrap`,
    )
    this.promptEl = el(
      `position:absolute;left:50%;bottom:96px;transform:translateX(-50%);color:#fff;font:${FONT};background:rgba(0,0,0,0.5);padding:6px 12px;border-radius:6px;opacity:0`,
    )
    // Builder edit-mode hint — its own line above prompt() so interaction
    // prompts (doors, gun table) can come and go without clobbering it.
    this.editHintEl = el(
      `position:absolute;left:50%;bottom:132px;transform:translateX(-50%);color:rgba(255,255,255,0.85);font:${FONT};font-size:12px;letter-spacing:0.08em;background:rgba(0,0,0,0.4);padding:4px 10px;border-radius:6px;opacity:0;transition:opacity 0.15s`,
    )
    el(
      `position:absolute;left:50%;bottom:28px;transform:translateX(-50%);padding:8px 16px;border-radius:999px;background:rgba(0,0,0,0.55);color:#fff;font:${FONT};letter-spacing:0.04em;white-space:nowrap`,
      'Esc exit · G grenade · R rotate · F edit · Z undo',
    )

    container.appendChild(root)

    const render = () => {
      const s = useBoots.getState()
      if (this.weaponEl) {
        const label = WEAPON_LABEL[s.weapon] ?? s.weapon.toUpperCase()
        this.weaponEl.textContent = s.weapon === 'builder' ? `${label} · ${s.buildPiece.toUpperCase()} (Q)` : label
      }
      if (this.healthEl) this.healthEl.textContent = `♥ ${Math.max(0, Math.round(s.health))}`
      this.health = s.health

      // Low-HP vignette DEPTH: 0 above 45hp, ramping to 1 at 10hp. (Pulse
      // RATE is heartbeatBpm(health) — shared with the audible heartbeat.)
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

    // Phase-lock the vignette pulse to the audible heartbeat: every scheduled
    // lub re-times the next visual beat to land exactly on the sound.
    setHeartbeatPulseListener((delayMs) => this.beatPulse(delayMs))
  }

  /**
   * One heartbeat of the low-HP vignette: quick swell to a peak, slow relax
   * to a rest level, then re-arm. Depth scales with lowHp severity; RATE is
   * audio.ts's heartbeatBpm(health) — the exact mapping the audible lub-dub
   * uses, so the red pulse can't drift from the sound. Chained setTimeout
   * (not setInterval) so the rate tracks health between beats;
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
    this.beatTimer = setTimeout(this.beat, 60000 / heartbeatBpm(this.health))
  }

  /**
   * Phase lock from the audio side: retimes the NEXT visual beat to fire
   * `delayMs` from now (audio.ts calls this once per scheduled audible lub,
   * with the lookahead delay). The beat then re-arms itself as usual, so if
   * the audio stops driving (silent level, no WebAudio, handle stopped) the
   * pulse degrades gracefully to self-timing at heartbeatBpm(health).
   * No-op while healthy or unmounted.
   */
  beatPulse(delayMs = 0): void {
    if (!this.root || this.lowHp <= 0) return
    if (this.beatTimer) clearTimeout(this.beatTimer)
    this.beatTimer = setTimeout(this.beat, delayMs)
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

  /**
   * Grenade-ready pip (bottom-right, above the weapon line). `readyFraction`
   * 0..1: 0 = just thrown, 1 = ready. Dim while cooling (opacity ramps with
   * the fraction), snaps to full bright + green dot at ready. Safe to call
   * every frame — the write is gated on a 1%-quantized change. Caller:
   * grenade.tsx, as `hud.grenadePip?.(1 - cooldownLeft / GRENADE_COOLDOWN)`.
   */
  grenadePip(readyFraction: number): void {
    const pip = this.pipEl
    const dot = this.pipDotEl
    if (!pip || !dot) return
    const v = Math.min(1, Math.max(0, readyFraction))
    const q = v >= 1 ? 1 : Math.round(v * 100) / 100
    if (q === this.pipF) return
    const wasReady = this.pipF === 1
    this.pipF = q
    pip.style.opacity = q >= 1 ? '1' : String(0.25 + 0.4 * q)
    const ready = q >= 1
    if (ready !== wasReady) {
      dot.style.background = ready ? 'rgba(80,255,120,0.95)' : 'rgba(255,255,255,0.85)'
    }
  }

  /**
   * Paint-sprayer swatch (above the grenade pip). `hex` = current palette
   * color, null hides the line. Caller: paint.tsx, change-gated on its side,
   * feature-detected as `hud.paintSwatch?.(hex, name)`.
   */
  paintSwatch(hex: string | null, label = ''): void {
    const line = this.paintEl
    const dot = this.paintDotEl
    if (!line || !dot) return
    if (!hex) {
      line.style.display = 'none'
      return
    }
    line.style.display = 'flex'
    dot.style.background = hex
    ;(line.lastChild as HTMLElement).textContent = `${label} (R)`
  }

  /**
   * Aim-down-sights crosshair morph. `v` 0..1 (playerRig.ads): the four hip
   * ticks fade OUT (opacity 1-v) and the small center dot fades IN (opacity
   * v). Safe to call every frame — change-gated. Caller: viewmodel.tsx, as
   * `hud.setAds?.(rigFeel.ads)`.
   */
  setAds(v: number): void {
    const ticks = this.crossTicksEl
    const dot = this.crossDotEl
    if (!ticks || !dot) return
    const q = Math.min(1, Math.max(0, v))
    if (q === this.lastAds) return
    this.lastAds = q
    ticks.style.opacity = String(1 - q)
    dot.style.opacity = String(q)
  }

  /**
   * Builder edit-mode hint line ('F done · LMB carve · RMB reset'). Persistent
   * until cleared with null — dedicated element, so the shared prompt()
   * line stays free for doors/gun-table interactions. Last write wins.
   */
  editHint(text: string | null): void {
    if (!this.editHintEl) return
    this.editHintEl.textContent = text ?? ''
    this.editHintEl.style.opacity = text ? '1' : '0'
  }

  /**
   * Build-ghost status line under the crosshair. Pass the ghost's failing
   * reason (grid.ts TargetResult.reason) while the builder is active;
   * 'ok'/null blanks the line. Owner-keyed exactly like prompt(): showing
   * records `owner` (last writer wins), clearing only takes effect while
   * that same owner still holds the line. Change-gated — safe per frame.
   */
  ghostStatus(reason: GhostReason | null, owner = 'default'): void {
    if (!this.ghostStatusEl) return
    const failing = reason !== null && reason !== 'ok' ? reason : null
    if (failing) {
      if (this.ghostOwner === owner && this.lastGhostReason === failing) return
      this.ghostOwner = owner
      this.lastGhostReason = failing
      this.ghostStatusEl.textContent = GHOST_REASON_LABEL[failing]
      this.ghostStatusEl.style.opacity = '1'
      return
    }
    if (this.ghostOwner !== null && this.ghostOwner !== owner) return
    if (this.ghostOwner === null && this.lastGhostReason === null) return
    this.ghostOwner = null
    this.lastGhostReason = null
    this.ghostStatusEl.textContent = ''
    this.ghostStatusEl.style.opacity = '0'
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
    setHeartbeatPulseListener(null)
    this.unsub?.()
    this.unsub = null
    this.promptOwner = null
    this.ghostOwner = null
    this.lastGhostReason = null
    this.lowHp = 0
    this.health = 100
    if (this.hitTimer) clearTimeout(this.hitTimer)
    if (this.flashTimer) clearTimeout(this.flashTimer)
    if (this.beatTimer) clearTimeout(this.beatTimer)
    if (this.relaxTimer) clearTimeout(this.relaxTimer)
    this.hitTimer = this.flashTimer = this.beatTimer = this.relaxTimer = null
    this.root?.remove()
    this.root = null
    this.editHintEl = null
    this.ghostStatusEl = null
    this.edgeEls = null
    this.lowHpEl = null
    this.staggerEl = null
    this.pipEl = null
    this.pipDotEl = null
    this.paintEl = null
    this.paintDotEl = null
    this.crossTicksEl = null
    this.crossDotEl = null
    this.pipF = -1
    this.lastAds = -1
  }
}
