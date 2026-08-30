import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  Box3,
  BoxGeometry,
  Color,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Vector3,
} from 'three'
import { clearPassages, passageHidesCell, registerPassage, unregisterPassage } from './collision'
import {
  ensureVoxelTarget,
  resetDestruction,
  setShellFlag,
  type VoxelTarget,
} from './destruction'
import { buildPassageBox } from './interact'
import { primeSkin, syncPassageHoles } from './voxel-walls'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

/**
 * AN OPEN DOOR LOOKS OPEN — the VISIBLE half of the owner's report ("i see
 * voxels when it's open through it and i can open with E but not walk into it",
 * 2026-08-30). door-passage-voxels.test.ts pins the walking half.
 *
 * A voxel grid carves its OWN target's openings and nobody else's, so scene
 * geometry authored across a neighbour's doorway — on the QA house the east
 * wall's end stands inside the front opening, and the browser census counted 43
 * such cells on the sculpted lot, 65 at the bath door — renders as a wall of
 * cubes right through the aperture the moment that wall wakes. The collision
 * lanes already treat those cells as absent; the picture has to agree.
 *
 * These pin the INVARIANT — "the drawn cell set is the alive set minus the cells
 * standing in an open doorway, and NOTHING else moves" — not the call site, so
 * the rule survives the writer being refactored or moved between layers. The
 * bound is as load-bearing as the hole: relief that reached one cell too far
 * would notch a jamb, hole the threshold, or slot the header, which is a worse
 * bug than the one being fixed.
 */

// Conforming-shell prebuilds are DORMANT (host mesh renders, grid sleeps) — the
// case that never had the bug. This suite is about the AWAKE grid that draws its
// own cubes, so throw the per-kind kill switches exactly as the other voxel
// suites do; afterAll restores the S2 defaults.
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
 * The QA house's front door reduced to what matters: a door leaf filling the
 * opening (the node whose collider group becomes the passage prism), a wall
 * running along Z whose end stands INSIDE that opening and rises PAST the
 * leaf's head — so one target carries both the cells that must vanish and the
 * header cells that must not — and a floor slab under the threshold.
 */
function makeDoorwayWorld(): GameWorld {
  const leaf = boxCollider('door_front', 'door', [OPENING_HALF * 2, 2.1, 0.12], [0, 1.05, 0])
  const cross = boxCollider('wall_cross', 'wall', [0.12, 2.7, 1], [0, 1.35, -0.5])
  const floor = boxCollider('slab_floor', 'slab', [8, 0.3, 8], [0, -0.15, 0])
  const colliders = [leaf, cross, floor]
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

function meshFor(target: VoxelTarget): InstancedMesh {
  return new InstancedMesh(
    new BoxGeometry(1, 1, 1),
    new MeshStandardMaterial(),
    target.grid.count,
  )
}

const _m = new Matrix4()

/**
 * Is instance `i` actually on screen? Hidden cells carry a zero-scale matrix
 * (voxel-walls.tsx ZERO) — the ONE mechanism this layer has for "absent", so the
 * only thing worth asserting about.
 *
 * Read the basis columns straight out of `elements` rather than decomposing:
 * three r0.185's `Matrix4.decompose` GUARDS a zero determinant by handing back
 * scale (1, 1, 1), so decomposing a hidden instance reports it as drawn at full
 * size. (That guard silently passed the first cut of this suite.)
 */
function drawn(mesh: InstancedMesh, i: number): boolean {
  mesh.getMatrixAt(i, _m)
  const e = _m.elements
  const sx = Math.hypot(e[0]!, e[1]!, e[2]!)
  const sy = Math.hypot(e[4]!, e[5]!, e[6]!)
  const sz = Math.hypot(e[8]!, e[9]!, e[10]!)
  return sx > 1e-9 && sy > 1e-9 && sz > 1e-9
}

/** Where instance `i` draws (the matrix's translation column). */
function drawnAt(mesh: InstancedMesh, i: number): Vector3 {
  mesh.getMatrixAt(i, _m)
  const e = _m.elements
  return new Vector3(e[12]!, e[13]!, e[14]!)
}

interface Census {
  /** alive cells whose centre stands inside the doorway */
  inside: number[]
  /** alive cells outside it */
  outside: number[]
  /** alive cells above the door's head — the header */
  header: number[]
  hiddenInside: number
  hiddenOutside: number
}

/**
 * Classify the target's live cells against the doorway by PURE GEOMETRY — the
 * prism box interact.tsx built, shrunk/grown by a hair so cells sitting exactly
 * on a face are neither counted (they are the one genuinely arbitrary case).
 * Deliberately does NOT call the predicate under test: asking `passageHidesCell`
 * which cells should vanish and then checking that those cells vanished would
 * assert only that the writer calls the predicate, which is the call site, not
 * the invariant.
 */
function census(mesh: InstancedMesh, target: VoxelTarget, prism: Box3): Census {
  const { grid } = target
  const out: Census = { inside: [], outside: [], header: [], hiddenInside: 0, hiddenOutside: 0 }
  const eps = 0.03
  const inner = prism.clone().expandByScalar(-eps)
  const outer = prism.clone().expandByScalar(eps)
  const at = new Vector3()
  for (let i = 0; i < grid.count; i++) {
    if (!grid.alive[i]) continue
    at.set(grid.centers[i * 3]!, grid.centers[i * 3 + 1]!, grid.centers[i * 3 + 2]!)
    if (inner.containsPoint(at)) {
      out.inside.push(i)
      if (!drawn(mesh, i)) out.hiddenInside++
    } else if (!outer.containsPoint(at)) {
      out.outside.push(i)
      if (!drawn(mesh, i)) out.hiddenOutside++
      if (at.y > prism.max.y) out.header.push(i)
    }
  }
  return out
}

describe('an open doorway is EMPTY on screen too', () => {
  test('THE BUG: an awake grid crossing an open door draws no cubes in the opening', () => {
    const world = makeDoorwayWorld()
    const target = ensureVoxelTarget(world, 'wall_cross')!
    // Guard the premise twice over: a dormant prebuild would not draw its own
    // cubes at all, and a target with nothing in the aperture would pass this
    // test while the bug stood.
    expect(target.dormant).toBeFalsy() // awake targets clear the flag to undefined
    const mesh = meshFor(target)
    const prism = openDoor(world)
    syncPassageHoles(mesh, target)

    const seen = census(mesh, target, prism)
    expect(seen.inside.length).toBeGreaterThan(10)
    // Every cell standing in the opening is gone...
    expect(seen.hiddenInside).toBe(seen.inside.length)
    // ...and not one cell outside it went with them.
    expect(seen.hiddenOutside).toBe(0)
  })

  test('the cubes that stay put stay EXACTLY put — same centres, no nudge', () => {
    const world = makeDoorwayWorld()
    const target = ensureVoxelTarget(world, 'wall_cross')!
    const mesh = meshFor(target)
    // Where the prime drew them, before any door existed.
    primeSkin(mesh, target)
    const before = new Map<number, Vector3>()
    for (let i = 0; i < target.grid.count; i++) {
      if (target.grid.alive[i] && drawn(mesh, i)) before.set(i, drawnAt(mesh, i))
    }
    expect(before.size).toBeGreaterThan(0)

    const prism = openDoor(world)
    syncPassageHoles(mesh, target)
    // The prime and the passage sweep are two different writers of the same
    // matrices; if they ever disagree about scale, rotation or origin, opening a
    // door would visibly shift the whole wall.
    const outer = prism.clone().expandByScalar(0.03)
    const at3 = new Vector3()
    for (const [i, at] of before) {
      const c = target.grid.centers
      at3.set(c[i * 3]!, c[i * 3 + 1]!, c[i * 3 + 2]!)
      if (outer.containsPoint(at3)) continue
      expect(drawn(mesh, i)).toBe(true)
      expect(drawnAt(mesh, i).distanceTo(at)).toBeLessThan(1e-6)
    }
  })

  test('closing the door puts every cube back', () => {
    const world = makeDoorwayWorld()
    const target = ensureVoxelTarget(world, 'wall_cross')!
    const mesh = meshFor(target)
    const prism = openDoor(world)
    const hadHoles = syncPassageHoles(mesh, target)
    expect(hadHoles).toBe(true) // the latch the caller needs to run this sweep again

    unregisterPassage(prism)
    expect(syncPassageHoles(mesh, target)).toBe(false)
    let missing = 0
    for (let i = 0; i < target.grid.count; i++) {
      if (target.grid.alive[i] && !drawn(mesh, i)) missing++
    }
    expect(missing).toBe(0)
  })

  test('a prime while the door already stands open comes out with the hole in it', () => {
    const world = makeDoorwayWorld()
    const target = ensureVoxelTarget(world, 'wall_cross')!
    const mesh = meshFor(target)
    // Waking a wall mid-session, or the budgeted dormant queue reaching one
    // while the player is standing in the doorway: the prime is the only writer
    // that runs, so it has to know about passages by itself.
    const prism = openDoor(world)
    expect(primeSkin(mesh, target)).toBe(true)
    const seen = census(mesh, target, prism)
    expect(seen.inside.length).toBeGreaterThan(10)
    expect(seen.hiddenInside).toBe(seen.inside.length)
    expect(seen.hiddenOutside).toBe(0)
  })

  test('dead cells stay hidden whether or not a door is open', () => {
    const world = makeDoorwayWorld()
    const target = ensureVoxelTarget(world, 'wall_cross')!
    const mesh = meshFor(target)
    const dead: number[] = []
    for (let i = 0; i < target.grid.count && dead.length < 5; i += 7) {
      if (target.grid.alive[i]) {
        target.grid.alive[i] = 0
        dead.push(i)
      }
    }
    expect(dead.length).toBe(5)
    openDoor(world)
    syncPassageHoles(mesh, target)
    for (const i of dead) expect(drawn(mesh, i)).toBe(false)
  })
})

describe('the hole is bounded — it clears the opening and nothing else', () => {
  test('the THRESHOLD keeps its floor: no cell of the slab under the door vanishes', () => {
    const world = makeDoorwayWorld()
    const floor = ensureVoxelTarget(world, 'slab_floor')!
    const mesh = meshFor(floor)
    primeSkin(mesh, floor)
    // A hole here is the trade the collision lane's feet rule exists to refuse,
    // and it would be far worse than the reported bug: you would see through the
    // floor of the doorway you were trying to walk into.
    expect(openDoor(world).min.y).toBeGreaterThanOrEqual(0)
    expect(syncPassageHoles(mesh, floor)).toBe(false)
    let missing = 0
    for (let i = 0; i < floor.grid.count; i++) {
      if (floor.grid.alive[i] && !drawn(mesh, i)) missing++
    }
    expect(missing).toBe(0)
  })

  test('the HEADER keeps its cubes: the wall above the door head still draws', () => {
    const world = makeDoorwayWorld()
    const target = ensureVoxelTarget(world, 'wall_cross')!
    const mesh = meshFor(target)
    const prism = openDoor(world)
    syncPassageHoles(mesh, target)
    const seen = census(mesh, target, prism)
    // wall_cross rises to 2.7 against a 2.1 m leaf, so there IS a header here.
    expect(seen.header.length).toBeGreaterThan(0)
    for (const i of seen.header) expect(drawn(mesh, i)).toBe(true)
  })

  test('the predicate is a CENTRE test: it can never reach past a cell of its own', () => {
    const world = makeDoorwayWorld()
    const prism = openDoor(world)
    const mid = new Vector3()
    prism.getCenter(mid)
    expect(passageHidesCell(mid.x, mid.y, mid.z)).toBe(true)
    // Just outside each face, by more than the edge epsilon and less than a
    // cell: unpadded on purpose — padding outward notches the jambs, padding
    // down holes the threshold, padding up slots the header. Under-hiding costs
    // at most half a cube of real wall at the edge of the aperture, which the
    // collision lane has already relieved, so nobody can get stuck on it.
    expect(passageHidesCell(prism.max.x + 0.05, mid.y, mid.z)).toBe(false)
    expect(passageHidesCell(prism.min.x - 0.05, mid.y, mid.z)).toBe(false)
    expect(passageHidesCell(mid.x, prism.max.y + 0.05, mid.z)).toBe(false)
    expect(passageHidesCell(mid.x, prism.min.y - 0.05, mid.z)).toBe(false)
    expect(passageHidesCell(mid.x, mid.y, prism.max.z + 0.05)).toBe(false)
    expect(passageHidesCell(mid.x, mid.y, prism.min.z - 0.05)).toBe(false)
  })

  test('no doorway open, no hole: an unregistered prism hides nothing', () => {
    const world = makeDoorwayWorld()
    const target = ensureVoxelTarget(world, 'wall_cross')!
    const mesh = meshFor(target)
    const leaf = world.colliders.find((c) => c.nodeId === 'door_front')!
    leaf.disabled = true // door open for movement, but nobody registered it
    expect(syncPassageHoles(mesh, target)).toBe(false)
    let missing = 0
    for (let i = 0; i < target.grid.count; i++) {
      if (target.grid.alive[i] && !drawn(mesh, i)) missing++
    }
    expect(missing).toBe(0)
  })

  test('paint and skin tone survive a door being opened: the sweep writes matrices only', () => {
    const world = makeDoorwayWorld()
    const target = ensureVoxelTarget(world, 'wall_cross')!
    const mesh = meshFor(target)
    primeSkin(mesh, target)
    // Stand in for a painted coat: a cell colour nothing about doors should touch.
    const painted = new Color(0.9, 0.1, 0.35)
    mesh.setColorAt(3, painted)
    openDoor(world)
    syncPassageHoles(mesh, target)
    const got = new Color()
    mesh.getColorAt(3, got)
    expect(got.getHex()).toBe(painted.getHex())
  })
})
