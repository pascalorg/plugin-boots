import { describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, Matrix4, Vector3 } from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import {
  buildVoxelGrid,
  dropInteriorCells,
  findUnsupportedIslands,
  raycastVoxels,
  raycastYawObb,
  removeSphere,
} from './voxel'

/** A 2m long × 1m tall × 0.2m thick wall segment centered at origin. */
function wallGrid(cell = 0.2) {
  const geometry = new BoxGeometry(2, 1, 0.2)
  const bvh = new MeshBVH(geometry)
  const bounds = new Box3(new Vector3(-1, -0.5, -0.1), new Vector3(1, 0.5, 0.1))
  return buildVoxelGrid([{ bvh, matrixWorld: new Matrix4() }], bounds, cell)
}

describe('buildVoxelGrid', () => {
  test('fills a solid box wall', () => {
    const grid = wallGrid()
    // 10 × 5 × 1 cells at 0.2m
    expect(grid.nx).toBe(10)
    expect(grid.ny).toBe(5)
    expect(grid.count).toBe(50)
    expect(grid.aliveCount).toBe(50)
  })

  test('respects transforms', () => {
    const geometry = new BoxGeometry(2, 1, 0.2)
    const bvh = new MeshBVH(geometry)
    const matrixWorld = new Matrix4().makeTranslation(10, 0, 0)
    const bounds = new Box3(new Vector3(9, -0.5, -0.1), new Vector3(11, 0.5, 0.1))
    const grid = buildVoxelGrid([{ bvh, matrixWorld }], bounds, 0.2)
    expect(grid.count).toBe(50)
    expect(grid.centers[0]).toBeGreaterThan(8.9)
  })
})

describe('removeSphere', () => {
  test('kills voxels in radius and only those', () => {
    const grid = wallGrid()
    const removed = removeSphere(grid, 0, 0, 0, 0.25)
    expect(removed.length).toBeGreaterThan(0)
    expect(grid.aliveCount).toBe(grid.count - removed.length)
    for (const idx of removed) {
      const dx = grid.centers[idx * 3]!
      const dy = grid.centers[idx * 3 + 1]!
      expect(Math.hypot(dx, dy)).toBeLessThanOrEqual(0.25)
    }
  })
})

describe('raycastVoxels', () => {
  test('hits the wall face first', () => {
    const grid = wallGrid()
    const hit = raycastVoxels(grid, 0, 0, 5, 0, 0, -1, 20)
    expect(hit).not.toBeNull()
    expect(hit!.distance).toBeGreaterThan(4.5)
    expect(hit!.distance).toBeLessThan(5.5)
  })

  test('passes through a blown-out hole', () => {
    const grid = wallGrid()
    removeSphere(grid, 0, 0, 0, 0.45)
    const hit = raycastVoxels(grid, 0, 0, 5, 0, 0, -1, 20)
    expect(hit).toBeNull()
  })

  test('misses when aimed off-grid', () => {
    const grid = wallGrid()
    expect(raycastVoxels(grid, 0, 5, 5, 0, 0, -1, 20)).toBeNull()
  })
})

describe('dropInteriorCells', () => {
  test('a 10x5x3 box keeps only z-layers 0 and 2', () => {
    const geometry = new BoxGeometry(2, 1, 0.6)
    const bvh = new MeshBVH(geometry)
    const bounds = new Box3(new Vector3(-1, -0.5, -0.3), new Vector3(1, 0.5, 0.3))
    const grid = buildVoxelGrid([{ bvh, matrixWorld: new Matrix4() }], bounds, 0.2)
    expect(grid.nx).toBe(10)
    expect(grid.ny).toBe(5)
    expect(grid.nz).toBe(3)
    expect(grid.count).toBe(150)
    const skinned = dropInteriorCells(grid)
    expect(skinned.count).toBe(100)
    expect(skinned.aliveCount).toBe(100)
    for (let i = 0; i < skinned.count; i++) {
      const iz = skinned.coords[i * 3 + 2]!
      expect(iz === 0 || iz === 2).toBe(true)
      // The rebuilt index map resolves every kept cell back to itself.
      const key =
        skinned.coords[i * 3]! +
        skinned.nx * (skinned.coords[i * 3 + 1]! + skinned.ny * iz)
      expect(skinned.index.get(key)).toBe(i)
    }
    // The dropped middle layer is gone from the lookup entirely.
    expect(skinned.index.get(5 + skinned.nx * (2 + skinned.ny * 1))).toBeUndefined()
  })

  test('thin grids (≤2 cells thick) keep everything', () => {
    const grid = wallGrid() // 10 × 5 × 1
    expect(dropInteriorCells(grid)).toBe(grid)
  })

  test('picks the smallest axis when it is not z', () => {
    // 3 × 5 × 10 box: x is the thickness axis.
    const geometry = new BoxGeometry(0.6, 1, 2)
    const bvh = new MeshBVH(geometry)
    const bounds = new Box3(new Vector3(-0.3, -0.5, -1), new Vector3(0.3, 0.5, 1))
    const grid = buildVoxelGrid([{ bvh, matrixWorld: new Matrix4() }], bounds, 0.2)
    const skinned = dropInteriorCells(grid)
    expect(skinned.count).toBe(100)
    for (let i = 0; i < skinned.count; i++) {
      const ix = skinned.coords[i * 3]!
      expect(ix === 0 || ix === 2).toBe(true)
    }
  })
})

describe('raycastYawObb', () => {
  test('hits an axis-aligned box straight on', () => {
    const t = raycastYawObb(0, 0, 5, 0, 0, -1, 0, 0, 0, 0.5, 0.5, 0.5, 0, 20)
    expect(t).not.toBeNull()
    expect(t!).toBeCloseTo(4.5, 5)
  })

  test('respects the stud yaw convention', () => {
    // A plank 2 long (local x) × 1 tall × 0.1 thick (local z), yawed so its
    // length lies along world z (yaw = atan2(dz, dx) = π/2).
    const yaw = Math.PI / 2
    // Down the length: enter at world z = 1 → distance 4.
    let t = raycastYawObb(0, 0, 5, 0, 0, -1, 0, 0, 0, 1, 0.5, 0.05, yaw, 20)
    expect(t).not.toBeNull()
    expect(t!).toBeCloseTo(4, 4)
    // From the side it is only 0.1 thick: enter at world x = 0.05.
    t = raycastYawObb(5, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0.5, 0.05, yaw, 20)
    expect(t).not.toBeNull()
    expect(t!).toBeCloseTo(4.95, 4)
    // Down the length of the UNROTATED plank the same ray misses.
    expect(raycastYawObb(0, 0, 5, 0, 0, -1, 0, 0, 0, 1, 0.5, 0.05, 0, 20)).not.toBeNull()
    expect(raycastYawObb(0, 0.8, 5, 0, 0, -1, 0, 0, 0, 1, 0.5, 0.05, yaw, 20)).toBeNull()
  })

  test('misses when out of range or off to the side', () => {
    expect(raycastYawObb(0, 0, 5, 0, 0, -1, 0, 0, 0, 0.5, 0.5, 0.5, 0, 4)).toBeNull()
    expect(raycastYawObb(3, 0, 5, 0, 0, -1, 0, 0, 0, 0.5, 0.5, 0.5, 0, 20)).toBeNull()
  })

  test('starts inside → distance 0', () => {
    const t = raycastYawObb(0, 0, 0, 0, 0, -1, 0, 0, 0, 0.5, 0.5, 0.5, 0.7, 20)
    expect(t).toBe(0)
  })
})

describe('findUnsupportedIslands', () => {
  test('solid wall has no islands', () => {
    const grid = wallGrid()
    expect(findUnsupportedIslands(grid)).toHaveLength(0)
  })

  test('a horizontal cut drops the top as one island', () => {
    const grid = wallGrid()
    // Kill the full row at iy=2 → everything above (iy 3,4) detaches.
    for (let i = 0; i < grid.count; i++) {
      if (grid.coords[i * 3 + 1] === 2) {
        grid.alive[i] = 0
        grid.aliveCount--
      }
    }
    const islands = findUnsupportedIslands(grid)
    expect(islands).toHaveLength(1)
    expect(islands[0]!.length).toBe(20) // two full rows of 10×1
    for (const idx of islands[0]!) {
      expect(grid.coords[idx * 3 + 1]!).toBeGreaterThan(2)
    }
  })
})
