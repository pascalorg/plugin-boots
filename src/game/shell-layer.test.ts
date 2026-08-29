import { afterEach, describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, Matrix4, Mesh, MeshStandardMaterial, Vector3 } from 'three'
import {
  collapseWholeTarget,
  damageSegment,
  damageTarget,
  ensureVoxelTarget,
  prevoxelizeTick,
  resetDestruction,
  setShellFlag,
  useDestruction,
  type VoxelTarget,
} from './destruction'
import { captureDemolition, useDemolition } from './save-demolition'
import {
  countDeadFragments,
  deadLatticeKeys,
  diffNewlyDead,
  latticeCellWorldCenter,
  shellCensus,
  worldShellArrays,
} from './shell-layer'
import { drainShellRemovals } from './shell-render'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

/**
 * Shell S0 milestone 4b — the mounting layer's pure half plus the
 * integration contract: a synthetic wall world voxelized with the flag ON
 * carries a shell whose fragments cover every surface cell, the flag OFF
 * path is bit-identical to today, and the save-demolition / target
 * censuses cannot tell the two apart after identical damage (the shell is
 * a pure VIEW over the grid — it never writes destruction state).
 */

function boxCollider(
  nodeId: string,
  nodeType: string,
  size: [number, number, number],
  center: [number, number, number],
  material?: MeshStandardMaterial,
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

function makeWorld(): GameWorld {
  const matA = new MeshStandardMaterial({ color: '#b04030' })
  const matB = new MeshStandardMaterial({ color: '#5a7a4a' })
  const wallA = boxCollider('wall-1', 'wall', [2, 2.7, 0.12], [0, 1.35, 0], matA)
  const wallB = boxCollider('wall-2', 'wall', [3, 2.7, 0.12], [5, 1.35, 0], matB)
  const colliders = [wallA, wallB]
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
    overlayRoots: [],
    buildingAabb,
    spawn: new Vector3(6, 0, 6),
    spawnYaw: 0,
    levelId: null,
  } as unknown as GameWorld
}

function prevoxelize(world: GameWorld): void {
  let done = false
  for (let i = 0; i < 50 && !done; i++) done = prevoxelizeTick(world, 8)
  expect(done).toBe(true)
}

function shelledWall(world: GameWorld, nodeId = 'wall-1'): VoxelTarget {
  prevoxelize(world)
  const target = useDestruction.getState().targets.get(nodeId)!
  expect(target.shell).toBeDefined()
  return target
}

const latticeKeyOfVoxel = (target: VoxelTarget, i: number): number => {
  const { coords, nx, ny } = target.grid
  return coords[i * 3]! + nx * (coords[i * 3 + 1]! + ny * coords[i * 3 + 2]!)
}

afterEach(() => {
  setShellFlag('wall', false)
  useDemolition.getState().clear()
  resetDestruction()
})

describe('diffNewlyDead (the drain-ownership-proof carve detector)', () => {
  test('surfaces each death exactly once, pre-seen deaths on the first look', () => {
    const alive = new Uint8Array([1, 0, 1, 0])
    const seen = new Uint8Array(alive.length).fill(1) // ALL-ONES at mount
    // Deaths that happened before the first look (first-hit voxelize).
    expect(diffNewlyDead(alive, seen, [])).toEqual([1, 3])
    // Nothing new — nothing reported.
    expect(diffNewlyDead(alive, seen, [])).toEqual([])
    // A fresh death reports alone.
    alive[2] = 0
    expect(diffNewlyDead(alive, seen, [])).toEqual([2])
    expect(diffNewlyDead(alive, seen, [])).toEqual([])
  })
})

describe('deadLatticeKeys (cavity-ward expansion along the thickness axis)', () => {
  test('a dead skin voxel also names its voxel-less cavity cells, never the far skin', () => {
    setShellFlag('wall', true)
    const target = shelledWall(makeWorld())
    const grid = target.grid
    // A 0.12 m wall pins 3 thickness layers; dropInteriorCells kept 0 and 2.
    // Find a skin voxel on the min layer of the thickness axis.
    const axisSpan = { x: grid.nx * grid.cellX, y: grid.ny * grid.cellY, z: grid.nz * grid.cellZ }
    const axis = axisSpan.x <= axisSpan.z ? 0 : 2
    const span = axis === 0 ? grid.nx : grid.nz
    const stride = axis === 0 ? 1 : grid.nx * grid.ny
    expect(span).toBe(3)
    let voxel = -1
    for (let i = 0; i < grid.count; i++) {
      if (grid.coords[i * 3 + axis] === 0) {
        voxel = i
        break
      }
    }
    expect(voxel).toBeGreaterThanOrEqual(0)
    const key = latticeKeyOfVoxel(target, voxel)
    const keys = deadLatticeKeys(grid, [voxel])
    // Own key + the dropped middle-layer cell of the same column…
    expect(keys).toContain(key)
    expect(keys).toContain(key + stride)
    // …and NOT the far skin (a real voxel owns its own fate).
    expect(keys).not.toContain(key + stride * 2)
    expect(keys).toHaveLength(2)
    // The middle cell really is voxel-less and the far skin really exists.
    expect(grid.index.has(key + stride)).toBe(false)
    expect(grid.index.has(key + stride * 2)).toBe(true)
  })

  test('feeding the wards into drainShellRemovals kills edge fragments too', () => {
    setShellFlag('wall', true)
    const target = shelledWall(makeWorld())
    const shell = target.shell!
    const grid = target.grid
    // Some fragments live on voxel-less lattice cells (wall top/bottom/side
    // faces span the dropped cavity layer) — the whole reason wards exist.
    let orphanFragments = 0
    for (const cells of shell.cellsOfFragment) {
      if (cells.every((cell) => !grid.index.has(cell))) orphanFragments++
    }
    expect(orphanFragments).toBeGreaterThan(0)
    // Killing EVERY voxel through the ward expansion kills EVERY fragment —
    // no floating edge strips after a full demolition.
    const allVoxels = Array.from({ length: grid.count }, (_, i) => i)
    const keys = deadLatticeKeys(grid, allVoxels)
    const killed = new Uint8Array(shell.fragments.length)
    const batch = drainShellRemovals(shell, keys, killed)
    expect(batch.fragments.length).toBe(shell.fragments.length)
  })
})

describe('latticeCellWorldCenter / worldShellArrays (world-frame debris data)', () => {
  test('a voxel-backed lattice cell centers exactly on the voxel world center', () => {
    setShellFlag('wall', true)
    const target = shelledWall(makeWorld())
    const grid = target.grid
    for (const i of [0, Math.floor(grid.count / 2), grid.count - 1]) {
      const [x, y, z] = latticeCellWorldCenter(grid, latticeKeyOfVoxel(target, i))
      expect(x).toBeCloseTo(grid.centers[i * 3]!, 5)
      expect(y).toBeCloseTo(grid.centers[i * 3 + 1]!, 5)
      expect(z).toBeCloseTo(grid.centers[i * 3 + 2]!, 5)
    }
  })

  test('identity-basis walls: world positions = shell positions + origin; uvs shared', () => {
    setShellFlag('wall', true)
    const target = shelledWall(makeWorld())
    const shell = target.shell!
    const arrays = worldShellArrays(shell, target.grid)
    const { origin } = target.grid
    for (const i of [0, 3, shell.positions.length - 3]) {
      expect(arrays.positions[i]!).toBeCloseTo(shell.positions[i]! + origin.x, 5)
      expect(arrays.positions[i + 1]!).toBeCloseTo(shell.positions[i + 1]! + origin.y, 5)
      expect(arrays.positions[i + 2]!).toBeCloseTo(shell.positions[i + 2]! + origin.z, 5)
    }
    // Identity basis leaves normals untouched.
    expect(arrays.normals[0]).toBeCloseTo(shell.normals[0]!, 6)
    // uvs are frame-free and SHARED (no copy).
    expect(arrays.uvs).toBe(shell.uvs)
    // Fresh copies for the frame-bound arrays (the shell's stay pristine).
    expect(arrays.positions).not.toBe(shell.positions)
    expect(arrays.normals).not.toBe(shell.normals)
  })
})

describe('integration: synthetic wall world, flag on/off', () => {
  test('flag ON: fragmentForCell covers every alive surface cell', () => {
    setShellFlag('wall', true)
    const world = makeWorld()
    prevoxelize(world)
    for (const nodeId of ['wall-1', 'wall-2']) {
      const target = useDestruction.getState().targets.get(nodeId)!
      const shell = target.shell!
      const grid = target.grid
      for (let i = 0; i < grid.count; i++) {
        if (grid.alive[i] === 0) continue
        expect(shell.fragmentForCell[latticeKeyOfVoxel(target, i)]!).toBeGreaterThanOrEqual(0)
      }
    }
  })

  test('flag OFF: no target carries a shell, census reads empty', () => {
    const world = makeWorld()
    prevoxelize(world)
    for (const target of useDestruction.getState().targets.values()) {
      expect(target.shell).toBeUndefined()
    }
    expect(shellCensus()).toEqual({ enabled: false, targets: 0, fragments: 0, killed: 0 })
  })

  test('census counts shelled targets, fragments, and killed fragments after a carve', () => {
    setShellFlag('wall', true)
    const world = makeWorld()
    prevoxelize(world)
    const before = shellCensus()
    expect(before.enabled).toBe(true)
    expect(before.targets).toBe(2)
    expect(before.fragments).toBeGreaterThan(0)
    expect(before.killed).toBe(0)
    const removed = damageTarget(world, 'wall-1', new Vector3(0, 1.35, -0.06), 0.25)
    expect(removed).toBeGreaterThan(0)
    const after = shellCensus()
    expect(after.fragments).toBe(before.fragments)
    expect(after.killed).toBeGreaterThan(0)
    // The headless fallback (voxel-backed rule) agrees on this target.
    const target = useDestruction.getState().targets.get('wall-1')!
    expect(countDeadFragments(target.shell!, target.grid)).toBe(after.killed)
  })

  test('save-demolition + target censuses are identical flag on/off', () => {
    /** One deterministic demolition run; returns the comparable censuses. */
    const run = (shellOn: boolean) => {
      setShellFlag('wall', shellOn)
      const world = makeWorld()
      prevoxelize(world)
      // Identical damage under both flags: pierce wall-2 twice (both
      // skins), then level wall-1 wholesale (the levelTarget recipe).
      damageTarget(world, 'wall-2', new Vector3(5, 1.35, -0.06), 0.25)
      damageTarget(world, 'wall-2', new Vector3(5, 1.35, 0.06), 0.25)
      ensureVoxelTarget(world, 'wall-1')
      const leveled = useDestruction.getState().targets.get('wall-1')!
      collapseWholeTarget('wall-1')
      for (const segment of leveled.segments) {
        if (segment.broken) continue
        damageSegment(
          world,
          'wall-1',
          segment.id,
          10_000,
          new Vector3(segment.center[0], segment.center[1], segment.center[2]),
        )
      }
      captureDemolition()
      const destroyed = useDemolition.getState().destroyed.map((d) => ({ ...d }))
      const targets = Array.from(useDestruction.getState().targets.values()).map((t) => ({
        nodeId: t.nodeId,
        aliveCount: t.grid.aliveCount,
        alive: Array.from(t.grid.alive).join(''),
        broken: t.segments.map((s) => (s.broken ? 1 : 0)).join(''),
        sheets: t.sheets.map((s) => `${s.torn}/${s.hits}/${s.flownOff ? 1 : 0}`).join(','),
      }))
      useDemolition.getState().clear()
      resetDestruction()
      return { destroyed, targets }
    }
    const withShell = run(true)
    const withoutShell = run(false)
    expect(withShell.destroyed).toEqual(withoutShell.destroyed)
    expect(withShell.targets).toEqual(withoutShell.targets)
    // And the run really demolished something (the classifier fired).
    expect(withShell.destroyed.map((d) => d.nodeId)).toContain('wall-1')
  })
})
