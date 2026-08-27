import { afterEach, describe, expect, test } from 'bun:test'
import { sceneRegistry, useScene } from '@pascal-app/core'
import {
  Box3,
  BoxGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  Vector3,
} from 'three'
import { ensureVoxelTarget, resetDestruction } from './destruction'
import {
  bvhFor,
  type ColliderEntry,
  collectWorld,
  type GameWorld,
  isGlassLikeMesh,
  ITEM_FAMILY_KINDS,
} from './world'

/**
 * Item anatomy (phase 6 — items keep their SHAPE):
 * 1. collectWorld routes GLASS-LIKE sub-meshes of ITEM_FAMILY_KINDS nodes
 *    (transparent && opacity < 0.95, or transmission > 0.2) to world.glass
 *    instead of the solid collider list — a shower door shatters like a
 *    window and is never a voxel source; solid siblings keep colliding.
 * 2. ensureVoxelTarget grids item-family targets at SILHOUETTE cells —
 *    clamp(minDim/3, 0.055, 0.11) m under a raised raw budget — so a
 *    toilet reads as a toilet in voxels, not 3 fat cubes. Dense items that
 *    would hit voxel.ts's fill ceiling rebuild coarser instead of shipping
 *    a top-chopped grid (solid boxes must always fill their whole span).
 */

// ── Registry fixtures (collectWorld lane) ───────────────────────────────────

type Registered = { id: string; kind: string }
const registered: Registered[] = []

function register(id: string, kind: string, root: Group | Mesh): void {
  sceneRegistry.nodes.set(id, root)
  sceneRegistry.byType[kind]!.add(id)
  registered.push({ id, kind })
}

afterEach(() => {
  for (const { id, kind } of registered.splice(0)) {
    sceneRegistry.nodes.delete(id)
    sceneRegistry.byType[kind]!.delete(id)
  }
  useScene.getState().setScene({}, [])
  resetDestruction()
})

/** One level hosting one shower 'item': a solid tray + a transparent glass
 * door + a transmission-glass side panel (opaque-flagged physical material,
 * the GLB-style glass), all under the item's registered root. */
function buildShowerItem() {
  const level = new Group()
  level.userData.__testTrueY = 0

  const shower = new Group()
  const tray = new Mesh(new BoxGeometry(0.9, 0.1, 0.9))
  tray.position.set(0, 0.05, 0)
  const glassDoor = new Mesh(
    new BoxGeometry(0.9, 1.9, 0.02),
    new MeshBasicMaterial({ transparent: true, opacity: 0.3 }),
  )
  glassDoor.position.set(0, 1.05, 0.44)
  const sidePanel = new Mesh(new BoxGeometry(0.02, 1.9, 0.9), new MeshPhysicalMaterial())
  ;(sidePanel.material as MeshPhysicalMaterial).transmission = 0.9
  sidePanel.position.set(0.44, 1.05, 0)
  shower.add(tray)
  shower.add(glassDoor)
  shower.add(sidePanel)
  shower.position.set(10, 0, 0)
  level.add(shower)
  level.updateMatrixWorld(true)

  register('level_1', 'level', level)
  register('shower_1', 'item', shower)

  useScene.getState().setScene(
    {
      level_1: {
        id: 'level_1',
        type: 'level',
        parentId: null,
        visible: true,
        level: 0,
        children: ['shower_1'],
      },
      shower_1: {
        id: 'shower_1',
        type: 'item',
        parentId: 'level_1',
        visible: true,
      },
    } as never,
    ['level_1'] as never,
  )

  return { tray, glassDoor, sidePanel }
}

describe('item-family glass split (collectWorld)', () => {
  test('glass-like sub-meshes route to world.glass, never the collider list', () => {
    const { tray, glassDoor, sidePanel } = buildShowerItem()
    const world = collectWorld()

    // Both glass lanes trigger: transparent+opacity and transmission.
    const glassMeshes = world.glass.map((g) => g.mesh)
    expect(new Set(glassMeshes)).toEqual(new Set([glassDoor, sidePanel]))
    for (const pane of world.glass) expect(pane.nodeId).toBe('shower_1')

    // The solid tray is the node's ONLY collider — panes never collide,
    // never eat bullets, never become voxel sources.
    const showerColliders = world.colliders.filter((c) => c.nodeId === 'shower_1')
    expect(showerColliders.map((c) => c.mesh)).toEqual([tray])
    expect(showerColliders[0]!.nodeType).toBe('item')
  })

  test('the shattered lane covers the whole item family', () => {
    expect(ITEM_FAMILY_KINDS).toEqual(
      new Set(['item', 'shelf', 'cabinet', 'cabinet-module', 'counter', 'kitchen-unit']),
    )
  })

  test('isGlassLikeMesh (the sweep-skip predicate) matches panes, not solids', () => {
    const { tray, glassDoor, sidePanel } = buildShowerItem()
    // The exported predicate is what a mesh sweep over a VOXELIZED node
    // must skip so live panes survive (see the doc block in world.ts).
    expect(isGlassLikeMesh(glassDoor)).toBe(true)
    expect(isGlassLikeMesh(sidePanel)).toBe(true)
    expect(isGlassLikeMesh(tray)).toBe(false)
  })

  test('end-to-end: the transparent door is excluded from the voxel grid sources', () => {
    buildShowerItem()
    const world = collectWorld()
    const target = ensureVoxelTarget(world, 'shower_1')!
    expect(target).toBeDefined()
    // The grid spans the 0.1 m tray only — had the 2 m glass door leaked
    // into the sources, cells would stand a couple of metres up.
    const gridTop = target.grid.origin.y + target.grid.ny * target.grid.cellY
    expect(gridTop).toBeLessThan(0.5)
    for (let i = 0; i < target.grid.count; i++) {
      expect(target.grid.centers[i * 3 + 1]!).toBeLessThan(0.3)
    }
  })
})

// ── Hand-built world fixtures (silhouette-cell lane) ────────────────────────

function boxCollider(
  nodeId: string,
  nodeType: string,
  size: [number, number, number],
  center: [number, number, number],
  material?: MeshBasicMaterial | MeshBasicMaterial[],
): ColliderEntry {
  const mesh = new Mesh(new BoxGeometry(size[0], size[1], size[2]), material)
  mesh.position.set(center[0], center[1], center[2])
  mesh.updateMatrixWorld(true)
  mesh.geometry.computeBoundingBox()
  const worldBox = mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld)
  return {
    mesh,
    bvh: bvhFor(mesh),
    inverse: new Matrix4().copy(mesh.matrixWorld).invert(),
    worldBox,
    root: mesh,
    nodeId,
    nodeType,
  }
}

function makeWorld(colliders: ColliderEntry[]): GameWorld {
  const buildingAabb = new Box3()
  for (const c of colliders) buildingAabb.union(c.worldBox)
  return {
    colliders,
    walls: new Map(),
    glass: [],
    doors: [],
    overlayRoots: [],
    buildingAabb,
    spawn: new Vector3(6, 0, 6),
    spawnYaw: 0,
    levelId: null,
  }
}

describe('item silhouette cells (ensureVoxelTarget)', () => {
  test('a toilet-shaped item (0.4×0.7×0.5) voxelizes at fine cells, whole silhouette', () => {
    const world = makeWorld([boxCollider('toilet-1', 'item', [0.4, 0.7, 0.5], [0, 0.35, 0])])
    const target = ensureVoxelTarget(world, 'toilet-1')!
    // Silhouette cell: clamp(0.4/3, 0.055, 0.11) = 0.11 m, isotropic.
    expect(target.grid.cellX).toBeCloseTo(0.11, 5)
    expect(target.grid.cellY).toBeCloseTo(0.11, 5)
    expect(target.grid.cellZ).toBeCloseTo(0.11, 5)
    // A solid box fills its whole raw span — 4×7×5 = 140 voxels tracing the
    // shape, vs 60 chunky cells on the legacy 0.15 m volume lane.
    expect(target.grid.count).toBe(target.grid.nx * target.grid.ny * target.grid.nz)
    expect(target.grid.count).toBeGreaterThanOrEqual(100)
    // Items stay plain volumes: shape is the anatomy — no skins, no sticks.
    expect(target.kind).toBe('volume')
    expect(target.item).toBe(true)
    expect(target.sheets.length).toBe(0)
    expect(target.segments.length).toBe(0)
  })

  test('tiny items clamp at the 0.055 m cell floor', () => {
    const world = makeWorld([boxCollider('soap-1', 'shelf', [0.12, 0.12, 0.12], [0, 0.06, 0])])
    const target = ensureVoxelTarget(world, 'soap-1')!
    expect(target.grid.cellX).toBeCloseTo(0.055, 5)
    expect(target.grid.count).toBe(target.grid.nx * target.grid.ny * target.grid.nz)
  })

  test('dense items never ship a truncated grid — the fill-ceiling guard rebuilds coarser', () => {
    // 0.9×2.4×0.9 at the 0.11 m silhouette cell is 1782 raw cells: under
    // the raised item budget but over voxel.ts's 1600 fill cap. A solid box
    // MUST fill every raw cell, so count == nx·ny·nz proves nothing was
    // silently chopped off the top.
    const world = makeWorld([boxCollider('cab-1', 'cabinet', [0.9, 2.4, 0.9], [0, 1.2, 0])])
    const target = ensureVoxelTarget(world, 'cab-1')!
    expect(target.grid.count).toBe(target.grid.nx * target.grid.ny * target.grid.nz)
    expect(target.grid.count).toBeLessThanOrEqual(1600)
    // Still finer than the legacy 0.15 m volume cell.
    expect(target.grid.cellX).toBeLessThan(0.15)
    expect(target.grid.count).toBeGreaterThan(600)
  })

  test('non-family kinds keep the legacy adaptive volume lane', () => {
    const world = makeWorld([boxCollider('block-1', 'block', [1, 1, 1], [0, 0.5, 0])])
    const target = ensureVoxelTarget(world, 'block-1')!
    expect(target.item).toBe(false)
    expect(target.grid.cellX).toBeCloseTo(0.15, 5)
  })

  test('the grid hugs an L-shaped silhouette — no cells in the empty quadrant', () => {
    // Two boxes forming an L in plan; the fourth quadrant (x, z > 0.4) is
    // real air and must stay cell-free — items trace their SHAPE, they
    // never fall back to a crude AABB box fill.
    const world = makeWorld([
      boxCollider('bench-1', 'item', [0.4, 0.6, 0.8], [0.2, 0.3, 0.4]),
      boxCollider('bench-1', 'item', [0.4, 0.6, 0.4], [0.6, 0.3, 0.2]),
    ])
    const target = ensureVoxelTarget(world, 'bench-1')!
    let inEmptyQuadrant = 0
    for (let i = 0; i < target.grid.count; i++) {
      if (!target.grid.alive[i]) continue
      const x = target.grid.centers[i * 3]!
      const z = target.grid.centers[i * 3 + 2]!
      // 0.46 clears the last legitimate 0.11 m cell column (spans → 0.44).
      if (x > 0.46 && z > 0.46) inEmptyQuadrant++
    }
    expect(inEmptyQuadrant).toBe(0)
    expect(target.grid.aliveCount).toBeGreaterThan(100)
  })
})

// ── Item palette (cellColors — the voxels wear the material) ────────────────

describe('item palette sampling (ensureVoxelTarget cellColors)', () => {
  test('per-cell colors come from the sub-mesh region the cell sits in', () => {
    const red = new MeshBasicMaterial({ color: '#aa2222' })
    const blue = new MeshBasicMaterial({ color: '#2233aa' })
    const world = makeWorld([
      boxCollider('dresser-1', 'item', [0.8, 0.4, 0.8], [0, 0.2, 0], red),
      boxCollider('dresser-1', 'item', [0.8, 0.4, 0.8], [0, 0.6, 0], blue),
    ])
    const target = ensureVoxelTarget(world, 'dresser-1')!
    const colors = target.cellColors!
    expect(colors).toBeDefined()
    expect(colors.length).toBe(target.grid.count * 3)
    let lower = 0
    let upper = 0
    for (let i = 0; i < target.grid.count; i++) {
      const y = target.grid.centers[i * 3 + 1]!
      // Skip the 0.11 m cell row straddling the 0.4 m material seam.
      if (y < 0.35) {
        expect(colors[i * 3]!).toBeCloseTo(red.color.r, 5)
        expect(colors[i * 3 + 2]!).toBeCloseTo(red.color.b, 5)
        lower++
      } else if (y > 0.45) {
        expect(colors[i * 3]!).toBeCloseTo(blue.color.r, 5)
        expect(colors[i * 3 + 2]!).toBeCloseTo(blue.color.b, 5)
        upper++
      }
    }
    expect(lower).toBeGreaterThan(0)
    expect(upper).toBeGreaterThan(0)
    // baseColor becomes the palette average — dust and fallback debris stay
    // in the item's own family instead of the greige default.
    expect(target.baseColor.r).toBeGreaterThan(blue.color.r)
    expect(target.baseColor.r).toBeLessThan(red.color.r)
    expect(target.baseColor.b).toBeGreaterThan(red.color.b)
    expect(target.baseColor.b).toBeLessThan(blue.color.b)
  })

  test('multi-material sub-meshes resolve to the group-dominant material', () => {
    const red = new MeshBasicMaterial({ color: '#aa2222' })
    const blue = new MeshBasicMaterial({ color: '#2233aa' })
    const geometry = new BoxGeometry(0.6, 0.6, 0.6)
    geometry.clearGroups()
    geometry.addGroup(0, 12, 0)
    geometry.addGroup(12, Infinity, 1) // "to the end" — 24 of 36 indices
    const mesh = new Mesh(geometry, [red, blue])
    mesh.position.set(0, 0.3, 0)
    mesh.updateMatrixWorld(true)
    mesh.geometry.computeBoundingBox()
    const worldBox = mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld)
    const world = makeWorld([
      {
        mesh,
        bvh: bvhFor(mesh),
        inverse: new Matrix4().copy(mesh.matrixWorld).invert(),
        worldBox,
        root: mesh,
        nodeId: 'crate-1',
        nodeType: 'item',
      },
    ])
    const target = ensureVoxelTarget(world, 'crate-1')!
    const colors = target.cellColors!
    for (let i = 0; i < target.grid.count; i++) {
      expect(colors[i * 3]!).toBeCloseTo(blue.color.r, 5)
      expect(colors[i * 3 + 2]!).toBeCloseTo(blue.color.b, 5)
    }
  })

  test('non-item targets carry no cellColors — walls/volumes are untouched', () => {
    const world = makeWorld([boxCollider('block-2', 'block', [1, 1, 1], [0, 0.5, 0])])
    expect(ensureVoxelTarget(world, 'block-2')!.cellColors).toBeUndefined()
  })
})
