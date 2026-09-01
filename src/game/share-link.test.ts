import { afterEach, describe, expect, test } from 'bun:test'
import {
  copyText,
  currentDropInUrl,
  dropInUrlFrom,
  getShareBridge,
  type ProjectShareBridge,
  publishProject,
  shareMessage,
  shareMessageTone,
  shareReach,
  type ShareState,
  shareVisibility,
  showsPrivateWarning,
} from './share-link'

/**
 * SHARE LINK — the one-link drop-in.
 *
 * What these tests protect is ONE mistake, and an earlier version of this file
 * asserted the mistake instead of catching it: handing a friend a URL that
 * opens for YOU and does nothing for THEM.
 *
 * `/editor/<id>` is the route the owner is standing on. Shared, it renders a
 * stranger the read-only public project view — no plugin rail, no drop gate,
 * so "nothing happened" (owner report 2026-08-31). The recipient's route is
 * `/play/<id>`, the open-lobby one. Hence: the origin and project id are read
 * off the page, but the route is normalized to the one that works for whoever
 * receives the link. `/scene/` is left alone — a dev server has no `/play`.
 *
 * The second thing they protect is the sentence under the button. A private
 * project only opens for its owner; a share flow that says "link copied!" and
 * stops there sends someone to a permission wall. So every state has a
 * message, and the one state that must never lie — private — is asserted
 * against the warning gate too.
 */

const globals = globalThis as {
  __pascalProjectShare?: ProjectShareBridge
  location?: unknown
  navigator?: unknown
}

/** A bridge whose visibility the test controls. */
const bridgeOf = (
  isPrivate: boolean,
  setPublic: ProjectShareBridge['setPublic'] = async () => ({ ok: true }),
): ProjectShareBridge => ({
  isPrivate,
  projectId: 'project_AHyVrpVr3g1jUXpr',
  setPublic,
  subscribe: () => () => {},
  version: 1,
})

/**
 * A v2 bridge — one that can tell us whether the link drops anyone in.
 * `isPrivate` defaults to public because reach only matters once it is.
 */
const lobbyBridge = (isOpenLobby: boolean, isPrivate = false): ProjectShareBridge => ({
  ...bridgeOf(isPrivate),
  isOpenLobby,
  version: 2,
})

afterEach(() => {
  delete globals.__pascalProjectShare
  // `location` and `navigator` do not exist under bun by default; anything a
  // test installed has to go, or the next file inherits a fake browser.
  delete globals.location
  delete globals.navigator
})

describe('the link is the route that works for them', () => {
  test('the editor route is normalized to the lobby route', () => {
    // THE REGRESSION. Standing at my desk, the link I hand out is the lobby.
    expect(dropInUrlFrom('https://editor.pascal.app/editor/project_AHyVrpVr3g1jUXpr')).toBe(
      'https://editor.pascal.app/play/project_AHyVrpVr3g1jUXpr?boots=drop',
    )
  })

  test('a lobby link stays a lobby link', () => {
    expect(dropInUrlFrom('https://editor.pascal.app/play/project_AHyVrpVr3g1jUXpr')).toBe(
      'https://editor.pascal.app/play/project_AHyVrpVr3g1jUXpr?boots=drop',
    )
  })

  test('a local dev link keeps /scene — there is no /play to send anyone to', () => {
    expect(dropInUrlFrom('http://localhost:3002/scene/project_ahyvrpvr3g1juxpr')).toBe(
      'http://localhost:3002/scene/project_ahyvrpvr3g1juxpr?boots=drop',
    )
  })

  test('the drop marker is set, not appended twice', () => {
    // Sharing a link you were yourself given must not compound. Already-lobby
    // input is the realistic case here: it is what a recipient re-shares.
    expect(dropInUrlFrom('https://editor.pascal.app/play/p_1?boots=drop')).toBe(
      'https://editor.pascal.app/play/p_1?boots=drop',
    )
  })

  test('your own query state never rides along', () => {
    // A `?follow=` or a `?publish=1` from your visit is noise at best and a
    // wrong instruction at worst; the hash is yours too.
    expect(dropInUrlFrom('https://editor.pascal.app/editor/p_1?follow=abc&publish=1#node_9')).toBe(
      'https://editor.pascal.app/play/p_1?boots=drop',
    )
  })

  test('a trailing segment is dropped, not carried into the id', () => {
    expect(dropInUrlFrom('https://editor.pascal.app/editor/p_1/settings')).toBe(
      'https://editor.pascal.app/play/p_1?boots=drop',
    )
  })

  test('off a project page there is no link, and no crash', () => {
    for (const href of [
      'https://editor.pascal.app/',
      'https://editor.pascal.app/projects',
      'https://editor.pascal.app/editor/',
      'https://www.pascal.app/admin',
      'not a url at all',
      '',
    ]) {
      expect(dropInUrlFrom(href), href).toBeNull()
    }
  })

  test('currentDropInUrl reads location, and is null when there is none', () => {
    expect(currentDropInUrl()).toBeNull() // bun: no location
    globals.location = { href: 'https://editor.pascal.app/editor/p_1' }
    expect(currentDropInUrl()).toBe('https://editor.pascal.app/play/p_1?boots=drop')
  })
})

describe('the host bridge is feature-detected', () => {
  test('absent reads as no bridge; v1 and every version above it are taken', () => {
    // Deliberately NOT the collab bus's exact-version rule. Every field read
    // here is v1's and v2 only adds an optional one, so refusing a v2 host
    // would trade a host that can tell us MORE for no bridge at all — losing
    // the private warning and its one-click fix to a version bump.
    expect(getShareBridge()).toBeNull()
    globals.__pascalProjectShare = bridgeOf(true)
    expect(getShareBridge()?.projectId).toBe('project_AHyVrpVr3g1jUXpr')
    globals.__pascalProjectShare = { ...bridgeOf(true), version: 2 }
    expect(getShareBridge()?.version).toBe(2)
    globals.__pascalProjectShare = { ...bridgeOf(true), version: 7 }
    expect(getShareBridge()?.version).toBe(7)
  })

  test('a version below the protocol is still refused', () => {
    globals.__pascalProjectShare = { ...bridgeOf(true), version: 0 }
    expect(getShareBridge()).toBeNull()
  })

  test('visibility is unknown without a bridge — never guessed', () => {
    expect(shareVisibility(null)).toBe('unknown')
    expect(shareVisibility(bridgeOf(true))).toBe('private')
    expect(shareVisibility(bridgeOf(false))).toBe('public')
  })
})

describe('public is not the same as joinable', () => {
  /**
   * The bug this describes: a project can be public — anyone may OPEN it — and
   * still not be an open lobby, in which case the link renders the building
   * read-only and nobody drops into the game. The sidebar used to promise
   * "anyone with the link signs in and drops straight into your game" for any
   * public project, which is exactly the "nothing really like joining a game
   * together" report.
   */
  const url = 'https://editor.pascal.app/play/p_1?boots=drop'

  test('reach is unknown on a v1 host, and unknown is not false', () => {
    // The dangerous default: `isOpenLobby ?? false` would tell every v1 host's
    // owner their friend lands on a read-only view, including the hosts where
    // they in fact drop straight in.
    expect(shareReach(null)).toBe('unknown')
    expect(shareReach(bridgeOf(false))).toBe('unknown')
    expect(shareReach({ ...bridgeOf(false), version: 2 })).toBe('unknown')
  })

  test('reach follows the flag once the host sets it', () => {
    expect(shareReach(lobbyBridge(true))).toBe('drops-in')
    expect(shareReach(lobbyBridge(false))).toBe('view-only')
  })

  test('only a real lobby gets the promise', () => {
    const dropsIn = shareMessage({ kind: 'copied', reach: 'drops-in', url, visibility: 'public' })
    expect(dropsIn).toContain('drops straight into your game')

    const viewOnly = shareMessage({ kind: 'copied', reach: 'view-only', url, visibility: 'public' })
    expect(viewOnly).not.toContain('drops straight into your game')
    expect(viewOnly).toContain('read-only')
  })

  test('an unknown reach names the condition instead of promising or denying', () => {
    const message = shareMessage({ kind: 'copied', reach: 'unknown', url, visibility: 'public' })
    expect(message).not.toContain('drops straight into your game')
    expect(message).not.toContain('read-only')
    expect(message).toContain('lobby')
  })

  test('publishing a non-lobby says so — going public did not make it joinable', () => {
    // The trap in the one-click fix: the owner presses "Make it public",
    // succeeds, and the old copy congratulated them with a promise that
    // publishing has no power to make true.
    const message = shareMessage({ kind: 'published', reach: 'view-only', url })
    expect(message).not.toContain('drops straight into your game')
    expect(message).toContain('not an open lobby')
  })

  test('publishProject reports the reach it read from the host', async () => {
    expect(await publishProject(lobbyBridge(false), url)).toEqual({
      kind: 'published',
      reach: 'view-only',
      url,
    })
    expect(await publishProject(lobbyBridge(true), url)).toEqual({
      kind: 'published',
      reach: 'drops-in',
      url,
    })
  })

  test('a caveat is amber; an outcome is grey', () => {
    // "Copied" with a link that cannot deliver anyone looks like success, so it
    // may not be styled as one.
    expect(shareMessageTone({ kind: 'copied', reach: 'view-only', url, visibility: 'public' })).toBe(
      'warn',
    )
    expect(shareMessageTone({ kind: 'published', reach: 'view-only', url })).toBe('warn')
    expect(shareMessageTone({ error: 'nope', kind: 'publish-failed', url })).toBe('warn')

    expect(shareMessageTone({ kind: 'copied', reach: 'drops-in', url, visibility: 'public' })).toBe(
      'muted',
    )
    expect(shareMessageTone({ kind: 'copied', reach: 'unknown', url, visibility: 'public' })).toBe(
      'muted',
    )
    // Private is the warning box's job, not this line's.
    expect(shareMessageTone({ kind: 'copied', reach: 'view-only', url, visibility: 'private' })).toBe(
      'muted',
    )
    expect(shareMessageTone({ kind: 'idle' })).toBe('muted')
  })
})

describe('copying', () => {
  test('reports failure instead of assuming it landed', async () => {
    expect(await copyText('x')).toBe(false) // no navigator.clipboard under bun

    globals.navigator = {
      clipboard: {
        writeText: async () => {
          throw new Error('NotAllowedError')
        },
      },
    }
    expect(await copyText('x')).toBe(false)
  })

  test('writes the text through when the clipboard is there', async () => {
    const wrote: string[] = []
    globals.navigator = {
      clipboard: {
        writeText: async (t: string) => {
          wrote.push(t)
        },
      },
    }
    expect(await copyText('https://editor.pascal.app/editor/p_1?boots=drop')).toBe(true)
    expect(wrote).toEqual(['https://editor.pascal.app/editor/p_1?boots=drop'])
  })
})

describe('what the button says', () => {
  const url = 'https://editor.pascal.app/editor/p_1?boots=drop'

  test('every state says something, and only idle says nothing', () => {
    const states: ShareState[] = [
      { kind: 'idle' },
      { kind: 'no-link' },
      { kind: 'copied', reach: 'drops-in', url, visibility: 'public' },
      { kind: 'copied', reach: 'view-only', url, visibility: 'public' },
      { kind: 'copied', reach: 'unknown', url, visibility: 'public' },
      { kind: 'copied', reach: 'unknown', url, visibility: 'private' },
      { kind: 'copied', reach: 'unknown', url, visibility: 'unknown' },
      { kind: 'manual', reach: 'drops-in', url, visibility: 'public' },
      { kind: 'publishing', url },
      { kind: 'published', reach: 'drops-in', url },
      { kind: 'published', reach: 'view-only', url },
      { kind: 'published', reach: 'unknown', url },
      { error: 'not allowed', kind: 'publish-failed', url },
    ]
    for (const state of states) {
      expect(shareMessage(state).length > 0, state.kind).toBe(state.kind !== 'idle')
    }
  })

  test('a private copy never claims the friend can join', () => {
    // The regression that matters: "Link copied — anyone with it can join" on
    // a private project sends someone straight into a permission wall.
    // Private wins over reach: even a project that IS an open lobby refuses a
    // stranger while it is private, so the promise stays off.
    for (const reach of ['drops-in', 'view-only', 'unknown'] as const) {
      const message = shareMessage({ kind: 'copied', reach, url, visibility: 'private' })
      expect(message, reach).not.toContain('anyone')
    }
    expect(showsPrivateWarning({ kind: 'copied', reach: 'drops-in', url, visibility: 'private' })).toBe(
      true,
    )
    expect(showsPrivateWarning({ kind: 'manual', reach: 'unknown', url, visibility: 'private' })).toBe(
      true,
    )
  })

  test('an unknown visibility says the condition out loud', () => {
    // No bridge: we cannot read the row, so the honest line names what has to
    // be true rather than promising either way.
    const message = shareMessage({ kind: 'copied', reach: 'unknown', url, visibility: 'unknown' })
    expect(message).toContain('public')
    expect(showsPrivateWarning({ kind: 'copied', reach: 'unknown', url, visibility: 'unknown' })).toBe(
      false,
    )
  })

  test('the warning is gone the moment the project is public', () => {
    expect(showsPrivateWarning({ kind: 'copied', reach: 'drops-in', url, visibility: 'public' })).toBe(
      false,
    )
    expect(showsPrivateWarning({ kind: 'published', reach: 'drops-in', url })).toBe(false)
    expect(showsPrivateWarning({ kind: 'publishing', url })).toBe(false)
    expect(
      shareMessage({ kind: 'copied', reach: 'drops-in', url, visibility: 'public' }),
    ).toContain('anyone')
  })

  test('a refusal is quoted, not swallowed', () => {
    expect(shareMessage({ error: 'not your project', kind: 'publish-failed', url })).toContain(
      'not your project',
    )
  })
})

describe('the one-click publish', () => {
  const url = 'https://editor.pascal.app/editor/p_1?boots=drop'

  test('success becomes published', async () => {
    // A v1 host cannot say whether the link drops anyone in, so it does not.
    expect(await publishProject(bridgeOf(true), url)).toEqual({
      kind: 'published',
      reach: 'unknown',
      url,
    })
  })

  test("the host's own refusal is surfaced verbatim", async () => {
    // The host gates this on a capability (`project:make-public`), so a
    // no-permission answer is a normal outcome, not an exception — and the
    // owner has to be told which it was.
    const bridge = bridgeOf(true, async () => ({ error: 'you cannot publish this project', ok: false }))
    expect(await publishProject(bridge, url)).toEqual({
      error: 'you cannot publish this project',
      kind: 'publish-failed',
      url,
    })
  })

  test('a refusal with no reason still reports a failure', async () => {
    const bridge = bridgeOf(true, async () => ({ ok: false }))
    expect(await publishProject(bridge, url)).toEqual({
      error: 'the host refused',
      kind: 'publish-failed',
      url,
    })
  })

  test('a thrown error cannot leave the button spinning', async () => {
    const bridge = bridgeOf(true, async () => {
      throw new Error('network down')
    })
    expect(await publishProject(bridge, url)).toEqual({
      error: 'network down',
      kind: 'publish-failed',
      url,
    })
  })

  test('with no bridge it fails honestly instead of pretending', async () => {
    // Flag off, or an older host: the plugin has no way to publish, and must
    // say so rather than reporting a success nobody performed.
    const state = await publishProject(null, url)
    expect(state.kind).toBe('publish-failed')
    expect(shareMessage(state)).toContain('cannot change project visibility')
  })
})
