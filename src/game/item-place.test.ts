import { beforeEach, describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, Group, Matrix4, Mesh, MeshStandardMaterial, Object3D, Vector3 } from 'three'
import { PLAYER_CAPSULE } from './collision'
import { ensureVoxelTarget, resetDestruction } from './destruction'
import { type CatalogEntry, OPENING_ENTRIES } from './inventory'
import {
  aimWallPoint,
  aimedPlacedApertureId,
  aimedPlacedItemId,
  anchorOnFloor,
  anchorOnSupport,
  anchorOnWorldSupport,
  apertureFits,
  apertureRect,
  configureItemModelLoader,
  disposeItemContent,
  ghostYaw,
  ITEM_REACH,
  type ItemAnchor,
  itemFootprint,
  itemBlockedByWorld,
  itemGhostActive,
  itemPlacementActive,
  itemModelLoader,
  itemOverlapsPlayer,
  pendingApertureRects,
  rectsOverlap,
  snapApertureU,
  updateItemPlacementTrigger,
  useItems,
  type WallAim,
  wallPlacementFrame,
} from './item-place'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

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
  resetDestruction()
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

describe('anchorOnSupport: editor-like surface placement', () => {
  const collider = (
    nodeId: string,
    nodeType: string,
    min: [number, number, number],
    max: [number, number, number],
  ) =>
    ({
      nodeId,
      nodeType,
      worldBox: new Box3(new Vector3(...min), new Vector3(...max)),
    }) as never

  test('aiming down at a counter anchors on its top instead of the floor behind it', () => {
    const out = anchor()
    const counter = collider('counter-1', 'counter', [-1, 0, -2.5], [1, 0.9, -1])
    expect(anchorOnSupport(out, [counter], 0, 1.58, 0, 0, -0.35)).toBe(true)
    expect(out.y).toBeCloseTo(0.9)
    expect(out.z).toBeGreaterThanOrEqual(-2.5)
    expect(out.z).toBeLessThanOrEqual(-1)
  })

  test('open air and upward gaze keep the floor fallback in charge', () => {
    const out = anchor()
    expect(anchorOnSupport(out, [], 0, 1.58, 0, 0, -0.35)).toBe(false)
    expect(anchorOnSupport(out, [], 0, 1.58, 0, 0, 0.2)).toBe(false)
  })

  test('disabled and terrain AABBs are never mistaken for tabletop surfaces', () => {
    const out = anchor()
    const site = collider('site-1', 'site', [-20, -2, -20], [20, 5, 20])
    const disabled = collider('counter-1', 'counter', [-1, 0, -2.5], [1, 0.9, -1]) as {
      disabled?: boolean
    }
    disabled.disabled = true
    expect(anchorOnSupport(out, [site as never, disabled as never], 0, 1.58, 0, 0, -0.35)).toBe(false)
  })
})

function supportWorld(): GameWorld {
  const root = new Group()
  const mesh = new Mesh(new BoxGeometry(2, 0.9, 1.5), new MeshStandardMaterial())
  mesh.position.set(0, 0.45, -2)
  root.add(mesh)
  root.updateMatrixWorld(true)
  const entry: ColliderEntry = {
    mesh,
    bvh: bvhFor(mesh),
    inverse: new Matrix4().copy(mesh.matrixWorld).invert(),
    worldBox: new Box3().setFromObject(mesh),
    root,
    nodeId: 'island-1',
    nodeType: 'item',
  }
  return {
    colliders: [entry],
    walls: new Map(),
    glass: [],
    doors: [],
    overlayRoots: [],
    buildingAabb: entry.worldBox.clone(),
    spawn: new Vector3(),
    spawnYaw: 0,
    levelId: null,
  }
}

describe('anchorOnWorldSupport: visible geometry and live voxels', () => {
  const pitch = Math.atan2(0.9 - 1.58, 1.8)

  test('uses the actual countertop triangle under the crosshair', () => {
    const world = supportWorld()
    const out = anchor()
    expect(anchorOnWorldSupport(out, world, 0, 1.58, 0, 0, pitch)).toBe(true)
    expect(out.x).toBeCloseTo(0)
    expect(out.y).toBeCloseTo(0.9)
    expect(out.z).toBeCloseTo(-1.8)
  })

  test('a front face occludes the floor fallback instead of placing behind it', () => {
    const world = supportWorld()
    const out = anchor()
    expect(anchorOnWorldSupport(out, world, 0, 1.58, 0, 0, -0.65)).toBe(false)
    expect(out.blocked).toBe(true)
  })

  test('keeps a pure voxel island placeable after its host collider is disabled', () => {
    const world = supportWorld()
    expect(ensureVoxelTarget(world, 'island-1')).not.toBeNull()
    expect(world.colliders[0]!.disabled).toBe(true)
    const out = anchor()
    expect(anchorOnWorldSupport(out, world, 0, 1.58, 0, 0, pitch)).toBe(true)
    // The combat voxel skin is slightly proud of the 0.9 m source mesh;
    // placement follows the visible live cells, not the hidden source.
    expect(out.y).toBeGreaterThan(0.9)
    expect(out.y).toBeLessThan(1.1)
    expect(out.z).toBeLessThan(-1.4)
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

  test('L lift is reversible and a drop keeps the runtime identity', () => {
    const original = useItems.getState().addItem(asset(), [1, 0, 2], Math.PI / 2)
    expect(useItems.getState().beginMove(original.id)).toEqual(original)
    expect(useItems.getState().items).toEqual([])
    expect(useItems.getState().armed?.id).toBe(original.asset.id)

    useItems.getState().cancelMove()
    expect(useItems.getState().items).toEqual([original])

    useItems.getState().beginMove(original.id)
    const moved = useItems.getState().finishMove([4, 0, 5], -Math.PI / 2)
    expect(moved).toMatchObject({ id: original.id, position: [4, 0, 5] })
    expect(useItems.getState().moving).toBeNull()
    expect(useItems.getState().armed).toBeNull()
  })

  test('L drop owns its click through release before the hammer can place', () => {
    const original = useItems.getState().addItem(asset(), [1, 0, 2], 0)
    useItems.getState().beginMove(original.id)
    useItems.getState().finishMove([4, 0, 5], 0)

    // The store has finished moving, but this same physical press still
    // belongs to item placement for all later frame consumers.
    expect(useItems.getState().moving).toBeNull()
    expect(useItems.getState().armed).toBeNull()
    expect(itemGhostActive()).toBe(true)
    expect(itemPlacementActive()).toBe(true)

    updateItemPlacementTrigger(true)
    expect(itemPlacementActive()).toBe(true)
    updateItemPlacementTrigger(false)
    expect(itemGhostActive()).toBe(false)
    expect(itemPlacementActive()).toBe(false)
  })

  test('itemGhostActive tracks arm/disarm (menu closed headless)', () => {
    expect(itemGhostActive()).toBe(false)
    useItems.getState().arm(asset())
    expect(itemGhostActive()).toBe(true)
    useItems.getState().disarm()
    expect(itemGhostActive()).toBe(false)
  })

  test('itemPlacementActive covers an armed or lifted placement', () => {
    expect(itemPlacementActive()).toBe(false)
    useItems.getState().arm(asset())
    expect(itemPlacementActive()).toBe(true)
    useItems.getState().disarm()
    expect(itemPlacementActive()).toBe(false)
  })
})

describe('L aim and blocking', () => {
  const collider = (nodeId: string, nodeType: string, min: [number, number, number], max: [number, number, number]) => ({
    nodeId,
    nodeType,
    worldBox: new Box3(new Vector3(...min), new Vector3(...max)),
  }) as never

  test('selects the nearest placed item but never through a wall', () => {
    const couch = collider('__boots-item-17', 'item', [-0.5, 0, -3.5], [0.5, 1, -2.5])
    expect(aimedPlacedItemId([couch], { x: 0, y: 0.5, z: 0 }, 0, 0)).toBe(17)
    const wall = collider('wall-1', 'wall', [-1, 0, -2], [1, 2.5, -1.9])
    expect(aimedPlacedItemId([couch, wall], { x: 0, y: 0.5, z: 0 }, 0, 0)).toBeNull()
  })

  test('selects a Boots-placed opening only inside its wall rectangle', () => {
    const opening = useItems.getState().addAperture(OPENING_ENTRIES[0]!, 'wall-1', 2, 1.05)
    const frame = {
      wallId: 'wall-1',
      originX: -2,
      originY: 0,
      originZ: -3,
      ux: 1,
      uz: 0,
      length: 4,
      height: 2.5,
      thickness: 0.15,
      yaw: 0,
    }
    expect(aimedPlacedApertureId([opening], [frame], { x: 0, y: 1.58, z: 0 }, 0, 0)).toBe(opening.id)
    expect(aimedPlacedApertureId([opening], [frame], { x: 1.8, y: 1.58, z: 0 }, 0, 0)).toBeNull()
  })

  test('ground contact is allowed, but a wall in the volume or sightline blocks', () => {
    const floor = collider('floor-1', 'floor', [-10, -0.2, -10], [10, 0, 10])
    expect(itemBlockedByWorld([floor], 0, 0, -3, 0, [1, 1, 1], { x: 0, y: 1.58, z: 0 })).toBe(false)
    const wall = collider('wall-1', 'wall', [-1, 0, -2], [1, 2.5, -1.9])
    expect(itemBlockedByWorld([floor, wall], 0, 0, -3, 0, [1, 1, 1], { x: 0, y: 1.58, z: 0 })).toBe(true)
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

  test('wires KTX2/Basis textures for API models such as the plunger', () => {
    const renderer = {
      isWebGPURenderer: true,
      hasFeature: () => false,
    }
    expect(configureItemModelLoader(renderer)).toBe(true)
    expect(
      (itemModelLoader() as unknown as { ktx2Loader: unknown }).ktx2Loader,
    ).toBeTruthy()
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

// --- Wall apertures (the openings tab's wall-snap lane) ----------------------

const hingedDoor = OPENING_ENTRIES.find((e) => e.id === 'opening-door-hinged')!
const fixedWindow = OPENING_ENTRIES.find((e) => e.id === 'opening-window-fixed')!

/**
 * A host wall entry. The registered root IS the wall-local frame (origin
 * at the wall start, local +X toward the end — the group the host mounts
 * door/window children in), so the helper poses the root the way the host
 * does: at `start`, yawed along start→end. `pose` overrides simulate an
 * elevated / re-posed frame directly.
 */
const wallEntry = (
  start: [number, number],
  end: [number, number],
  over: { height?: number; thickness?: number } = {},
  pose?: { position?: [number, number, number]; yawY?: number },
) => {
  const root = new Object3D()
  const dx = end[0] - start[0]
  const dz = end[1] - start[1]
  root.position.set(...(pose?.position ?? [start[0], 0, start[1]]))
  root.rotation.y = pose?.yawY ?? Math.atan2(-dz, dx)
  root.updateMatrixWorld(true)
  return { node: { id: 'wall_test', start, end, ...over }, root }
}

describe('wallPlacementFrame', () => {
  test('host-posed root: origin at start, unit u start→end, defaults 2.5/0.15', () => {
    const frame = wallPlacementFrame(wallEntry([1, 2], [5, 2]))!
    expect(frame.wallId).toBe('wall_test')
    expect([frame.originX, frame.originY, frame.originZ]).toEqual([1, 0, 2])
    expect(frame.ux).toBeCloseTo(1)
    expect(frame.uz).toBeCloseTo(0)
    expect(frame.length).toBeCloseTo(4)
    expect(frame.height).toBe(2.5)
    expect(frame.thickness).toBe(0.15)
    expect(frame.yaw).toBeCloseTo(0)
  })

  test('node height/thickness override the defaults', () => {
    const frame = wallPlacementFrame(wallEntry([0, 0], [3, 0], { height: 3.2, thickness: 0.3 }))!
    expect(frame.height).toBe(3.2)
    expect(frame.thickness).toBe(0.3)
  })

  test('the root pose IS the frame — start/end only contribute length', () => {
    // Elevated, re-posed root (a rotated building's wall): the frame reads
    // the root, never re-applies plan coords through it.
    const frame = wallPlacementFrame(
      wallEntry([0, 0], [4, 0], {}, { position: [10, 3, 5], yawY: Math.PI / 2 }),
    )!
    expect([frame.originX, frame.originY, frame.originZ]).toEqual([10, 3, 5])
    expect(frame.ux).toBeCloseTo(0)
    expect(frame.uz).toBeCloseTo(-1)
    expect(frame.length).toBeCloseTo(4)
    expect(frame.yaw).toBeCloseTo(Math.PI / 2)
  })

  test('a diagonal wall frame follows its own yaw', () => {
    const frame = wallPlacementFrame(wallEntry([0, 0], [3, 3]))!
    expect(frame.ux).toBeCloseTo(Math.SQRT1_2)
    expect(frame.uz).toBeCloseTo(Math.SQRT1_2)
    expect(frame.length).toBeCloseTo(Math.hypot(3, 3))
    expect(frame.yaw).toBeCloseTo(-Math.PI / 4)
  })

  test('stub walls (< 0.3 m) are refused', () => {
    expect(wallPlacementFrame(wallEntry([0, 0], [0.2, 0]))).toBeNull()
  })
})

describe('aimWallPoint', () => {
  const aim = (): WallAim => ({ frame: null, u: 0, v: 0, dist: 0 })
  // A 6 m wall along X at z = −2 (facing the origin-standing player).
  const wall = () => wallPlacementFrame(wallEntry([-3, -2], [3, -2]))!

  test('level gaze straight at the wall: u along the span, v at eye height', () => {
    const out = aim()
    expect(aimWallPoint(out, [wall()], 0, 1.6, 0, 0, 0)).toBe(true)
    expect(out.frame!.wallId).toBe('wall_test')
    expect(out.u).toBeCloseTo(3) // origin is the −3 end
    expect(out.v).toBeCloseTo(1.6)
    expect(out.dist).toBeCloseTo(2)
  })

  test('beyond reach: no hit', () => {
    const far = wallPlacementFrame(wallEntry([-3, -10], [3, -10]))!
    expect(aimWallPoint(aim(), [far], 0, 1.6, 0, 0, 0)).toBe(false)
  })

  test('wall behind the gaze: no hit', () => {
    const behind = wallPlacementFrame(wallEntry([-3, 2], [3, 2]))!
    expect(aimWallPoint(aim(), [behind], 0, 1.6, 0, 0, 0)).toBe(false)
  })

  test('nearest of two candidate walls wins', () => {
    const near = wallPlacementFrame(wallEntry([-3, -1], [3, -1]))!
    near.wallId = 'wall_near'
    const out = aim()
    expect(aimWallPoint(out, [wall(), near], 0, 1.6, 0, 0, 0)).toBe(true)
    expect(out.frame!.wallId).toBe('wall_near')
    expect(out.dist).toBeCloseTo(1)
  })

  test('aim past the wall end (u out of span): no hit', () => {
    // Yawed ~64° left: the ray crosses the z=−2 plane at x≈−4.1, past −3.
    expect(aimWallPoint(aim(), [wall()], 0, 1.6, 0, 1.12, 0)).toBe(false)
  })

  test('aim above the wall top (v > height): no hit', () => {
    // tan(0.6) ≈ 0.68 → v ≈ 1.6 + 2.28 > 2.5.
    expect(aimWallPoint(aim(), [wall()], 0, 1.6, 0, 0, 0.6)).toBe(false)
  })
})

describe('snapApertureU', () => {
  test('snaps to the 10 cm step', () => {
    expect(snapApertureU(2.34, 0.9, 6)).toBeCloseTo(2.3)
    expect(snapApertureU(2.36, 0.9, 6)).toBeCloseTo(2.4)
  })

  test('clamps so the aperture keeps its end margins', () => {
    expect(snapApertureU(0.1, 0.9, 6)).toBeCloseTo(0.5) // margin + w/2
    expect(snapApertureU(5.9, 0.9, 6)).toBeCloseTo(5.5)
  })

  test('wall too short for the aperture: null', () => {
    expect(snapApertureU(0.4, 0.9, 0.8)).toBeNull()
  })
})

describe('aperture rect validity (fits / overlap)', () => {
  test('apertureRect: center-u, bottom-v0 → wall-space corners', () => {
    expect(apertureRect(2, 0.9, 1.5, 1.5)).toEqual({ u0: 1.25, u1: 2.75, v0: 0.9, v1: 2.4 })
  })

  test('rectsOverlap is strict — touching edges do not overlap', () => {
    const a = apertureRect(1, 0, 0.9, 2.1) // u 0.55..1.45, v 0..2.1
    expect(rectsOverlap(a, apertureRect(1.9, 0, 0.9, 2.1))).toBe(false) // u-edge touch
    expect(rectsOverlap(a, apertureRect(1.8, 0, 0.9, 2.1))).toBe(true)
    // Disjoint vertically even though u-spans overlap (door vs high band).
    expect(rectsOverlap(a, { u0: 0.5, u1: 1.5, v0: 2.2, v1: 2.4 })).toBe(false)
    expect(rectsOverlap(a, { u0: 0.5, u1: 1.5, v0: 2.05, v1: 2.4 })).toBe(true)
  })

  test('fits mid-wall, clear of obstacles', () => {
    expect(apertureFits(apertureRect(3, 0, 0.9, 2.1), 6, 2.5, [])).toBe(true)
  })

  test('violating an end margin refuses', () => {
    expect(apertureFits(apertureRect(0.4, 0, 0.9, 2.1), 6, 2.5, [])).toBe(false)
  })

  test('poking past the top margin refuses (tall window on a low wall)', () => {
    expect(apertureFits(apertureRect(3, 1.2, 1.5, 1.5), 6, 2.5, [])).toBe(false)
  })

  test('overlapping an existing opening refuses; clear neighbors pass', () => {
    const existing = [{ u0: 2.03, u1: 2.97, v0: -0.02, v1: 2.12 }] // a host door
    expect(apertureFits(apertureRect(2.8, 0.9, 1.5, 1.5), 6, 2.5, existing)).toBe(false)
    expect(apertureFits(apertureRect(4.2, 0.9, 1.5, 1.5), 6, 2.5, existing)).toBe(true)
  })
})

describe('useItems aperture round-trip', () => {
  test('addAperture appends kind aperture with the def size, shared id sequence', () => {
    const item = useItems.getState().addItem(asset(), [1, 0, 2], 0)
    const door = useItems.getState().addAperture(hingedDoor, 'wall_a', 1.2, 1.05)
    expect(door.kind).toBe('aperture')
    expect(door.id).toBeGreaterThan(item.id)
    expect(door.wallId).toBe('wall_a')
    expect(door.u).toBe(1.2)
    expect(door.v).toBe(1.05)
    expect(door.width).toBe(hingedDoor.width)
    expect(door.height).toBe(hingedDoor.height)
    expect(useItems.getState().items).toEqual([item, door])
  })

  test('resolveItems forgets both kinds', () => {
    useItems.getState().addItem(asset(), [0, 0, 0], 0)
    useItems.getState().addAperture(fixedWindow, 'wall_a', 2, 1.65)
    useItems.getState().resolveItems()
    expect(useItems.getState().items).toEqual([])
  })

  test('L moves an aperture while preserving its runtime id and dimensions', () => {
    const original = useItems.getState().addAperture(hingedDoor, 'wall_a', 1.2, 1.05)
    expect(useItems.getState().beginMove(original.id)).toEqual(original)
    expect(useItems.getState().items).toEqual([])
    expect(useItems.getState().armed?.id).toBe(hingedDoor.id)
    const moved = useItems.getState().finishApertureMove('wall_a', 3.25, 1.05)
    expect(moved).toMatchObject({ id: original.id, wallId: 'wall_a', u: 3.25, v: 1.05 })
    expect(moved?.width).toBe(original.width)
    expect(moved?.height).toBe(original.height)
  })

  test('an armed opening entry owns the trigger like furniture does', () => {
    expect(itemGhostActive()).toBe(false)
    useItems.getState().arm(hingedDoor)
    expect(itemGhostActive()).toBe(true)
    useItems.getState().disarm()
    expect(itemGhostActive()).toBe(false)
  })

  test('pendingApertureRects: same-wall apertures only, inflated by the pad', () => {
    useItems.getState().addAperture(hingedDoor, 'wall_a', 1.2, 1.05)
    useItems.getState().addAperture(fixedWindow, 'wall_b', 2, 1.65)
    useItems.getState().addItem(asset(), [0, 0, 0], 0)
    const rects = pendingApertureRects(useItems.getState().items, 'wall_a')
    expect(rects).toHaveLength(1)
    expect(rects[0]!.u0).toBeCloseTo(1.2 - 0.45 - 0.02)
    expect(rects[0]!.u1).toBeCloseTo(1.2 + 0.45 + 0.02)
    expect(rects[0]!.v0).toBeCloseTo(-0.02)
    expect(rects[0]!.v1).toBeCloseTo(2.12)
  })
})
