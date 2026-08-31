'use client'

import { sceneRegistry } from '@pascal-app/core'
import { useEffect } from 'react'
import { useBoots } from '../store'
import { enterGame } from './session'

/**
 * THE SHAREABLE-LINK DROP GATE (owner vision, refined): open a project URL
 * carrying `?boots=drop` and you never see the editor at all — an OPAQUE
 * full-screen veil covers everything from the moment the plugin mounts,
 * a loading bar tracks the scene hydrating underneath, and when the world
 * is ready the bar gives way to ONE centered button: JUMP IN. That single
 * click satisfies the browser's user-gesture requirement (fullscreen +
 * pointer lock) and enters the game; the in-game loading card takes over
 * without a flash (the veil holds until the game's own veil is up).
 *
 * Ideally there'd be no button — but fullscreen/pointer-lock need a real
 * gesture, so the button is the gesture and everything heavy has already
 * loaded behind the veil by the time it appears.
 *
 * READINESS is measured, not guessed: the host registers every rendered
 * node in sceneRegistry — the bar advances as nodes stream in and the
 * button appears once the census holds still for a few polls (plus a
 * hard cap so an empty lobby scene never stalls the gate).
 *
 * One-shot per page load, latched ON THE CLICK: React StrictMode
 * double-invokes effects in dev — a mount-time latch made the first pass
 * consume the gate while its cleanup removed the veil.
 */

/** Pure gate: offer the interstitial? Exported for tests. */
export function shouldOfferDrop(search: string, phase: string, consumed: boolean): boolean {
  if (consumed || phase !== 'editor') return false
  return new URLSearchParams(search).get('boots') === 'drop'
}

/**
 * Pure gate: offer the RE-ENTRY pill? Exported for tests.
 *
 * The exact mirror of `shouldOfferDrop`, and the answer to a trap the one-shot
 * created (owner report 2026-08-31: dropped in from a share link, pressed Esc,
 * and found an empty "Plugins" panel).
 *
 * On the lobby route the host registers NO panels — that is deliberate, it is
 * how the rail stays out of a visitor's way — so there is no "Jump in" button
 * to go back to. Combined with the gate being consumed on its first click,
 * leaving the game left a visitor stranded on a read-only canvas with no way
 * back in short of reloading the page.
 *
 * `?boots=drop` is precisely the right condition: it means "this page was
 * reached by a share link", which is the same set of pages that have no rail.
 * On `/editor` the owner has the panel and needs no pill, and there the marker
 * is absent (the share link normalizes to `/play` — see share-link.ts).
 */
export function shouldOfferReentry(search: string, phase: string, consumed: boolean): boolean {
  if (!consumed || phase !== 'editor') return false
  return new URLSearchParams(search).get('boots') === 'drop'
}

/** Poll cadence + stability window for the readiness census. */
const POLL_MS = 250
const STABLE_POLLS = 4
/** Never hold the button hostage longer than this (empty scenes settle
 * instantly; huge ones keep streaming dormant work AFTER entry anyway). */
const READY_CAP_MS = 12000

/**
 * Progress model, pure (exported for tests): maps (elapsedMs, census,
 * stablePolls) to a 0..1 bar. Node streaming dominates the middle; the
 * stability window walks the last stretch; the cap forces 1.
 */
export function dropProgress(elapsedMs: number, census: number, stablePolls: number): number {
  if (elapsedMs >= READY_CAP_MS) return 1
  const time = Math.min(0.25, elapsedMs / 8000) // slow ambient crawl
  const nodes = census > 0 ? Math.min(0.55, 0.2 + census / 400) : 0
  const stable = Math.min(1, stablePolls / STABLE_POLLS) * 0.35
  return Math.min(1, Math.max(time, 0.05) + nodes + stable)
}

/** Total registered nodes across every kind — the hydration census. */
function registryCensus(): number {
  let total = 0
  for (const kind of Object.keys(sceneRegistry.byType)) {
    total += sceneRegistry.byType[kind]?.size ?? 0
  }
  return total
}

let dropConsumed = false

/** Test/session hook: re-arm the one-shot (a fresh page load does this). */
export function resetDropGate(): void {
  dropConsumed = false
}

const FONT = "system-ui, -apple-system, sans-serif"

export function DropGate() {
  const phase = useBoots((s) => s.phase)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return
    if (!shouldOfferDrop(window.location.search, phase, dropConsumed)) return

    // OPAQUE from the first paint the plugin gets — the visitor never sees
    // the editor chrome. Body-level (NOT the canvas parent): enterGame
    // fullscreens the canvas container and the veil must not ride into it.
    const veil = document.createElement('div')
    veil.style.cssText =
      `position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;align-items:center;` +
      `justify-content:center;gap:26px;background:#0c0e10`
    const word = document.createElement('div')
    word.textContent = 'BOOTS'
    word.style.cssText = `font:800 44px/1 ${FONT};letter-spacing:0.35em;color:rgba(255,255,255,0.92);padding-left:0.35em`
    // Loading bar (visible until ready) — same look as the in-game card.
    const track = document.createElement('div')
    track.style.cssText =
      'width:min(420px,60vw);height:10px;border-radius:5px;background:rgba(255,255,255,0.08);overflow:hidden'
    const fill = document.createElement('div')
    fill.style.cssText =
      'width:0%;height:100%;border-radius:5px;background:rgba(255,255,255,0.85);transition:width 0.25s linear'
    track.appendChild(fill)
    // The ONE button — hidden until the world is ready.
    const button = document.createElement('button')
    button.textContent = '⏵ JUMP IN'
    button.style.cssText =
      `display:none;font:700 20px/1 ${FONT};letter-spacing:0.12em;color:#0f1113;background:#e8c229;` +
      'border:none;border-radius:8px;padding:16px 44px;cursor:pointer'
    veil.append(word, track, button)
    document.body.appendChild(veil)

    const t0 = performance.now()
    let lastCensus = -1
    let stablePolls = 0
    let ready = false
    const timer = setInterval(() => {
      const census = registryCensus()
      if (census === lastCensus && census >= 0) stablePolls++
      else stablePolls = 0
      lastCensus = census
      const elapsed = performance.now() - t0
      const p = dropProgress(elapsed, census, stablePolls)
      fill.style.width = `${Math.round(p * 100)}%`
      if (!ready && p >= 1) {
        ready = true
        clearInterval(timer)
        // Bar → button: the swap IS the "it's ready" tell.
        track.style.display = 'none'
        button.style.display = 'block'
      }
    }, POLL_MS)

    button.onclick = () => {
      dropConsumed = true
      enterGame()
      // Hold the opaque veil until the game's own loading card is up, so
      // the editor never flashes between the click and the game veil.
      const holdT0 = performance.now()
      const hold = setInterval(() => {
        const gameVeil = document.querySelector('[data-boots-veil]')
        if (gameVeil || performance.now() - holdT0 > 3000) {
          clearInterval(hold)
          veil.remove()
        }
      }, 100)
    }
    return () => {
      clearInterval(timer)
      veil.remove()
    }
  }, [phase])

  // ── Back in, after Esc ────────────────────────────────────────────────────
  // Separate effect, same `phase` dependency: this one runs on the way OUT,
  // when the first one has already latched. Deliberately NOT the opaque veil —
  // a visitor who just left the game wants to see the building, so this is a
  // small pill and nothing else. Bottom-centre keeps it clear of the floor
  // selector at top-left.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return
    if (!shouldOfferReentry(window.location.search, phase, dropConsumed)) return

    const pill = document.createElement('button')
    pill.textContent = '⏵ JUMP BACK IN'
    pill.setAttribute('data-boots-reentry', '')
    pill.style.cssText =
      `position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:9998;` +
      `font:700 15px/1 ${FONT};letter-spacing:0.1em;color:#0f1113;background:#e8c229;` +
      'border:none;border-radius:8px;padding:13px 30px;cursor:pointer;' +
      'box-shadow:0 6px 20px rgba(0,0,0,0.35)'
    // The click is the user gesture fullscreen and pointer lock require — the
    // same reason the first-arrival gate is a button and not an auto-enter.
    pill.onclick = () => enterGame()
    document.body.appendChild(pill)

    return () => pill.remove()
  }, [phase])

  return null
}
