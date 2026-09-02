import { localUserId, participantName } from './net'
import { browserPendingStorage } from './pending-store'

/**
 * THE PLAYER'S NAME — what floats over your hard hat, and how you change it.
 *
 * The name a peer sees is host-provided today: the roster carries each
 * participant's display name (their Google name), and remote-players paints it
 * on the tag. That is a fine DEFAULT — `googleFirstName()` is the first token
 * of your own roster name, the Fortnite-style given name — but the roster is
 * the host's and cannot carry a name YOU chose. So a chosen nickname rides the
 * pose frame instead (presence-interp's soft `nm`, like the fire counter `f`),
 * reaching peers with your first frame and needing no host cooperation.
 *
 * Persistence follows voice.ts exactly: the override lives in browser-scoped
 * storage OUTSIDE the session store (store.ts is wiped by resetSession on
 * reload), so your name survives a refresh. Blank clears the override and you
 * are your Google first name again.
 *
 * Import-light on purpose: only net.ts (localUserId/participantName). Reusing
 * presence.participantName would loop (presence → remote-players → nickname),
 * so the 'builder' fallback is kept local here.
 */

/** Max characters — matches makeNameTexture's slice, so the tag never clips a longer name mid-render. */
export const NICK_MAX = 16
const NICK_KEY = 'boots.nick.1'

let override: string | null = null
let loaded = false
const listeners = new Set<() => void>()

/**
 * Clean a raw name: trim, strip control characters, collapse whitespace to
 * single spaces, cap at NICK_MAX. Pure — the wire and the UI both run it.
 */
export function sanitizeNick(raw: string): string {
  let out = ''
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0
    // Drop control characters (< 0x20 and DEL); everything printable stays.
    out += code < 0x20 || code === 0x7f ? ' ' : ch
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, NICK_MAX)
}

function load(): void {
  if (loaded) return
  loaded = true
  const raw = browserPendingStorage()?.getItem(NICK_KEY)
  override = raw ? sanitizeNick(raw) || null : null
}

/** The first token of the roster (Google) name — the given name, the default tag. */
export function googleFirstName(): string {
  const mine = localUserId()
  const full = mine ? (participantName(mine) ?? '') : ''
  return full.trim().split(/\s+/)[0] ?? ''
}

/**
 * The name to show and to send: your chosen override, else your Google first
 * name, else 'builder' (the roster may not have resolved yet). Recomputed on
 * each read — cheap — so a late-arriving roster name is picked up.
 */
export function localDisplayName(): string {
  load()
  if (override) return override
  const google = googleFirstName()
  return google || 'builder'
}

/**
 * Set (or clear, with '' / blank) the chosen nickname. Persists to browser
 * storage, updates the module state, and notifies listeners (the HUD label,
 * the panel input, the depot mirror) so they re-read.
 */
export function setNick(raw: string): string {
  load()
  const clean = sanitizeNick(raw)
  override = clean || null
  const store = browserPendingStorage()
  if (store) {
    if (override) store.setItem(NICK_KEY, override)
    else store.removeItem(NICK_KEY)
  }
  for (const fn of listeners) fn()
  return clean
}

/** The raw override (for an input's current value); '' when using the default. */
export function currentNick(): string {
  load()
  return override ?? ''
}

/** Re-notified whenever the name changes (rename, or a clear back to default). */
export function onNickChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Test-only reset of the module singleton. */
export function resetNicknameForTests(): void {
  override = null
  loaded = false
  listeners.clear()
}
