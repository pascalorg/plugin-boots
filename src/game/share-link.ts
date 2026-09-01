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
 * ── THE LINK IS THE ROUTE THAT WORKS FOR *THEM* ───────────────────────────
 * The URL is derived from `location` — the origin and the project id are read
 * off the page rather than configured — but the ROUTE is not kept as-is, and
 * that distinction cost us a broken share (owner report 2026-08-31: "my
 * friend clicked it and got to that editor screen, nothing happened").
 *
 * `/editor/<id>` is the route that works for ME, an insider. For a stranger
 * the same URL renders the read-only public project view: no plugin rail, no
 * drop gate, nothing to click. The route that works for THEM is `/play/<id>`
 * — the open-lobby route, which checks the lobby marker, sends them through
 * sign-in and arms the gate. So a shared `/editor/<id>` is silently useless
 * to the only person who receives it, and this module normalizes it away.
 *
 *   /editor/<id>  →  /play/<id>?boots=drop     (share the lobby, not my desk)
 *   /play/<id>    →  /play/<id>?boots=drop     (already right)
 *   /scene/<id>   →  /scene/<id>?boots=drop    (local dev has no /play)
 *
 * `?boots=drop` is the marker (drop-gate.tsx) that offers the game on arrival
 * instead of making them hunt for the plugin rail. On `/play` it is also the
 * canonical form the route redirects to (`lobby-drop-link.ts`), so emitting it
 * here costs the recipient one fewer redirect and never loops.
 *
 * A LIMIT WORTH KNOWING: `/play` additionally requires the project to carry
 * the host's open-lobby marker, which is a reviewed entry and NOT something
 * visibility implies. Public-but-unmarked does not drop anyone in, so "public"
 * alone was never enough to promise a friend gets into the game — and until
 * bridge v2 this module could not tell the two apart, so it said the friend
 * "drops straight into your game" for any public project. That sentence was
 * wrong for every public project that is not a lobby.
 *
 * Bridge v2 adds `isOpenLobby`, and `shareReach` below turns it into the only
 * three answers there are: they drop in, they get a read-only view, or we do
 * not know (a v1 host, which is every host that has not shipped the field).
 * The unknown branch promises nothing.
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
 * Where a visitor should be sent for each route we might be standing on.
 *
 * `editor → play` is the whole point: see the header. `scene` stays itself
 * because a local dev server has no `/play` route at all, and a link to a dev
 * server is only ever shared with yourself or a machine on the same LAN.
 */
const SHARE_ROUTE_FOR: Record<string, string> = {
  editor: 'play',
  play: 'play',
  scene: 'scene',
}

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
  /**
   * v2 — whether the host will drop a stranger holding this link into the
   * game (`/play/<id>`), which is a separate decision from visibility.
   *
   * Optional on purpose: absent means "this host does not know how to tell
   * you", which is the honest reading of a v1 bridge and NOT `false`. Never
   * default it — `bridge.isOpenLobby ?? false` would print "they will land on
   * a read-only view" on hosts that in fact drop them straight in.
   */
  isOpenLobby?: boolean
  /** Flip the project to public. Never throws; reports its own failure. */
  setPublic(): Promise<{ ok: boolean; error?: string }>
  /** Called whenever `isPrivate` changes. Returns the unsubscribe. */
  subscribe(handler: () => void): () => void
}

/**
 * Feature detection — v1 and up.
 *
 * Forward-compatible rather than exact, which is the opposite of the collab
 * bus's rule and deliberate: every field this module reads is v1's, and v2 only
 * ADDS an optional one. A `version === 1` gate would make a v2 host — a host
 * that can tell us MORE — read as no bridge at all, and lose the private
 * warning and its one-click fix to a version bump. A field we do not know about
 * is ignored; a field we do know about is optional and feature-detected on its
 * own (`shareReach`).
 */
export function getShareBridge(): ProjectShareBridge | null {
  const bridge = (globalThis as { __pascalProjectShare?: ProjectShareBridge })
    .__pascalProjectShare
  return bridge && bridge.version >= 1 ? bridge : null
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
  const route = SHARE_ROUTE_FOR[match[1]!]
  if (!route) return null
  const share = new URL(`${url.origin}/${route}/${match[2]}`)
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

/**
 * What the person receiving the link actually gets. Visibility answers "can
 * they open it"; this answers "do they end up in the game", and the two come
 * apart for every public project the host has not opened as a lobby.
 *
 * `unknown` is a v1 host and stays unknown: see `isOpenLobby`.
 */
export type ShareReach = 'drops-in' | 'view-only' | 'unknown'

export function shareReach(bridge: ProjectShareBridge | null): ShareReach {
  if (!bridge || bridge.isOpenLobby === undefined) return 'unknown'
  return bridge.isOpenLobby ? 'drops-in' : 'view-only'
}

export type ShareState =
  | { kind: 'idle' }
  | { kind: 'copied'; url: string; visibility: ShareVisibility; reach: ShareReach }
  /** Copy failed — the caller shows the URL for a manual copy. */
  | { kind: 'manual'; url: string; visibility: ShareVisibility; reach: ShareReach }
  | { kind: 'no-link' }
  | { kind: 'publishing'; url: string }
  /** Publishing changed visibility and nothing else — reach is unaffected by
   * it, which is exactly why this branch has to carry one. */
  | { kind: 'published'; url: string; reach: ShareReach }
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
      if (state.visibility === 'public') return publicReachMessage('Link copied', state.reach)
      return 'Link copied. Your friend needs the project to be public (or shared with them) to open it.'
    case 'manual':
      return 'Copy this link by hand — the browser refused clipboard access here.'
    case 'publishing':
      return 'Making the project public…'
    case 'published':
      return publicReachMessage('Public now', state.reach)
    case 'publish-failed':
      return `Could not make the project public: ${state.error}`
  }
}

/**
 * The one sentence that used to be a lie. A public project only drops a
 * stranger into the game if the host also opened it as a lobby, so the promise
 * is made only where we can see that it holds.
 */
function publicReachMessage(lead: string, reach: ShareReach): string {
  switch (reach) {
    case 'drops-in':
      return `${lead} — anyone with it signs in and drops straight into your game.`
    case 'view-only':
      return `${lead} — but this project is not an open lobby, so the link shows your building read-only instead of dropping them into the game.`
    case 'unknown':
      return `${lead} — anyone with it can open the project. Dropping them into the game also needs this project opened as a lobby.`
  }
}

/**
 * How the line under the button should read. The view-only case is a caveat,
 * not an outcome: it looks like success and isn't, so it gets the same amber as
 * a failed publish rather than sitting greyed out under a copied link.
 */
export function shareMessageTone(state: ShareState): 'muted' | 'warn' {
  if (state.kind === 'publish-failed') return 'warn'
  const reachesNobody =
    (state.kind === 'published' && state.reach === 'view-only') ||
    ((state.kind === 'copied' || state.kind === 'manual') &&
      state.visibility === 'public' &&
      state.reach === 'view-only')
  return reachesNobody ? 'warn' : 'muted'
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
    // Read the reach AFTER the host applied it: publishing is the one moment a
    // host could also open the lobby, and re-reading costs nothing.
    if (result.ok) return { kind: 'published', reach: shareReach(bridge), url }
    return { error: result.error ?? 'the host refused', kind: 'publish-failed', url }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'unexpected error',
      kind: 'publish-failed',
      url,
    }
  }
}
