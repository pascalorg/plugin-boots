import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, Matrix4, Mesh, Vector3 } from 'three'
import {
  collideVoxelTargets,
  damageTarget,
  ensureVoxelTarget,
  raycastStuds,
  resetDestruction,
  useDestruction,
  setShellFlag,
} from './destruction'
import { doorsDebug } from './doors'
import { playerRig } from './player'
import { fire } from './shooting'
import type { WeaponDef } from './weapons'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

// S2 flips conforming shells DEFAULT ON. This suite pins the VOXEL-ONLY
// lane (awake voxelize, collider hand-over, replica collision/raycasts),
// so it throws the per-kind kill-switches before every test — the same
// session-latched setShell(kind, false) rollback QA uses (the latch
// re-arms via each test's resetDestruction). afterAll restores the
// defaults for whatever suite runs after this file.
beforeEach(() => {
  setShellFlag('wall', false)
  setShellFlag('roof', false)
  setShellFlag('slab', false)
})
afterAll(() => {
  setShellFlag('wall', true)
  setShellFlag('roof', true)
  setShellFlag('slab', true)
})


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

/** A 2m × 2.7m × 0.12m wall at the origin (skins at z ≈ ±0.04), a crate-item
 * volume at x=10, and an indestructible prop at x=20 — all on the z=0 line. */
function makeWorld(): GameWorld {
  const wall = boxCollider('wall-1', 'wall', [2, 2.7, 0.12], [0, 1.35, 0])
  const crate = boxCollider('crate-1', 'item', [1.2, 0.3, 1.2], [10, 1.35, 0])
  const prop = boxCollider('prop-1', 'prop', [1, 1, 1], [20, 1.35, 0])
  const colliders = [wall, crate, prop]
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
    overlayRoots: [],
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
    // 2m at 16" o.c. → 5 stud lines × 3 sticks + 2 plates × 2 runs = 19
    // charcoal-stick segments; `studs` is the legacy alias of the SAME array.
    expect(target!.studs).toHaveLength(19)
    expect(target!.segments).toBe(target!.studs)
    const snapshot = studsSnapshot()
    expect(snapshot).toHaveLength(19)
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
    // Carves under the pierce gate respect the entered skin now (phase-3
    // pierce fix) — a heavy 0.65 m carve is what blows both faces at once.
    damageTarget(world, 'wall-1', new Vector3(0, 1.35, 0), 0.65)
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
    // Stud line 3 splits into sticks 9/10/11 — y = 1.35 is the middle one.
    expect(exposed!.studId).toBe(10)
    expect(exposed!.segmentId).toBe(10)
    // Real lumber cross-section: depth 0.089 on the 0.12 m wall → the stick
    // face sits at z = 0.0445, inside the wall (never proud of the 0.06
    // outer face) but deeper than the old cavity-only studs.
    expect(exposed!.distance).toBeCloseTo(4.9555, 2)
    expect(exposed!.distance).toBeGreaterThan(5 - 0.06)

    // The opening carve SPLASH-chipped the stick it exposed (2 → 1;
    // splash is sub-lethal — chipSegmentSplash's hp-1 floor).
    const target = useDestruction.getState().targets.get('wall-1')!
    const stud = target.segments.find((s) => s.id === 10)!
    expect(stud.hp).toBe(1)
    expect(stud.broken).toBe(false)

    // Knife whittles the scuffed stick: 1 hp → snapped (the full
    // chip-then-snap ladder is asserted in destruction.test.ts).
    expect(fire(world, KNIFE)).toBe('wall')
    expect(stud.broken).toBe(true)
    expect(stud.hp).toBe(0)
    expect(studsSnapshot().find((s) => s.studId === 10)!.broken).toBe(true)

    // Broken studs are transparent to rays.
    expect(raycastStuds(playerRig.position, new Vector3(0, 0, -1), 90)).toBeNull()
    // The far skin survived the near-face carves (pierce fix) — open it
    // from its own face and the lane is fully clear.
    damageTarget(world, 'wall-1', new Vector3(studX, 1.35, -0.06), 0.45)
    expect(fire(world, GUN)).toBe('none')
  })
})

describe('(c) non-wall destructibles carve as plain volumes', () => {
  test('item volume voxelizes on first hit: kind volume, no studs, interior kept', () => {
    const world = makeWorld()
    aimFrom(10, 1.35, 5)
    expect(fire(world, GUN)).toBe('wall') // outcome class for any carve
    const target = useDestruction.getState().targets.get('crate-1')
    expect(target).toBeDefined()
    expect(target!.kind).toBe('volume')
    expect(target!.studs).toHaveLength(0)
    expect(target!.grid.aliveCount).toBeLessThan(target!.grid.count)
    // Solid volumes keep their interior (8 × 2 × 8 full box at 0.15m).
    expect(target!.grid.count).toBe(target!.grid.nx * target!.grid.ny * target!.grid.nz)
    expect(world.colliders.find((c) => c.nodeId === 'crate-1')!.disabled).toBe(true)
  })

  test('direct damageTarget carve removes voxels without a shot', () => {
    const world = makeWorld()
    const removed = damageTarget(world, 'crate-1', new Vector3(10, 1.35, 0.15), 0.3)
    expect(removed).toBeGreaterThan(0)
    expect(useDestruction.getState().targets.get('crate-1')!.kind).toBe('volume')
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
    // A dedicated 6m wall and a THIN line cut: fat carves on the short 2m
    // wall now tear past the sheet fly-off thresholds (by design — round-2
    // drywall dies fast) and the fly-off would beat the island timer to the
    // top rows. A 0.2m-radius grazing cut across 6m keeps every ~1.2m
    // sheet under the fly-off floor, leaving the disconnected top for the
    // flood-fill to find.
    const wall = boxCollider('wall-long', 'wall', [6, 2.7, 0.12], [0, 1.35, 0])
    const world = makeWorld()
    world.colliders.push(wall)
    world.walls.set('wall-long', {
      node: { id: 'wall-long', start: [-3, 0], end: [3, 0], height: 2.7, thickness: 0.12 },
      root: wall.root,
      meshes: [wall.mesh],
    })
    // A horizontal cut across the full 6m length at y = 2.0 — one grazing
    // pass per FACE, since sub-pierce carves respect the entered skin now.
    for (let x = -3; x <= 3.001; x += 0.35) {
      damageTarget(world, 'wall-long', new Vector3(x, 2.0, -0.06), 0.2)
      damageTarget(world, 'wall-long', new Vector3(x, 2.0, 0.06), 0.2)
    }
    // The grazing cut must not have shed whole sheets — that would empty
    // the top rows before the island pass gets to prove itself.
    const cutTarget = useDestruction.getState().targets.get('wall-long')!
    expect(cutTarget.sheets.some((s) => s.flownOff)).toBe(false)
    const target = useDestruction.getState().targets.get('wall-long')!
    const afterCarve = target.grid.aliveCount
    // Rows above the cut are still alive but disconnected…
    let above = 0
    for (let i = 0; i < target.grid.count; i++) {
      if (target.grid.alive[i] && target.grid.centers[i * 3 + 1]! > 2.25) above++
    }
    expect(above).toBeGreaterThan(0)
    // …until the island timer (140ms + up to 150ms B2 settle jitter) fires.
    await new Promise((resolve) => setTimeout(resolve, 450))
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
