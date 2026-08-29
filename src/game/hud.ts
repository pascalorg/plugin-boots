import { useBoots } from '../store'
import { heartbeatBpm, setHeartbeatPulseListener } from './audio'
import type { TargetResult } from './grid'
import { barPercent, LOADING_CAP_MS, shouldWriteBar } from './loading'

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
 * - Keybind bar: automatic. Follows store.weapon — while the BUILDER is
 *   held it lists the piece hotkeys (builderKeybarText: Z/X/C/V/Q, with
 *   layout-map caps on non-QWERTY), otherwise KEYBAR_DEFAULT.
 * - hint(id, text) — contextual micro-hints (owner: "it needs to be
 *   discreet"): a tiny low-contrast line just above the keybar, fade-in
 *   300ms, gone after ~4s, each id shown ONCE per session (per Hud
 *   instance — session.ts builds a fresh Hud every Jump-in). Weapon-moment
 *   hints fire from the store subscription itself (first builder equip,
 *   first gun, first paint equip); the catalog hint fires from a 20s
 *   mount timer unless hintSeen('catalog') suppressed it (openItemMenu
 *   marks it — the player already found the catalog). Overlapping hints
 *   queue; nothing is permanent chrome. Returns whether the hint fired
 *   (the once-gate is what hud.test.ts pins).
 * - hitmarker(kind?) — confirmed-hit feedback, driven by shooting.ts:
 *   'hit' (default) the classic 4-tick pulse (~90ms), 'carve' a subtler
 *   low-opacity pulse (~80ms) for wall/item carves, 'kill' a warm-tinted
 *   slightly-longer flare for bot kills. A kill flare holds against
 *   trailing 'hit'/'carve' writes for its window, so the killing blow's
 *   read never gets stomped by the next round of a burst.
 * - waveCleared() — one-shot "WAVE CLEARED" center banner (fade in, hold
 *   ~1.8s, fade out). Driven by enemies.tsx when the last live bot of a
 *   wave dies; feature-detected there, so integration order can't crash.
 * - presenceChip(count) — co-presence "N builders here" chip, top-left,
 *   muted, change-gated, hidden at 0 (remote-players.tsx drives it on
 *   roster edges). presenceToast(text) — one queued muted join/leave line
 *   under it; unlike hint() there is NO once-gate (peers come and go).
 * - loadingProgress(p, pending?) — the entry veil's REAL progress feed
 *   (game-root's LoadingDriver, weights in loading.ts). The veil mounts
 *   opaque with a thin bottom bar + one quip line and holds until p ≥ 1
 *   (or the LOADING_CAP_MS backstop), then fades 300ms and removes
 *   itself; a cap reveal console.infos the last `pending` label. Bar DOM
 *   writes are width%-only on ONE element, change-gated on whole percents
 *   and rate-limited to 10 Hz (loading.ts shouldWriteBar). `onReveal`
 *   fires exactly once at reveal — session.ts uses it to drop the
 *   loading input gate. unmount() tears the veil down with the session,
 *   so Esc during loading exits cleanly.
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

/** Bottom keybind bar, holstered/default loadout. */
export const KEYBAR_DEFAULT = 'Esc exit · G grenade · R rotate/shape · F edit · U undo · I catalog'

/** Physical piece-hotkey codes → what they do. Mirrors builder.tsx's
 * PIECE_KEYS + the Q cycle (duplicated as display data — hud must not import
 * the React builder: builder → session → hud would cycle). */
const BUILDER_KEY_CODES: ReadonlyArray<readonly [string, string]> = [
  ['KeyZ', 'wall'],
  ['KeyX', 'floor'],
  ['KeyC', 'stairs'],
  ['KeyV', 'roof'],
  ['KeyQ', 'cycle'],
]

/** QWERTY caps for the physical codes (the no-Keyboard-API fallback). */
const QWERTY_LABEL: Record<string, string> = {
  KeyZ: 'Z',
  KeyX: 'X',
  KeyC: 'C',
  KeyV: 'V',
  KeyQ: 'Q',
}

/**
 * Keybind-bar text while the BUILDER is held — the piece hotkeys must be
 * discoverable in-game, not only in the sidebar panel (owner QA 2026-08-27:
 * "no ramp, no roof" traced to the bar never mentioning stairs/roof keys).
 * `labelFor` maps a physical e.code to the cap printed on that key; the
 * default is QWERTY. input.ts matches e.code (physical position), so on
 * AZERTY the key AT KeyZ prints W — mount() upgrades the captions through
 * the Keyboard API's layout map where the browser offers it.
 */
export function builderKeybarText(
  labelFor: (code: string) => string = (code) => QWERTY_LABEL[code] ?? code,
): string {
  const pieces = BUILDER_KEY_CODES.map(([code, action]) => `${labelFor(code)} ${action}`).join(
    ' · ',
  )
  return `${pieces} · R rotate/shape · F edit · U undo · Esc exit`
}

/** Hitmarker flavors — see hitmarker() in the header. */
export type HitmarkerKind = 'hit' | 'kill' | 'carve'

/**
 * Co-presence chip text — pure so the copy + pluralization are pinnable
 * headless. null = no chip (solo). The count is REMOTE players only (the
 * local player is not a ghost to themselves).
 */
export function presenceChipText(count: number): string | null {
  if (count <= 0) return null
  return count === 1 ? '1 builder here' : `${count} builders here`
}

/** Presence toast pacing — join/leave lines, muted, short-lived. */
const PRESENCE_TOAST_HOLD_MS = 2400
const PRESENCE_TOAST_GAP_MS = 300

/** How long a kill flare owns the marker against trailing hit writes. */
const KILL_HOLD_MS = 160

/** Micro-hint pacing: fade-in 300ms, hold ~4s, fade-out, small gap. */
const HINT_HOLD_MS = 4000
const HINT_GAP_MS = 700

/** The catalog nudge moment — ~20s into a session that never opened it. */
const CATALOG_HINT_DELAY_MS = 20000

/** Veil fade once progress completes (ms) — quick, the work is done. */
const VEIL_FADE_MS = 300

/** Loading quips — one line, rotating at most once (game tone, no lore
 * dump): the second lands when progress crosses the halfway mark. */
const LOADING_QUIPS = ['lacing up your boots…', 'hanging the drywall…'] as const

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
  private hitArms: HTMLDivElement[] = []
  /** Last arm color written (change gate — recolors are per-kind flips). */
  private hitColor = ''
  /** Until this Date.now() a kill flare owns the marker (see header). */
  private killHoldUntil = 0
  private hintEl: HTMLDivElement | null = null
  /** Once-per-session gate: hint ids already fired (or hintSeen-marked). */
  private readonly hintsShown = new Set<string>()
  private hintQueue: string[] = []
  private hintActive = false
  private hintTimer: ReturnType<typeof setTimeout> | null = null
  private hintGapTimer: ReturnType<typeof setTimeout> | null = null
  private catalogTimer: ReturnType<typeof setTimeout> | null = null
  private waveClearEl: HTMLDivElement | null = null
  private waveClearTimer: ReturnType<typeof setTimeout> | null = null
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
  private keybarEl: HTMLDivElement | null = null
  /** Builder-mode keybar text — QWERTY caps until the layout map resolves. */
  private builderBar = builderKeybarText()
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
  /** Entry veil (loading) — see loadingProgress() in the header. */
  private veilEl: HTMLDivElement | null = null
  private veilBarEl: HTMLDivElement | null = null
  private veilQuipEl: HTMLDivElement | null = null
  private veilRevealed = false
  private veilCapTimer: ReturnType<typeof setTimeout> | null = null
  private veilRemoveTimer: ReturnType<typeof setTimeout> | null = null
  /** Last bar write (10 Hz + whole-percent change gate; loading.ts). */
  private veilBarWriteAt = 0
  private veilBarPct = -1
  /** Quip index currently shown (change gate). */
  private veilQuip = -1
  /** Last pending label from the driver — non-empty at reveal = a cap. */
  private veilPending = ''
  /** Fires exactly once when the veil reveals (progress or cap) — session.ts
   * drops its loading input gate here. Cleared on unmount, never called by
   * teardown (an Esc mid-load exits without a reveal). */
  onReveal: (() => void) | null = null
  /** Co-presence chip ("N builders here") — see presenceChip(). */
  private presenceChipEl: HTMLDivElement | null = null
  /** Last presenceChip() count written (change gate; -1 = never). */
  private presenceCount = -1
  /** Presence toast line + its queue (join/leave events can burst). */
  private presenceToastEl: HTMLDivElement | null = null
  private presenceToastQueue: string[] = []
  private presenceToastActive = false
  private presenceToastTimer: ReturnType<typeof setTimeout> | null = null
  private presenceToastGapTimer: ReturnType<typeof setTimeout> | null = null

  mount(container: HTMLElement): void {
    const root = document.createElement('div')
    root.id = 'boots-hud'
    root.style.cssText =
      'position:absolute;inset:0;pointer-events:none;z-index:2147483646;user-select:none;font-family:system-ui'
    this.root = root

    // Entry veil — a black cover that holds until the session's REAL entry
    // work is done. Session entry front-loads one-off work (prevoxelize
    // ticks, dormant replica primes + their serialized first GPU uploads,
    // BVH warms); the old fixed 1.2s fade revealed mid-churn — this one is
    // progress-driven: game-root's LoadingDriver feeds loadingProgress()
    // (stage weights in loading.ts) and the veil fades VEIL_FADE_MS once
    // progress hits 1, with a LOADING_CAP_MS wall-clock backstop so a
    // wedged stage (or a dead frame loop) never traps the player. Pure
    // DOM, outside the scene graph, first child on purpose: every HUD
    // element paints ON TOP of it, so prompts stay readable through the
    // fade. Carries its own minimal chrome — small title, one quip line,
    // a thin bottom bar (ONE element, width%-only writes, ≤ 10 Hz).
    const veil = document.createElement('div')
    veil.dataset.bootsVeil = '1' // QA hook: presence = still loading
    veil.style.cssText = 'position:absolute;inset:0;background:#000;opacity:1'
    const veilTitle = document.createElement('div')
    veilTitle.textContent = 'BOOTS'
    veilTitle.style.cssText = `position:absolute;left:50%;bottom:118px;transform:translateX(-50%);color:rgba(255,255,255,0.85);font:${FONT};font-size:14px;letter-spacing:0.42em;text-indent:0.42em`
    veil.appendChild(veilTitle)
    this.veilQuipEl = document.createElement('div')
    this.veilQuipEl.textContent = LOADING_QUIPS[0]
    this.veilQuip = 0
    this.veilQuipEl.style.cssText = `position:absolute;left:50%;bottom:88px;transform:translateX(-50%);color:rgba(255,255,255,0.45);font:${FONT};font-size:11px;letter-spacing:0.14em;white-space:nowrap`
    veil.appendChild(this.veilQuipEl)
    const veilTrack = document.createElement('div')
    veilTrack.style.cssText =
      'position:absolute;left:50%;bottom:72px;transform:translateX(-50%);width:min(320px,42%);height:2px;border-radius:2px;background:rgba(255,255,255,0.14);overflow:hidden'
    this.veilBarEl = document.createElement('div')
    this.veilBarEl.dataset.bootsVeilBar = '1' // QA hook: width% = progress
    this.veilBarEl.style.cssText =
      'height:100%;width:0%;border-radius:2px;background:rgba(255,255,255,0.85);transition:width 0.25s linear'
    veilTrack.appendChild(this.veilBarEl)
    veil.appendChild(veilTrack)
    root.appendChild(veil)
    this.veilEl = veil
    this.veilRevealed = false
    this.veilBarWriteAt = 0
    this.veilBarPct = -1
    this.veilPending = ''
    // Wall-clock backstop: even a wedged R3F loop (the driver never runs)
    // reveals at the cap — never trap the player behind the veil.
    this.veilCapTimer = setTimeout(() => {
      this.veilCapTimer = null
      if (!this.veilPending) this.veilPending = 'no progress reported (frame loop stalled?)'
      this.revealVeil()
    }, LOADING_CAP_MS)

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
      this.hitArms.push(arm)
    }
    this.hitColor = '#fff'

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
    // Keybind bar — swaps to the builder's piece-hotkey listing while the
    // builder is held (render() below drives it off store.weapon).
    this.keybarEl = el(
      `position:absolute;left:50%;bottom:28px;transform:translateX(-50%);padding:8px 16px;border-radius:999px;background:rgba(0,0,0,0.55);color:#fff;font:${FONT};letter-spacing:0.04em;white-space:nowrap`,
      KEYBAR_DEFAULT,
    )
    // Contextual micro-hint — one small low-contrast line just above the
    // keybar (its top edge sits near 59px). No box, no border: text only.
    this.hintEl = el(
      `position:absolute;left:50%;bottom:66px;transform:translateX(-50%);color:rgba(255,255,255,0.6);font:${FONT};font-size:11px;letter-spacing:0.08em;text-shadow:0 1px 3px rgba(0,0,0,0.7);white-space:nowrap;opacity:0;transition:opacity 0.3s`,
    )
    // Co-presence chip — top-left, MUTED on purpose (other builders in the
    // lot are ambient information, never combat chrome). presenceChip()
    // drives it change-gated; hidden while the count is 0.
    this.presenceChipEl = el(
      `position:absolute;left:28px;top:20px;color:rgba(255,255,255,0.55);font:${FONT};font-size:11px;letter-spacing:0.1em;text-shadow:0 1px 3px rgba(0,0,0,0.7);white-space:nowrap;opacity:0;transition:opacity 0.25s`,
    )
    // Presence join/leave toast — one muted line under the chip; queued so
    // a burst of joins reads one at a time.
    this.presenceToastEl = el(
      `position:absolute;left:28px;top:40px;color:rgba(255,255,255,0.45);font:${FONT};font-size:11px;letter-spacing:0.08em;text-shadow:0 1px 3px rgba(0,0,0,0.7);white-space:nowrap;opacity:0;transition:opacity 0.3s`,
    )
    // WAVE CLEARED banner — center card, opacity-only (waveCleared()).
    this.waveClearEl = el(
      `position:absolute;left:50%;top:34%;transform:translateX(-50%);color:rgba(255,255,255,0.92);font:${FONT};font-size:16px;letter-spacing:0.34em;text-shadow:0 1px 4px rgba(0,0,0,0.9);white-space:nowrap;opacity:0;transition:opacity 0.25s`,
      'WAVE CLEARED',
    )
    // Catalog nudge: ~20s in, IF the player never opened it (openItemMenu
    // marks the id via hintSeen, which makes this timer's hint() a no-op).
    this.catalogTimer = setTimeout(() => {
      this.catalogTimer = null
      this.hint('catalog', 'I — place furniture')
    }, CATALOG_HINT_DELAY_MS)

    // The piece hotkeys match PHYSICAL key positions (e.code), so non-QWERTY
    // layouts print different caps on those keys (AZERTY: KeyZ is W, KeyQ is
    // A). Where the Keyboard API exists, upgrade the builder bar to the
    // layout's real labels; the QWERTY captions stay the fallback.
    const keyboard =
      typeof navigator === 'undefined'
        ? undefined
        : (
            navigator as Navigator & {
              keyboard?: {
                getLayoutMap?: () => Promise<{ get: (code: string) => string | undefined }>
              }
            }
          ).keyboard
    const layoutMap = keyboard?.getLayoutMap?.()
    if (layoutMap) {
      layoutMap
        .then((map) => {
          this.builderBar = builderKeybarText((code) =>
            (map.get(code) ?? QWERTY_LABEL[code] ?? code).toUpperCase(),
          )
          if (this.keybarEl && useBoots.getState().weapon === 'builder') {
            this.keybarEl.textContent = this.builderBar
          }
        })
        .catch(() => {}) // permission/api refusal → keep the QWERTY captions
    }

    container.appendChild(root)

    const render = () => {
      const s = useBoots.getState()
      if (this.weaponEl) {
        const label = WEAPON_LABEL[s.weapon] ?? s.weapon.toUpperCase()
        this.weaponEl.textContent = s.weapon === 'builder' ? `${label} · ${s.buildPiece.toUpperCase()} (Q)` : label
      }
      // Keybind bar tracks the held weapon: the builder shows its piece
      // hotkeys (Z/X/C/V/Q — discoverability), everything else the default.
      if (this.keybarEl) {
        const bar = s.weapon === 'builder' ? this.builderBar : KEYBAR_DEFAULT
        if (this.keybarEl.textContent !== bar) this.keybarEl.textContent = bar
      }
      if (this.healthEl) this.healthEl.textContent = `♥ ${Math.max(0, Math.round(s.health))}`
      this.health = s.health

      // Weapon-moment micro-hints — the once-gate inside hint() makes these
      // per-render calls free after the first fire of each id.
      if (s.weapon === 'builder') this.hint('builder-keys', 'Z wall · X floor · C stairs · V roof')
      else if (s.weapon === 'paint') this.hint('paint-close', 'hold close to write')
      else if (s.weapon === 'pistol' || s.weapon === 'rifle' || s.weapon === 'minigun')
        this.hint('gun-aim', 'RMB to aim')

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
   * Entry-veil progress feed (see header). `p` is the driver's monotonic
   * capped progress (loading.ts advanceProgress); `pending` is the compact
   * still-pending label — non-empty at reveal time means the cap fired, and
   * gets console.info'd so a slow scene leaves a trace. Safe per frame:
   * DOM writes are change-gated on whole percents and ≤ 10 Hz.
   */
  loadingProgress(p: number, pending = ''): void {
    if (!this.veilEl || this.veilRevealed) return
    this.veilPending = pending
    const now = Date.now()
    if (shouldWriteBar(this.veilBarWriteAt, this.veilBarPct, now, p)) {
      this.veilBarWriteAt = now
      this.veilBarPct = barPercent(p)
      if (this.veilBarEl) this.veilBarEl.style.width = `${this.veilBarPct}%`
      const quip = p >= 0.5 ? 1 : 0
      if (quip !== this.veilQuip && this.veilQuipEl) {
        this.veilQuip = quip
        this.veilQuipEl.textContent = LOADING_QUIPS[quip] ?? ''
      }
    }
    if (p >= 1) this.revealVeil()
  }

  /** Fade the veil out (VEIL_FADE_MS) and remove it; idempotent. Fires
   * onReveal exactly once — a cap reveal logs what was still pending. */
  private revealVeil(): void {
    const veil = this.veilEl
    if (!veil || this.veilRevealed) return
    this.veilRevealed = true
    if (this.veilCapTimer) {
      clearTimeout(this.veilCapTimer)
      this.veilCapTimer = null
    }
    if (this.veilPending) {
      console.info(
        `[boots] loading veil capped at ${LOADING_CAP_MS / 1000}s — still pending: ${this.veilPending}`,
      )
    }
    if (this.veilBarEl) this.veilBarEl.style.width = '100%'
    veil.style.transition = `opacity ${VEIL_FADE_MS / 1000}s ease`
    veil.style.opacity = '0'
    this.veilRemoveTimer = setTimeout(() => {
      this.veilRemoveTimer = null
      veil.remove()
      this.veilEl = null
      this.veilBarEl = null
      this.veilQuipEl = null
    }, VEIL_FADE_MS + 100)
    const onReveal = this.onReveal
    this.onReveal = null
    onReveal?.()
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

  /**
   * Confirmed-hit crosshair pulse. 'hit' = the classic full 4-tick flash,
   * 'carve' = a subtler low-opacity pulse for wall/item carves, 'kill' = a
   * warm flare that holds slightly longer AND owns the marker for
   * KILL_HOLD_MS — a burst's next 'hit'/'carve' can't stomp the killing
   * blow's read. Zero-arg calls keep the legacy 'hit' behavior.
   */
  hitmarker(kind: HitmarkerKind = 'hit'): void {
    const el = this.hitmarkerEl
    if (!el) return
    const now = Date.now()
    if (kind !== 'kill' && now < this.killHoldUntil) return
    let color = '#fff'
    let opacity = '1'
    let hold = 90
    if (kind === 'kill') {
      color = 'rgba(255,120,90,0.95)'
      opacity = '0.9'
      hold = KILL_HOLD_MS
      this.killHoldUntil = now + KILL_HOLD_MS
    } else if (kind === 'carve') {
      opacity = '0.45'
      hold = 80
    }
    if (color !== this.hitColor) {
      this.hitColor = color
      for (const arm of this.hitArms) arm.style.background = color
    }
    el.style.opacity = opacity
    if (this.hitTimer) clearTimeout(this.hitTimer)
    this.hitTimer = setTimeout(() => {
      if (this.hitmarkerEl) this.hitmarkerEl.style.opacity = '0'
    }, hold)
  }

  /**
   * Contextual micro-hint, once per session per id (see header). Returns
   * whether this call fired the hint — false when the id already showed
   * (or was hintSeen-suppressed). The once-gate runs before any DOM work,
   * so the gate itself is testable headless; unmounted, a fresh id is
   * consumed silently (the moment passed without a screen to show it on).
   */
  hint(id: string, text: string): boolean {
    if (this.hintsShown.has(id)) return false
    this.hintsShown.add(id)
    if (!this.hintEl) return true
    this.hintQueue.push(text)
    if (!this.hintActive) this.showNextHint()
    return true
  }

  /**
   * Mark a hint id as already-known WITHOUT showing it — e.g. openItemMenu
   * calls hintSeen('catalog') so the 20s nudge never fires for a player
   * who already found the catalog.
   */
  hintSeen(id: string): void {
    this.hintsShown.add(id)
  }

  /** Dequeue-and-show loop for hint(): fade in 300ms, hold ~4s, fade out,
   * small gap, next. Self-terminates when the queue drains. */
  private showNextHint = (): void => {
    this.hintGapTimer = null
    const el = this.hintEl
    if (!el) return
    const text = this.hintQueue.shift()
    if (text === undefined) {
      this.hintActive = false
      return
    }
    this.hintActive = true
    el.textContent = text
    el.style.transition = 'opacity 0.3s'
    el.style.opacity = '1'
    this.hintTimer = setTimeout(() => {
      this.hintTimer = null
      if (!this.hintEl) return
      this.hintEl.style.transition = 'opacity 0.6s'
      this.hintEl.style.opacity = '0'
      this.hintGapTimer = setTimeout(this.showNextHint, HINT_GAP_MS)
    }, HINT_HOLD_MS)
  }

  /**
   * One-shot WAVE CLEARED banner: fade in fast, hold ~1.8s, fade out slow.
   * Caller: enemies.tsx, on the frame the last live bot of a wave dies
   * (feature-detected — `session.hud.waveCleared?.()`). Re-entrant safe:
   * a second call mid-fade just restarts the hold.
   */
  waveCleared(): void {
    const el = this.waveClearEl
    if (!el) return
    el.style.transition = 'opacity 0.25s'
    el.style.opacity = '1'
    if (this.waveClearTimer) clearTimeout(this.waveClearTimer)
    this.waveClearTimer = setTimeout(() => {
      this.waveClearTimer = null
      if (!this.waveClearEl) return
      this.waveClearEl.style.transition = 'opacity 0.9s'
      this.waveClearEl.style.opacity = '0'
    }, 1800)
  }

  /**
   * Co-presence chip: "N builders here" while remote players share the
   * session's project (remote-players.tsx drives it on roster edges, and
   * defensively per frame — the change gate makes repeats free). 0 hides
   * the chip. Muted styling on purpose: ambient info, not combat chrome.
   */
  presenceChip(count: number): void {
    if (count === this.presenceCount) return
    this.presenceCount = count
    const el = this.presenceChipEl
    if (!el) return
    const text = presenceChipText(count)
    el.textContent = text ?? ''
    el.style.opacity = text ? '1' : '0'
  }

  /**
   * Presence join/leave toast — one short muted line ("Alice joined").
   * Queued (a burst of joins reads one at a time), fade in 300ms, hold
   * ~2.4s, fade out, small gap, next. Unlike hint(), toasts have no
   * once-gate: the same player can join and leave repeatedly.
   */
  presenceToast(text: string): void {
    if (!this.presenceToastEl) return
    this.presenceToastQueue.push(text)
    if (!this.presenceToastActive) this.showNextPresenceToast()
  }

  /** Dequeue-and-show loop for presenceToast() — mirrors showNextHint. */
  private showNextPresenceToast = (): void => {
    this.presenceToastGapTimer = null
    const el = this.presenceToastEl
    if (!el) return
    const text = this.presenceToastQueue.shift()
    if (text === undefined) {
      this.presenceToastActive = false
      return
    }
    this.presenceToastActive = true
    el.textContent = text
    el.style.transition = 'opacity 0.3s'
    el.style.opacity = '1'
    this.presenceToastTimer = setTimeout(() => {
      this.presenceToastTimer = null
      if (!this.presenceToastEl) return
      this.presenceToastEl.style.transition = 'opacity 0.5s'
      this.presenceToastEl.style.opacity = '0'
      this.presenceToastGapTimer = setTimeout(this.showNextPresenceToast, PRESENCE_TOAST_GAP_MS)
    }, PRESENCE_TOAST_HOLD_MS)
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
    if (this.hintTimer) clearTimeout(this.hintTimer)
    if (this.hintGapTimer) clearTimeout(this.hintGapTimer)
    if (this.catalogTimer) clearTimeout(this.catalogTimer)
    if (this.waveClearTimer) clearTimeout(this.waveClearTimer)
    this.hintTimer = this.hintGapTimer = this.catalogTimer = this.waveClearTimer = null
    this.hintQueue.length = 0
    this.hintActive = false
    this.hintEl = null
    this.waveClearEl = null
    if (this.presenceToastTimer) clearTimeout(this.presenceToastTimer)
    if (this.presenceToastGapTimer) clearTimeout(this.presenceToastGapTimer)
    this.presenceToastTimer = this.presenceToastGapTimer = null
    this.presenceToastQueue.length = 0
    this.presenceToastActive = false
    this.presenceToastEl = null
    this.presenceChipEl = null
    this.presenceCount = -1
    // Veil teardown — Esc during loading exits cleanly: the veil rides the
    // root removal below; onReveal is deliberately NOT fired (the session
    // is over, there is nothing to un-gate).
    if (this.veilCapTimer) clearTimeout(this.veilCapTimer)
    if (this.veilRemoveTimer) clearTimeout(this.veilRemoveTimer)
    this.veilCapTimer = this.veilRemoveTimer = null
    this.veilEl = null
    this.veilBarEl = null
    this.veilQuipEl = null
    this.veilRevealed = false
    this.veilBarWriteAt = 0
    this.veilBarPct = -1
    this.veilQuip = -1
    this.veilPending = ''
    this.onReveal = null
    this.hitArms.length = 0
    this.hitColor = ''
    this.killHoldUntil = 0
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
    this.keybarEl = null
    this.pipF = -1
    this.lastAds = -1
  }
}
