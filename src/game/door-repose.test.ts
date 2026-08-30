import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  Box3,
  BoxGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three'
import { clearPassages, passageCount } from './collision'
import {
  collideVoxelTargets,
  damageTarget,
  posedTargetIsStale,
  raycastVoxelTargets,
  resetDestruction,
  resyncPosedTarget,
  setShellFlag,
  useDestruction,
  type VoxelTarget,
} from './destruction'
import { advanceOperables, mountInteract, type OperableState, toggleOperable, unmountInteract } from './interact'
import { gridContainsPoint, reposeVoxelGrid, type VoxelGridData } from './voxel'
import { primeSkin, syncPassageHoles } from './voxel-walls'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

/**
 * THE HOLES RIDE THE SWING — a player's bullet holes survive a door moving.
 *
 * A voxel grid is baked in WORLD space, so it is correct only at the pose its
 * source meshes stood in at voxelize time. door-stale-pose.test.ts pins what
 * must never happen when a bake lands MID-SWING (a grid left hanging where the
 * leaf isn't — invisible, bullet-stopping, unrepairable) and is deliberately
 * indifferent to the remedy. This suite pins the remedy that KEEPS THE DAMAGE:
 * the grid's frame is rigidly re-posed onto the leaf, so every cell goes on
 * naming the same material point of the door and the holes travel with it.
 *
 * Why that is expressible at all: a grid's pose lives entirely in `q` (the
 * world→grid rotation) and `origin`. `coords`, `index`, `alive` and every
 * damage key are INDEX space and mean nothing in the world by themselves — so
 * one world rigid motion pushed into those two fields moves the cells, the
 * removed set and the holes together, by construction rather than by
 * bookkeeping. `centers` is a world-space cache and is re-derived from the new
 * frame.
 *
 * THE ORACLE, and the reason these tests are worth trusting: nothing below asks
 * the re-pose where it put anything. The expected positions are re-derived
 * independently, two ways —
 *
 *  1. from the LEAF: a cell's position in the leaf's own local frame
 *     (`matrixWorld⁻¹ · centre`) must be the SAME before and after the swing.
 *     That is what "the holes are in the same places on the leaf" means, stated
 *     without reference to any transform this code computes.
 *  2. from the MOTION: the leaf's before/after world matrices give a rigid M,
 *     and every new centre must equal `M · oldCentre`.
 *
 * And the four lanes are checked SEPARATELY against those positions — drawn
 * cubes (voxel-walls' instance matrices), bullets/bot-LOS (raycastVoxelTargets),
 * bodies (collideVoxelTargets) and framing members — because a re-pose that
 * moved some of them and not others is the render-disagrees-with-physics bug
 * this lane has spent three waves removing. A ghost that blocks shots where
 * nothing is drawn is strictly worse than healing the holes, so the bound is as
 * load-bearing as the fix: a motion that is NOT one rigid turn (a sash sliding
 * inside a still frame, a tilt out of world Y) must fall back to the handback.
 */

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

const targets = () => useDestruction.getState().targets

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Built = { root: Group; meshes: Mesh[]; colliders: ColliderEntry[] }

function colliderFor(mesh: Mesh, root: Group, nodeId: string, nodeType: string): ColliderEntry {
  mesh.geometry.computeBoundingBox()
  return {
    mesh,
    bvh: bvhFor(mesh),
    inverse: new Matrix4().copy(mesh.matrixWorld).invert(),
    worldBox: mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld),
    root,
    nodeId,
    nodeType,
  }
}

/** A node whose parts are box meshes at local offsets under one Group root —
 * the shape interact's hinged rig expects (hinge = the leaf's local −X edge, so
 * opening really carries the leaf out of the doorway along −Z). */
function buildNode(
  nodeId: string,
  nodeType: string,
  center: [number, number, number],
  parts: { size: [number, number, number]; at: [number, number, number] }[],
): Built {
  const root = new Group()
  root.position.set(center[0], center[1], center[2])
  const meshes = parts.map((p) => {
    const mesh = new Mesh(new BoxGeometry(p.size[0], p.size[1], p.size[2]))
    mesh.position.set(p.at[0], p.at[1], p.at[2])
    root.add(mesh)
    return mesh
  })
  root.updateMatrixWorld(true)
  return { root, meshes, colliders: meshes.map((m) => colliderFor(m, root, nodeId, nodeType)) }
}

/** A 0.8 m leaf in a doorway, like every interior door in the QA house. */
const doorLeaf = (nodeId: string, x = 0) =>
  buildNode(nodeId, 'door', [x, 1.05, 0], [{ size: [0.8, 2.1, 0.12], at: [0, 0, 0] }])

const HINGED = { doorType: 'hinged', openingKind: 'door' }

function makeWorld(nodes: Built[]): GameWorld {
  const colliders = nodes.flatMap((n) => n.colliders)
  const buildingAabb = new Box3()
  for (const c of colliders) buildingAabb.union(c.worldBox)
  let next = 0
  return {
    colliders,
    walls: new Map(),
    glass: [],
    doors: nodes.map((n) => ({
      nodeId: n.colliders[0]!.nodeId,
      root: n.root,
      colliderIndices: n.colliders.map(() => next++),
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

const step = (states: Map<string, OperableState>, frames: number, dt = 1 / 60) => {
  for (let i = 0; i < frames; i++) advanceOperables(states.values(), dt)
}
const settle = (states: Map<string, OperableState>) => step(states, 30, 1 / 30)

// ---------------------------------------------------------------------------
// Independent re-derivation (the oracle)
// ---------------------------------------------------------------------------

const centreOf = (grid: VoxelGridData, i: number) =>
  new Vector3(grid.centers[i * 3]!, grid.centers[i * 3 + 1]!, grid.centers[i * 3 + 2]!)

/** Every live cell's centre expressed in the LEAF's own local frame. This is
 * the material-point statement: it must not change when the leaf moves, and it
 * is computed from the mesh's `matrixWorld` — never from the re-pose. */
function leafLocalCentres(grid: VoxelGridData, mesh: Mesh): Map<number, Vector3> {
  const inverse = new Matrix4().copy(mesh.matrixWorld).invert()
  const out = new Map<number, Vector3>()
  for (let i = 0; i < grid.count; i++) {
    if (!grid.alive[i]) continue
    out.set(i, centreOf(grid, i).applyMatrix4(inverse))
  }
  return out
}

/** Snapshot enough of a grid to prove afterwards what moved and what didn't. */
function snapshot(grid: VoxelGridData) {
  return {
    centers: Float32Array.from(grid.centers),
    centersBuffer: grid.centers,
    coords: grid.coords,
    index: grid.index,
    alive: Uint8Array.from(grid.alive),
    aliveCount: grid.aliveCount,
    count: grid.count,
    cell: grid.cell,
    cells: [grid.cellX, grid.cellY, grid.cellZ] as const,
    q: { ...grid.q },
    origin: { ...grid.origin },
  }
}

/** INDEX SPACE IS SACRED. A re-pose that renumbered cells, re-derived `alive`,
 * or resized the lattice would move the holes relative to the door even if
 * every centre landed somewhere plausible — and would break the multiplayer
 * damage keys (shared-damage.ts keys by lattice index), silently. */
function expectIndexSpaceUntouched(grid: VoxelGridData, before: ReturnType<typeof snapshot>): void {
  expect(grid.count).toBe(before.count)
  expect(grid.aliveCount).toBe(before.aliveCount)
  expect(grid.coords).toBe(before.coords) // same buffer, not merely equal
  expect(grid.index).toBe(before.index)
  expect(Array.from(grid.alive)).toEqual(Array.from(before.alive))
  expect(grid.cell).toBe(before.cell)
  expect([grid.cellX, grid.cellY, grid.cellZ]).toEqual([...before.cells])
}

// ---------------------------------------------------------------------------
// The render lane, read the way voxel-walls writes it
// ---------------------------------------------------------------------------

function meshFor(target: VoxelTarget): InstancedMesh {
  return new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial(), target.grid.count)
}

const _m = new Matrix4()

/** Is instance `i` on screen? Hidden cells carry a zero-scale matrix — read the
 * basis columns straight out of `elements`, because three's `Matrix4.decompose`
 * guards a zero determinant by reporting scale (1, 1, 1). */
function drawn(mesh: InstancedMesh, i: number): boolean {
  mesh.getMatrixAt(i, _m)
  const e = _m.elements
  return (
    Math.hypot(e[0]!, e[1]!, e[2]!) > 1e-9 &&
    Math.hypot(e[4]!, e[5]!, e[6]!) > 1e-9 &&
    Math.hypot(e[8]!, e[9]!, e[10]!) > 1e-9
  )
}

function drawnAt(mesh: InstancedMesh, i: number): Vector3 {
  mesh.getMatrixAt(i, _m)
  const e = _m.elements
  return new Vector3(e[12]!, e[13]!, e[14]!)
}

/** THE RENDER LANE AGREES WITH THE GRID: every drawn cube stands exactly at
 * its cell's centre. This is the pair that produces a ghost when it drifts —
 * a bullet stopping in mid-air short of a visible cube is precisely the drawn
 * position and the queried position disagreeing. */
function expectDrawnOnCentres(target: VoxelTarget, prime: boolean): number {
  const mesh = meshFor(target)
  if (prime) primeSkin(mesh, target)
  else syncPassageHoles(mesh, target)
  const grid = target.grid
  let visible = 0
  for (let i = 0; i < grid.count; i++) {
    if (!grid.alive[i]) {
      expect(drawn(mesh, i)).toBe(false) // a carved cell never draws
      continue
    }
    if (!drawn(mesh, i)) continue // hidden by an open doorway prism
    visible++
    expect(drawnAt(mesh, i).distanceTo(centreOf(grid, i))).toBeLessThan(1e-4)
  }
  return visible
}

// ---------------------------------------------------------------------------
// 1. reposeVoxelGrid — the algebra, on its own
// ---------------------------------------------------------------------------

describe('reposeVoxelGrid moves the FRAME and nothing else', () => {
  /** A shot door, awake and carved, without any interact machinery. */
  function carvedDoor(): { target: VoxelTarget; mesh: Mesh; world: GameWorld } {
    const leaf = doorLeaf('door_a')
    const world = makeWorld([leaf])
    damageTarget(world, 'door_a', new Vector3(0, 1.2, 0), 0.22)
    const target = targets().get('door_a')!
    expect(target.grid.aliveCount).toBeGreaterThan(0)
    expect(target.grid.aliveCount).toBeLessThan(target.grid.count) // really carved
    return { target, mesh: leaf.meshes[0]!, world }
  }

  test('a pure translation carries every cell, and every LANE follows', () => {
    const { target } = carvedDoor()
    const grid = target.grid
    const before = snapshot(grid)
    const shift = new Vector3(3.5, 0, -2.25)
    const motion = new Matrix4().makeTranslation(shift.x, shift.y, shift.z)

    reposeVoxelGrid(grid, motion)

    expectIndexSpaceUntouched(grid, before)
    // Independently re-derived: old centre + shift, cell by cell.
    for (let i = 0; i < grid.count; i++) {
      const expected = new Vector3(
        before.centers[i * 3]! + shift.x,
        before.centers[i * 3 + 1]! + shift.y,
        before.centers[i * 3 + 2]! + shift.z,
      )
      expect(centreOf(grid, i).distanceTo(expected)).toBeLessThan(1e-3)
    }
    // A translation cannot change the basis — only the origin.
    expect(grid.q).toEqual(before.q)
    // The QUERY lane agrees with the cache: gridContainsPoint walks the frame
    // (q, origin, coords), never `centers`, so this is the pair that must not
    // drift. Old locations are empty; new ones are solid.
    for (let i = 0; i < grid.count; i++) {
      if (!grid.alive[i]) continue
      const now = centreOf(grid, i)
      expect(gridContainsPoint(grid, now.x, now.y, now.z)).toBe(true)
      expect(
        gridContainsPoint(
          grid,
          before.centers[i * 3]!,
          before.centers[i * 3 + 1]!,
          before.centers[i * 3 + 2]!,
        ),
      ).toBe(false)
    }
  })

  test('a yaw about an arbitrary pivot equals M · oldCentres, and stays yaw-only', () => {
    const { target } = carvedDoor()
    const grid = target.grid
    const before = snapshot(grid)
    // Hinge-like: rotate 100° about world Y through the leaf's −X edge.
    const pivot = new Vector3(-0.4, 0, 0)
    const angle = (100 * Math.PI) / 180
    const motion = new Matrix4()
      .makeTranslation(pivot.x, pivot.y, pivot.z)
      .multiply(new Matrix4().makeRotationY(angle))
      .multiply(new Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z))

    reposeVoxelGrid(grid, motion)

    expectIndexSpaceUntouched(grid, before)
    for (let i = 0; i < grid.count; i++) {
      const expected = new Vector3(
        before.centers[i * 3]!,
        before.centers[i * 3 + 1]!,
        before.centers[i * 3 + 2]!,
      ).applyMatrix4(motion)
      expect(centreOf(grid, i).distanceTo(expected)).toBeLessThan(1e-3)
    }
    // Grid Y must still BE world Y: the legacy yaw fast path stays live, and
    // every reader that treats row 0 as the ground row (findUnsupportedIslands)
    // or origin.y as a world height keeps its meaning.
    expect(grid.q.x).toBeCloseTo(0, 10)
    expect(grid.q.z).toBeCloseTo(0, 10)
    // The legacy `yaw` scalar needs no separate assertion: cellWorldCenter
    // rebuilt `centers` THROUGH the yaw-only branch, so the per-cell agreement
    // above already fails if the scalar and the quaternion disagree.
    for (let i = 0; i < grid.count; i++) {
      if (!grid.alive[i]) continue
      const now = centreOf(grid, i)
      expect(gridContainsPoint(grid, now.x, now.y, now.z)).toBe(true)
    }
  })

  test('re-posing by M then M⁻¹ returns the grid to where it started', () => {
    const { target } = carvedDoor()
    const grid = target.grid
    const before = snapshot(grid)
    const motion = new Matrix4().compose(
      new Vector3(1.2, 0, 0.7),
      new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.83),
      new Vector3(1, 1, 1),
    )

    reposeVoxelGrid(grid, motion)
    // Mid-way the grid really has moved — otherwise the round trip is vacuous.
    expect(centreOf(grid, 0).distanceTo(new Vector3(before.centers[0]!, before.centers[1]!, before.centers[2]!))).toBeGreaterThan(0.5)
    reposeVoxelGrid(grid, motion.clone().invert())

    for (let i = 0; i < grid.count * 3; i++) {
      expect(Math.abs(grid.centers[i]! - before.centers[i]!)).toBeLessThan(1e-3)
    }
    expect(grid.origin.x).toBeCloseTo(before.origin.x, 6)
    expect(grid.origin.y).toBeCloseTo(before.origin.y, 6)
    expect(grid.origin.z).toBeCloseTo(before.origin.z, 6)
  })

  test('the centers buffer is REPLACED, not mutated', () => {
    const { target } = carvedDoor()
    const grid = target.grid
    const original = grid.centers
    reposeVoxelGrid(grid, new Matrix4().makeTranslation(1, 0, 0))
    // voxel-walls caches a grid's bounding sphere in a WeakMap keyed on this
    // very buffer, on the documented invariant that cell centres never move.
    // A fresh allocation is what keeps that invariant true — an in-place
    // rewrite would leave every replica culling against a stale sphere.
    expect(grid.centers).not.toBe(original)
    expect(grid.centers.length).toBe(grid.count * 3)
  })
})

// ---------------------------------------------------------------------------
// 2. THE HEADLINE: shoot a door, swing it, the holes are in the same places
// ---------------------------------------------------------------------------

describe('a shot door keeps its holes through a swing', () => {
  test('THE ACCEPTANCE BAR: every hole is in the same place ON THE LEAF afterwards', () => {
    const leaf = doorLeaf('door_bed1')
    const world = makeWorld([leaf])
    const states = (mounted = mountInteract(world))
    const state = states.get('door_bed1')!
    const mesh = leaf.meshes[0]!

    toggleOperable(state)
    step(states, 6) // 0.1 s in: mid-arc, colliders ballistic — a bullet lands
    damageTarget(world, 'door_bed1', leaf.colliders[0]!.worldBox.getCenter(new Vector3()), 0.18)
    const target = targets().get('door_bed1')!
    const grid = target.grid
    const before = snapshot(grid)
    const holes = before.count - before.aliveCount
    expect(holes).toBeGreaterThan(0)
    // Where the holes are ON THE DOOR, in the leaf's own frame, before it moves.
    const localBefore = leafLocalCentres(grid, mesh)
    const poseBefore = mesh.matrixWorld.clone()

    settle(states)

    // The re-pose was taken — destruction still owns the node, so the damage
    // was not healed by a handback. (If this flips, the suite below is not
    // testing what it says; door-stale-pose.test.ts covers the fallback.)
    expect(targets().get('door_bed1')).toBe(target)
    expect(posedTargetIsStale('door_bed1')).toBe(false) // re-stamped at the new pose
    expect(target.poseRevision).toBe(1)
    expectIndexSpaceUntouched(grid, before)
    expect(before.count - grid.aliveCount).toBe(holes) // the same holes, still

    // SELF-GUARD: the leaf really swung, and it carried the cells more than two
    // cell-widths — so a grid that survived the swing UNMOVED would fail both
    // oracles below by a wide margin. Neither can pass vacuously.
    expect(mesh.matrixWorld.elements).not.toEqual(poseBefore.elements)
    let maxTravel = 0
    for (let i = 0; i < grid.count; i++) {
      const wasAt = new Vector3(
        before.centers[i * 3]!,
        before.centers[i * 3 + 1]!,
        before.centers[i * 3 + 2]!,
      )
      maxTravel = Math.max(maxTravel, centreOf(grid, i).distanceTo(wasAt))
    }
    expect(maxTravel).toBeGreaterThan(grid.cell * 2)

    // ORACLE 1 — the material-point claim, re-derived from the leaf's own live
    // matrix: each surviving cell sits at the same spot on the door as before.
    const localAfter = leafLocalCentres(grid, mesh)
    expect(localAfter.size).toBe(localBefore.size)
    for (const [i, local] of localBefore) {
      const now = localAfter.get(i)
      expect(now).toBeDefined()
      expect(now!.distanceTo(local)).toBeLessThan(1e-3)
    }

    // ORACLE 2 — the rigid-motion claim, re-derived from the leaf's before and
    // after world matrices: M = after · before⁻¹, and every centre followed it.
    const motion = mesh.matrixWorld.clone().multiply(poseBefore.clone().invert())
    for (let i = 0; i < grid.count; i++) {
      const expected = new Vector3(
        before.centers[i * 3]!,
        before.centers[i * 3 + 1]!,
        before.centers[i * 3 + 2]!,
      ).applyMatrix4(motion)
      expect(centreOf(grid, i).distanceTo(expected)).toBeLessThan(1e-3)
    }
  })

  test('ALL FOUR LANES agree on where the re-posed door stands', () => {
    const leaf = doorLeaf('door_bed1')
    const world = makeWorld([leaf])
    const states = (mounted = mountInteract(world))
    const state = states.get('door_bed1')!

    toggleOperable(state)
    step(states, 6)
    damageTarget(world, 'door_bed1', leaf.colliders[0]!.worldBox.getCenter(new Vector3()), 0.18)
    const target = targets().get('door_bed1')!
    const stale = snapshot(target.grid)
    settle(states)
    expect(targets().get('door_bed1')).toBe(target)
    const grid = target.grid
    const live = leaf.colliders[0]!.worldBox // interact re-snapshotted it on settle
    const pad = grid.cell * 0.87

    // LANE 1 — DRAWN CUBES. Every visible instance stands on its cell's centre,
    // through both writers (the full prime and the passage sweep, which are the
    // two compositions voxel-walls has and must never disagree).
    expect(expectDrawnOnCentres(target, true)).toBeGreaterThan(0)
    expect(expectDrawnOnCentres(target, false)).toBeGreaterThan(0)

    // ...and the whole drawn set is on the LEAF, not where it used to be.
    const livePadded = live.clone().expandByScalar(pad)
    for (let i = 0; i < grid.count; i++) {
      if (!grid.alive[i]) continue
      expect(livePadded.containsPoint(centreOf(grid, i))).toBe(true)
    }

    // LANE 2 — BULLETS AND BOT LINE-OF-SIGHT. Fire from inside the room the
    // leaf swung into, on a line OUTSIDE the doorway prism (|z| > 0.41) so
    // nothing here is masked by passage relief.
    const from = new Vector3(3, 1, -0.5)
    const dir = new Vector3(-1, 0, 0)
    const hit = raycastVoxelTargets(from, dir, 20)
    expect(hit?.nodeId).toBe('door_bed1')
    const point = from.clone().addScaledVector(dir, hit!.distance)
    expect(livePadded.containsPoint(point)).toBe(true)

    // ...and NOT at the stale pose. The old grid stood across the doorway; a
    // ray down the doorway must now pass clean through where it used to be.
    const staleBox = new Box3()
    for (let i = 0; i < stale.count; i++) {
      if (!stale.alive[i]) continue
      staleBox.expandByPoint(
        new Vector3(stale.centers[i * 3]!, stale.centers[i * 3 + 1]!, stale.centers[i * 3 + 2]!),
      )
    }
    expect(livePadded.containsBox(staleBox)).toBe(false) // the poses really differ

    // LANE 3 — BODIES. A capsule walked into the leaf's new position is pushed
    // out; the same capsule at the stale position is not touched.
    const atLeaf = live.getCenter(new Vector3())
    atLeaf.y = 0.9
    const pos = atLeaf.clone()
    const vel = new Vector3(0, 0, 0)
    collideVoxelTargets(pos, vel, 0.34, 1.7)
    expect(pos.distanceTo(atLeaf)).toBeGreaterThan(1e-4)

    // LANE 4 — FRAMING MEMBERS. Vacuous for a door BY CONSTRUCTION, and that
    // is the precondition the re-pose leans on rather than an untested gap: a
    // door bakes as a plain volume, so there is no second world-space payload
    // (segments/sheets/shell) that could stay behind when the frame moves. If
    // this ever fails, the re-pose must be re-derived for those layers first.
    expect(target.kind).toBe('volume')
    expect(target.segments.length).toBe(0)
    expect(target.sheets.length).toBe(0)
    expect(target.shell).toBeUndefined()
    expect(target.item).toBeFalsy()
  })

  test('a leaf shot mid-CLOSE keeps its holes AND shuts properly', () => {
    const leaf = doorLeaf('door_bed1')
    const world = makeWorld([leaf])
    const states = (mounted = mountInteract(world))
    const state = states.get('door_bed1')!
    const mesh = leaf.meshes[0]!

    toggleOperable(state)
    settle(states)
    toggleOperable(state) // and back
    step(states, 6)
    damageTarget(world, 'door_bed1', leaf.colliders[0]!.worldBox.getCenter(new Vector3()), 0.18)
    const target = targets().get('door_bed1')!
    const before = snapshot(target.grid)
    const localBefore = leafLocalCentres(target.grid, mesh)
    settle(states)

    // Still owned, still carved, still in the same places on the leaf.
    expect(targets().get('door_bed1')).toBe(target)
    expect(target.grid.aliveCount).toBe(before.aliveCount)
    const localAfter = leafLocalCentres(target.grid, mesh)
    for (const [i, local] of localBefore) {
      expect(localAfter.get(i)!.distanceTo(local)).toBeLessThan(1e-3)
    }

    // THE INVERSE GHOST this had to avoid: with the grid kept, the settle's
    // re-latch no longer runs (it is gated on the node being un-voxelized), so
    // the passage prism would outlive the leaf — leaving a SHUT door that feet
    // walk through, that draws with a hole in it, and that still stops the
    // bullets aimed at the cells the prism happens to miss.
    expect(state.open).toBe(false)
    expect(passageCount()).toBe(0)
    // The host must stay OUT while the grid collides, or the shut door is solid
    // exactly where the player shot holes in it.
    expect(leaf.colliders[0]!.disabled).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. THE BOUND: where a rigid re-pose is not sound, the drop still wins
// ---------------------------------------------------------------------------

describe('the re-pose REFUSES anything that is not one rigid turn', () => {
  test('a node posed through NAMED MOVING PARTS is handed back, not re-posed', () => {
    // A sash sliding inside a still frame: two meshes, one moves. There is no
    // single frame that describes the result, so re-posing by either mesh's
    // motion would drag the other's cells somewhere they never went.
    const node = buildNode('win_a', 'window', [0, 1.2, 0], [
      { size: [1.2, 1.4, 0.06], at: [0, 0, 0] }, // frame
      { size: [1.1, 0.6, 0.05], at: [0, -0.35, 0.03] }, // sash
    ])
    const world = makeWorld([node])
    mounted = mountInteract(world)
    damageTarget(world, 'win_a', new Vector3(0, 1.2, 0), 0.2)
    const target = targets().get('win_a')!
    const before = snapshot(target.grid)
    expect(target.grid.aliveCount).toBeGreaterThan(0)

    // Slide the sash only.
    node.meshes[1]!.position.x += 0.5
    node.root.updateMatrixWorld(true)
    expect(posedTargetIsStale('win_a')).toBe(true)

    // Handed BACK (the fallback), and the grid was not moved on the way out:
    // a partial re-pose followed by a drop would still be a drop, but a
    // partial re-pose followed by a KEEP is the ghost.
    expect(resyncPosedTarget('win_a')).toBe(true)
    expect(targets().has('win_a')).toBe(false)
    expect(target.grid.centers).toBe(before.centersBuffer)
    expect(target.poseRevision).toBeUndefined()
  })

  test('a motion that tips OUT of world Y is handed back', () => {
    const node = doorLeaf('door_a')
    const world = makeWorld([node])
    mounted = mountInteract(world)
    damageTarget(world, 'door_a', new Vector3(0, 1.2, 0), 0.2)
    const target = targets().get('door_a')!
    const before = snapshot(target.grid)

    // Tip it over: rigid, one motion, but grid Y would stop being world Y —
    // the yaw fast path and every ground-row reader would be reading a lie.
    node.root.rotateX(0.4)
    node.root.updateMatrixWorld(true)
    expect(posedTargetIsStale('door_a')).toBe(true)

    expect(resyncPosedTarget('door_a')).toBe(true)
    expect(targets().has('door_a')).toBe(false)
    expect(target.grid.centers).toBe(before.centersBuffer)
  })

  test('a SCALED motion is handed back — a cell size is not negotiable', () => {
    const node = doorLeaf('door_a')
    const world = makeWorld([node])
    mounted = mountInteract(world)
    damageTarget(world, 'door_a', new Vector3(0, 1.2, 0), 0.2)
    const target = targets().get('door_a')!
    const before = snapshot(target.grid)

    node.root.scale.set(1.4, 1, 1)
    node.root.updateMatrixWorld(true)
    expect(posedTargetIsStale('door_a')).toBe(true)

    expect(resyncPosedTarget('door_a')).toBe(true)
    expect(targets().has('door_a')).toBe(false)
    expect(target.grid.centers).toBe(before.centersBuffer)
  })

  test('an UNMOVED leaf is neither re-posed nor handed back', () => {
    const node = doorLeaf('door_a')
    const world = makeWorld([node])
    mounted = mountInteract(world)
    damageTarget(world, 'door_a', new Vector3(0, 1.2, 0), 0.2)
    const target = targets().get('door_a')!
    const before = snapshot(target.grid)

    // The every-frame case: a tolerance too tight to tell "unmoved" from float
    // noise, or a hook that fires unconditionally, would re-pose the grid by an
    // identity-ish motion on every frame — reallocating `centers`, bumping
    // poseRevision, and re-sweeping every replica's matrices forever.
    expect(resyncPosedTarget('door_a')).toBe(false)
    expect(targets().get('door_a')).toBe(target)
    expect(target.grid.centers).toBe(before.centersBuffer)
    expect(target.poseRevision).toBeUndefined()
  })

  test('a DORMANT prebuild is retired, never re-posed — the host still owns it', () => {
    const node = doorLeaf('door_a')
    const world = makeWorld([node])
    mounted = mountInteract(world)
    damageTarget(world, 'door_a', new Vector3(0, 1.2, 0), 0.2)
    const target = targets().get('door_a')!
    target.dormant = true // as prevoxelize leaves it

    node.root.position.x += 1
    node.root.updateMatrixWorld(true)

    // While dormant the HOST renders and collides; a re-posed sleeping grid
    // would be invisible work, and the wake path rebuilds from the live pose.
    expect(resyncPosedTarget('door_a')).toBe(true)
    expect(targets().has('door_a')).toBe(false)
    expect(target.poseRevision).toBeUndefined()
  })
})
