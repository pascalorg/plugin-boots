import { beforeEach, describe, expect, test } from 'bun:test'
import type { CatalogEntry } from './inventory'
import {
  anchorOnFloor,
  ghostYaw,
  ITEM_REACH,
  type ItemAnchor,
  itemFootprint,
  itemGhostActive,
  useItems,
} from './item-place'

/**
 * Placement-store math + ghost anchoring (pure halves of item-place.tsx).
 * The GLB loading / collider registration paths are render-side and land
 * with QA; everything here runs headless.
 */

const asset = (over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  id: 'couch-test',
  category: 'furniture',
  name: 'Couch',
  thumbnail: 'https://cdn.test/items/couch/thumbnail.png',
  src: 'https://cdn.test/items/couch/model.glb',
  ...over,
})

const anchor = (): ItemAnchor => ({ x: 0, y: 0, z: 0, valid: false })

beforeEach(() => {
  useItems.getState().resolveItems()
  useItems.getState().disarm()
})

describe('itemFootprint', () => {
  test('schema defaults: no dimensions/scale → unit box', () => {
    expect(itemFootprint(asset())).toEqual([1, 1, 1])
  })

  test('dimensions × scale, per axis', () => {
    const fp = itemFootprint(asset({ dimensions: [2, 0.8, 0.9], scale: [2, 1, 0.5] }))
    expect(fp[0]).toBeCloseTo(4)
    expect(fp[1]).toBeCloseTo(0.8)
    expect(fp[2]).toBeCloseTo(0.45)
  })

  test('degenerate catalog dims clamp to a graspable minimum', () => {
    const fp = itemFootprint(asset({ dimensions: [0, 0.5, 0.5] }))
    expect(fp[0]).toBeCloseTo(0.05)
  })
})

describe('anchorOnFloor', () => {
  test('45° downward gaze lands eye-height ahead, valid', () => {
    const out = anchor()
    expect(anchorOnFloor(out, 0, 1.58, 0, 0, -Math.PI / 4, 0)).toBe(true)
    expect(out.x).toBeCloseTo(0)
    expect(out.y).toBe(0)
    expect(out.z).toBeCloseTo(-1.58)
    expect(out.valid).toBe(true)
  })

  test('shallow gaze clamps to reach along the ground track, invalid', () => {
    const out = anchor()
    expect(anchorOnFloor(out, 0, 1.58, 0, 0, -0.1, 0)).toBe(true)
    expect(Math.hypot(out.x, out.z)).toBeCloseTo(ITEM_REACH)
    expect(out.z).toBeLessThan(0) // still along the aim, facing -Z
    expect(out.valid).toBe(false)
  })

  test('level gaze anchors a fixed distance ahead, valid', () => {
    const out = anchor()
    expect(anchorOnFloor(out, 0, 1.58, 0, 0, 0, 0)).toBe(true)
    expect(out.x).toBeCloseTo(0)
    expect(out.z).toBeCloseTo(-ITEM_REACH * 0.6)
    expect(out.valid).toBe(true)
  })

  test('yaw steers the anchor (yaw π/2 faces -X)', () => {
    const out = anchor()
    anchorOnFloor(out, 0, 1.58, 0, Math.PI / 2, -Math.PI / 4, 0)
    expect(out.x).toBeCloseTo(-1.58)
    expect(out.z).toBeCloseTo(0)
  })

  test('upper-storey plane: floorY offsets the intersection distance', () => {
    const out = anchor()
    anchorOnFloor(out, 0, 2.8 + 1.58, 0, 0, -Math.PI / 4, 2.8)
    expect(out.y).toBe(2.8)
    expect(out.z).toBeCloseTo(-1.58)
    expect(out.valid).toBe(true)
  })

  test('near-vertical gaze yields no anchor at all', () => {
    const out = anchor()
    expect(anchorOnFloor(out, 0, 1.58, 0, 0, -Math.PI / 2 + 0.05, 0)).toBe(false)
    expect(anchorOnFloor(out, 0, 1.58, 0, 0, Math.PI / 2 - 0.05, 0)).toBe(false)
  })
})

describe('ghostYaw', () => {
  test('faces the player (yaw + π), wrapped to [-π, π)', () => {
    expect(ghostYaw(0, 0)).toBeCloseTo(-Math.PI)
    expect(ghostYaw(Math.PI / 2, 0)).toBeCloseTo(-Math.PI / 2)
  })

  test('snaps the base to the nearest quarter', () => {
    expect(ghostYaw(0.1, 0)).toBeCloseTo(-Math.PI)
    expect(ghostYaw(Math.PI / 4 + 0.01, 0)).toBeCloseTo(-Math.PI / 2)
  })

  test('R quarter-turns accumulate mod 4 and stay wrapped', () => {
    const base = ghostYaw(0, 0)
    expect(ghostYaw(0, 1)).toBeCloseTo(base + Math.PI / 2)
    expect(ghostYaw(0, 4)).toBeCloseTo(base)
    expect(ghostYaw(0, 7)).toBeCloseTo(ghostYaw(0, 3))
    for (let turns = 0; turns < 8; turns++) {
      const yaw = ghostYaw(1.2, turns)
      expect(yaw).toBeGreaterThanOrEqual(-Math.PI)
      expect(yaw).toBeLessThan(Math.PI)
    }
  })
})

describe('useItems store', () => {
  test('addItem appends with unique increasing ids', () => {
    const a = useItems.getState().addItem(asset(), [1, 0, 2], 0)
    const b = useItems.getState().addItem(asset({ id: 'lamp' }), [3, 0, 4], Math.PI / 2)
    expect(useItems.getState().items).toEqual([a, b])
    expect(b.id).toBeGreaterThan(a.id)
    expect(b.position).toEqual([3, 0, 4])
    expect(b.yaw).toBeCloseTo(Math.PI / 2)
  })

  test('resolveItems forgets placements but not the armed selection', () => {
    useItems.getState().arm(asset())
    useItems.getState().addItem(asset(), [0, 0, 0], 0)
    useItems.getState().resolveItems()
    expect(useItems.getState().items).toEqual([])
    expect(useItems.getState().armed).not.toBeNull()
  })

  test('itemGhostActive tracks arm/disarm (menu closed headless)', () => {
    expect(itemGhostActive()).toBe(false)
    useItems.getState().arm(asset())
    expect(itemGhostActive()).toBe(true)
    useItems.getState().disarm()
    expect(itemGhostActive()).toBe(false)
  })
})
