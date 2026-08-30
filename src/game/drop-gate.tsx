'use client'

import { useEffect } from 'react'
import { useBoots } from '../store'
import { enterGame } from './session'

/**
 * THE SHAREABLE-LINK DROP GATE (owner vision: "share a link, sign in, and
 * you're in the game with other people"). When the editor URL carries
 * `?boots=drop`, a full-screen interstitial offers one button — DROP IN —
 * and that single click both satisfies the browser's user-gesture
 * requirement (fullscreen + pointer lock) and enters the game. Plugin-only:
 * the host just has to deliver a signed-in user to the project URL with the
 * param intact (the callbackURL preservation is the host-side P0).
 *
 * One-shot per page load: Esc after dropping returns to the EDITOR on
 * purpose — the gate never nags again until a fresh navigation.
 */

/** Pure gate: offer the interstitial? Exported for tests. */
export function shouldOfferDrop(search: string, phase: string, consumed: boolean): boolean {
  if (consumed || phase !== 'editor') return false
  return new URLSearchParams(search).get('boots') === 'drop'
}

let dropConsumed = false

/** Test/session hook: re-arm the one-shot (a fresh page load does this). */
export function resetDropGate(): void {
  dropConsumed = false
}

export function DropGate() {
  const phase = useBoots((s) => s.phase)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return
    if (!shouldOfferDrop(window.location.search, phase, dropConsumed)) return
    // The one-shot latches on the CLICK, not on mount: React StrictMode
    // double-invokes effects in dev — a mount-time latch made the first
    // pass consume the gate and its cleanup remove the veil, leaving the
    // second pass silent (the interstitial never showed at all).

    // Body-level DOM (NOT inside the canvas parent): enterGame requests
    // fullscreen on the canvas container, and the interstitial must not
    // ride into it — it removes itself on the very click that enters.
    const veil = document.createElement('div')
    veil.style.cssText =
      'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;' +
      'background:radial-gradient(ellipse at center, rgba(18,21,24,0.82), rgba(10,12,14,0.94))'
    const card = document.createElement('div')
    card.style.cssText =
      'display:flex;flex-direction:column;align-items:center;gap:18px;padding:44px 56px;' +
      'background:#14171b;border:2px solid #2e343b;border-radius:12px'
    const word = document.createElement('div')
    word.textContent = 'BOOTS'
    word.style.cssText =
      "font:800 40px/1 system-ui, -apple-system, sans-serif;letter-spacing:0.35em;color:rgba(255,255,255,0.92);padding-left:0.35em"
    const stripe = document.createElement('div')
    stripe.style.cssText =
      'width:100%;height:6px;border-radius:3px;background:repeating-linear-gradient(45deg,#e8c229 0 12px,#15171a 12px 24px)'
    const button = document.createElement('button')
    button.textContent = '⏵ DROP IN'
    button.style.cssText =
      "font:700 18px/1 system-ui, -apple-system, sans-serif;letter-spacing:0.12em;color:#0f1113;" +
      'background:#e8c229;border:none;border-radius:8px;padding:14px 34px;cursor:pointer'
    const hint = document.createElement('div')
    hint.textContent = 'WASD move · E gear up at the depot behind you · Esc leaves the game'
    hint.style.cssText =
      "font:600 11px/1.4 system-ui, -apple-system, sans-serif;letter-spacing:0.06em;color:rgba(255,255,255,0.4)"
    card.append(word, stripe, button, hint)
    veil.appendChild(card)
    button.onclick = () => {
      dropConsumed = true
      veil.remove()
      enterGame()
    }
    document.body.appendChild(veil)
    return () => {
      veil.remove()
    }
  }, [phase])
  return null
}
