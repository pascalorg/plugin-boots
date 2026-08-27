import { beforeEach, describe, expect, test } from 'bun:test'
import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three'
import { PLAYER_CAPSULE } from './collision'
import type { CatalogEntry } from './inventory'
import {
  anchorOnFloor,
  disposeItemContent,
  ghostYaw,
  ITEM_REACH,
  type ItemAnchor,
  itemFootprint,
  itemGhostActive,
  itemModelLoader,
  itemOverlapsPlayer,
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

describe('itemOverlapsPlayer: placement must never entomb the player', () => {
  const WARDROBE: [number, number, number] = [1.2, 1.9, 0.6]

  test('anchor at the near-look limit (~0.32 m) is blocked', () => {
    // Regression: looking down near your feet, anchorOnFloor permits
    // anchors ~0.32 m out — a wardrobe there swallowed the capsule with
    // no in-game item undo to escape.
    expect(itemOverlapsPlayer(0.32, 0, 0, 0, WARDROBE, 0, 0, 0)).toBe(true)
  })

  test('clear of the expanded AABB → allowed', () => {
    const clearance = WARDROBE[2] / 2 + PLAYER_CAPSULE.radius + 0.01
    expect(itemOverlapsPlayer(0, 0, clearance, 0, WARDROBE, 0, 0, 0)).toBe(false)
  })

  test('odd quarter-turns swap the footprint axes', () => {
    // 0.9 m out along z clears the wardrobe's 0.6 depth at yaw 0 but not
    // its 1.2 width once a quarter-turn swings it across the aim line.
    expect(itemOverlapsPlayer(0, 0, 0.9, 0, WARDROBE, 0, 0, 0)).toBe(false)
    expect(itemOverlapsPlayer(0, 0, 0.9, Math.PI / 2, WARDROBE, 0, 0, 0)).toBe(true)
    expect(itemOverlapsPlayer(0, 0, 0.9, -Math.PI / 2, WARDROBE, 0, 0, 0)).toBe(true)
  })

  test('vertical separation clears: a lamp on a shelf above the head', () => {
    const lamp: [number, number, number] = [0.3, 0.4, 0.3]
    expect(itemOverlapsPlayer(0, PLAYER_CAPSULE.height + 0.05, 0, 0, lamp, 0, 0, 0)).toBe(false)
    expect(itemOverlapsPlayer(0, PLAYER_CAPSULE.height - 0.05, 0, 0, lamp, 0, 0, 0)).toBe(true)
  })
})

describe('itemModelLoader: catalog GLBs decode (2026-08-27 real-models fix)', () => {
  test('wires Draco + meshopt — the system catalog is Draco-compressed', () => {
    const loader = itemModelLoader()
    // A bare GLTFLoader throws "No DRACOLoader instance provided" on every
    // KHR_draco_mesh_compression catalog GLB → the labeled-proxy fallback
    // for the WHOLE catalog. The decoder host is the host renderer's own.
    const draco = (
      loader as unknown as { dracoLoader: { decoderPaths: { wasm?: string } } | null }
    ).dracoLoader
    expect(draco).not.toBeNull()
    expect(draco!.decoderPaths.wasm).toBe(
      'https://www.gstatic.com/draco/versioned/decoders/1.5.5/draco_decoder.wasm',
    )
    expect(
      (loader as unknown as { meshoptDecoder: unknown }).meshoptDecoder,
    ).toBeTruthy()
  })

  test('one loader per session — repeat calls reuse the instance', () => {
    expect(itemModelLoader()).toBe(itemModelLoader())
  })
})

describe('disposeItemContent: mount-owned three resources are released', () => {
  const build = () => {
    const content = new Group()
    const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial())
    content.add(mesh)
    const disposed = { geometry: 0, material: 0 }
    mesh.geometry.addEventListener('dispose', () => disposed.geometry++)
    ;(mesh.material as MeshStandardMaterial).addEventListener('dispose', () => disposed.material++)
    return { content, disposed }
  }

  test('proxy content owns geometry + material', () => {
    const { content, disposed } = build()
    disposeItemContent(content, true, false)
    expect(disposed).toEqual({ geometry: 1, material: 1 })
  })

  test('ghost GLB clone owns its material clones, never the geometry', () => {
    const { content, disposed } = build()
    disposeItemContent(content, false, true)
    expect(disposed).toEqual({ geometry: 0, material: 1 })
  })

  test('real GLB placement shares everything with the template — no-op', () => {
    const { content, disposed } = build()
    disposeItemContent(content, false, false)
    expect(disposed).toEqual({ geometry: 0, material: 0 })
  })
})
