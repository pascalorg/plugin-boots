import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, Matrix4, Mesh, Vector3 } from 'three'
import { clearPassages, registerPassage, unregisterPassage } from './collision'
import {
  ensureVoxelTarget,
  raycastVoxelTargets,
  resetDestruction,
  setShellFlag,
} from './destruction'
import { buildPassageBox } from './interact'
import { raycastVoxels } from './voxel'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

/**
 * YOU CAN SHOOT THROUGH AN OPEN DOOR — the third lane of the owner's report
 * ("i see voxels when it's open through it and i can open with E but not walk
 * into it", 2026-08-30). door-passage-voxels.test.ts pins the FEET,
 * door-passage-render.test.ts pins the EYE, this one pins every RAY: bullets,
 * paint spray, and the bots' line-of-sight probe.
 *
 * Same root cause as the other two. A voxel grid carves its own target's
 * openings and nobody else's, so scene geometry authored across a neighbour's
 * doorway re-solidifies the aperture the moment that wall wakes. Once the feet
 * and the eye agree the cells are absent, a ray that still stops on them is
 * strictly worse than a visible wall: the player sees clear air through the
 * doorway, fires, and the shot dies in the middle of it — which reads as the
 * gun being broken, not the door. The bots read the same lane for LOS, so they
 * also refuse to fire back through a door they will happily walk through.
 *
 * These pin the INVARIANT — "a ray is stopped by exactly the cells that are
 * there for the feet and the eye, and by no others" — through the PUBLIC lane
 * functions, never by asking the predicate which cells it would relieve. The
 * bound is as load-bearing as the relief and points the other way from the
 * collision lane's: over-relieving here would let shots through a shut door or
 * through the wall beside a doorway, which is a worse bug than the blockage.
 */

// Conforming-shell prebuilds are DORMANT (the host mesh owns rays), which is
// the case that never had the bug. This suite is about the AWAKE grid, so throw
// the per-kind kill switches as the other voxel suites do; afterAll restores S2.
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
 * A doorway with a wall authored straight across it and something to hit
 * beyond, so "the shot got through" is a POSITIVE observation rather than the
 * absence of one:
 *
 *   door_front   the leaf whose collider group becomes the passage prism
 *   wall_cross   a panel across the aperture, thin along Z and WIDER and TALLER
 *                than the opening — so the same target carries cells that must
 *                go transparent (inside the aperture) and cells that must not
 *                (past the jambs at |x| > 0.4, above the head at y > 2.1)
 *   wall_back    2.9 m past the door, the thing a freed shot should reach
 *   slab_floor   the threshold, under the prism's floor
 */
function makeDoorwayWorld(): GameWorld {
  const leaf = boxCollider('door_front', 'door', [OPENING_HALF * 2, 2.1, 0.12], [0, 1.05, 0])
  const cross = boxCollider('wall_cross', 'wall', [1.2, 2.6, 0.12], [0, 1.3, 0])
  const back = boxCollider('wall_back', 'wall', [4, 2.7, 0.2], [0, 1.35, -3])
  const floor = boxCollider('slab_floor', 'slab', [8, 0.3, 8], [0, -0.15, 0])
  const colliders = [leaf, cross, back, floor]
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

/** Open the door the way interact.tsx does. Returns the registered prism. */
function openDoor(world: GameWorld): Box3 {
  const leaf = world.colliders.find((c) => c.nodeId === 'door_front')!
  const prism = buildPassageBox([leaf])!
  leaf.disabled = true
  registerPassage(prism)
  return prism
}

const DOWN = new Vector3(0, -1, 0)
const INTO = new Vector3(0, 0, -1) // the way the player faces the door
/** Eye height, dead centre of the doorway, two metres back. */
const fromDoorway = (x = 0, y = 1, z = 2) => new Vector3(x, y, z)

describe('an open doorway is EMPTY to rays too', () => {
  test('THE BUG: a shot through an open door reaches what is BEYOND the doorway', () => {
    const world = makeDoorwayWorld()
    const cross = ensureVoxelTarget(world, 'wall_cross')!
    ensureVoxelTarget(world, 'wall_back')
    // Guard the premise twice: a dormant prebuild would leave rays to the host
    // mesh, and an empty grid would pass this test while the bug stood.
    expect(cross.dormant).toBeFalsy() // awake targets clear the flag to undefined
    expect(cross.grid.aliveCount).toBeGreaterThan(0)

    const shut = raycastVoxelTargets(fromDoorway(), INTO, 20)
    expect(shut?.nodeId).toBe('wall_cross') // the wall in the aperture, as authored

    openDoor(world)
    const open = raycastVoxelTargets(fromDoorway(), INTO, 20)
    expect(open?.nodeId).toBe('wall_back')
    // ...and it really travelled: the far wall's face is 2.9 m past the door.
    expect(open!.distance).toBeGreaterThan(shut!.distance + 2)
    expect(Math.abs(open!.distance - 4.9)).toBeLessThan(0.3)
  })

  test('nothing beyond the doorway means NO hit — not a phantom one', () => {
    const world = makeDoorwayWorld()
    ensureVoxelTarget(world, 'wall_cross') // the only awake grid on this line
    openDoor(world)
    // Relief must drop the hit entirely rather than report the relieved cell
    // with a longer distance: shooting.ts picks the nearest lane by distance and
    // then applies damage to `nodeId`, so a phantom hit would chip a wall the
    // player cannot see and never aimed at.
    expect(raycastVoxelTargets(fromDoorway(), INTO, 20)).toBeNull()
  })

  test('closing the door stops the bullets again', () => {
    const world = makeDoorwayWorld()
    ensureVoxelTarget(world, 'wall_cross')
    ensureVoxelTarget(world, 'wall_back')
    const prism = openDoor(world)
    expect(raycastVoxelTargets(fromDoorway(), INTO, 20)?.nodeId).toBe('wall_back')
    unregisterPassage(prism)
    expect(raycastVoxelTargets(fromDoorway(), INTO, 20)?.nodeId).toBe('wall_cross')
  })

  test('the relieved cells are still ALIVE — the shot passes, it does not carve', () => {
    const world = makeDoorwayWorld()
    const cross = ensureVoxelTarget(world, 'wall_cross')!
    ensureVoxelTarget(world, 'wall_back')
    const before = cross.grid.aliveCount
    openDoor(world)
    raycastVoxelTargets(fromDoorway(), INTO, 20)
    // The non-destructive session invariant: opening a door and firing through
    // it must not quietly delete the neighbour's geometry. Close the door and
    // the wall is whole again.
    expect(cross.grid.aliveCount).toBe(before)
  })
})

describe('ray relief is bounded — the aperture only', () => {
  test('the JAMB still stops a shot: past the opening edge the wall is solid', () => {
    const world = makeDoorwayWorld()
    ensureVoxelTarget(world, 'wall_cross')
    ensureVoxelTarget(world, 'wall_back')
    const prism = openDoor(world)
    // x = 0.5 is outside the 0.8 m opening (prism max 0.4) and inside the
    // panel (half-width 0.6) — the wall BESIDE the door.
    expect(prism.max.x).toBeLessThan(0.5)
    expect(raycastVoxelTargets(fromDoorway(0.5), INTO, 20)?.nodeId).toBe('wall_cross')
    expect(raycastVoxelTargets(fromDoorway(-0.5), INTO, 20)?.nodeId).toBe('wall_cross')
  })

  test('the HEADER still stops a shot: above the door head the wall is solid', () => {
    const world = makeDoorwayWorld()
    ensureVoxelTarget(world, 'wall_cross')
    ensureVoxelTarget(world, 'wall_back')
    const prism = openDoor(world)
    // The panel rises to 2.6 against a 2.1 m leaf, so there IS a header. Aim
    // just above the head rather than at the top of the wall: a slot opened
    // over a door lintel is only ever a cell or two tall, so a ray fired well
    // clear of it would not notice one.
    expect(prism.max.y).toBeLessThan(2.2)
    expect(raycastVoxelTargets(fromDoorway(0, 2.25), INTO, 20)?.nodeId).toBe('wall_cross')
  })

  test('the THRESHOLD still stops a shot fired down into the doorway', () => {
    const world = makeDoorwayWorld()
    ensureVoxelTarget(world, 'wall_cross')
    ensureVoxelTarget(world, 'slab_floor')
    const prism = openDoor(world)
    expect(prism.min.y).toBeGreaterThanOrEqual(0)
    // Standing in the doorway shooting at your own feet: the floor is below the
    // prism, so it is not part of the opening and never goes transparent.
    // (Debris, decals and craters all place themselves on this hit.)
    const down = raycastVoxelTargets(new Vector3(0, 1.6, 0), DOWN, 6)
    expect(down?.nodeId).toBe('slab_floor')
  })

  test('a shut door stops a shot even while ANOTHER door stands open', () => {
    const world = makeDoorwayWorld()
    ensureVoxelTarget(world, 'wall_cross')
    ensureVoxelTarget(world, 'wall_back')
    // A prism 20 m away, registered exactly as a real open door would be: the
    // relief is per-cell against the live registry, so a doorway elsewhere in
    // the house must not thin the wall in front of the player.
    registerPassage(new Box3(new Vector3(19.6, 0, -0.4), new Vector3(20.4, 2.1, 0.4)))
    expect(raycastVoxelTargets(fromDoorway(), INTO, 20)?.nodeId).toBe('wall_cross')
  })
})

describe('the SUPPORT probes are deliberately not relieved', () => {
  test('the raw grid walk still sees a cell an open doorway hides', () => {
    const world = makeDoorwayWorld()
    const cross = ensureVoxelTarget(world, 'wall_cross')!
    ensureVoxelTarget(world, 'slab_floor')
    openDoor(world)

    // probeLandingY (destruction.ts) and cellIsSupported (structure.ts) call
    // raycastVoxels DIRECTLY, so relief added to the target lane cannot reach
    // them — which is the whole reason it needed no opt-out flag. If it ever
    // did reach them, debris would fall through the wall it is resting on and
    // the structure pass would crumble standing walls next to open doors.
    const inAperture = raycastVoxels(cross.grid, 0, 1.6, 0, 0, -1, 0, 4)
    expect(inAperture).not.toBeNull()
    const c = cross.grid.centers
    const at = new Vector3(
      c[inAperture!.index * 3]!,
      c[inAperture!.index * 3 + 1]!,
      c[inAperture!.index * 3 + 2]!,
    )
    // Pure geometry, not the predicate: the cell the raw walk stopped on really
    // does stand inside the opening.
    expect(buildPassageBox([world.colliders[0]!])!.containsPoint(at)).toBe(true)

    // Same ray through the public lane, which IS relieved, falls to the floor.
    expect(raycastVoxelTargets(new Vector3(0, 1.6, 0), DOWN, 4)?.nodeId).toBe('slab_floor')
  })
})
