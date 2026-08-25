import { describe, expect, test } from 'bun:test'
import { sceneRegistry } from '@pascal-app/core'
import { Group, Mesh, Object3D } from 'three'
import {
  collectOverlayRoots,
  countCoplanarSuspects,
  isOverlayName,
  OVERLAY_KINDS,
  OVERLAY_NAME_PREFIXES,
} from './world'

/**
 * Owner round 2026-08-25, feedback B ("a face that can't be destroyed"):
 * the session hides Bones' engineering overlays through exactly TWO exported
 * predicates — registry KINDS (OVERLAY_KINDS + the `bones:` prefix sweep)
 * for registered roots, and object NAMES (OVERLAY_NAME_PREFIXES) for the
 * re-parented foreign groups no root hide can reach. These tests pin both
 * predicates and the countCoplanarSuspects probe that QA asserts is 0
 * in-game — the probe counts through the same predicates, so a green run
 * here means the hiders and the tripwire can never disagree on the match
 * set.
 */

/** Register a root under a kind the way the host's useRegistry does. */
function register(id: string, kind: string, root: Object3D): () => void {
  sceneRegistry.nodes.set(id, root)
  sceneRegistry.byType[kind]!.add(id)
  return () => {
    sceneRegistry.nodes.delete(id)
    sceneRegistry.byType[kind]!.delete(id)
  }
}

describe('overlay predicates', () => {
  test('OVERLAY_KINDS pins every kind plugin-bones registers today', () => {
    // Audit 2026-08-25: grep of every useRegistry call in plugin-bones —
    // these four are the complete set. A bones kind missing here still gets
    // swept by the `bones:` prefix, but the explicit list is the contract.
    expect([...OVERLAY_KINDS].sort()).toEqual([
      'bones:device',
      'bones:framing',
      'bones:lumber',
      'bones:service',
    ])
  })

  test('isOverlayName matches exactly the exported prefix list', () => {
    expect(OVERLAY_NAME_PREFIXES).toContain('bones-foreign-')
    for (const prefix of OVERLAY_NAME_PREFIXES) {
      expect(isOverlayName(`${prefix}level-1`)).toBe(true)
    }
    // Host / other-plugin names must never match — hiding the host's merged
    // roof or a wall would blank real geometry.
    expect(isOverlayName('merged-roof')).toBe(false)
    expect(isOverlayName('wall')).toBe(false)
    expect(isOverlayName('')).toBe(false)
    expect(isOverlayName('foreign-bones-x')).toBe(false)
  })
})

describe('collectOverlayRoots', () => {
  test('collects explicit kinds AND unknown bones:* kinds via prefix sweep', () => {
    const framingRoot = new Group()
    const cmuRoot = new Group()
    const wallRoot = new Group()
    const cleanups = [
      register('t-framing', 'bones:framing', framingRoot),
      // NOT in OVERLAY_KINDS — must be swept by the `bones:` prefix, so a
      // future bones engine can never resurrect the unbreakable-face bug.
      register('t-cmu', 'bones:cmu', cmuRoot),
      register('t-wall', 'wall', wallRoot),
    ]
    try {
      const roots = collectOverlayRoots()
      expect(roots).toContain(framingRoot)
      expect(roots).toContain(cmuRoot)
      expect(roots).not.toContain(wallRoot)
    } finally {
      for (const cleanup of cleanups) cleanup()
    }
  })
})

describe('countCoplanarSuspects', () => {
  test('plain host meshes never count', () => {
    const scene = new Object3D()
    scene.add(new Mesh())
    expect(countCoplanarSuspects(scene)).toBe(0)
  })

  test('counts a rendering mesh inside a bones-foreign-* group, and stops counting under either hide mechanism', () => {
    const scene = new Object3D()
    const foreign = new Group()
    foreign.name = 'bones-foreign-level-1'
    const mesh = new Mesh()
    foreign.add(mesh)
    scene.add(foreign)

    // Would render → suspect.
    expect(countCoplanarSuspects(scene)).toBe(1)

    // Per-frame hider mechanism 1: visible = false on the group.
    foreign.visible = false
    expect(countCoplanarSuspects(scene)).toBe(0)
    foreign.visible = true

    // Per-frame hider mechanism 2: layer mask cleared on the mesh.
    mesh.layers.disableAll()
    expect(countCoplanarSuspects(scene)).toBe(0)
  })

  test('counts meshes under a REGISTERED overlay root until the root hides', () => {
    const scene = new Object3D()
    const root = new Group()
    const inner = new Group()
    const mesh = new Mesh()
    inner.add(mesh)
    root.add(inner)
    scene.add(root)

    // Unregistered: just anonymous host geometry — not a suspect.
    expect(countCoplanarSuspects(scene)).toBe(0)

    const cleanup = register('t-suspect-root', 'bones:framing', root)
    try {
      expect(countCoplanarSuspects(scene)).toBe(1)
      // The session's root hide (hideForGame sets visible = false).
      root.visible = false
      expect(countCoplanarSuspects(scene)).toBe(0)
    } finally {
      cleanup()
    }
  })
})
