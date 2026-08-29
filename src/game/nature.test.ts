import { describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, Group, InstancedMesh, Matrix4, Vector3 } from 'three'
import {
  clearScatterInRadius,
  FIELD_MARGIN,
  freezeStaticObject,
  GRASS_SECTORS,
  registerScatterField,
  scatter,
  scatterBoundingSphere,
  sectorizeScatter,
} from './nature'
import type { GameWorld } from './world'

/**
 * Static-field discipline (idle perf 2026-08-29), headless: the angular
 * grass sectorization (chunked culling), the per-field bounding sphere the
 * frustum tests against, and the matrix freeze that pulls never-moving
 * fields out of three's per-frame recompose walk. Rendering (<Nature/>) is
 * DOM-bound and covered by the headed QA runs.
 */

function makeWorld(): GameWorld {
  return {
    colliders: [],
    walls: new Map(),
    glass: [],
    doors: [],
    overlayRoots: [],
    buildingAabb: new Box3(new Vector3(-4, 0, -4), new Vector3(4, 3, 4)),
    spawn: new Vector3(),
    spawnYaw: 0,
    levelId: null,
  }
}

describe('sectorizeScatter — angular grass chunks', () => {
  test('partitions completely, keeps (matrix, color) pairs together, sector matches angle', () => {
    const world = makeWorld()
    const grass = scatter(world, 11, 800, 2, 55, (rand, position, matrix) => {
      matrix.setPosition(position)
      // Tag the color with a rand draw so pairing is detectable.
      void rand()
      return { tag: matrix } as never
    })
    const cx = world.buildingAabb.getCenter(new Vector3()).x
    const cz = world.buildingAabb.getCenter(new Vector3()).z
    const chunks = sectorizeScatter(grass, cx, cz, GRASS_SECTORS)

    expect(chunks.length).toBe(GRASS_SECTORS)
    let total = 0
    for (let k = 0; k < chunks.length; k++) {
      const chunk = chunks[k]!
      expect(chunk.colors.length).toBe(chunk.matrices.length)
      total += chunk.matrices.length
      for (let i = 0; i < chunk.matrices.length; i++) {
        const e = chunk.matrices[i]!.elements
        const angle = Math.atan2(e[14]! - cz, e[12]! - cx)
        let expected = Math.floor(((angle + Math.PI) / (2 * Math.PI)) * GRASS_SECTORS)
        if (expected >= GRASS_SECTORS) expected = GRASS_SECTORS - 1
        expect(expected).toBe(k)
        // The color that travelled with this matrix is ITS color (the make
        // callback tagged each color with its own matrix).
        expect((chunk.colors[i] as unknown as { tag: Matrix4 }).tag).toBe(chunk.matrices[i]!)
      }
    }
    expect(total).toBe(grass.matrices.length)
    expect(total).toBeGreaterThan(0)
  })

  test('empty scatter yields all-empty sectors (renderer skips them)', () => {
    const chunks = sectorizeScatter({ matrices: [], colors: [] }, 0, 0, GRASS_SECTORS)
    expect(chunks.length).toBe(GRASS_SECTORS)
    for (const chunk of chunks) expect(chunk.matrices.length).toBe(0)
  })
})

describe('scatterBoundingSphere — the frustum sphere over a field', () => {
  test('covers every instance origin with at least FIELD_MARGIN to spare', () => {
    const matrices = [
      new Matrix4().makeTranslation(10, 0, -3),
      new Matrix4().makeTranslation(-8, 0.2, 40),
      new Matrix4().makeTranslation(2, 1.5, 2),
    ]
    const sphere = scatterBoundingSphere(matrices, FIELD_MARGIN)
    for (const matrix of matrices) {
      const p = new Vector3().setFromMatrixPosition(matrix)
      expect(p.distanceTo(sphere.center) + FIELD_MARGIN).toBeLessThanOrEqual(sphere.radius + 1e-9)
    }
  })

  test('an empty field gets three\'s empty sphere (radius −1 — always culled)', () => {
    const sphere = scatterBoundingSphere([], FIELD_MARGIN)
    expect(sphere.radius).toBe(-1)
  })

  test('a sector chunk sphere is far tighter than the whole-field sphere', () => {
    const world = makeWorld()
    const grass = scatter(world, 11, 2000, 2, 55, (_rand, position, matrix) => {
      matrix.setPosition(position)
      return undefined as never
    })
    const whole = scatterBoundingSphere(grass.matrices, FIELD_MARGIN)
    const chunks = sectorizeScatter(grass, 0, 0, GRASS_SECTORS)
    const busiest = chunks.reduce((a, b) => (b.matrices.length > a.matrices.length ? b : a))
    const chunkSphere = scatterBoundingSphere(busiest.matrices, FIELD_MARGIN)
    expect(chunkSphere.radius).toBeLessThan(whole.radius * 0.85)
  })
})

describe('freezeStaticObject — static fields leave the per-frame matrix walk', () => {
  test('settles the world matrix once, then survives the scene force-cascade untouched', () => {
    const parent = new Group()
    parent.position.set(3, 0, -2)
    const mesh = new InstancedMesh(new BoxGeometry(), undefined, 1)
    mesh.position.set(1, 0.5, 0)
    parent.add(mesh)

    freezeStaticObject(mesh)
    expect(mesh.matrixAutoUpdate).toBe(false)
    expect(mesh.matrixWorldAutoUpdate).toBe(false)
    const settled = new Vector3().setFromMatrixPosition(mesh.matrixWorld)
    expect(settled.x).toBeCloseTo(4, 10)
    expect(settled.y).toBeCloseTo(0.5, 10)
    expect(settled.z).toBeCloseTo(-2, 10)

    // The per-frame scene walk (parent recomposes → force cascade) must NOT
    // touch the frozen mesh — that walk is exactly the idle cost this kills.
    parent.position.x = 50
    parent.updateMatrixWorld(true)
    const after = new Vector3().setFromMatrixPosition(mesh.matrixWorld)
    expect(after.x).toBeCloseTo(4, 10)
  })

  test('re-freezing (field re-attach) re-settles from current transforms', () => {
    const mesh = new InstancedMesh(new BoxGeometry(), undefined, 1)
    mesh.position.set(1, 0, 0)
    freezeStaticObject(mesh)
    mesh.position.set(7, 0, 0)
    freezeStaticObject(mesh) // second attach must not keep the stale matrix
    expect(new Vector3().setFromMatrixPosition(mesh.matrixWorld).x).toBeCloseTo(7, 10)
  })
})

describe('crater clearing across sector chunks', () => {
  test('clearScatterInRadius reaches instances in every registered chunk field', () => {
    const world = makeWorld()
    const grass = scatter(world, 11, 1200, 2, 30, (_rand, position, matrix) => {
      matrix.setPosition(position)
      return undefined as never
    })
    const chunks = sectorizeScatter(grass, 0, 0, GRASS_SECTORS).filter(
      (chunk) => chunk.matrices.length > 0,
    )
    const unregisters = chunks.map((chunk) => {
      const mesh = new InstancedMesh(new BoxGeometry(), undefined, chunk.matrices.length)
      for (let i = 0; i < chunk.matrices.length; i++) mesh.setMatrixAt(i, chunk.matrices[i]!)
      return registerScatterField(mesh, chunk.matrices)
    })
    try {
      // A crater at the building edge overlaps several sectors' wedges.
      const cleared = clearScatterInRadius(6, 0, 8)
      expect(cleared).toBeGreaterThan(0)
      let zeroed = 0
      for (const chunk of chunks) {
        for (const matrix of chunk.matrices) {
          if (matrix.elements[0] === 0 && matrix.elements[5] === 0) zeroed++
        }
      }
      expect(zeroed).toBe(cleared)
    } finally {
      for (const unregister of unregisters) unregister()
    }
  })
})
