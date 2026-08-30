import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, Matrix4, Mesh, Vector3 } from 'three'
import {
  clearPassages,
  moveCapsule,
  passageCount,
  passageRelievesCell,
  PLAYER_CAPSULE,
  registerPassage,
  unregisterPassage,
} from './collision'
import {
  collideVoxelTargets,
  ensureVoxelTarget,
  resetDestruction,
  setShellFlag,
} from './destruction'
import { buildPassageBox } from './interact'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

/**
 * AN OPEN DOOR ADMITS THE PLAYER, EVEN AFTER THE WALLS HAVE BEEN SHOT
 * (owner report 2026-08-30: "i still cant enter a door because i see voxels
 * when it's open through it and i can open with E but not walk into it").
 *
 * Real scenes author neighbouring geometry straight across their openings —
 * on the QA house the east wall's END stands inside the front doorway — and a
 * wall's voxel grid does not carve the door aperture. The player is resolved
 * in TWO independent lanes (player.tsx: moveCapsule against host collider
 * triangles, then collideVoxelTargets against live voxel grids), so an open
 * door only truly admits the player when BOTH lanes honour its passage prism.
 * Before the fix only the triangle lane did: the door walked fine while the
 * crosser's grid was dormant, and the instant gunfire woke that grid the same
 * geometry re-solidified as cubes and sealed the doorway.
 *
 * These tests pin the INVARIANT — "a registered doorway prism is passable in
 * whichever lane owns the geometry, and is passable in neither more nor less
 * than that volume" — rather than any one call site, so moving the relief
 * between lanes cannot silently drop it.
 */

// The conforming-shell tier would make these walls DORMANT prebuilds (host
// keeps colliding, grid sleeps), which is the case that already worked. This
// suite is about the AWAKE grid, so throw the per-kind kill switches exactly
// as the other voxel-lane suites do; afterAll restores the S2 defaults.
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
afterEach(() => {
  resetDestruction()
  clearPassages()
})

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

const OPENING_HALF = 0.4 // a 0.8 m doorway, like every door in the QA house

/**
 * The QA house's front door, reduced to what matters: a doorway on the z = 0
 * line bounded by two jamb stubs, a door leaf filling the opening (the node
 * whose collider group becomes the passage prism), and `wall_cross` — a wall
 * running along Z whose END stands INSIDE the opening, exactly the authoring
 * the owner walks into. Walk direction is -Z.
 */
function makeDoorwayWorld(): GameWorld {
  const jambWest = boxCollider('wall_jamb_w', 'wall', [1, 2.7, 0.12], [-OPENING_HALF - 0.5, 1.35, 0])
  const jambEast = boxCollider('wall_jamb_e', 'wall', [1, 2.7, 0.12], [OPENING_HALF + 0.5, 1.35, 0])
  const leaf = boxCollider('door_front', 'door', [OPENING_HALF * 2, 2.1, 0.12], [0, 1.05, 0])
  // The crosser: its end cap sits on the door plane, its body runs into the
  // room (z < 0), straddling the middle of the opening.
  const cross = boxCollider('wall_cross', 'wall', [0.12, 2.7, 1], [0, 1.35, -0.5])
  const floor = boxCollider('slab_floor', 'slab', [8, 0.3, 8], [0, -0.15, 0])
  const colliders = [jambWest, jambEast, leaf, cross, floor]
  const buildingAabb = new Box3()
  for (const c of colliders) buildingAabb.union(c.worldBox)
  return {
    colliders,
    walls: new Map(),
    glass: [],
    doors: [],
    overlayRoots: [],
    buildingAabb,
    spawn: new Vector3(0, 0, 6),
    spawnYaw: 0,
    levelId: null,
  }
}

/** Open the door the way interact.tsx does: leaf colliders go pass-through
 * for movement and the doorway prism is registered. Returns the prism. */
function openDoor(world: GameWorld): Box3 {
  const leaf = world.colliders.find((c) => c.nodeId === 'door_front')!
  const prism = buildPassageBox([leaf])!
  leaf.disabled = true
  registerPassage(prism)
  return prism
}

/**
 * The player's EXACT per-frame resolve (player.tsx): integrate + slide + step
 * against host collider triangles, then push out of live voxel grids. Returns
 * the deepest -Z the feet reached.
 */
function walkThrough(world: GameWorld, from: Vector3, seconds = 3): { deepestZ: number; end: Vector3 } {
  const pos = from.clone()
  const vel = new Vector3()
  const dt = 1 / 60
  const speed = 4
  let grounded = true
  let deepestZ = pos.z
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    vel.set(0, grounded ? 0 : vel.y - 9.81 * dt, -speed)
    grounded = moveCapsule(pos, vel, dt, world.colliders, grounded, false, PLAYER_CAPSULE)
    grounded = collideVoxelTargets(pos, vel, PLAYER_CAPSULE.radius, PLAYER_CAPSULE.height) || grounded
    if (pos.z < deepestZ) deepestZ = pos.z
  }
  return { deepestZ, end: pos.clone() }
}

/** Past the door plane AND past the prism's far face — really inside. */
const THROUGH_Z = -0.6

describe('an open doorway is passable in the VOXEL lane too', () => {
  test('baseline: the open door admits the player while the crosser is pristine', () => {
    const world = makeDoorwayWorld()
    openDoor(world)
    const { deepestZ } = walkThrough(world, new Vector3(0, 0.05, 1.5))
    expect(deepestZ).toBeLessThan(THROUGH_Z)
  })

  test('THE BUG: an AWAKE grid standing in the opening must not seal it', () => {
    const world = makeDoorwayWorld()
    const target = ensureVoxelTarget(world, 'wall_cross')!
    // Guard the premise: a dormant prebuild would leave the host triangles in
    // charge and this test would pass for the wrong reason.
    expect(target.dormant).toBeFalsy() // awake targets clear the flag to undefined
    expect(target.grid.aliveCount).toBeGreaterThan(0)
    openDoor(world)
    const { deepestZ } = walkThrough(world, new Vector3(0, 0.05, 1.5))
    expect(deepestZ).toBeLessThan(THROUGH_Z)
  })

  test('the prism is what admits them: same awake grid, no prism registered, sealed', () => {
    const world = makeDoorwayWorld()
    ensureVoxelTarget(world, 'wall_cross')
    const leaf = world.colliders.find((c) => c.nodeId === 'door_front')!
    leaf.disabled = true // door open, but nobody registered the doorway
    expect(passageCount()).toBe(0)
    const { deepestZ } = walkThrough(world, new Vector3(0, 0.05, 1.5))
    expect(deepestZ).toBeGreaterThan(THROUGH_Z)
  })

  test('closing the door re-seals it: unregistering the prism restores the block', () => {
    const world = makeDoorwayWorld()
    ensureVoxelTarget(world, 'wall_cross')
    const prism = openDoor(world)
    expect(walkThrough(world, new Vector3(0, 0.05, 1.5)).deepestZ).toBeLessThan(THROUGH_Z)
    unregisterPassage(prism)
    expect(passageCount()).toBe(0)
    expect(walkThrough(world, new Vector3(0, 0.05, 1.5)).deepestZ).toBeGreaterThan(THROUGH_Z)
  })
})

describe('passage relief is bounded — it frees the opening and nothing else', () => {
  test('a voxel FLOOR inside the prism still carries the capsule (no fall-through)', () => {
    const world = makeDoorwayWorld()
    const floor = ensureVoxelTarget(world, 'slab_floor')!
    expect(floor.dormant).toBeFalsy()
    openDoor(world)
    // Standing in the middle of the doorway, on the threshold, feet just
    // below the slab's top skin: the ground-ish push must still resolve.
    const pos = new Vector3(0, -0.05, 0)
    const vel = new Vector3(0, -1, 0)
    const grounded = collideVoxelTargets(pos, vel, PLAYER_CAPSULE.radius, PLAYER_CAPSULE.height)
    expect(grounded).toBe(true)
    expect(pos.y).toBeGreaterThan(-0.05)
    expect(vel.y).toBeGreaterThanOrEqual(-1e-6)
  })

  test('voxel cells OUTSIDE the prism keep pushing while the door stands open', () => {
    const world = makeDoorwayWorld()
    ensureVoxelTarget(world, 'wall_cross')
    const prism = openDoor(world)
    // A point on the crosser well past the prism's far face — deep in the
    // room, where the wall is just a wall.
    expect(prism.max.z).toBeLessThan(0.9)
    const pos = new Vector3(0.3, 0.05, -0.9)
    const before = pos.x
    collideVoxelTargets(pos, new Vector3(-1, 0, 0), PLAYER_CAPSULE.radius, PLAYER_CAPSULE.height)
    expect(pos.x).toBeGreaterThan(before + 0.01)
  })

  /**
   * A CELL IS A CUBE, NOT A POINT — the second half of the same owner report.
   *
   * With the relief comparing only cell CENTRES against the prism, the flat QA
   * house's front door still refused the player (open-walk advance 1.81 m
   * against 20.6 m pristine) while the relief was demonstrably firing: 6633
   * consults, 5067 grants. Recording and attributing every refusal named the
   * blockers exactly — 1566 refusals, ZERO of them "below the feet", all of
   * them "centre outside the prism", from two owners only: `wall_e`'s column at
   * z 3.54 against a prism starting at z 3.587 (cell 0.203, so the cube spans
   * 3.44-3.64 and over half of it stands INSIDE the opening) and the swung-open
   * leaf's own grid at x 5.44 against a prism ending at x 5.40 (cell 0.15).
   *
   * Relieving centres only therefore leaves a fringe one cell thick lining the
   * whole aperture. A 0.8 m door leaves a 0.68 m capsule 0.06 m of clearance per
   * side, so a fringe of 0.08-0.11 m seals it on its own — the door looks open,
   * reports open, and still will not admit anyone. These pin the rule that
   * fixes it (relief means "this cube intrudes into the opening") and the bound
   * that keeps it honest (a cube clear of the opening still resolves, so the
   * padding can never open a hole in a jamb).
   */
  test('a cell whose CUBE overlaps the opening is relieved though its centre is outside', () => {
    const world = makeDoorwayWorld()
    const prism = openDoor(world)
    // `collideVoxelTargets` resolves a cell as a sphere of `grid.cell * 0.55`;
    // the relief has to be told the same half-extent to answer the same question.
    for (const cell of [0.15, 0.203, 0.273]) {
      const half = cell * 0.55
      const feetY = prism.min.y
      // Straddling the far face: more than half the cube is inside the opening.
      const straddlesFarFace = prism.min.z - half * 0.5
      expect(passageRelievesCell(0, 1, straddlesFarFace, feetY, half)).toBe(true)
      // The same cell judged as a bare point — the fringe that sealed the door.
      expect(passageRelievesCell(0, 1, straddlesFarFace, feetY, 0)).toBe(false)
      // And the leaf's own grid, just past the hinge-side edge of the opening.
      expect(passageRelievesCell(prism.max.x + half * 0.5, 1, 0, feetY, half)).toBe(true)
    }
  })

  test('the padding is bounded by the cell itself: a cube clear of the opening still blocks', () => {
    const world = makeDoorwayWorld()
    const prism = openDoor(world)
    const half = 0.203 * 0.55
    const feetY = prism.min.y
    // Two cells out from the opening is jamb wall / room, not doorway.
    expect(passageRelievesCell(0, 1, prism.min.z - half * 3, feetY, half)).toBe(false)
    expect(passageRelievesCell(prism.max.x + half * 3, 1, 0, feetY, half)).toBe(false)
    // A generous half-extent must not reach across a whole doorway's width
    // either: relief is per-cell, so it can only ever free what a cell occupies.
    expect(passageRelievesCell(prism.max.x + 1, 1, 0, feetY, half)).toBe(false)
  })

  test('padding never relieves the floor: a cell below the feet resolves at any size', () => {
    const world = makeDoorwayWorld()
    const prism = openDoor(world)
    // Dead centre of the doorway, cell just under the capsule's feet: the feet
    // test is deliberately unpadded, or the padding would drop the player
    // through the very threshold slab holding them up.
    const feetY = prism.min.y + 0.05
    expect(passageRelievesCell(0, feetY - 0.01, 0, feetY, 0.273 * 0.55)).toBe(false)
    expect(passageRelievesCell(0, feetY + 0.01, 0, feetY, 0.273 * 0.55)).toBe(true)
  })

  test('relief is keyed to the LIVE registry, not to the door being open', () => {
    const world = makeDoorwayWorld()
    ensureVoxelTarget(world, 'wall_cross')
    const prism = openDoor(world)
    const inOpening = () => {
      const pos = new Vector3(0.3, 0.05, 0)
      const start = pos.x
      collideVoxelTargets(pos, new Vector3(-1, 0, 0), PLAYER_CAPSULE.radius, PLAYER_CAPSULE.height)
      return pos.x - start
    }
    expect(Math.abs(inOpening())).toBeLessThan(1e-6) // relieved
    unregisterPassage(prism)
    expect(inOpening()).toBeGreaterThan(0.01) // solid again
  })
})
