import { afterEach, describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, Matrix4, Mesh, Vector3 } from 'three'
import {
  damageTarget,
  ensureVoxelTarget,
  prevoxelizeTick,
  resetDestruction,
  useDestruction,
} from './destruction'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

/**
 * Round-2 destruction surface, headless: session-start prevoxelization
 * (walls clad + host colliders handed over without a single shot) and the
 * LOGICAL sheet system — per-face ~1.2 × 2.4 m groups of existing skin
 * voxels that count carve hits/torn cells and fly off wholesale. No new
 * rendered plane exists anywhere in the sheet model (coplanar z-fighting is
 * impossible by construction), so everything here asserts on grid + member
 * state only.
 */

function boxCollider(
  nodeId: string,
  nodeType: string,
  size: [number, number, number],
  center: [number, number, number],
): ColliderEntry {
  const mesh = new Mesh(new BoxGeometry(size[0], size[1], size[2]))
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

/** Two walls facing the z+ firing line + one slab volume — the same layout
 * family as the shooting tests. */
function makeWorld(): GameWorld {
  const wallA = boxCollider('wall-1', 'wall', [2, 2.7, 0.12], [0, 1.35, 0])
  const wallB = boxCollider('wall-2', 'wall', [3, 2.7, 0.12], [5, 1.35, 0])
  const slab = boxCollider('slab-1', 'slab', [1.2, 0.3, 1.2], [10, 1.35, 0])
  const colliders = [wallA, wallB, slab]
  const buildingAabb = new Box3()
  for (const c of colliders) buildingAabb.union(c.worldBox)
  const wallEntry = (c: ColliderEntry, start: [number, number], end: [number, number]) => ({
    node: { id: c.nodeId, start, end, height: 2.7, thickness: 0.12 },
    root: c.root,
    meshes: [c.mesh],
  })
  return {
    colliders,
    walls: new Map([
      ['wall-1', wallEntry(wallA, [-1, 0], [1, 0])],
      ['wall-2', wallEntry(wallB, [3.5, 0], [6.5, 0])],
    ]),
    glass: [],
    doors: [],
    buildingAabb,
    spawn: new Vector3(6, 0, 6),
    spawnYaw: 0,
    levelId: null,
  }
}

afterEach(() => {
  resetDestruction()
})

describe('prevoxelizeTick', () => {
  test('voxelizes every wall (and only walls) without a shot, colliders handed over', () => {
    const world = makeWorld()
    let done = false
    for (let i = 0; i < 50 && !done; i++) done = prevoxelizeTick(world, 8)
    expect(done).toBe(true)
    const targets = useDestruction.getState().targets
    expect(targets.get('wall-1')?.kind).toBe('wall')
    expect(targets.get('wall-2')?.kind).toBe('wall')
    expect(targets.has('slab-1')).toBe(false)
    // Host handover happened in the same path as first-hit voxelization.
    for (const collider of world.colliders) {
      expect(Boolean(collider.disabled)).toBe(collider.nodeType === 'wall')
    }
    // The anatomy is fully there before any damage.
    const wall = targets.get('wall-1')!
    expect(wall.grid.aliveCount).toBeGreaterThan(0)
    expect(wall.studs.length).toBeGreaterThan(0)
    expect(wall.sheets.length).toBeGreaterThan(0)
  })

  test('a zero-budget tick returns false and a later tick finishes the job', () => {
    const world = makeWorld()
    expect(prevoxelizeTick(world, 0)).toBe(false)
    let done = false
    for (let i = 0; i < 50 && !done; i++) done = prevoxelizeTick(world, 8)
    expect(done).toBe(true)
    expect(prevoxelizeTick(world, 8)).toBe(true) // idempotent once done
  })
})

describe('drywall sheets', () => {
  test('walls get per-face sheet groups covering every skin cell; volumes get none', () => {
    const world = makeWorld()
    const wall = ensureVoxelTarget(world, 'wall-1')!
    // Both faces are sheeted and every cell belongs to exactly one sheet.
    const sides = new Set(wall.sheets.map((s) => s.side))
    expect(sides).toEqual(new Set([0, 1]))
    let covered = 0
    for (const sheet of wall.sheets) {
      expect(sheet.cellCount).toBe(sheet.cells.length)
      expect(sheet.hits).toBe(0)
      expect(sheet.torn).toBe(0)
      expect(sheet.flownOff).toBe(false)
      covered += sheet.cellCount
      for (const idx of sheet.cells) expect(wall.sheetByCell[idx]).toBe(sheet.id)
    }
    expect(covered).toBe(wall.grid.count)
    // Sheets are LOGICAL: outward normals are horizontal unit vectors.
    for (const sheet of wall.sheets) {
      const [nx, ny, nz] = sheet.normal
      expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 5)
      expect(ny).toBe(0)
    }
    const slab = ensureVoxelTarget(world, 'slab-1')!
    expect(slab.kind).toBe('volume')
    expect(slab.sheets.length).toBe(0)
  })

  test('one big carve = one hit per touched sheet, torn matches removed cells', () => {
    const world = makeWorld()
    const removed = damageTarget(world, 'wall-1', new Vector3(0, 1.35, 0), 0.45)
    expect(removed).toBeGreaterThan(8)
    const wall = useDestruction.getState().targets.get('wall-1')!
    const touched = wall.sheets.filter((s) => s.torn > 0)
    expect(touched.length).toBeGreaterThan(0)
    let torn = 0
    for (const sheet of touched) {
      expect(sheet.hits).toBe(1)
      torn += sheet.torn
    }
    expect(torn).toBe(removed)
    expect(Math.max(...touched.map((s) => s.torn))).toBeGreaterThan(8)
  })

  test('repeated carves fly the whole sheet off: flownOff, cells gone, one shot each', () => {
    const world = makeWorld()
    const wall = ensureVoxelTarget(world, 'wall-1')!
    const before = wall.grid.aliveCount
    // Walk small carves across one board area (fresh cells each time, the
    // way a player chews a hole wider) until a sheet lets go.
    const spots: Array<[number, number]> = [
      [-0.7, 1.0],
      [-0.4, 1.0],
      [-0.7, 1.7],
      [-0.4, 1.7],
      [-0.55, 1.35],
    ]
    for (const [x, y] of spots) {
      damageTarget(world, 'wall-1', new Vector3(x, y, 0), 0.3, new Vector3(0, 0, -1))
      if (wall.sheets.some((s) => s.flownOff)) break
    }
    const flown = wall.sheets.filter((s) => s.flownOff)
    expect(flown.length).toBeGreaterThan(0)
    for (const sheet of flown) {
      expect(sheet.torn).toBe(sheet.cellCount)
      for (const idx of sheet.cells) expect(wall.grid.alive[idx]).toBe(0)
    }
    // The wall lost at least one whole sheet's worth of material.
    expect(before - wall.grid.aliveCount).toBeGreaterThanOrEqual(flown[0]!.cellCount)
    // Untouched sheets are still intact.
    const intact = wall.sheets.filter((s) => s.torn === 0)
    expect(intact.length).toBeGreaterThan(0)
    for (const sheet of intact) {
      for (const idx of sheet.cells) expect(wall.grid.alive[idx]).toBe(1)
    }
  })

  test('a flown-off sheet takes no further hits', () => {
    const world = makeWorld()
    const wall = ensureVoxelTarget(world, 'wall-1')!
    for (let i = 0; i < 8 && !wall.sheets.some((s) => s.flownOff); i++) {
      damageTarget(world, 'wall-1', new Vector3(-0.6 + i * 0.05, 1.0 + i * 0.15, 0), 0.3)
    }
    const flown = wall.sheets.find((s) => s.flownOff)!
    expect(flown).toBeDefined()
    const frozen = { hits: flown.hits, torn: flown.torn }
    // Empty air where the sheet was — more carves land nothing on it.
    damageTarget(world, 'wall-1', new Vector3(flown.center[0], flown.center[1], flown.center[2]), 0.3)
    expect(flown.hits).toBe(frozen.hits)
    expect(flown.torn).toBe(frozen.torn)
    expect(flown.torn).toBe(flown.cellCount)
  })
})
