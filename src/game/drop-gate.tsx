'use client'

import { sceneRegistry } from '@pascal-app/core'
import { useEffect } from 'react'
import { BOOTS_LOADER } from '../art'
import { useBoots } from '../store'
import { enterGame } from './session'
import { ASK_HINT, beginEntry, currentEntryPlan, primeMicPermission } from './mic-gate'
import { currentNick, googleFirstName, setNick } from './nickname'
import { loadMicPref, micState, releaseMic, saveMicPref } from './voice'

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
 *
 * THE MIC IS DECIDED HERE TOO (mic-gate.ts). The browser's permission prompt
 * must never open inside enterGame's fullscreen + pointer-lock sequence —
 * session.ts exits the game when either is lost — so the veil carries a
 * MIC ON/OFF toggle (remembered across visits, default on) and JUMP IN runs
 * through `beginEntry`: when the browser has to ask, that click IS the prompt
 * ("ALLOW THE MIC ↑" → "⏵ PLAY") and the next one enters; when it already said
 * yes, one click does both. The re-entry pill takes the same path. A page that
 * leaves the veil without entering releases the mic; one that entered hands it
 * to the session, which releases it on Esc.
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
    veil.dataset.bootsDropVeil = '1' // QA hook: distinct from the game's own [data-boots-veil]
    veil.style.cssText =
      `position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;align-items:center;` +
      `justify-content:center;gap:26px;background:#0c0e10`
    // THE HERO, above the bar — the same animated Pascaline plate the in-game
    // card shows (art.ts), so the two loading surfaces a visitor sees back to
    // back are one brand. A plain <img>: the browser animates it, and nothing
    // here competes with the scene hydrating underneath.
    const hero = document.createElement('img')
    hero.src = BOOTS_LOADER
    hero.alt = ''
    hero.draggable = false
    hero.dataset.bootsHero = '1'
    // height:auto keeps the plate's own hazard rail — a fixed height with
    // object-fit:cover cropped it off in the first pass.
    hero.style.cssText =
      'display:block;width:min(520px,74vw);height:auto;border-radius:8px;' +
      'border:1px solid rgba(255,255,255,0.10);box-sizing:border-box;background:#0d0f11'
    const word = document.createElement('div')
    word.textContent = 'BOOTS'
    word.style.cssText = `font:800 44px/1 ${FONT};letter-spacing:0.35em;color:rgba(255,255,255,0.92);padding-left:0.35em`
    // Loading bar (visible until ready) — same look as the in-game card.
    const track = document.createElement('div')
    track.dataset.bootsDropBar = '1' // QA hook: the bar the hero must sit above
    track.style.cssText =
      'width:min(420px,60vw);height:10px;border-radius:5px;background:rgba(255,255,255,0.08);overflow:hidden'
    const fill = document.createElement('div')
    fill.style.cssText =
      'width:0%;height:100%;border-radius:5px;background:rgba(255,255,255,0.85);transition:width 0.25s linear'
    track.appendChild(fill)
    // YOUR NAME — the tag other players see over your hard hat. Defaults to your
    // Google first name (the placeholder); type to pick a nickname, which
    // persists across reloads and rides your first pose frame to peers.
    const nameRow = document.createElement('div')
    nameRow.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px'
    const nameLabel = document.createElement('div')
    nameLabel.textContent = 'YOUR NAME'
    nameLabel.style.cssText = `font:600 11px/1 ${FONT};letter-spacing:0.22em;color:rgba(255,255,255,0.45)`
    const nameInput = document.createElement('input')
    nameInput.type = 'text'
    nameInput.maxLength = 16
    nameInput.value = currentNick()
    nameInput.placeholder = googleFirstName() || 'builder'
    nameInput.dataset.bootsNameInput = '1' // QA hook
    nameInput.style.cssText =
      `font:600 18px/1 ${FONT};text-align:center;color:rgba(255,255,255,0.95);background:rgba(255,255,255,0.06);` +
      'border:1px solid rgba(255,255,255,0.14);border-radius:8px;padding:11px 16px;width:min(260px,54vw);outline:none'
    nameInput.oninput = () => setNick(nameInput.value)
    // Keep the veil's own keyboard handling from swallowing typing.
    nameInput.onkeydown = (e) => e.stopPropagation()
    // THE MIC, BEFORE THE GAME (see the header). The toggle is the standing
    // choice; the prompt itself, when the browser needs one, is the JUMP IN
    // click. Reading the permission now means the button knows which it is by
    // the time it appears.
    primeMicPermission()
    const micToggle = document.createElement('button')
    micToggle.type = 'button'
    micToggle.dataset.bootsMicPref = '1' // QA hook: [data-boots-mic-pref-value] = on|off
    micToggle.style.cssText =
      `font:600 11px/1 ${FONT};letter-spacing:0.22em;color:rgba(255,255,255,0.85);background:rgba(255,255,255,0.06);` +
      'border:1px solid rgba(255,255,255,0.14);border-radius:999px;padding:8px 14px;cursor:pointer;margin-top:4px'
    nameRow.append(nameLabel, nameInput, micToggle)
    // The ONE button — hidden until the world is ready.
    const button = document.createElement('button')
    button.textContent = '⏵ JUMP IN'
    button.style.cssText =
      `display:none;font:700 20px/1 ${FONT};letter-spacing:0.12em;color:#0f1113;background:#e8c229;` +
      'border:none;border-radius:8px;padding:16px 44px;cursor:pointer'
    // Under the button, only while the click will be a permission prompt.
    const micHint = document.createElement('div')
    micHint.dataset.bootsMicHint = '1' // QA hook
    micHint.textContent = ASK_HINT
    micHint.style.cssText = `display:none;font:600 11px/1 ${FONT};letter-spacing:0.12em;color:rgba(255,255,255,0.45);margin-top:-14px`
    veil.append(hero, word, nameRow, track, button, micHint)
    document.body.appendChild(veil)

    const t0 = performance.now()
    let lastCensus = -1
    let stablePolls = 0
    let ready = false
    const renderMic = () => {
      const pref = loadMicPref()
      micToggle.textContent = pref === 'on' ? '🎙 MIC ON' : '🎙 MIC OFF'
      micToggle.dataset.bootsMicPrefValue = pref
      micToggle.style.color = pref === 'on' ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.45)'
      micHint.style.display = ready && currentEntryPlan() === 'ask-first' ? 'block' : 'none'
    }
    micToggle.onclick = () => {
      const next = loadMicPref() === 'on' ? 'off' : 'on'
      saveMicPref(next)
      // MIC OFF lets go of a device the first click already acquired ('ask-first'
      // settled to PLAY): the recording indicator goes out here, not on the next
      // click, and nothing live can be carried into the game. The permission
      // read is unaffected — flipping back on re-acquires without a prompt.
      if (next === 'off' && (micState() === 'live' || micState() === 'muted')) releaseMic()
      renderMic()
    }
    renderMic()
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
        // Bar → button: the swap IS the "it's ready" tell.
        track.style.display = 'none'
        button.style.display = 'block'
      }
      // The permission read (primeMicPermission) settles asynchronously; the
      // toggle can flip; either changes whether the next click asks or enters.
      renderMic()
    }, POLL_MS)

    button.onclick = () =>
      beginEntry({
        setLabel: (text, busy) => {
          button.textContent = text
          button.disabled = busy
          button.style.opacity = busy ? '0.6' : '1'
          micHint.style.display = 'none'
        },
        enter: () => {
          dropConsumed = true
          if (!enterGame()) {
            // Nothing entered (no canvas yet), so nothing may keep the mic.
            releaseMic()
            return
          }
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
        },
      })
    return () => {
      clearInterval(timer)
      veil.remove()
      // A page that leaves the veil without entering must not keep a hot mic.
      // One that entered hands it to the session: setPhase('game') is
      // synchronous inside enterGame, so by the time this cleanup runs the
      // phase already says so, and the session's stopVoice releases it on Esc.
      if (useBoots.getState().phase !== 'game') releaseMic()
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
    // same reason the first-arrival gate is a button and not an auto-enter. It
    // runs through the mic gate like the first one: Esc released the mic, and
    // re-acquiring an already-granted device is prompt-free.
    pill.onclick = () =>
      beginEntry({
        setLabel: (text, busy) => {
          pill.textContent = text
          pill.disabled = busy
          pill.style.opacity = busy ? '0.6' : '1'
        },
        enter: () => {
          if (!enterGame()) releaseMic()
        },
      })
    document.body.appendChild(pill)

    return () => {
      pill.remove()
      if (useBoots.getState().phase !== 'game') releaseMic()
    }
  }, [phase])

  return null
}
