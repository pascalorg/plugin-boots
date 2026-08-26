import { afterEach, describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, Matrix4, Mesh, Vector3 } from 'three'
import {
  damageExplosion,
  damageSegment,
  damageTarget,
  ensureVoxelTarget,
  prevoxelizeTick,
  raycastSegments,
  resetDestruction,
  useDestruction,
} from './destruction'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

/**
 * Round-2 destruction surface, headless: session-start prevoxelization
 * (walls clad + host colliders handed over without a single shot) and the
 * LOGICAL sheet system — per-face ~1.2 × 2.4 m groups of existing skin
 * voxels that count carve hits/torn cells and fly off wholesale. No new
 * rendered plane exists anywhere in the sheet model (coplanar z-fighting is
 * impossible by construction), so everything here asserts on grid + member
 * state only.
 */

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

/** Two walls facing the z+ firing line + one slab volume — the same layout
 * family as the shooting tests. */
function makeWorld(): GameWorld {
  const wallA = boxCollider('wall-1', 'wall', [2, 2.7, 0.12], [0, 1.35, 0])
  const wallB = boxCollider('wall-2', 'wall', [3, 2.7, 0.12], [5, 1.35, 0])
  const slab = boxCollider('slab-1', 'slab', [1.2, 0.3, 1.2], [10, 1.35, 0])
  const colliders = [wallA, wallB, slab]
  const buildingAabb = new Box3()
  for (const c of colliders) buildingAabb.union(c.worldBox)
  const wallEntry = (c: ColliderEntry, start: [number, number], end: [number, number]) => ({
    node: { id: c.nodeId, start, end, height: 2.7, thickness: 0.12 },
    root: c.root,
    meshes: [c.mesh],
  })
  return {
    colliders,
    walls: new Map([
      ['wall-1', wallEntry(wallA, [-1, 0], [1, 0])],
      ['wall-2', wallEntry(wallB, [3.5, 0], [6.5, 0])],
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

afterEach(() => {
  resetDestruction()
})

describe('prevoxelizeTick', () => {
  test('voxelizes every wall (and only walls) without a shot, colliders handed over', () => {
    const world = makeWorld()
    let done = false
    for (let i = 0; i < 50 && !done; i++) done = prevoxelizeTick(world, 8)
    expect(done).toBe(true)
    const targets = useDestruction.getState().targets
    expect(targets.get('wall-1')?.kind).toBe('wall')
    expect(targets.get('wall-2')?.kind).toBe('wall')
    expect(targets.has('slab-1')).toBe(false)
    // Host handover happened in the same path as first-hit voxelization.
    for (const collider of world.colliders) {
      expect(Boolean(collider.disabled)).toBe(collider.nodeType === 'wall')
    }
    // The anatomy is fully there before any damage.
    const wall = targets.get('wall-1')!
    expect(wall.grid.aliveCount).toBeGreaterThan(0)
    expect(wall.studs.length).toBeGreaterThan(0)
    expect(wall.sheets.length).toBeGreaterThan(0)
  })

  test('a zero-budget tick returns false and a later tick finishes the job', () => {
    const world = makeWorld()
    expect(prevoxelizeTick(world, 0)).toBe(false)
    let done = false
    for (let i = 0; i < 50 && !done; i++) done = prevoxelizeTick(world, 8)
    expect(done).toBe(true)
    expect(prevoxelizeTick(world, 8)).toBe(true) // idempotent once done
  })
})

describe('skin-respecting carve (pierce fix)', () => {
  test('a rifle-size tear opens only the entered skin; the far face holds', () => {
    const world = makeWorld()
    const wall = ensureVoxelTarget(world, 'wall-1')!
    // Shot entering the z-min face of the 0.12 m wall — the carve sphere
    // (rifle tearRadius 0.55) spans both skins, but only the entered one
    // may lose cells.
    const removed = damageTarget(world, 'wall-1', new Vector3(0, 1.35, -0.06), 0.55, new Vector3(0, 0, 1))
    expect(removed).toBeGreaterThan(0)
    for (const sheet of wall.sheets) {
      if (sheet.side === 1) {
        expect(sheet.torn).toBe(0)
        for (const idx of sheet.cells) expect(wall.grid.alive[idx]).toBe(1)
      }
    }
    expect(wall.sheets.some((s) => s.side === 0 && s.torn > 0)).toBe(true)
  })

  test('a follow-up through the hole tears the far skin', () => {
    const world = makeWorld()
    const wall = ensureVoxelTarget(world, 'wall-1')!
    damageTarget(world, 'wall-1', new Vector3(0, 1.35, -0.06), 0.55, new Vector3(0, 0, 1))
    // Second shot sails through the near-skin hole and lands ON the far
    // face — its entry point is on side 1 now, so side 1 tears.
    const removed = damageTarget(world, 'wall-1', new Vector3(0, 1.35, 0.02), 0.55, new Vector3(0, 0, 1))
    expect(removed).toBeGreaterThan(0)
    expect(wall.sheets.some((s) => s.side === 1 && s.torn > 0)).toBe(true)
  })

  test('a heavy carve past the pierce gate punches both skins at once', () => {
    const world = makeWorld()
    const wall = ensureVoxelTarget(world, 'wall-1')!
    damageTarget(world, 'wall-1', new Vector3(0, 1.35, -0.06), 0.65, new Vector3(0, 0, 1))
    const sides = new Set(wall.sheets.filter((s) => s.torn > 0).map((s) => s.side))
    expect(sides).toEqual(new Set([0, 1]))
  })
})

describe('framing segments (charcoal sticks)', () => {
  test('walls carry stick segments at the real lumber cross-section; studs aliases the array', () => {
    const world = makeWorld()
    const wall = ensureVoxelTarget(world, 'wall-1')!
    expect(wall.segments.length).toBeGreaterThan(0)
    expect(wall.studs).toBe(wall.segments)
    for (const seg of wall.segments) {
      expect(seg.hp).toBeGreaterThan(0)
      expect(seg.broken).toBe(false)
      // Cross-section is real lumber — every axis but the long one is far
      // skinnier than the 0.15 m render cell.
      const sorted = [...seg.size].sort((a, b) => a - b)
      expect(sorted[0]!).toBeLessThan(0.05)
      expect(sorted[1]!).toBeLessThan(0.1)
      // Depth never poked proud of the 0.12 m wall.
      expect(sorted[1]!).toBeLessThanOrEqual(0.12)
    }
    // Vertical 2.6 m lines split into thirds — sticks, not whole studs.
    const verticals = wall.segments.filter((s) => s.size[1] > s.size[0])
    expect(verticals.length).toBeGreaterThan(0)
    for (const seg of verticals) expect(seg.size[1]).toBeLessThan(1)
    // Ids are array indices (fixed-length member contract).
    wall.segments.forEach((seg, i) => expect(seg.id).toBe(i))
    // Volumes carry no framing.
    expect(ensureVoxelTarget(world, 'slab-1')!.segments.length).toBe(0)
  })

  test('raycastSegments finds the stick, damageSegment chips then snaps it', () => {
    const world = makeWorld()
    const wall = ensureVoxelTarget(world, 'wall-1')!
    const hit = raycastSegments(new Vector3(0.2192, 1.35, 5), new Vector3(0, 0, -1), 90)
    expect(hit).not.toBeNull()
    expect(hit!.nodeId).toBe('wall-1')
    expect(hit!.studId).toBe(hit!.segmentId)
    const seg = wall.segments[hit!.segmentId]!
    const revBefore = wall.revision
    // Chip: hp drops, no break, revision untouched (checksum picks it up).
    expect(damageSegment(world, 'wall-1', seg.id, 1, hit!.point)).toBe(true)
    expect(seg.hp).toBe(1)
    expect(seg.broken).toBe(false)
    expect(wall.revision).toBe(revBefore)
    // Snap: broken, revision bumped, no underflow, further damage refused.
    expect(damageSegment(world, 'wall-1', seg.id, 24, hit!.point)).toBe(true)
    expect(seg.broken).toBe(true)
    expect(seg.hp).toBe(0)
    expect(wall.revision).toBe(revBefore + 1)
    expect(damageSegment(world, 'wall-1', seg.id, 24, hit!.point)).toBe(false)
    // Broken sticks are transparent to the segment ray.
    const again = raycastSegments(new Vector3(0.2192, 1.35, 5), new Vector3(0, 0, -1), 90)
    expect(again?.segmentId).not.toBe(seg.id)
  })
})

describe('carve splash chips the framing (gunfire chips neighbors)', () => {
  test('a rifle tear at mid-bay chips the flanking stick each side, never snaps it', () => {
    const world = makeWorld()
    const wall = ensureVoxelTarget(world, 'wall-1')!
    // Stud lines on wall-1 sit at x = -1 + i*0.4064; aim between two of
    // them (mid-bay) at stick height 1.35.
    const bayX = -1 + 1.5 * 0.4064
    damageTarget(world, 'wall-1', new Vector3(bayX, 1.35, -0.06), 0.55, new Vector3(0, 0, 1))
    const chipped = wall.segments.filter((s) => !s.broken && s.hp === 1)
    // Both flanking sticks (~0.2 m away) scuffed; nothing snapped by splash.
    expect(chipped.length).toBeGreaterThanOrEqual(2)
    expect(wall.segments.some((s) => s.broken)).toBe(false)
    // The next studs over (~0.61 m) stayed clean: chips are local.
    for (const seg of wall.segments) {
      const dx = Math.abs(seg.center[0] - bayX)
      if (seg.size[1] > seg.size[0] && dx > 0.56) expect(seg.hp).toBe(2)
    }
  })

  test('repeated carves in the same bay keep the hp-1 floor (splash is sub-lethal)', () => {
    const world = makeWorld()
    const wall = ensureVoxelTarget(world, 'wall-1')!
    const bayX = -1 + 1.5 * 0.4064
    // Fresh cells fall each time (rising carve height + the far skin
    // through the hole), so every carve re-runs the splash over the same
    // flanking sticks.
    for (const [y, z] of [
      [1.15, -0.06],
      [1.35, 0.02],
      [1.55, -0.06],
      [1.75, 0.02],
    ] as const) {
      damageTarget(world, 'wall-1', new Vector3(bayX, y, z), 0.55, new Vector3(0, 0, 1))
    }
    for (const seg of wall.segments) {
      expect(seg.broken).toBe(false)
      expect(seg.hp).toBeGreaterThanOrEqual(1)
    }
  })

  test('volume carves splash nothing (no framing)', () => {
    const world = makeWorld()
    const slab = ensureVoxelTarget(world, 'slab-1')!
    expect(slab.segments.length).toBe(0)
    expect(() =>
      damageTarget(world, 'slab-1', new Vector3(10, 1.35, -0.5), 0.4),
    ).not.toThrow()
  })
})

describe('island collapse on studless volumes (the shower cut)', () => {
  test('severing an item volume drops the floating top half after the settle delay', async () => {
    const world = makeWorld()
    const shower = boxCollider('shower-1', 'item', [0.9, 2.4, 0.9], [20, 1.2, 0])
    world.colliders.push(shower)
    const target = ensureVoxelTarget(world, 'shower-1')!
    expect(target.kind).toBe('volume')
    const total = target.grid.aliveCount
    // Cut clean through at y = 1.2 — a 3×3 pattern of carves covers the
    // full 0.9 × 0.9 cross-section.
    for (const dx of [-0.3, 0, 0.3]) {
      for (const dz of [-0.3, 0, 0.3]) {
        damageTarget(world, 'shower-1', new Vector3(20 + dx, 1.2, dz), 0.35)
      }
    }
    const afterCarve = target.grid.aliveCount
    expect(afterCarve).toBeLessThan(total)
    // The top half is still alive but disconnected…
    let above = 0
    for (let i = 0; i < target.grid.count; i++) {
      if (target.grid.alive[i] && target.grid.centers[i * 3 + 1]! > 1.7) above++
    }
    expect(above).toBeGreaterThan(0)
    // …until the island timer fires — then it falls as debris, numerically
    // visible in aliveCount (the __boots.targets() census field).
    await new Promise((resolve) => setTimeout(resolve, 260))
    expect(target.grid.aliveCount).toBeLessThan(afterCarve)
    for (let i = 0; i < target.grid.count; i++) {
      if (target.grid.centers[i * 3 + 1]! > 1.7) expect(target.grid.alive[i]).toBe(0)
    }
    // The floor-supported bottom survives.
    expect(target.grid.aliveCount).toBeGreaterThan(0)
  })
})

describe('drywall sheets', () => {
  test('walls get per-face sheet groups covering every skin cell; volumes get none', () => {
    const world = makeWorld()
    const wall = ensureVoxelTarget(world, 'wall-1')!
    // Both faces are sheeted and every cell belongs to exactly one sheet.
    const sides = new Set(wall.sheets.map((s) => s.side))
    expect(sides).toEqual(new Set([0, 1]))
    let covered = 0
    for (const sheet of wall.sheets) {
      expect(sheet.cellCount).toBe(sheet.cells.length)
      expect(sheet.hits).toBe(0)
      expect(sheet.torn).toBe(0)
      expect(sheet.flownOff).toBe(false)
      covered += sheet.cellCount
      for (const idx of sheet.cells) expect(wall.sheetByCell[idx]).toBe(sheet.id)
    }
    expect(covered).toBe(wall.grid.count)
    // Sheets are LOGICAL: outward normals are horizontal unit vectors.
    for (const sheet of wall.sheets) {
      const [nx, ny, nz] = sheet.normal
      expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 5)
      expect(ny).toBe(0)
    }
    const slab = ensureVoxelTarget(world, 'slab-1')!
    expect(slab.kind).toBe('volume')
    expect(slab.sheets.length).toBe(0)
  })

  test('one big carve = one hit per touched sheet, torn matches removed cells', () => {
    const world = makeWorld()
    const removed = damageTarget(world, 'wall-1', new Vector3(0, 1.35, 0), 0.45)
    expect(removed).toBeGreaterThan(8)
    const wall = useDestruction.getState().targets.get('wall-1')!
    const touched = wall.sheets.filter((s) => s.torn > 0)
    expect(touched.length).toBeGreaterThan(0)
    let torn = 0
    for (const sheet of touched) {
      expect(sheet.hits).toBe(1)
      torn += sheet.torn
    }
    expect(torn).toBe(removed)
    expect(Math.max(...touched.map((s) => s.torn))).toBeGreaterThan(8)
  })

  test('repeated carves fly the whole sheet off: flownOff, cells gone, one shot each', () => {
    const world = makeWorld()
    const wall = ensureVoxelTarget(world, 'wall-1')!
    const before = wall.grid.aliveCount
    // Walk small carves across one board area (fresh cells each time, the
    // way a player chews a hole wider) until a sheet lets go.
    const spots: Array<[number, number]> = [
      [-0.7, 1.0],
      [-0.4, 1.0],
      [-0.7, 1.7],
      [-0.4, 1.7],
      [-0.55, 1.35],
    ]
    for (const [x, y] of spots) {
      damageTarget(world, 'wall-1', new Vector3(x, y, 0), 0.3, new Vector3(0, 0, -1))
      if (wall.sheets.some((s) => s.flownOff)) break
    }
    const flown = wall.sheets.filter((s) => s.flownOff)
    expect(flown.length).toBeGreaterThan(0)
    for (const sheet of flown) {
      expect(sheet.torn).toBe(sheet.cellCount)
      for (const idx of sheet.cells) expect(wall.grid.alive[idx]).toBe(0)
    }
    // The wall lost at least one whole sheet's worth of material.
    expect(before - wall.grid.aliveCount).toBeGreaterThanOrEqual(flown[0]!.cellCount)
    // Untouched sheets are still intact.
    const intact = wall.sheets.filter((s) => s.torn === 0)
    expect(intact.length).toBeGreaterThan(0)
    for (const sheet of intact) {
      for (const idx of sheet.cells) expect(wall.grid.alive[idx]).toBe(1)
    }
  })

  test('a flown-off sheet takes no further hits', () => {
    const world = makeWorld()
    const wall = ensureVoxelTarget(world, 'wall-1')!
    for (let i = 0; i < 8 && !wall.sheets.some((s) => s.flownOff); i++) {
      damageTarget(world, 'wall-1', new Vector3(-0.6 + i * 0.05, 1.0 + i * 0.15, 0), 0.3)
    }
    const flown = wall.sheets.find((s) => s.flownOff)!
    expect(flown).toBeDefined()
    const frozen = { hits: flown.hits, torn: flown.torn }
    // Empty air where the sheet was — more carves land nothing on it.
    damageTarget(world, 'wall-1', new Vector3(flown.center[0], flown.center[1], flown.center[2]), 0.3)
    expect(flown.hits).toBe(frozen.hits)
    expect(flown.torn).toBe(frozen.torn)
    expect(flown.torn).toBe(flown.cellCount)
  })
})

describe('damageExplosion (grenade detonation carve)', () => {
  test('one blast guts every destructible in range and snaps its framing', () => {
    const world = makeWorld()
    const wall = ensureVoxelTarget(world, 'wall-1')!
    const before = wall.grid.aliveCount
    const removed = damageExplosion(world, new Vector3(0, 1.2, 0.5), 3.2, { immediate: true })
    expect(removed).toBeGreaterThan(0)
    // The 3.2 m sphere dwarfs the 2 × 2.7 wall — most of it is gone…
    expect(wall.grid.aliveCount).toBeLessThan(before * 0.5)
    // …and the framing inside the radius snapped with it (cap 48).
    const broken = wall.segments.filter((s) => s.broken).length
    expect(broken).toBeGreaterThan(0)
    expect(broken).toBeLessThanOrEqual(48)
  })

  test('far targets and non-destructibles are untouched', () => {
    const world = makeWorld()
    // Blast at wall-1; wall-2 (5 m away, bounds > 3.2 m out) never voxelizes.
    damageExplosion(world, new Vector3(0, 1.2, 0.5), 3.2, { immediate: true })
    const targets = useDestruction.getState().targets
    expect(targets.has('wall-2')).toBe(false)
    expect(targets.has('slab-1')).toBe(false)
  })
})

describe('skeleton snap (cladding gone → bare frame falls)', () => {
  test('a wall carved to zero live voxels snaps every segment within ~1.5 s', async () => {
    const world = makeWorld()
    const wall = ensureVoxelTarget(world, 'wall-1')!
    expect(wall.segments.some((s) => !s.broken)).toBe(true)
    // One giant full-depth carve (radius >= pierce gate) strips ALL cladding.
    damageTarget(world, 'wall-1', new Vector3(0, 1.35, 0), 4)
    expect(wall.grid.aliveCount).toBe(0)
    // Immediately after: the snap is STAGGERED, not instantaneous.
    // After the 1.5 s span (+ buffer): the whole skeleton is down.
    await new Promise((resolve) => setTimeout(resolve, 1800))
    expect(wall.segments.every((s) => s.broken)).toBe(true)
  })
})
