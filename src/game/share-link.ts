/**
 * SHARE LINK — one link, and your friend is standing next to you.
 *
 * Owner call (2026-08-31): "dans la sidebar, sous jump in et sous les
 * controls, je veux un bouton 'share link' qui copy le link a paste a un ami
 * pour qu'il join ce projet, cet editor, cette game (drop in en 1 lien)" —
 * and then: "si qq1 click le 'share link' on met warning, 'project is
 * private, only you can join' avec un bouton dans le warning pour mettre en
 * public en 1 click".
 *
 * So two jobs, and only the first one is the plugin's alone.
 *
 * ── THE LINK IS THE PAGE YOU ARE ON ───────────────────────────────────────
 * The URL is built from `location`, not assembled from a route template. That
 * is deliberate: the same project is reachable at `/editor/<id>` in
 * production, `/play/<id>` on the lobby route and `/scene/<id>` on a local
 * dev server, and a hand-built `/editor/...` link would hand a 404 to
 * whoever is testing locally. Whatever route got YOU here is the route that
 * works, so the share link keeps it and only appends the drop-in marker.
 *
 * `?boots=drop` is that marker (drop-gate.tsx): the friend lands in the
 * editor and the gate offers the game immediately instead of making them
 * find the plugin rail.
 *
 * ── VISIBILITY IS THE HOST'S, NOT OURS ────────────────────────────────────
 * Whether a project is private, and the right to change that, belong to the
 * host app: it owns the row, the session, and the capability check behind
 * `project:make-public`. A plugin must not invent a way to publish someone's
 * building. So the host may install a bridge —
 * `globalThis.__pascalProjectShare`, feature-detected exactly like the
 * collaboration bus in net.ts — and this module reads it if it is there.
 *
 * With no bridge the button still copies the link and says the one true
 * thing we can say without asking anyone: a private project only opens for
 * you. That is the flag-off path, and it is the path on every host that has
 * not shipped the bridge.
 *
 * Everything here is pure or purely a wrapper, so the whole flow is testable
 * without a browser: pass a `href`, pass a fake bridge, pass a fake clipboard.
 */

/** The drop-in query marker the gate watches for (drop-gate.ts). */
export const DROP_PARAM = 'boots'
export const DROP_VALUE = 'drop'

/** Routes a Boots session can be reached on — the same three the pending
 * window scopes by (pending-store.ts). Anything else is not a project page
 * and there is no link to share. */
const SHAREABLE_ROUTE = /^\/(editor|play|scene)\/([A-Za-z0-9_-]{1,120})(?:\/|$)/

/**
 * The host's project-share bridge. Version-gated like the collab bus: an
 * unknown version reads as "no bridge" rather than as a bridge we can only
 * half-understand.
 *
 * `isPrivate` is a snapshot, not a promise — the host keeps it live in its own
 * project store and re-renders us through `subscribe`.
 */
export type ProjectShareBridge = {
  version: number
  projectId: string
  isPrivate: boolean
  /** Flip the project to public. Never throws; reports its own failure. */
  setPublic(): Promise<{ ok: boolean; error?: string }>
  /** Called whenever `isPrivate` changes. Returns the unsubscribe. */
  subscribe(handler: () => void): () => void
}

/** Feature detection — protocol v1 only. */
export function getShareBridge(): ProjectShareBridge | null {
  const bridge = (globalThis as { __pascalProjectShare?: ProjectShareBridge })
    .__pascalProjectShare
  return bridge && bridge.version === 1 ? bridge : null
}

/**
 * The drop-in link for a page URL, or null when this is not a project page.
 * Pure — `href` in, href out.
 *
 * Keeps the route and the project id exactly as they are, drops every other
 * query parameter and the hash (a `?follow=<session>` or a `?publish=1`
 * carried over from your own visit is noise at best and a wrong instruction
 * at worst), and sets the drop marker.
 */
export function dropInUrlFrom(href: string): string | null {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  const match = SHAREABLE_ROUTE.exec(url.pathname)
  if (!match) return null
  const share = new URL(`${url.origin}/${match[1]}/${match[2]}`)
  share.searchParams.set(DROP_PARAM, DROP_VALUE)
  return share.toString()
}

/** The drop-in link for THIS page, or null off a project page. */
export function currentDropInUrl(): string | null {
  const href = (globalThis as { location?: { href?: string } }).location?.href
  return typeof href === 'string' ? dropInUrlFrom(href) : null
}

/**
 * Copy text, reporting whether it landed. `navigator.clipboard` needs a
 * secure context and a user gesture; both hold on a button click in the
 * editor, but an http:// dev host over a LAN address is exactly the case
 * where it silently does not exist — so the failure is reported, never
 * assumed away, and the caller shows the link to copy by hand.
 */
export async function copyText(text: string): Promise<boolean> {
  const clipboard = (globalThis as { navigator?: { clipboard?: { writeText?: (t: string) => Promise<void> } } })
    .navigator?.clipboard
  if (!clipboard?.writeText) return false
  try {
    await clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

// ── What the button says ────────────────────────────────────────────────────

/** What we know about who can open the link. `unknown` is the honest answer
 * on a host with no bridge — not a guess in either direction. */
export type ShareVisibility = 'public' | 'private' | 'unknown'

export function shareVisibility(bridge: ProjectShareBridge | null): ShareVisibility {
  if (!bridge) return 'unknown'
  return bridge.isPrivate ? 'private' : 'public'
}

export type ShareState =
  | { kind: 'idle' }
  | { kind: 'copied'; url: string; visibility: ShareVisibility }
  /** Copy failed — the caller shows the URL for a manual copy. */
  | { kind: 'manual'; url: string; visibility: ShareVisibility }
  | { kind: 'no-link' }
  | { kind: 'publishing'; url: string }
  | { kind: 'published'; url: string }
  | { kind: 'publish-failed'; url: string; error: string }

/**
 * The single line under the button. Pure, and the reason the panel has no
 * copy logic of its own: every branch of the flow says something, and none of
 * them may claim the friend can join when only the owner can.
 */
export function shareMessage(state: ShareState): string {
  switch (state.kind) {
    case 'idle':
      return ''
    case 'no-link':
      return 'Open a project to get a link to share.'
    case 'copied':
      if (state.visibility === 'private') return 'Link copied.'
      if (state.visibility === 'public') {
        return 'Link copied — anyone with it lands in the editor and can jump straight into your game.'
      }
      return 'Link copied. Your friend needs the project to be public (or shared with them) to open it.'
    case 'manual':
      return 'Copy this link by hand — the browser refused clipboard access here.'
    case 'publishing':
      return 'Making the project public…'
    case 'published':
      return 'Public now — anyone with the link can open the project and jump in.'
    case 'publish-failed':
      return `Could not make the project public: ${state.error}`
  }
}

/** True when the private warning (and its one-click fix) belongs on screen. */
export function showsPrivateWarning(state: ShareState): boolean {
  return (
    (state.kind === 'copied' || state.kind === 'manual') && state.visibility === 'private'
  )
}

/**
 * Ask the host to publish. Returns the next state, so the panel is a thin
 * `setState(await publishProject(...))` — no error handling of its own to get
 * wrong, and no way for a rejected promise to leave the button spinning.
 */
export async function publishProject(
  bridge: ProjectShareBridge | null,
  url: string,
): Promise<ShareState> {
  if (!bridge) {
    return { error: 'this editor cannot change project visibility', kind: 'publish-failed', url }
  }
  try {
    const result = await bridge.setPublic()
    if (result.ok) return { kind: 'published', url }
    return { error: result.error ?? 'the host refused', kind: 'publish-failed', url }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'unexpected error',
      kind: 'publish-failed',
      url,
    }
  }
}
