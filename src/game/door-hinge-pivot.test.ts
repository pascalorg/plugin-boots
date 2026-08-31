import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, Group, Matrix4, Mesh, Vector3 } from 'three'
import { clearPassages } from './collision'
import { resetDestruction } from './destruction'
import {
  advanceOperables,
  mountInteract,
  type OperableState,
  toggleOperable,
  unmountInteract,
} from './interact'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

/**
 * A HINGE IS A FIXED LINE — the one property a swinging door has.
 *
 * Every other door suite asks where the leaf ENDED UP. This one asks about the
 * point that must not move at all: the hinge edge. A door is a rotation about
 * that edge, so the edge is world-stationary at every value from closed to
 * open. Anything else is not a door — it is a leaf being translated and turned
 * on separate schedules, which reads as a leaf that tears out of its frame,
 * pokes through the jamb, or floats.
 *
 * Worth its own file because the oracle is independent of the implementation.
 * `interact.tsx` computes the hinge from the leaf's local bounds (the −X, −Y
 * vertical edge, centered on the thin axis) and then keeps a `hingeLocal` +
 * `arm0` + `quaternion0` rig; none of that is read here. The test recomputes
 * the hinge point from the GEOMETRY, in the leaf's own frame, and pushes it
 * through the leaf's live `matrixWorld` at each frame of the swing. If the rig
 * and the geometry ever disagree about where the pivot is, the two answers
 * separate — and the size of the separation is the size of the error, in
 * meters, with no need to know how the rig is spelled.
 *
 * THE TILTED CASE IS THE POINT. `applyPose` builds the swing as a rotation
 * about parent-local +Y and then applies it to the ORIENTATION on one side of
 * `quaternion0` and to the POSITION arm on the other. Those two agree exactly
 * when `quaternion0` commutes with a Y rotation — i.e. when the leaf's rest
 * pose is itself yaw-only, which is every door in a Pascal building today.
 * So the yaw case below is a regression guard, and the tilted case is the one
 * that can actually catch the inconsistency.
 */

// Interact's state map, the destruction ledger and the passage registry are
// module singletons: clean going IN, not just coming out, so a file that ran
// before this one cannot leave a door standing in them.
let mounted: Map<string, OperableState> | null = null

const isolate = () => {
  if (mounted) unmountInteract(mounted)
  mounted = null
  resetDestruction()
  clearPassages()
}

beforeEach(isolate)
afterEach(isolate)

// ── Fixture ────────────────────────────────────────────────────────────────

const LEAF: [number, number, number] = [0.8, 2.1, 0.12]

function colliderFor(mesh: Mesh, root: Group, nodeId: string): ColliderEntry {
  mesh.geometry.computeBoundingBox()
  return {
    mesh,
    bvh: bvhFor(mesh),
    inverse: new Matrix4().copy(mesh.matrixWorld).invert(),
    worldBox: mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld),
    root,
    nodeId,
    nodeType: 'door',
  }
}

/**
 * One hinged leaf, posed however the caller likes. `pose` runs on the root
 * BEFORE the world matrix is baked, so whatever rest orientation it sets is
 * what interact's rig snapshots as `quaternion0`.
 */
function makeWorld(pose: (root: Group) => void): { world: GameWorld; root: Group } {
  const root = new Group()
  root.position.set(0, 1.05, 0)
  pose(root)
  const mesh = new Mesh(new BoxGeometry(LEAF[0], LEAF[1], LEAF[2]))
  root.add(mesh)
  root.updateMatrixWorld(true)

  const collider = colliderFor(mesh, root, 'door-1')
  const world = {
    colliders: [collider],
    walls: new Map(),
    glass: [],
    doors: [
      {
        nodeId: 'door-1',
        root,
        colliderIndices: [0],
        node: { doorType: 'hinged', openingKind: 'door' },
      },
    ],
    operables: [],
    overlayRoots: [],
    buildingAabb: new Box3().union(collider.worldBox),
    spawn: new Vector3(6, 0, 6),
    spawnYaw: 0,
    levelId: null,
  } as unknown as GameWorld
  return { world, root }
}

/**
 * The hinge point in the LEAF's own frame, straight off the geometry — the
 * −X, −Y vertical edge, centered across the thin axis. Independent of the rig.
 */
function hingeInLeafFrame(root: Group): Vector3 {
  const mesh = root.children[0] as Mesh
  mesh.geometry.computeBoundingBox()
  const b = mesh.geometry.boundingBox!
  return new Vector3(b.min.x, b.min.y, (b.min.z + b.max.z) / 2).applyMatrix4(mesh.matrix)
}

/** Where that point currently sits in the world. */
const hingeInWorld = (root: Group, leafFrame: Vector3): Vector3 => {
  root.updateMatrixWorld(true)
  return leafFrame.clone().applyMatrix4(root.matrixWorld)
}

/**
 * Swing the door and return the furthest the hinge point ever strays from
 * where it started, in meters. Samples every frame — a pivot that drifts out
 * and comes back would still be a hinge that moved.
 */
function maxHingeDrift(pose: (root: Group) => void): number {
  const { world, root } = makeWorld(pose)
  mounted = mountInteract(world)
  const state = mounted.get('door-1')
  expect(state).toBeDefined()
  expect(state!.kind).toBe('door-hinged')

  const leafFrame = hingeInLeafFrame(root)
  const at0 = hingeInWorld(root, leafFrame)

  toggleOperable(state!)
  let worst = 0
  // 90 frames at 1/60 comfortably covers the hinged duration, so the sweep
  // includes the settled-open pose as well as every intermediate one.
  for (let i = 0; i < 90; i++) {
    advanceOperables(mounted.values(), 1 / 60)
    worst = Math.max(worst, hingeInWorld(root, leafFrame).distanceTo(at0))
  }
  // And the swing really happened — a door that never moved would pass the
  // drift assertion trivially.
  expect(state!.value).toBeGreaterThan(0.99)
  return worst
}

// ── The invariant ──────────────────────────────────────────────────────────

describe('a hinged door rotates about its hinge edge', () => {
  test('the hinge holds still through the whole swing — leaf at rest, no yaw', () => {
    expect(maxHingeDrift(() => {})).toBeLessThan(1e-6)
  })

  test('...and with the frame yawed, which is every door in a building today', () => {
    expect(maxHingeDrift((root) => root.rotation.set(0, Math.PI / 3, 0))).toBeLessThan(1e-6)
  })

  test('...and with the leaf TILTED, where a Y swing no longer commutes', () => {
    // A rest pose that is not a rotation about Y: the two sides of the pose
    // math stop agreeing, and the pivot is what pays for it.
    expect(maxHingeDrift((root) => root.rotation.set(0, 0, Math.PI / 12))).toBeLessThan(1e-6)
  })

  test('...and tilted on two axes at once', () => {
    expect(maxHingeDrift((root) => root.rotation.set(Math.PI / 16, Math.PI / 5, Math.PI / 10))).toBeLessThan(1e-6)
  })
})
