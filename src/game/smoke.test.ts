import { afterEach, describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, Matrix4, Mesh, Vector3 } from 'three'
import {
  collideVoxelTargets,
  damageTarget,
  ensureVoxelTarget,
  raycastStuds,
  resetDestruction,
  useDestruction,
} from './destruction'
import { doorsDebug } from './doors'
import { playerRig } from './player'
import { fire } from './shooting'
import type { WeaponDef } from './weapons'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

/**
 * Round-2 smoke pass, headless edition. The dev host at :3002 was down (and
 * restarts are off-limits for agents), so instead of driving __boots through
 * a browser this exercises the exact same pipeline the debug handles call:
 * fire() → solid/voxel/stud resolution → damageTarget/damageStud → the
 * useDestruction state that __boots.studs() snapshots. Everything DOM-bound
 * (doorsDebug.toggle with a mounted Doors, session enter/exit) is covered by
 * report-side review instead.
 */

/** Deterministic test guns — zero spread so rays go exactly where aimed. */
const GUN: WeaponDef = {
  id: 'rifle',
  rate: 10,
  auto: true,
  damage: 24,
  holeRadius: 0.19,
  spread: 0,
  range: 90,
  melee: false,
  kick: 0,
}
/** Long-reach knife: melee chips studs 1 hp per swing, deterministically. */
const KNIFE: WeaponDef = {
  id: 'knife',
  rate: 2,
  auto: true,
  damage: 45,
  holeRadius: 0.11,
  spread: 0,
  range: 90,
  melee: true,
  kick: 0,
}

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

/** A 2m × 2.7m × 0.12m wall at the origin (skins at z ≈ ±0.04), a slab-like
 * volume at x=10, and an indestructible prop at x=20 — all on the z=0 line. */
function makeWorld(): GameWorld {
  const wall = boxCollider('wall-1', 'wall', [2, 2.7, 0.12], [0, 1.35, 0])
  const slab = boxCollider('slab-1', 'slab', [1.2, 0.3, 1.2], [10, 1.35, 0])
  const prop = boxCollider('prop-1', 'prop', [1, 1, 1], [20, 1.35, 0])
  const colliders = [wall, slab, prop]
  const buildingAabb = new Box3()
  for (const c of colliders) buildingAabb.union(c.worldBox)
  return {
    colliders,
    walls: new Map([
      [
        'wall-1',
        {
          node: { id: 'wall-1', start: [-1, 0], end: [1, 0], height: 2.7, thickness: 0.12 },
          root: wall.root,
          meshes: [wall.mesh],
        },
      ],
    ]),
    glass: [],
    doors: [],
    buildingAabb,
    spawn: new Vector3(6, 0, 6),
    spawnYaw: 0,
    levelId: null,
  }
}

/** Stand at (x, y, z) looking straight down -Z (yaw 0, pitch 0). */
function aimFrom(x: number, y: number, z: number): void {
  playerRig.position.set(x, y, z)
  playerRig.yaw = 0
  playerRig.pitch = 0
  playerRig.speed = 0
  playerRig.grounded = true
}

/** What __boots.studs() returns, minus the React closure. */
function studsSnapshot() {
  return Array.from(useDestruction.getState().targets.values()).flatMap((target) =>
    target.studs.map((stud) => ({
      nodeId: target.nodeId,
      studId: stud.id,
      hp: stud.hp,
      broken: stud.broken,
    })),
  )
}

afterEach(() => {
  resetDestruction()
})

describe('(a) first shot voxelizes a wall with the skins + studs anatomy', () => {
  test('fire() on a pristine wall carves and __boots.studs() has members', () => {
    const world = makeWorld()
    aimFrom(0, 1.35, 5)
    expect(fire(world, GUN)).toBe('wall')

    const target = useDestruction.getState().targets.get('wall-1')
    expect(target).toBeDefined()
    expect(target!.kind).toBe('wall')
    // 2m at 16" o.c. → 5 studs + top/bottom plates.
    expect(target!.studs).toHaveLength(7)
    const snapshot = studsSnapshot()
    expect(snapshot).toHaveLength(7)
    for (const stud of snapshot) {
      expect(stud.nodeId).toBe('wall-1')
      expect(stud.hp).toBeGreaterThan(0)
      expect(stud.broken).toBe(false)
    }

    // Anatomy: 3 thickness layers, interior dropped → two skins, real cavity.
    expect(target!.grid.nz).toBe(3)
    for (let i = 0; i < target!.grid.count; i++) {
      expect(target!.grid.coords[i * 3 + 2]).not.toBe(1)
    }
    // The shot actually carved.
    expect(target!.grid.aliveCount).toBeLessThan(target!.grid.count)
    expect(target!.removedQueue.length).toBeGreaterThan(0)

    // The host collider hands over to the grid, and legacy alias sees it too.
    const collider = world.colliders.find((c) => c.nodeId === 'wall-1')!
    expect(collider.disabled).toBe(true)
    expect(useDestruction.getState().walls.get('wall-1')).toBe(target!)
    expect(useDestruction.getState().version).toBeGreaterThan(0)
  })

  test('second shot resolves through the voxel grid, not a new target', () => {
    const world = makeWorld()
    aimFrom(0, 1.35, 5)
    fire(world, GUN)
    const target = useDestruction.getState().targets.get('wall-1')!
    const aliveAfterFirst = target.grid.aliveCount
    // The first hole goes through both skins (0.19m carve vs 0.12m wall), so
    // aim at fresh drywall — the disabled host collider must NOT catch this;
    // only the voxel grid can.
    aimFrom(0.5, 1.35, 5)
    expect(fire(world, GUN)).toBe('wall')
    expect(useDestruction.getState().targets.size).toBe(1)
    expect(target.grid.aliveCount).toBeLessThan(aliveAfterFirst)
  })

  test('a hole through both skins lets bullets pass clean', () => {
    const world = makeWorld()
    aimFrom(0, 1.35, 5)
    fire(world, GUN)
    damageTarget(world, 'wall-1', new Vector3(0, 1.35, 0), 0.5)
    // Nothing behind the wall on this ray → the shot exits the world.
    expect(fire(world, GUN)).toBe('none')
  })
})

describe('studs: expose, chip, snap', () => {
  test('knife chips 1 hp, gun snaps, broken studs stop blocking rays', () => {
    const world = makeWorld()
    // Open the cavity in front of stud 3 (x = 0.2192).
    const studX = 0.2192
    damageTarget(world, 'wall-1', new Vector3(studX, 1.35, 0), 0.45)
    aimFrom(studX, 1.35, 5)

    const exposed = raycastStuds(playerRig.position, new Vector3(0, 0, -1), 90)
    expect(exposed).not.toBeNull()
    expect(exposed!.nodeId).toBe('wall-1')
    expect(exposed!.studId).toBe(3)
    expect(exposed!.distance).toBeCloseTo(4.965, 2)

    // Knife whittles: 3 hp → 2.
    expect(fire(world, KNIFE)).toBe('wall')
    const target = useDestruction.getState().targets.get('wall-1')!
    const stud = target.studs.find((s) => s.id === 3)!
    expect(stud.hp).toBe(2)
    expect(stud.broken).toBe(false)

    // Gun finishes it: 24 damage ≥ 2 hp → snapped.
    expect(fire(world, GUN)).toBe('wall')
    expect(stud.broken).toBe(true)
    expect(studsSnapshot().find((s) => s.studId === 3)!.broken).toBe(true)

    // Broken studs are transparent to rays — and this lane is fully open now.
    expect(raycastStuds(playerRig.position, new Vector3(0, 0, -1), 90)).toBeNull()
    expect(fire(world, GUN)).toBe('none')
  })
})

describe('(c) non-wall destructibles carve as plain volumes', () => {
  test('slab voxelizes on first hit: kind volume, no studs, interior kept', () => {
    const world = makeWorld()
    aimFrom(10, 1.35, 5)
    expect(fire(world, GUN)).toBe('wall') // outcome class for any carve
    const target = useDestruction.getState().targets.get('slab-1')
    expect(target).toBeDefined()
    expect(target!.kind).toBe('volume')
    expect(target!.studs).toHaveLength(0)
    expect(target!.grid.aliveCount).toBeLessThan(target!.grid.count)
    // Solid volumes keep their interior (8 × 2 × 8 full box at 0.15m).
    expect(target!.grid.count).toBe(target!.grid.nx * target!.grid.ny * target!.grid.nz)
    expect(world.colliders.find((c) => c.nodeId === 'slab-1')!.disabled).toBe(true)
  })

  test('direct damageTarget carve removes voxels without a shot', () => {
    const world = makeWorld()
    const removed = damageTarget(world, 'slab-1', new Vector3(10, 1.35, 0.15), 0.3)
    expect(removed).toBeGreaterThan(0)
    expect(useDestruction.getState().targets.get('slab-1')!.kind).toBe('volume')
  })

  test('non-destructible node types spark instead of voxelizing', () => {
    const world = makeWorld()
    aimFrom(20, 1.35, 5)
    expect(fire(world, GUN)).toBe('solid')
    expect(useDestruction.getState().targets.has('prop-1')).toBe(false)
    expect(world.colliders.find((c) => c.nodeId === 'prop-1')!.disabled).toBeUndefined()
  })

  test('unknown node ids refuse to voxelize', () => {
    const world = makeWorld()
    expect(damageTarget(world, 'nope', new Vector3(), 0.3)).toBe(0)
    expect(ensureVoxelTarget(world, 'nope')).toBeNull()
  })
})

describe('voxel collision hands over from the host collider', () => {
  test('capsule is pushed off intact skins, walks through a carved hole', () => {
    const world = makeWorld()
    ensureVoxelTarget(world, 'wall-1')

    const pos = new Vector3(0.1, 0, 0.1)
    const vel = new Vector3(0, 0, -1)
    collideVoxelTargets(pos, vel, 0.35, 1.8)
    expect(pos.z).toBeGreaterThan(0.1)
    expect(vel.z).toBeGreaterThan(-1)

    damageTarget(world, 'wall-1', new Vector3(0.1, 0.9, 0), 1.2)
    const pos2 = new Vector3(0.1, 0, 0.1)
    const vel2 = new Vector3(0, 0, -1)
    collideVoxelTargets(pos2, vel2, 0.35, 1.8)
    expect(pos2.z).toBe(0.1)
    expect(vel2.z).toBe(-1)
  })
})

describe('unsupported islands crumble after the settle delay', () => {
  test('severing the wall drops everything above the cut', async () => {
    const world = makeWorld()
    // A horizontal cut across the full 2m length at y = 2.0.
    for (let x = -1; x <= 1.001; x += 0.25) {
      damageTarget(world, 'wall-1', new Vector3(x, 2.0, 0), 0.4)
    }
    const target = useDestruction.getState().targets.get('wall-1')!
    const afterCarve = target.grid.aliveCount
    // Rows above the cut are still alive but disconnected…
    let above = 0
    for (let i = 0; i < target.grid.count; i++) {
      if (target.grid.alive[i] && target.grid.centers[i * 3 + 1]! > 2.25) above++
    }
    expect(above).toBeGreaterThan(0)
    // …until the island timer (140ms) fires.
    await new Promise((resolve) => setTimeout(resolve, 240))
    expect(target.grid.aliveCount).toBeLessThan(afterCarve)
    for (let i = 0; i < target.grid.count; i++) {
      if (target.grid.centers[i * 3 + 1]! > 2.25) expect(target.grid.alive[i]).toBe(0)
    }
  })
})

describe('(b) doors debug handle, unmounted safety', () => {
  test('list() is empty and toggle() is a safe no-op without a mounted game', () => {
    expect(doorsDebug.list()).toEqual([])
    expect(() => doorsDebug.toggle('door-1')).not.toThrow()
  })
})
