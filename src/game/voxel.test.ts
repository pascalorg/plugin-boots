import { describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, Matrix4, Vector3 } from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import { buildVoxelGrid, findUnsupportedIslands, raycastVoxels, removeSphere } from './voxel'

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
