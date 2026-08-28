import { afterEach, describe, expect, test } from 'bun:test'
import { BoxGeometry, Mesh } from 'three'
import { resetGlass, shatterPane, useGlass } from './glass'
import type { GlassPane } from './world'

/**
 * The shatterPane session guard: a grenade's deferred glass waves (40/80 ms
 * setTimeout in explodeAt) can fire AFTER Esc tore the session down — the
 * teardown runs resetGlass first, so a late shatter used to mark the
 * still-rendering pane in the FRESH store (an unbreakable window all next
 * session), spawn shards into the cleared pool, and play the voice in the
 * editor. No session (bun tests never open one) → complete no-op.
 */

afterEach(() => {
  resetGlass()
})

describe('shatterPane session guard', () => {
  test('without a live session the pane is untouched and the store stays clean', () => {
    const mesh = new Mesh(new BoxGeometry(1, 1.2, 0.02))
    const pane: GlassPane = { mesh, root: mesh, nodeId: 'window-1' }
    shatterPane(pane)
    expect(useGlass.getState().shattered.size).toBe(0)
    expect(useGlass.getState().version).toBe(0)
    expect(mesh.visible).toBe(true) // hideForGame never ran
  })
})
