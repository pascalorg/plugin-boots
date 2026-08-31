import { afterEach, describe, expect, test } from 'bun:test'
import {
  copyText,
  currentDropInUrl,
  dropInUrlFrom,
  getShareBridge,
  type ProjectShareBridge,
  publishProject,
  type ShareState,
  shareMessage,
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
  test('absent, and any version but 1, read as no bridge', () => {
    // Same contract as the collab bus (net.ts): a protocol we only half
    // understand is worse than none, because the half we get wrong is
    // someone's project visibility.
    expect(getShareBridge()).toBeNull()
    globals.__pascalProjectShare = { ...bridgeOf(true), version: 2 }
    expect(getShareBridge()).toBeNull()
    globals.__pascalProjectShare = bridgeOf(true)
    expect(getShareBridge()?.projectId).toBe('project_AHyVrpVr3g1jUXpr')
  })

  test('visibility is unknown without a bridge — never guessed', () => {
    expect(shareVisibility(null)).toBe('unknown')
    expect(shareVisibility(bridgeOf(true))).toBe('private')
    expect(shareVisibility(bridgeOf(false))).toBe('public')
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
      { kind: 'copied', url, visibility: 'public' },
      { kind: 'copied', url, visibility: 'private' },
      { kind: 'copied', url, visibility: 'unknown' },
      { kind: 'manual', url, visibility: 'public' },
      { kind: 'publishing', url },
      { kind: 'published', url },
      { error: 'not allowed', kind: 'publish-failed', url },
    ]
    for (const state of states) {
      expect(shareMessage(state).length > 0, state.kind).toBe(state.kind !== 'idle')
    }
  })

  test('a private copy never claims the friend can join', () => {
    // The regression that matters: "Link copied — anyone with it can join" on
    // a private project sends someone straight into a permission wall.
    const message = shareMessage({ kind: 'copied', url, visibility: 'private' })
    expect(message).not.toContain('anyone')
    expect(showsPrivateWarning({ kind: 'copied', url, visibility: 'private' })).toBe(true)
    expect(showsPrivateWarning({ kind: 'manual', url, visibility: 'private' })).toBe(true)
  })

  test('an unknown visibility says the condition out loud', () => {
    // No bridge: we cannot read the row, so the honest line names what has to
    // be true rather than promising either way.
    const message = shareMessage({ kind: 'copied', url, visibility: 'unknown' })
    expect(message).toContain('public')
    expect(showsPrivateWarning({ kind: 'copied', url, visibility: 'unknown' })).toBe(false)
  })

  test('the warning is gone the moment the project is public', () => {
    expect(showsPrivateWarning({ kind: 'copied', url, visibility: 'public' })).toBe(false)
    expect(showsPrivateWarning({ kind: 'published', url })).toBe(false)
    expect(showsPrivateWarning({ kind: 'publishing', url })).toBe(false)
    expect(shareMessage({ kind: 'copied', url, visibility: 'public' })).toContain('anyone')
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
    expect(await publishProject(bridgeOf(true), url)).toEqual({ kind: 'published', url })
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
