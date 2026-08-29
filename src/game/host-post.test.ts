import { describe, expect, test } from 'bun:test'
import { DirectionalLight, Group, Mesh, Object3D, PointLight } from 'three'
import {
  collectShadowLights,
  createOutlineGuard,
  createShadowThrottle,
  hostPostDebug,
  type OutlinerArrays,
  resolveOutliner,
  SHADOW_REFRESH_INTERVAL,
  type ThrottleableLight,
} from './host-post'

/**
 * Perf fix 5 (2026-08-29): the session freezes per-frame shadow-map
 * re-renders (three's `shadow.autoUpdate` knob — the paired ~92k-tri
 * submit measured before every scene submit) and pins the outline pass in
 * its zero-cost early-out by keeping the viewer's outliner arrays empty.
 * These tests pin both levers' contracts: feature detection, exact-state
 * restore (including disposed shadows and host-repopulated arrays), and
 * the refresh cadence that keeps destruction shadows fresh.
 */

/** A fake throttleable light — the structural shape is the contract. */
function fakeLight(autoUpdate = true): ThrottleableLight {
  return { castShadow: true, shadow: { autoUpdate, needsUpdate: false } }
}

describe('collectShadowLights', () => {
  test('finds nested shadow-casting lights and skips everything else', () => {
    const root = new Group()
    const inner = new Group()
    root.add(inner)
    const sun = new DirectionalLight()
    sun.castShadow = true
    inner.add(sun)
    const lamp = new PointLight() // castShadow stays false
    root.add(lamp)
    root.add(new Mesh())
    expect(collectShadowLights(root)).toEqual([sun])
  })

  test('skips a light whose shadow lacks the autoUpdate knob (older host)', () => {
    const root = new Group()
    const odd = new Object3D() as Object3D & {
      isLight?: boolean
      castShadow?: boolean
      shadow?: object
    }
    odd.isLight = true
    odd.castShadow = true
    odd.shadow = {} // no autoUpdate boolean → not throttleable
    root.add(odd)
    expect(collectShadowLights(root)).toEqual([])
  })
})

describe('createShadowThrottle', () => {
  test('engage freezes autoUpdate, remembers the previous value, refreshes once', () => {
    const light = fakeLight(true)
    const throttle = createShadowThrottle()
    throttle.engage([light])
    expect(light.shadow?.autoUpdate).toBe(false)
    expect(light.shadow?.needsUpdate).toBe(true) // no stale window on adopt
    expect(throttle.size()).toBe(1)
  })

  test('re-engaging an adopted light never clobbers its original value', () => {
    const light = fakeLight(true)
    const throttle = createShadowThrottle()
    throttle.engage([light])
    throttle.engage([light]) // rescan finds it again — now autoUpdate=false
    throttle.release()
    expect(light.shadow?.autoUpdate).toBe(true) // original, not the frozen false
  })

  test('a light already frozen by someone else restores to frozen', () => {
    const light = fakeLight(false)
    const throttle = createShadowThrottle()
    throttle.engage([light])
    throttle.release()
    expect(light.shadow?.autoUpdate).toBe(false)
  })

  test('tick refreshes exactly on the cadence frames', () => {
    const light = fakeLight()
    const throttle = createShadowThrottle()
    throttle.engage([light])
    if (light.shadow) light.shadow.needsUpdate = false // consume the adopt refresh
    for (let frame = 1; frame < SHADOW_REFRESH_INTERVAL; frame++) {
      throttle.tick(frame)
      expect(light.shadow?.needsUpdate).toBe(false)
    }
    throttle.tick(SHADOW_REFRESH_INTERVAL)
    expect(light.shadow?.needsUpdate).toBe(true)
  })

  test('release restores autoUpdate and forces one resync render', () => {
    const light = fakeLight(true)
    const throttle = createShadowThrottle()
    throttle.engage([light])
    if (light.shadow) light.shadow.needsUpdate = false
    throttle.release()
    expect(light.shadow?.autoUpdate).toBe(true)
    expect(light.shadow?.needsUpdate).toBe(true)
    expect(throttle.size()).toBe(0)
  })

  test('a shadow disposed mid-session is skipped by tick and release', () => {
    const light = fakeLight()
    const throttle = createShadowThrottle()
    throttle.engage([light])
    light.shadow = null // host disposed the shadow (light unmounted)
    expect(() => throttle.tick(SHADOW_REFRESH_INTERVAL)).not.toThrow()
    expect(() => throttle.release()).not.toThrow()
  })

  test('release is idempotent and engage after release is a no-op', () => {
    const light = fakeLight(true)
    const throttle = createShadowThrottle()
    throttle.engage([light])
    throttle.release()
    throttle.release()
    throttle.engage([light]) // stray rescan after teardown must not re-freeze
    expect(light.shadow?.autoUpdate).toBe(true)
    expect(throttle.size()).toBe(0)
  })
})

describe('resolveOutliner', () => {
  test('null on hosts without the store shape', () => {
    expect(resolveOutliner(undefined)).toBeNull()
    expect(resolveOutliner({})).toBeNull()
    expect(resolveOutliner({ getState: () => ({}) })).toBeNull()
    expect(resolveOutliner({ getState: () => ({ outliner: { selectedObjects: 3 } }) })).toBeNull()
  })

  test('returns the live arrays (identity, never copies)', () => {
    const outliner = { selectedObjects: [], hoveredObjects: [] }
    const resolved = resolveOutliner({ getState: () => ({ outliner }) })
    expect(resolved?.selectedObjects).toBe(outliner.selectedObjects)
    expect(resolved?.hoveredObjects).toBe(outliner.hoveredObjects)
  })
})

describe('createOutlineGuard', () => {
  function armedOutliner(): { outliner: OutlinerArrays; selected: Object3D; hovered: Object3D } {
    const parent = new Group()
    const selected = new Object3D()
    const hovered = new Object3D()
    parent.add(selected)
    parent.add(hovered)
    return {
      outliner: { selectedObjects: [selected], hoveredObjects: [hovered] },
      selected,
      hovered,
    }
  }

  test('engage snapshots then empties both arrays IN PLACE (host keeps its refs)', () => {
    const { outliner } = armedOutliner()
    const selectedRef = outliner.selectedObjects
    const guard = createOutlineGuard(outliner)
    guard.engage()
    expect(outliner.selectedObjects).toBe(selectedRef) // same array, length 0
    expect(outliner.selectedObjects.length).toBe(0)
    expect(outliner.hoveredObjects.length).toBe(0)
  })

  test('tick re-clears mid-session arming and counts it', () => {
    const { outliner, hovered } = armedOutliner()
    const guard = createOutlineGuard(outliner)
    guard.engage()
    guard.tick()
    expect(guard.clears()).toBe(0) // quiet frames are free
    outliner.hoveredObjects.push(hovered) // e.g. a panel preview-hover write
    guard.tick()
    expect(outliner.hoveredObjects.length).toBe(0)
    expect(guard.clears()).toBe(1)
  })

  test('release restores the snapshot, dropping objects that lost their parent', () => {
    const { outliner, selected, hovered } = armedOutliner()
    const guard = createOutlineGuard(outliner)
    guard.engage()
    hovered.removeFromParent() // deleted mid-session — must not resurrect
    guard.release()
    expect(outliner.selectedObjects).toEqual([selected])
    expect(outliner.hoveredObjects).toEqual([])
  })

  test('release never clobbers arrays the host already repopulated', () => {
    const { outliner, selected } = armedOutliner()
    const guard = createOutlineGuard(outliner)
    guard.engage()
    const hostWritten = new Object3D()
    new Group().add(hostWritten)
    outliner.selectedObjects.push(hostWritten) // EditorOutlinerSync got there first
    guard.release()
    expect(outliner.selectedObjects).toEqual([hostWritten])
    expect(outliner.selectedObjects).not.toContain(selected)
  })

  test('null outliner (older host) makes every operation a no-op', () => {
    const guard = createOutlineGuard(null)
    expect(() => {
      guard.engage()
      guard.tick()
      guard.release()
    }).not.toThrow()
    expect(guard.clears()).toBe(0)
  })
})

describe('hostPostDebug', () => {
  test('inactive outside a session', () => {
    expect(hostPostDebug()).toEqual({ active: false, shadowLights: 0, outlineClears: 0 })
  })
})
