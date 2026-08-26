import { afterEach, describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, Group, Matrix4, Mesh, Vector3 } from 'three'
import {
  buildStuds,
  collectWallOpenings,
  ensureVoxelTarget,
  resetDestruction,
  type SegmentMember,
  type StudMember,
  type WallOpening,
} from './destruction'
import type { VoxelGridData } from './voxel'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

/**
 * Studs-through-openings fix (owner bug: "through the window I still see
 * the vertical studs … It shouldn't go through the doors and windows.")
 * — deterministic coverage for the aperture rects computed from the host
 * door/window node snapshots, the vertical stud clipping (cripples above
 * doors/windows, below sills; short remainders dropped), the bottom-plate
 * doorway clip, the header/sill garnish members, and the byte-identical
 * regression guarantee for walls WITHOUT openings.
 *
 * Wall-space conventions under test: `u` runs along the wall from its
 * START, `v` is height above the wall base; hosted door/window `position`
 * is the child's CENTER in that frame (doors sit on the floor with
 * position[1] = height / 2 — the host schema's own contract).
 */

// ── Harness ────────────────────────────────────────────────────────────────

/** 4 m × 2.7 m × 0.12 m wall along +X from the origin — mesh centered so
 * baseY = 0 and the node midpoint matches the mesh bounds center (no
 * level offset), keeping u/v math transparent in every assertion. */
function makeWallEntry() {
  const mesh = new Mesh(new BoxGeometry(4, 2.7, 0.12))
  mesh.position.set(2, 1.35, 0)
  mesh.updateMatrixWorld(true)
  return {
    node: {
      id: 'wall-1',
      start: [0, 0] as [number, number],
      end: [4, 0] as [number, number],
      height: 2.7,
      thickness: 0.12,
    },
    root: mesh as unknown as Group | Mesh,
    meshes: [mesh],
  }
}

/** Isotropic grid stub — buildStuds only reads cellX/cellZ (stud depth). */
const gridStub = { cellX: 0.15, cellZ: 0.15, nx: 4, nz: 4 } as unknown as VoxelGridData

function doorEntry(node: Record<string, unknown> | undefined): GameWorld['doors'][number] {
  return { nodeId: 'door-1', root: new Group(), colliderIndices: [], node }
}

function windowEntry(node: Record<string, unknown>, kind = 'window') {
  return { nodeId: 'win-1', kind, root: new Group(), colliderIndices: [], node }
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

/** Full destruction-lane world: one wall collider whose entry matches
 * makeWallEntry, plus whatever hosted-child snapshots the test wires in. */
function makeWorld(
  doors: GameWorld['doors'] = [],
  operables: NonNullable<GameWorld['operables']> = [],
): GameWorld {
  const wall = boxCollider('wall-1', 'wall', [4, 2.7, 0.12], [2, 1.35, 0])
  return {
    colliders: [wall],
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
    doors,
    operables,
    overlayRoots: [],
    buildingAabb: wall.worldBox.clone(),
    spawn: new Vector3(6, 0, 6),
    spawnYaw: 0,
    levelId: null,
  }
}

afterEach(() => {
  resetDestruction()
})

const DOOR = { u0: 1.03, u1: 1.97, v0: -0.02, v1: 2.12 } // 0.9×2.1 door at u 1.5
const doorNode = {
  parentId: 'wall-1',
  position: [1.5, 1.05, 0],
  width: 0.9,
  height: 2.1,
}
const windowNode = {
  parentId: 'wall-1',
  position: [3, 1.5, 0],
  width: 1.2,
  height: 1.2,
}

/** u along the wall for the harness wall (start at the origin, along +X). */
const uOf = (m: StudMember | SegmentMember) => m.center[0]
const isVertical = (m: StudMember | SegmentMember) => m.size[1] >= m.size[0]

// ── Opening rect math ──────────────────────────────────────────────────────

describe('collectWallOpenings', () => {
  test('door snapshot → floor-to-header rect, inflated by the pad', () => {
    const world = makeWorld([doorEntry(doorNode)])
    const rects = collectWallOpenings(world, 'wall-1')
    expect(rects.length).toBe(1)
    const r = rects[0]!
    expect(r.kind).toBe('door')
    expect(r.u0).toBeCloseTo(1.03, 6)
    expect(r.u1).toBeCloseTo(1.97, 6)
    // Doors reach the floor regardless of the center-height snapshot.
    expect(r.v0).toBeCloseTo(-0.02, 6)
    expect(r.v1).toBeCloseTo(2.12, 6)
  })

  test('window snapshot → sill-to-head rect (v0 = sill − pad)', () => {
    const world = makeWorld([], [windowEntry(windowNode)])
    const rects = collectWallOpenings(world, 'wall-1')
    expect(rects.length).toBe(1)
    const r = rects[0]!
    expect(r.kind).toBe('window')
    expect(r.u0).toBeCloseTo(2.38, 6)
    expect(r.u1).toBeCloseTo(3.62, 6)
    expect(r.v0).toBeCloseTo(0.88, 6) // sill 0.9 − 0.02 pad
    expect(r.v1).toBeCloseTo(2.12, 6) // head 2.1 + 0.02 pad
  })

  test('u clamps to the wall extents; children of OTHER walls, cabinets, and snapshot-less doors contribute nothing', () => {
    const world = makeWorld(
      [
        doorEntry({ parentId: 'wall-9', position: [1, 1.05, 0] }),
        doorEntry(undefined),
        doorEntry({ parentId: 'wall-1' }), // no position → unplaceable
        doorEntry({ parentId: 'wall-1', position: [0.1, 1.05, 0], width: 0.9 }),
      ],
      [windowEntry({ parentId: 'wall-1', position: [1, 1.2, 0] }, 'cabinet')],
    )
    const rects = collectWallOpenings(world, 'wall-1')
    expect(rects.length).toBe(1)
    expect(rects[0]!.u0).toBe(0) // 0.1 − 0.45 − pad clamps to the wall start
    expect(rects[0]!.u1).toBeCloseTo(0.57, 6)
  })

  test('wallId mirror field links a child when parentId points elsewhere', () => {
    const world = makeWorld([
      doorEntry({ parentId: 'level-1', wallId: 'wall-1', position: [1.5, 1.05, 0] }),
    ])
    expect(collectWallOpenings(world, 'wall-1').length).toBe(1)
  })
})

// ── Stud clipping ──────────────────────────────────────────────────────────

describe('buildStuds opening clipping', () => {
  const wall = makeWallEntry()
  const baseline = buildStuds(wall, gridStub) // 10 studs + 2 plates

  test('baseline sanity: 10 full-height studs + 2 full-length plates', () => {
    expect(baseline.length).toBe(12)
    expect(baseline.filter(isVertical).length).toBe(10)
    for (const stud of baseline.filter(isVertical)) {
      expect(stud.size[1]).toBeCloseTo(2.6, 6)
    }
  })

  test('door: crossing studs lose the aperture band, keep the >=0.25 m cripple above; others byte-identical', () => {
    const door: WallOpening = { ...DOOR, kind: 'door' }
    const studs = buildStuds(wall, gridStub, [door])
    const verticals = studs.filter(isVertical)
    // Studs at u ≈ 1.2192 and 1.6256 cross; both survive ONLY as cripples
    // above the door head (2.12 → 2.65).
    const cripples = verticals.filter((s) => uOf(s) > DOOR.u0 && uOf(s) < DOOR.u1)
    expect(cripples.length).toBe(2)
    for (const c of cripples) {
      expect(c.size[1]).toBeCloseTo(0.53, 6)
      expect(c.center[1]).toBeCloseTo((2.12 + 2.65) / 2, 6)
    }
    // No vertical member's span may intersect the aperture interior.
    for (const s of verticals) {
      if (uOf(s) <= DOOR.u0 || uOf(s) >= DOOR.u1) continue
      expect(s.center[1] - s.size[1] / 2).toBeGreaterThanOrEqual(DOOR.v1 - 1e-6)
    }
    // Unrelated studs (and the top plate) are BYTE-identical to baseline.
    const untouched = studs.filter(
      (s) => isVertical(s) && (uOf(s) < DOOR.u0 || uOf(s) > DOOR.u1),
    )
    const baseUntouched = baseline.filter(
      (s) => isVertical(s) && (uOf(s) < DOOR.u0 || uOf(s) > DOOR.u1),
    )
    expect(untouched.length).toBe(baseUntouched.length)
    for (let i = 0; i < untouched.length; i++) {
      expect(untouched[i]!.center).toEqual(baseUntouched[i]!.center)
      expect(untouched[i]!.size).toEqual(baseUntouched[i]!.size)
    }
  })

  test('window: crossing studs split into a lower stud (below sill) AND an upper cripple', () => {
    const win: WallOpening = { u0: 2.38, u1: 3.62, v0: 0.88, v1: 2.12, kind: 'window' }
    const studs = buildStuds(wall, gridStub, [win])
    const crossing = studs.filter((s) => isVertical(s) && uOf(s) > win.u0 && uOf(s) < win.u1)
    // Three stud lines cross (u ≈ 2.4384, 2.8448, 3.2512) → 2 pieces each.
    expect(crossing.length).toBe(6)
    const lowers = crossing.filter((s) => s.center[1] < 0.88)
    const uppers = crossing.filter((s) => s.center[1] > 2.12)
    expect(lowers.length).toBe(3)
    expect(uppers.length).toBe(3)
    for (const s of lowers) expect(s.size[1]).toBeCloseTo(0.88 - 0.05, 6)
    for (const s of uppers) expect(s.size[1]).toBeCloseTo(2.65 - 2.12, 6)
  })

  test('cripple shorter than 0.25 m is dropped (high window head)', () => {
    // Head at v1 = 2.52 → remainder above is 0.13 m < 0.25 m → dropped.
    const win: WallOpening = { u0: 2.38, u1: 3.62, v0: 0.88, v1: 2.52, kind: 'window' }
    const studs = buildStuds(wall, gridStub, [win])
    const crossing = studs.filter((s) => isVertical(s) && uOf(s) > win.u0 && uOf(s) < win.u1)
    expect(crossing.length).toBe(3) // below-sill pieces only
    for (const s of crossing) expect(s.center[1]).toBeLessThan(0.88)
  })

  test('door clips the BOTTOM plate across the doorway; top plate stays full length', () => {
    const door: WallOpening = { ...DOOR, kind: 'door' }
    const studs = buildStuds(wall, gridStub, [door])
    const plates = studs.filter((s) => !isVertical(s) && s.size[1] === 0.09)
    const bottom = plates.filter((s) => s.center[1] < 1)
    const top = plates.filter((s) => s.center[1] > 2.5) // above the door header band
    expect(top.length).toBe(1)
    expect(top[0]!.size[0]).toBeCloseTo(4, 6)
    expect(bottom.length).toBe(2)
    const sorted = bottom.sort((a, b) => uOf(a) - uOf(b))
    expect(sorted[0]!.size[0]).toBeCloseTo(1.03, 6) // [0, u0]
    expect(sorted[0]!.center[0]).toBeCloseTo(1.03 / 2, 6)
    expect(sorted[1]!.size[0]).toBeCloseTo(4 - 1.97, 6) // [u1, length]
    expect(sorted[1]!.center[0]).toBeCloseTo((1.97 + 4) / 2, 6)
  })

  test('header appears over each opening; windows also gain a sill member', () => {
    const door: WallOpening = { ...DOOR, kind: 'door' }
    const win: WallOpening = { u0: 2.38, u1: 3.62, v0: 0.88, v1: 2.12, kind: 'window' }
    const studs = buildStuds(wall, gridStub, [door, win])
    const flats = studs.filter((s) => !isVertical(s))
    const headers = flats.filter((s) => Math.abs(s.center[1] - (2.12 + 0.045)) < 1e-6)
    expect(headers.length).toBe(2) // one over the door, one over the window
    const doorHeader = headers.find((h) => Math.abs(uOf(h) - 1.5) < 1e-6)!
    expect(doorHeader.size[0]).toBeCloseTo(1.97 - 1.03 + 0.1, 6)
    const sills = flats.filter((s) => Math.abs(s.center[1] - (0.88 - 0.045)) < 1e-6)
    expect(sills.length).toBe(1) // window only — doors get no sill
    expect(uOf(sills[0]!)).toBeCloseTo(3, 6)
    expect(sills[0]!.size[0]).toBeCloseTo(3.62 - 2.38 + 0.1, 6)
  })

  test('header is skipped when the opening reaches the top plate (no room)', () => {
    const tall: WallOpening = { u0: 1.03, u1: 1.97, v0: -0.02, v1: 2.58, kind: 'door' }
    const studs = buildStuds(wall, gridStub, [tall])
    const headers = studs.filter((s) => !isVertical(s) && s.center[1] > 2.58)
    // Only the top plate lives above the head — no header wedged into it.
    expect(headers.length).toBe(1)
    expect(headers[0]!.size[0]).toBeCloseTo(4, 6)
  })

  test('REGRESSION: no openings → byte-identical layout to the legacy path', () => {
    const again = buildStuds(wall, gridStub, [])
    expect(again).toEqual(baseline)
  })
})

// ── Integration through ensureVoxelTarget ──────────────────────────────────

describe('ensureVoxelTarget wall framing with hosted openings', () => {
  test('no SEGMENT crosses the door aperture; header sticks carry hp 2', () => {
    const world = makeWorld([doorEntry(doorNode)])
    const target = ensureVoxelTarget(world, 'wall-1')!
    expect(target).toBeDefined()
    for (const seg of target.segments) {
      if (!isVertical(seg)) continue
      if (uOf(seg) <= DOOR.u0 || uOf(seg) >= DOOR.u1) continue
      // Anything vertical inside the doorway must sit fully above the head.
      expect(seg.center[1] - seg.size[1] / 2).toBeGreaterThanOrEqual(DOOR.v1 - 1e-6)
    }
    const headers = target.segments.filter(
      (s) => !isVertical(s) && Math.abs(s.center[1] - (2.12 + 0.045)) < 1e-6,
    )
    expect(headers.length).toBeGreaterThanOrEqual(1)
    for (const h of headers) expect(h.hp).toBe(2)
  })

  test('REGRESSION: a wall with a door hosted ELSEWHERE frames byte-identically to a doorless world', () => {
    const control = ensureVoxelTarget(makeWorld(), 'wall-1')!
    const controlSegments = structuredClone(control.segments)
    resetDestruction()
    const world = makeWorld([
      doorEntry({ parentId: 'wall-9', position: [1.5, 1.05, 0] }),
    ])
    const target = ensureVoxelTarget(world, 'wall-1')!
    expect(target.segments).toEqual(controlSegments)
  })
})
