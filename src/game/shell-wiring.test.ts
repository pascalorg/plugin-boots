import { afterEach, describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, Matrix4, Mesh, MeshStandardMaterial, Vector3 } from 'three'
import {
  damageTarget,
  ensureVoxelTarget,
  prevoxelizeTick,
  resetDestruction,
  setShellFlag,
  shellFlags,
  useDestruction,
} from './destruction'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

/**
 * Conforming-shell wiring (S0, milestone 4a): the destruction-side spots
 * only — flag latch, shell attach on the WALL path, host materials by
 * reference, dormant registration with the first-damage wake as the swap.
 * The shell math itself is pinned in shell.test.ts; the mounting/carve
 * side lands with milestone 4b.
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

/** Two textured-ish walls on the z = 0 line (the destruction.test.ts
 * layout family), each with its own host material instance. */
function makeWorld(extraWallMeshes: Mesh[] = []): GameWorld {
  const matA = new MeshStandardMaterial({ color: '#b04030' })
  const matB = new MeshStandardMaterial({ color: '#5a7a4a' })
  const wallA = boxCollider('wall-1', 'wall', [2, 2.7, 0.12], [0, 1.35, 0], matA)
  const wallB = boxCollider('wall-2', 'wall', [3, 2.7, 0.12], [5, 1.35, 0], matB)
  const colliders = [wallA, wallB]
  const buildingAabb = new Box3()
  for (const c of colliders) buildingAabb.union(c.worldBox)
  const wallEntry = (
    c: ColliderEntry,
    start: [number, number],
    end: [number, number],
    extra: Mesh[] = [],
  ) => ({
    node: { id: c.nodeId, start, end, height: 2.7, thickness: 0.12 },
    root: c.root,
    meshes: [c.mesh, ...extra],
  })
  return {
    colliders,
    walls: new Map([
      ['wall-1', wallEntry(wallA, [-1, 0], [1, 0], extraWallMeshes)],
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

afterEach(() => {
  setShellFlag('wall', true) // restore the S2 default for the next suite
  resetDestruction()
})

describe('conforming shell wiring (destruction, S0)', () => {
  test('kill-switch: setShell(wall, false) restores the voxel-only awake path — bit-identical', () => {
    expect(shellFlags.wall).toBe(true) // S2 default is ON…
    setShellFlag('wall', false) // …and OFF is the explicit rollback lever
    const world = makeWorld()
    prevoxelize(world)
    const target = useDestruction.getState().targets.get('wall-1')!
    expect(target.shell).toBeUndefined()
    expect(target.shellMaterials).toBeUndefined()
    expect(target.dormant).toBeFalsy()
    for (const collider of world.colliders) expect(Boolean(collider.disabled)).toBe(true)
  })

  test('flag ON (the default): shell attached (lattice-indexed), host materials by reference, wall dormant', () => {
    const world = makeWorld()
    prevoxelize(world)
    const target = useDestruction.getState().targets.get('wall-1')!
    const shell = target.shell!
    expect(shell).toBeDefined()
    expect(shell.fragments.length).toBeGreaterThan(0)
    // fragmentForCell spans the FULL lattice, not just occupied voxels.
    const grid = target.grid
    expect(shell.fragmentForCell.length).toBe(grid.nx * grid.ny * grid.nz)
    // Host material instance rides BY REFERENCE — never a clone.
    const hostMaterial = world.walls.get('wall-1')!.meshes[0]!.material
    expect(target.shellMaterials![0]).toBe(hostMaterial as MeshStandardMaterial)
    // DORMANT registration: the host keeps rendering AND colliding.
    expect(target.dormant).toBe(true)
    for (const collider of world.colliders) expect(Boolean(collider.disabled)).toBe(false)
    // The anatomy is intact regardless (core + framing untouched by S0).
    expect(target.grid.aliveCount).toBeGreaterThan(0)
    expect(target.studs.length).toBeGreaterThan(0)
    expect(target.sheets.length).toBeGreaterThan(0)
  })

  test('first damage wakes the shelled wall: the swap moment (host hides, colliders hand over)', () => {
    setShellFlag('wall', true)
    const world = makeWorld()
    prevoxelize(world)
    const before = useDestruction.getState().version
    const removed = damageTarget(world, 'wall-1', new Vector3(0, 1.35, -0.06), 0.25)
    expect(removed).toBeGreaterThan(0)
    const target = useDestruction.getState().targets.get('wall-1')!
    expect(target.dormant).toBeFalsy()
    // wakeTarget bumped the store so React re-renders the replica layers.
    expect(useDestruction.getState().version).toBeGreaterThan(before)
    // The woken wall's colliders handed over; the untouched wall keeps its.
    for (const collider of world.colliders) {
      expect(Boolean(collider.disabled)).toBe(collider.nodeId === 'wall-1')
    }
    // The shell (and its material table) survives the wake untouched.
    expect(target.shell).toBeDefined()
    expect(target.shellMaterials!.length).toBeGreaterThan(0)
  })

  test('mid-session flip only affects the NEXT session (prevoxelize latch)', () => {
    setShellFlag('wall', false) // the kill-switch, thrown before any voxelize
    const world = makeWorld()
    // First wall voxelize latches the OFF flag for the session…
    expect(ensureVoxelTarget(world, 'wall-1')).not.toBeNull()
    setShellFlag('wall', true)
    // …so a mid-session flip cannot shell the rest of the house.
    const late = ensureVoxelTarget(world, 'wall-2')!
    expect(late.shell).toBeUndefined()
    expect(late.dormant).toBeFalsy()
    // Next session (reset re-arms the latch) reads the flipped flag.
    resetDestruction()
    const world2 = makeWorld()
    prevoxelize(world2)
    expect(useDestruction.getState().targets.get('wall-1')!.shell).toBeDefined()
    expect(useDestruction.getState().targets.get('wall-2')!.shell).toBeDefined()
  })

  test('glass-like wall sub-meshes contribute no shell surface (shatter lane keeps them)', () => {
    setShellFlag('wall', true)
    const glassMaterial = new MeshStandardMaterial({ transparent: true, opacity: 0.3 })
    const pane = new Mesh(new BoxGeometry(0.8, 1.2, 0.02), glassMaterial)
    pane.position.set(0, 1.35, 0)
    pane.updateMatrixWorld(true)
    const world = makeWorld([pane])
    prevoxelize(world)
    const target = useDestruction.getState().targets.get('wall-1')!
    expect(target.shell).toBeDefined()
    expect(target.shellMaterials).not.toContain(glassMaterial)
  })
})
