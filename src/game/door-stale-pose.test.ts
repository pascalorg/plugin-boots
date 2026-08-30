import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, Group, Matrix4, Mesh, Ray, Vector3 } from 'three'
import { clearPassages, passageCount } from './collision'
import {
  damageTarget,
  posedTargetIsStale,
  raycastVoxelTargets,
  resetDestruction,
  resyncPosedTarget,
  setShellFlag,
  useDestruction,
} from './destruction'
import { advanceOperables, mountInteract, type OperableState, toggleOperable, unmountInteract } from './interact'
import type { VoxelGridData } from './voxel'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

/**
 * THE STALE-POSE BAKE — a door's voxel grid frozen at a pose the leaf has left.
 *
 * A grid is baked in WORLD space and nothing re-poses one, so it is correct
 * only at the pose its source meshes stood in when it was built. The toggle
 * paths all guard that: a DORMANT prebuild is retired before the pose changes,
 * and a toggle refuses to pose an AWAKE node at all. What was NOT guarded is
 * the swing itself — 0.28 s during which the leaf's colliders stay ballistic
 * (you can shoot a door while it opens, by design). A bullet landing in that
 * window bakes the grid mid-arc, wakes it (the host leaf hides, the replica
 * takes over), and the animation carries the leaf on to fully open. The grid
 * stays behind.
 *
 * What the player gets: a slab of voxels hanging in the air across the doorway
 * — partially masked, because the doorway prism hides exactly the cells that
 * fall inside it and no others — that stops bullets and bodies where there is
 * visibly nothing, while the real leaf stands somewhere else. The door can
 * never be repaired either: E stands down on a voxelized node, and an OPEN one
 * is not restorable, so the ghost outlives the session.
 *
 * The INVARIANT pinned here, through the public ray lane rather than any
 * predicate: EVERY voxel hit reported for a posed node lies within that node's
 * live collider bounds (plus a cell radius — cells overhang their source box
 * by up to half a cell by construction). It is deliberately indifferent to
 * HOW that is achieved: dropping the grid and rebuilding on the next hit
 * satisfies it, and so would re-posing the grid to follow the leaf. The bound
 * points the other way and is just as load-bearing: the tests below fence a
 * fix that reaches too far — a shot door that is never operated keeps its grid
 * AND its holes, a leaf voxelized at the pose it is standing in keeps its
 * grid, and one door's swing never retires another door's damage.
 */

// Conforming shells register DORMANT and hand rays to the host mesh, which is
// the case that never had the bug. Doors are plain volumes (no shell lane at
// all), but the fixtures below also voxelize a plain column, so throw the
// per-kind latches the way the other voxel suites do.
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

let mounted: Map<string, OperableState> | null = null
afterEach(() => {
  if (mounted) unmountInteract(mounted)
  mounted = null
  resetDestruction()
  clearPassages()
})

type Built = { root: Group; collider: ColliderEntry }

/** A one-mesh operable node: Group root at `center`, box mesh child — the
 * shape interact's hinged rig expects (the hinge is the leaf's local −X edge,
 * so the swing really does carry the leaf away from the doorway). */
function buildNode(
  nodeId: string,
  nodeType: string,
  size: [number, number, number],
  center: [number, number, number],
): Built {
  const root = new Group()
  root.position.set(center[0], center[1], center[2])
  const mesh = new Mesh(new BoxGeometry(size[0], size[1], size[2]))
  root.add(mesh)
  root.updateMatrixWorld(true)
  mesh.geometry.computeBoundingBox()
  return {
    root,
    collider: {
      mesh,
      bvh: bvhFor(mesh),
      inverse: new Matrix4().copy(mesh.matrixWorld).invert(),
      worldBox: mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld),
      root,
      nodeId,
      nodeType,
    },
  }
}

const HINGED = { doorType: 'hinged', openingKind: 'door' }

function makeWorld(doors: Built[], extra: Built[] = []): GameWorld {
  const colliders = [...doors, ...extra].map((b) => b.collider)
  const buildingAabb = new Box3()
  for (const c of colliders) buildingAabb.union(c.worldBox)
  return {
    colliders,
    walls: new Map(),
    glass: [],
    doors: doors.map((b, i) => ({
      nodeId: b.collider.nodeId,
      root: b.root,
      colliderIndices: [i],
      node: { ...HINGED },
    })),
    operables: [],
    overlayRoots: [],
    buildingAabb,
    spawn: new Vector3(6, 0, 6),
    spawnYaw: 0,
    levelId: null,
  } as unknown as GameWorld
}

/** A 0.8 m leaf in a doorway at the origin, like every interior door in the
 * QA house. Its hinge lands at world x = −0.4, so opening sweeps the leaf out
 * of the doorway and into the room along −Z. */
const doorLeaf = (nodeId: string, x = 0) =>
  buildNode(nodeId, 'door', [0.8, 2.1, 0.12], [x, 1.05, 0])

/** `frames` frames of animation. A fresh values() per step: a Map's iterator
 * is one-shot, and handing the same exhausted one to every step advances only
 * the first frame (which is how the fixture below quietly stopped mid-arc). */
const step = (states: Map<string, OperableState>, frames: number, dt = 1 / 60) => {
  for (let i = 0; i < frames; i++) advanceOperables(states.values(), dt)
}
/** Run every animation to its settled end. */
const settle = (states: Map<string, OperableState>) => step(states, 30, 1 / 30)

const targets = () => useDestruction.getState().targets

/** World box of a grid's live cell CENTERS. */
function gridBox(grid: VoxelGridData): Box3 {
  const box = new Box3()
  const c = grid.centers
  for (let i = 0; i < grid.count; i++) box.expandByPoint(new Vector3(c[i * 3]!, c[i * 3 + 1]!, c[i * 3 + 2]!))
  return box
}

const at = (from: Vector3, dir: Vector3, distance: number) =>
  from.clone().addScaledVector(dir, distance)

/**
 * The line the player fires along: standing IN the room the door swung into,
 * looking back across the doorway at the open leaf. It runs OUTSIDE the
 * doorway prism (|z| > 0.41), so nothing here is masked by passage relief —
 * every hit on this line is a hit the player sees.
 */
const AIM_FROM = new Vector3(3, 1, -0.5)
const AIM_DIR = new Vector3(-1, 0, 0)

/** Every voxel hit for `nodeId` on this line stands inside the node's LIVE
 * bounds, padded by one cell's half-diagonal (cells overhang their source box
 * by up to half a cell). Returns the hit for further assertions. */
function expectHitOnTheLeaf(
  from: Vector3,
  dir: Vector3,
  live: Box3,
  cell: number,
): { nodeId: string; distance: number } | null {
  const hit = raycastVoxelTargets(from, dir, 20)
  if (hit) {
    const point = at(from, dir, hit.distance)
    const pad = cell * 0.87
    expect(live.clone().expandByScalar(pad).containsPoint(point)).toBe(true)
  }
  return hit
}

describe('a door shot MID-SWING does not leave its grid behind', () => {
  test('THE BUG: the settled leaf owns every voxel hit — nothing hangs in the air', () => {
    const leaf = doorLeaf('door_bed1')
    const world = makeWorld([leaf])
    const states = (mounted = mountInteract(world))
    const state = states.get('door_bed1')!
    expect(state.kind).toBe('door-hinged')

    toggleOperable(state)
    step(states, 6) // 0.1 s in: the leaf is mid-arc, colliders ballistic
    // A bullet catches the swinging leaf — the real damage entry point, which
    // voxelizes on first hit and carves.
    const midArc = leaf.collider.worldBox.clone()
    damageTarget(world, 'door_bed1', midArc.getCenter(new Vector3()), 0.18)
    const target = targets().get('door_bed1')!
    expect(target.dormant).toBeFalsy() // an awake grid owns the node now
    expect(target.grid.aliveCount).toBeGreaterThan(0)
    expect(posedTargetIsStale('door_bed1')).toBe(false) // baked AT the live pose
    const baked = gridBox(target.grid)
    const cell = target.grid.cell

    settle(states)

    // SELF-GUARD, pure geometry: the grid was baked across the aim line at a
    // place the leaf has now left by more than a cell. A grid that survives
    // the swing unmoved therefore MUST break the invariant below — without
    // this the assertion could pass vacuously.
    const entry = new Ray(AIM_FROM, AIM_DIR).intersectBox(baked, new Vector3())
    expect(entry).not.toBeNull()
    const live = leaf.collider.worldBox
    expect(entry!.x).toBeGreaterThan(live.max.x + cell)

    // THE INVARIANT: no voxel hit outside the leaf's live bounds.
    expectHitOnTheLeaf(AIM_FROM, AIM_DIR, live, cell)
  })

  test('and the door still WORKS afterwards — it is not sealed for the session', () => {
    const leaf = doorLeaf('door_bed1')
    const world = makeWorld([leaf])
    const states = (mounted = mountInteract(world))
    const state = states.get('door_bed1')!

    toggleOperable(state)
    step(states, 6)
    damageTarget(world, 'door_bed1', leaf.collider.worldBox.getCenter(new Vector3()), 0.18)
    settle(states)

    // The doorway is still open: pass-through for feet, live for bullets, and
    // the prism the handback must not have retired.
    expect(state.open).toBe(true)
    expect(leaf.collider.disabled).toBe(true)
    expect(leaf.collider.ballistic).toBe(true)
    expect(passageCount()).toBe(1)

    // E answers again (the whole point: destruction no longer owns the node),
    // and closing it latches solid and retires the prism.
    toggleOperable(state)
    expect(state.open).toBe(false)
    settle(states)
    expect(leaf.collider.disabled).toBe(false)
    expect(leaf.collider.ballistic).toBe(false)
    expect(passageCount()).toBe(0)
  })

  test('a leaf shot mid-CLOSE latches shut instead of staying walk-through', () => {
    const leaf = doorLeaf('door_bed1')
    const world = makeWorld([leaf])
    const states = (mounted = mountInteract(world))
    const state = states.get('door_bed1')!

    toggleOperable(state) // open
    settle(states)
    toggleOperable(state) // and back
    expect(state.open).toBe(false)
    step(states, 6) // shot while swinging shut
    damageTarget(world, 'door_bed1', leaf.collider.worldBox.getCenter(new Vector3()), 0.18)
    settle(states)

    // The ordering half of the fix: the handback runs BEFORE the re-latch
    // reads isVoxelized, so a door that ends shut is solid, its prism is gone,
    // and it does not stand open-to-the-feet behind a ghost grid.
    expect(targets().has('door_bed1')).toBe(false)
    expect(leaf.collider.disabled).toBe(false)
    expect(leaf.collider.ballistic).toBe(false)
    expect(passageCount()).toBe(0)
  })
})

describe('the handback is BOUNDED — pose staleness, nothing else', () => {
  test('a door shot while CLOSED and left alone keeps its grid and its holes', () => {
    const leaf = doorLeaf('door_bed1')
    const world = makeWorld([leaf])
    const states = (mounted = mountInteract(world))

    damageTarget(world, 'door_bed1', new Vector3(0, 1.2, 0), 0.2)
    const target = targets().get('door_bed1')!
    const alive = target.grid.aliveCount
    expect(alive).toBeLessThan(target.grid.count) // it really is carved
    step(states, 60) // a second of frames, no toggle

    expect(targets().get('door_bed1')).toBe(target)
    expect(target.grid.aliveCount).toBe(alive)
    // The destruction feature still works: the shut voxel leaf stops a shot.
    expect(raycastVoxelTargets(new Vector3(0, 1, 2), new Vector3(0, 0, -1), 20)?.nodeId).toBe(
      'door_bed1',
    )
  })

  test('a leaf voxelized at the pose it STANDS in keeps its grid', () => {
    const leaf = doorLeaf('door_bed1')
    const world = makeWorld([leaf])
    const states = (mounted = mountInteract(world))
    const state = states.get('door_bed1')!

    toggleOperable(state)
    settle(states) // fully open FIRST
    const live = leaf.collider.worldBox.clone()
    damageTarget(world, 'door_bed1', live.getCenter(new Vector3()), 0.18)
    const target = targets().get('door_bed1')!
    expect(target.grid.aliveCount).toBeGreaterThan(0)
    step(states, 60)

    // Correctly posed: never stale, never handed back.
    expect(posedTargetIsStale('door_bed1')).toBe(false)
    expect(targets().get('door_bed1')).toBe(target)
    // ...and the open leaf is still shootable where it stands, on a line the
    // doorway prism does not mask.
    const hit = expectHitOnTheLeaf(AIM_FROM, AIM_DIR, live, target.grid.cell)
    expect(hit?.nodeId).toBe('door_bed1')
  })

  test("one door's swing never retires another door's damage", () => {
    const shot = doorLeaf('door_bath', 4)
    const swung = doorLeaf('door_bed1')
    const world = makeWorld([shot, swung])
    const states = (mounted = mountInteract(world))

    damageTarget(world, 'door_bath', new Vector3(4, 1.2, 0), 0.2)
    const bath = targets().get('door_bath')!
    const alive = bath.grid.aliveCount
    expect(alive).toBeLessThan(bath.grid.count)

    const state = states.get('door_bed1')!
    toggleOperable(state)
    step(states, 6)
    damageTarget(world, 'door_bed1', swung.collider.worldBox.getCenter(new Vector3()), 0.18)
    settle(states)

    expect(targets().has('door_bed1')).toBe(false) // the stale one went back
    expect(targets().get('door_bath')).toBe(bath) // this one is untouched
    expect(bath.grid.aliveCount).toBe(alive)
  })

  test('the handback REFUSES a grid that matches the pose', () => {
    const leaf = doorLeaf('door_bed1')
    const world = makeWorld([leaf])
    mounted = mountInteract(world)

    damageTarget(world, 'door_bed1', new Vector3(0, 1.2, 0), 0.2)
    const target = targets().get('door_bed1')!
    // The direct bound on the operation the settle hook calls: an unmoved leaf
    // is not stale, so nothing is handed back and no damage is healed. A
    // tolerance too tight to tell "unmoved" from float noise, or a hook that
    // fires unconditionally, loses a player's holes on every door they open.
    expect(resyncPosedTarget('door_bed1')).toBe(false)
    expect(targets().get('door_bed1')).toBe(target)
  })

  test('nothing but posed kinds is stamped — a column that MOVES is not handed back', () => {
    const column = buildNode('col_a', 'column', [0.3, 2.6, 0.3], [8, 1.3, 0])
    const world = makeWorld([], [column])

    damageTarget(world, 'col_a', new Vector3(8, 1.3, 0), 0.2)
    const target = targets().get('col_a')!
    expect(target.grid.aliveCount).toBeGreaterThan(0)

    // Move it anyway (a builder undo would; nothing poses a column in play).
    column.root.position.x += 3
    column.root.updateMatrixWorld(true)

    // No stamp, so no staleness question is even asked — the pose check costs
    // non-posed kinds nothing and can never take their grid away. Node
    // lifetime is dropTarget's job, not this lane's.
    expect(posedTargetIsStale('col_a')).toBe(false)
    expect(targets().get('col_a')).toBe(target)
  })
})
