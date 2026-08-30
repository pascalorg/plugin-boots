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
import {
  clearPassages,
  passageHidesCell,
  passageHidesSegment,
  registerPassage,
  unregisterPassage,
} from './collision'
import {
  ensureVoxelTarget,
  resetDestruction,
  type SegmentMember,
  setShellFlag,
} from './destruction'
import { buildPassageBox } from './interact'
import { membersBoundingSphere, syncMemberLayer } from './voxel-walls'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

/**
 * AN OPEN DOOR LOOKS OPEN — the FRAMING half.
 *
 * door-passage-render.test.ts pins the drywall skin, door-passage-voxels the
 * walking. This one pins the layer the skin fix EXPOSED: framing lives in the
 * cavity between the two skins, invisible while they are intact, so the moment
 * the crossing wall's cubes stopped drawing in the aperture (98a8fe3) the studs
 * and plates behind them became the thing standing in the open doorway. The
 * browser census measured 8-16 per doorway on the flat QA house and 20 across 11
 * doors on the sculpted lot.
 *
 * TWO fixtures, because this invariant has two failure directions and a test that
 * only had one would be worthless:
 *
 *   A — a NEIGHBOUR's wall running through the doorway. Its sticks must vanish.
 *       Neuter the gate and this fixture fails.
 *   B — the door's OWN host wall, which frames that very aperture. Not one of its
 *       members may vanish: the jamb studs, the cripples over the head, the
 *       header and the clipped bottom plates all sit as little as 0.026 m clear
 *       of the prism (OPENING_PAD 0.02 plus the segment's own 0.006 end shrink).
 *       Relieve outward by even 0.03 m and this fixture fails — which is the
 *       whole reason the predicate carries no pad, not even the cell lane's
 *       PASSAGE_EDGE_EPS.
 *
 * Members are classified by PURE GEOMETRY re-derived here from the documented
 * rotation convention and sampled densely along the centre line — never by asking
 * `passageHidesSegment` what it would relieve, which would assert only that the
 * writer calls the predicate. On top of that, fixture B asserts its framing
 * members by NAME and coordinate, so the bound is pinned by the domain and not
 * only by a model the test shares with the code.
 */

// Conforming-shell prebuilds are DORMANT — the case that never had the bug.
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

/**
 * FIXTURE A — the bug. A 0.8 m door leaf at the origin opening across X, and a
 * NEIGHBOUR wall running along Z straight through that opening, long enough that
 * its framing includes both sticks inside the aperture and sticks well clear of
 * it. The `walls` entry is not decoration: a collider-only wall generates zero
 * segments, so without it this fixture would pass while the bug stood.
 */
function makeCrossingWorld(): GameWorld {
  const leaf = boxCollider('door_front', 'door', [0.8, 2.1, 0.12], [0, 1.05, 0])
  const cross = boxCollider('wall_cross', 'wall', [0.12, 2.7, 3.6], [0, 1.35, -1.2])
  const floor = boxCollider('slab_floor', 'slab', [8, 0.3, 8], [0, -0.15, 0])
  const colliders = [leaf, cross, floor]
  const buildingAabb = new Box3()
  for (const c of colliders) buildingAabb.union(c.worldBox)
  return {
    colliders,
    walls: new Map([
      [
        'wall_cross',
        {
          node: {
            id: 'wall_cross',
            start: [0, -3] as [number, number],
            end: [0, 0.6] as [number, number],
            height: 2.7,
            thickness: 0.12,
          },
          root: cross.root,
          meshes: [cross.mesh],
        },
      ],
    ]),
    glass: [],
    doors: [],
    overlayRoots: [],
    buildingAabb,
    spawn: new Vector3(0, 0, 6),
    spawnYaw: 0,
    levelId: null,
  }
}

/**
 * FIXTURE B — the bound. The 4 m × 2.7 m wall from stud-openings.test.ts with its
 * OWN hosted 0.9 m door at u 1.5, so the framing under test is the framing of the
 * aperture being opened. Every member here is one the player is meant to see when
 * they look through that door.
 */
function makeHostedWorld(): GameWorld {
  const wall = boxCollider('wall-1', 'wall', [4, 2.7, 0.12], [2, 1.35, 0])
  const leaf = boxCollider('door-1', 'door', [0.9, 2.1, 0.12], [1.5, 1.05, 0])
  return {
    colliders: [wall, leaf],
    walls: new Map([
      [
        'wall-1',
        {
          node: {
            id: 'wall-1',
            start: [0, 0] as [number, number],
            end: [4, 0] as [number, number],
            height: 2.7,
            thickness: 0.12,
          },
          root: wall.root,
          meshes: [wall.mesh],
        },
      ],
    ]),
    glass: [],
    doors: [
      {
        nodeId: 'door-1',
        root: new Group(),
        colliderIndices: [1],
        node: { parentId: 'wall-1', position: [1.5, 1.05, 0], width: 0.9, height: 2.1 },
      },
    ],
    overlayRoots: [],
    buildingAabb: wall.worldBox.clone(),
    spawn: new Vector3(6, 0, 6),
    spawnYaw: 0,
    levelId: null,
  }
}

/** Open the door the way interact.tsx does. Returns the registered prism. */
function openDoor(world: GameWorld, leafId: string): Box3 {
  const leaf = world.colliders.find((c) => c.nodeId === leafId)!
  const prism = buildPassageBox([leaf])!
  leaf.disabled = true
  registerPassage(prism)
  return prism
}

/** A member layer's mesh, with the bounding sphere the passage early-out reads
 * set BEFORE the first write — exactly the order the component mounts in. */
function meshFor(members: SegmentMember[]): InstancedMesh {
  const mesh = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial(), members.length)
  mesh.boundingSphere = membersBoundingSphere(members, mesh.boundingSphere ?? undefined)
  return mesh
}

const maxHpOf = (members: SegmentMember[]) => {
  let max = 1
  for (const m of members) if ((m.hp ?? 1) > max) max = m.hp ?? 1
  return max
}

const _m = new Matrix4()

/**
 * Is instance `i` on screen? Hidden members carry the zero matrix — the ONE
 * mechanism this layer has for "absent". Basis columns read straight out of
 * `elements`: three r0.185's `Matrix4.decompose` guards a zero determinant by
 * handing back scale (1, 1, 1), so decomposing a hidden instance reports it drawn.
 */
function drawn(mesh: InstancedMesh, i: number): boolean {
  mesh.getMatrixAt(i, _m)
  const e = _m.elements
  return (
    Math.hypot(e[0]!, e[1]!, e[2]!) > 1e-9 &&
    Math.hypot(e[4]!, e[5]!, e[6]!) > 1e-9 &&
    Math.hypot(e[8]!, e[9]!, e[10]!) > 1e-9
  )
}

const UP = new Vector3(0, 1, 0)
const Z_AXIS = new Vector3(0, 0, 1)

/**
 * The member's centre line, re-derived from the DOCUMENTED convention
 * (Ry(−yaw)·Rz(pitch), roof-framing.ts) rather than imported from the writer, so
 * the suite fails if the two ever disagree about which way a stick points — a
 * disagreement that would hide the wrong sticks with no other symptom.
 */
function endpoints(m: SegmentMember): [Vector3, Vector3] {
  const q = new Quaternion().setFromAxisAngle(UP, -m.yaw)
  const pitch = (m as { pitch?: number }).pitch
  if (pitch) q.multiply(new Quaternion().setFromAxisAngle(Z_AXIS, pitch))
  const [sx, sy, sz] = m.size
  const half = new Vector3(0, 0, 0)
  if (sx >= sy && sx >= sz) half.x = sx / 2
  else if (sy >= sz) half.y = sy / 2
  else half.z = sz / 2
  half.applyQuaternion(q)
  const c = new Vector3(m.center[0], m.center[1], m.center[2])
  return [c.clone().sub(half), c.clone().add(half)]
}

/** Sampling pitch: 512 steps over a ≤1.2 m stick is ~2 mm, an order finer than
 * the 30 mm edge band, so a line that only clips a prism corner is still caught. */
const SAMPLES = 512
const EDGE = 0.03

/**
 * Ground truth, by dense sampling of the centre line against the prism grown and
 * shrunk by a hair. `edge` is the genuinely arbitrary band — a stick grazing a
 * face — and is asserted in neither direction.
 */
function classify(m: SegmentMember, prism: Box3): 'crosses' | 'clear' | 'edge' {
  const [a, b] = endpoints(m)
  const inner = prism.clone().expandByScalar(-EDGE)
  const outer = prism.clone().expandByScalar(EDGE)
  const p = new Vector3()
  let hitOuter = false
  for (let i = 0; i <= SAMPLES; i++) {
    p.lerpVectors(a, b, i / SAMPLES)
    if (inner.containsPoint(p)) return 'crosses'
    if (outer.containsPoint(p)) hitOuter = true
  }
  return hitOuter ? 'edge' : 'clear'
}

interface Split {
  crosses: number[]
  clear: number[]
  edge: number[]
}

function split(members: SegmentMember[], prism: Box3): Split {
  const out: Split = { crosses: [], clear: [], edge: [] }
  for (let i = 0; i < members.length; i++) out[classify(members[i]!, prism)].push(i)
  return out
}

/** Everything about a member the doorway must not touch. Frozen as text so a
 * single changed number in any field fails the comparison. */
const shapeOf = (members: SegmentMember[]) =>
  JSON.stringify(
    members.map((m) => [
      m.id,
      m.center,
      m.size,
      m.yaw,
      m.hp ?? null,
      m.broken ?? null,
      (m as { torn?: boolean }).torn ?? null,
    ]),
  )

describe('an open doorway has no FRAMING in it either (fixture A: a crossing wall)', () => {
  test("THE BUG: a neighbour wall's studs and plates vanish from the opening", () => {
    const world = makeCrossingWorld()
    const target = ensureVoxelTarget(world, 'wall_cross')!
    expect(target.dormant).toBeFalsy() // a dormant grid draws nothing of its own
    const members = target.segments as SegmentMember[]
    const mesh = meshFor(members)
    const prism = openDoor(world, 'door_front')
    syncMemberLayer(mesh, members, maxHpOf(members))

    const s = split(members, prism)
    // The premise, guarded: a fixture with nothing in the aperture would pass
    // this test with the gate ripped out.
    expect(s.crosses.length).toBeGreaterThan(4)
    expect(s.clear.length).toBeGreaterThan(10)
    for (const i of s.crosses) expect(drawn(mesh, i)).toBe(false)
    for (const i of s.clear) expect(drawn(mesh, i)).toBe(true)
  })

  test('the framing is HIDDEN, never killed: the layer is untouched data', () => {
    const world = makeCrossingWorld()
    const target = ensureVoxelTarget(world, 'wall_cross')!
    const members = target.segments as SegmentMember[]
    const mesh = meshFor(members)
    const before = shapeOf(members)
    const count = members.length
    openDoor(world, 'door_front')
    syncMemberLayer(mesh, members, maxHpOf(members))
    // The non-destructive session invariant: opening a door is a RENDER decision.
    // Killing the sticks instead would desync the destruction store from the
    // picture and survive the door closing.
    expect(members.length).toBe(count)
    expect(shapeOf(members)).toBe(before)
    // ...and the studs alias really is the same array instance destruction.ts hands out.
    expect(target.studs).toBe(target.segments)
  })

  test('closing the door puts every stick back', () => {
    const world = makeCrossingWorld()
    const target = ensureVoxelTarget(world, 'wall_cross')!
    const members = target.segments as SegmentMember[]
    const mesh = meshFor(members)
    const prism = openDoor(world, 'door_front')
    // The latch: by the time the door has closed no prism reaches this layer, so
    // the cheap sphere early-out would skip the restore sweep without it.
    expect(syncMemberLayer(mesh, members, maxHpOf(members))).toBe(true)

    unregisterPassage(prism)
    expect(syncMemberLayer(mesh, members, maxHpOf(members))).toBe(false)
    for (let i = 0; i < members.length; i++) expect(drawn(mesh, i)).toBe(true)
  })

  test('a CHIP anywhere in the wall does not re-draw the doorway sticks', () => {
    const world = makeCrossingWorld()
    const target = ensureVoxelTarget(world, 'wall_cross')!
    const members = target.segments as SegmentMember[]
    const mesh = meshFor(members)
    const prism = openDoor(world, 'door_front')
    const max = maxHpOf(members)
    syncMemberLayer(mesh, members, max)
    const s = split(members, prism)
    expect(s.crosses.length).toBeGreaterThan(4)

    // Bullet takes hp off a stick out at the far end of the wall. That bumps the
    // layer checksum, which re-uploads EVERY matrix — the reason the gate is
    // derived inside the writer instead of passed in by the door code.
    const far = s.clear[0]!
    members[far]!.hp = Math.max(0, (members[far]!.hp ?? max) - 1)
    syncMemberLayer(mesh, members, max)
    for (const i of s.crosses) expect(drawn(mesh, i)).toBe(false)
  })

  test('no door open, no holes: an unregistered prism hides no framing', () => {
    const world = makeCrossingWorld()
    const target = ensureVoxelTarget(world, 'wall_cross')!
    const members = target.segments as SegmentMember[]
    const mesh = meshFor(members)
    const leaf = world.colliders.find((c) => c.nodeId === 'door_front')!
    leaf.disabled = true // open for movement, but nobody registered a passage
    expect(syncMemberLayer(mesh, members, maxHpOf(members))).toBe(false)
    for (let i = 0; i < members.length; i++) expect(drawn(mesh, i)).toBe(true)
  })
})

describe('the bound: a door never eats its OWN frame (fixture B: hosted door)', () => {
  test('not one member of the host wall vanishes when its door opens', () => {
    const world = makeHostedWorld()
    const target = ensureVoxelTarget(world, 'wall-1')!
    const members = target.segments as SegmentMember[]
    const mesh = meshFor(members)
    const prism = openDoor(world, 'door-1')
    // destruction.ts already clipped this wall's studs around the aperture, so by
    // construction nothing crosses. If the classifier says otherwise the FIXTURE
    // is wrong, and the assertion below would be pinning the wrong thing.
    const s = split(members, prism)
    expect(members.length).toBeGreaterThan(20)
    expect(s.crosses).toEqual([])
    expect(syncMemberLayer(mesh, members, maxHpOf(members))).toBe(false)
    for (let i = 0; i < members.length; i++) expect(drawn(mesh, i)).toBe(true)
  })

  test('the frame members that bound the opening, one by one', () => {
    const world = makeHostedWorld()
    const target = ensureVoxelTarget(world, 'wall-1')!
    const members = target.segments as SegmentMember[]
    const mesh = meshFor(members)
    openDoor(world, 'door-1')
    syncMemberLayer(mesh, members, maxHpOf(members))

    /** Nearest member to a point, and whether it draws. Named coordinates rather
     * than indices so the assertion still means something if buildSegments
     * reorders its output. */
    const at = (x: number, y: number) => {
      let best = -1
      let bestD = Number.POSITIVE_INFINITY
      for (let i = 0; i < members.length; i++) {
        const c = members[i]!.center
        const d = Math.hypot(c[0] - x, c[1] - y)
        if (d < bestD) {
          bestD = d
          best = i
        }
      }
      expect(bestD).toBeLessThan(0.02) // the member really is there
      return drawn(mesh, best)
    }
    // The two JAMB studs flanking a 0.9 m door at u 1.5 (0.4064 m stud pitch).
    expect(at(0.8128, 1.35)).toBe(true)
    expect(at(2.032, 1.35)).toBe(true)
    // The CRIPPLES over the head: centre lines start 2.126, prism head 2.1 —
    // 0.026 m of clearance, the tightest margin in the whole build.
    expect(at(1.2192, 2.385)).toBe(true)
    expect(at(1.6256, 2.385)).toBe(true)
    // The HEADER across the opening, 0.065 m over the leaf.
    expect(at(1.5, 2.165)).toBe(true)
    // The BOTTOM PLATE runs, clipped to stop 0.026 m short of each jamb — the
    // threshold the player walks over.
    expect(at(2.4775, 0.045)).toBe(true)
    // The TOP PLATE, which runs straight over the doorway well above it.
    expect(at(2, 2.655)).toBe(true)
  })
})

describe('the predicate itself: a centre LINE, on the exact prism', () => {
  test('a stick whose CENTRE is outside still counts — the cell test does not transfer', () => {
    const world = makeHostedWorld()
    const prism = openDoor(world, 'door-1')
    const mid = new Vector3()
    prism.getCenter(mid)
    // A 1.2 m plate run poking into the opening from beyond the jamb: it crosses
    // the prism, but its midpoint is 0.55 m outside it. A centre-POINT test —
    // what the cell lane correctly uses, because a cell is smaller than a cell —
    // would leave exactly this bar standing across the doorway, and it would
    // leave it on the LONGEST members, the ones most visible.
    const x0 = prism.max.x - 0.05
    const x1 = x0 + 1.2
    const cx = (x0 + x1) / 2
    expect(prism.containsPoint(new Vector3(cx, mid.y, mid.z))).toBe(false)
    expect(passageHidesCell(cx, mid.y, mid.z)).toBe(false)
    expect(passageHidesSegment(x0, mid.y, mid.z, x1, mid.y, mid.z)).toBe(true)
  })

  test('and it reaches NO further than the prism, on any face', () => {
    const world = makeHostedWorld()
    const prism = openDoor(world, 'door-1')
    const mid = new Vector3()
    prism.getCenter(mid)
    const d = 0.03 // less than the 0.026-plus-a-hair the real frame clears by
    // Six sticks laid flat just outside each face. Every direction a pad could
    // grow in takes away geometry the player is looking straight at: outward
    // notches the jambs, down holes the threshold, up slots the header.
    const clear: [number, number, number, number, number, number][] = [
      [prism.max.x + d, mid.y, mid.z, prism.max.x + d + 0.4, mid.y, mid.z],
      [prism.min.x - d - 0.4, mid.y, mid.z, prism.min.x - d, mid.y, mid.z],
      [mid.x, prism.max.y + d, mid.z, mid.x + 0.4, prism.max.y + d, mid.z],
      [mid.x, prism.min.y - d, mid.z, mid.x + 0.4, prism.min.y - d, mid.z],
      [mid.x, mid.y, prism.max.z + d, mid.x + 0.4, mid.y, prism.max.z + d],
      [mid.x, mid.y, prism.min.z - d, mid.x + 0.4, mid.y, prism.min.z - d],
    ]
    for (const s of clear) expect(passageHidesSegment(...s)).toBe(false)
    // Sanity, so the six above cannot be passing because the registry is empty.
    expect(passageHidesSegment(mid.x, mid.y, mid.z, mid.x, mid.y, mid.z)).toBe(true)
  })

  test('a stick exactly parallel to a face, on the far side of it, is untouched', () => {
    const world = makeHostedWorld()
    const prism = openDoor(world, 'door-1')
    const mid = new Vector3()
    prism.getCenter(mid)
    // Zero extent on the axis being clipped is the degenerate case: the slab
    // clip's delta is 0, and a naive 0/0 would produce NaN and fail OPEN,
    // hiding a stud that runs alongside the doorway all the way up the wall.
    const y = prism.max.y + 0.03
    expect(passageHidesSegment(mid.x - 2, y, mid.z, mid.x + 2, y, mid.z)).toBe(false)
    const x = prism.max.x + 0.03
    expect(passageHidesSegment(x, prism.min.y - 1, mid.z, x, prism.max.y + 1, mid.z)).toBe(false)
    // ...and the same line dropped INSIDE the prism does hide, so the axis-zero
    // branch is not simply refusing everything.
    expect(passageHidesSegment(mid.x - 2, mid.y, mid.z, mid.x + 2, mid.y, mid.z)).toBe(true)
  })

  test('with no doorway open the predicate is off entirely', () => {
    expect(passageHidesSegment(0, 1, 0, 0, 2, 0)).toBe(false)
  })
})
