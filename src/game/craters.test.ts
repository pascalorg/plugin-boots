import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, InstancedMesh, Matrix4, Vector3 } from 'three'
import {
  buildCraterGeometry,
  buildScorchGeometry,
  CRATER_CAP,
  CRATER_DEPTH,
  CRATER_MAX_DIAMETER,
  CRATER_MIN_DIAMETER,
  CRATER_RIM_HEIGHT,
  CRATER_RIM_T,
  craterEligible,
  craterProfile,
  craterRadiusFor,
  craterSlots,
  liveCraters,
  resetCraters,
  spawnCrater,
} from './craters'
import { clearScatterInRadius, registerScatterField, scatterFieldCount } from './nature'
import { footprintFromTriangles, type RoadFootprint } from './world'

/**
 * Explosion craters, headless: the green-vs-road/building eligibility
 * call, the blast→crater size mapping, the radial displacement profile +
 * built geometry (flush edge, charred-to-soil colors), the 16-slot ring
 * buffer, and the scatter-clearing pass in nature.tsx. Rendering
 * (<Craters/>) is DOM-bound and covered by review, matching the grenade
 * suite's split.
 */

/** Rectangle footprint x ∈ [5, 15], z ∈ [−2, 2] — a straight road analog. */
function roadRect(): RoadFootprint {
  // biome-ignore format: two triangles, one per row
  const footprint = footprintFromTriangles(new Float32Array([
    5, -2, 15, -2, 15, 2,
    5, -2, 15, 2, 5, 2,
  ]))
  if (!footprint) throw new Error('footprint construction failed')
  return footprint
}

function greenWorld(opts?: { road?: RoadFootprint[]; building?: Box3 }) {
  return {
    roadFootprints: opts?.road,
    buildingAabb: opts?.building ?? new Box3(),
  }
}

const unregisters: Array<() => void> = []

function field(positions: Array<[number, number, number]>): {
  mesh: InstancedMesh
  matrices: Matrix4[]
} {
  const mesh = new InstancedMesh(new BoxGeometry(0.1, 0.1, 0.1), undefined, positions.length)
  const matrices = positions.map(([x, y, z]) => new Matrix4().makeTranslation(x, y, z))
  for (let i = 0; i < matrices.length; i++) mesh.setMatrixAt(i, matrices[i]!)
  unregisters.push(registerScatterField(mesh, matrices))
  return { mesh, matrices }
}

beforeEach(() => {
  resetCraters()
})

afterEach(() => {
  resetCraters()
  for (const unregister of unregisters) unregister()
  unregisters.length = 0
})

describe('craterEligible', () => {
  test('open green: eligible near terrain height', () => {
    expect(craterEligible(greenWorld(), 0, 0.15, 0)).toBe(true)
    expect(craterEligible(greenWorld(), -30, 0, 40)).toBe(true)
  })

  test('a blast well above (or below) terrain never scars the lawn', () => {
    expect(craterEligible(greenWorld(), 0, 3, 0)).toBe(false)
    expect(craterEligible(greenWorld(), 0, -3, 0)).toBe(false)
  })

  test('road footprint excluded, verge just past it is not', () => {
    const world = greenWorld({ road: [roadRect()] })
    expect(craterEligible(world, 10, 0.1, 0)).toBe(false)
    // 0.5 m off the pavement edge — outside pointOnRoad's 0.3 m margin.
    expect(craterEligible(world, 4.5, 0.1, 0)).toBe(true)
  })

  test('building AABB floors excluded, lawn beside them is not', () => {
    const building = new Box3(new Vector3(-6, 0, -6), new Vector3(6, 3, 6))
    const world = greenWorld({ building })
    expect(craterEligible(world, 1, 0.1, 1)).toBe(false)
    expect(craterEligible(world, 8, 0.1, 8)).toBe(true)
  })
})

describe('crater size', () => {
  test('scales with blast radius between the diameter clamps', () => {
    // The stock grenade (blast 3.2) digs a 2.08 m-wide hole.
    expect(craterRadiusFor(3.2)).toBeCloseTo(1.04, 5)
    expect(craterRadiusFor(0.5)).toBeCloseTo(CRATER_MIN_DIAMETER / 2, 5)
    expect(craterRadiusFor(50)).toBeCloseTo(CRATER_MAX_DIAMETER / 2, 5)
  })
})

describe('craterProfile', () => {
  test('center depth, rim crest, flush edge', () => {
    expect(craterProfile(0)).toBeCloseTo(-CRATER_DEPTH, 6)
    expect(craterProfile(CRATER_RIM_T)).toBeCloseTo(CRATER_RIM_HEIGHT, 6)
    expect(craterProfile(1)).toBe(0)
    expect(craterProfile(1.5)).toBe(0)
  })

  test('mid-bowl stays below grade and the bowl flank only rises', () => {
    expect(craterProfile(0.35)).toBeLessThan(0)
    let previous = craterProfile(0)
    for (let t = 0.05; t <= CRATER_RIM_T + 1e-9; t += 0.05) {
      const y = craterProfile(t)
      expect(y).toBeGreaterThanOrEqual(previous)
      previous = y
    }
  })
})

describe('buildCraterGeometry', () => {
  test('displaced patch: exact center depth, exact flush outer ring', () => {
    const radius = 1.04
    const geometry = buildCraterGeometry(radius, 7)
    const position = geometry.getAttribute('position')
    expect(position.count).toBe(1 + 5 * 20)
    expect(position.getY(0)).toBeCloseTo(-CRATER_DEPTH, 5)
    // Outer ring: zero displacement AND zero jitter — meets the lawn flush.
    for (let i = position.count - 20; i < position.count; i++) {
      expect(position.getY(i)).toBe(0)
      expect(Math.hypot(position.getX(i), position.getZ(i))).toBeCloseTo(radius, 5)
    }
    expect(geometry.getIndex()).not.toBeNull()
    expect(geometry.getAttribute('normal')).toBeDefined()
  })

  test('vertex colors run charred center → soil brown rim', () => {
    const geometry = buildCraterGeometry(1, 21)
    const color = geometry.getAttribute('color')
    expect(color.itemSize).toBe(3)
    // Soil is much redder than char; shade jitter (±8%) cannot cross them.
    expect(color.getX(0)).toBeLessThan(color.getX(color.count - 1))
  })

  test('deterministic per seed, varied across seeds', () => {
    const a = buildCraterGeometry(1, 5)
    const b = buildCraterGeometry(1, 5)
    const c = buildCraterGeometry(1, 6)
    const ax = a.getAttribute('position').getX(25)
    expect(b.getAttribute('position').getX(25)).toBe(ax)
    expect(c.getAttribute('position').getX(25)).not.toBe(ax)
  })
})

describe('buildScorchGeometry', () => {
  test('RGBA vertex colors fade to zero alpha at the outer ring', () => {
    const geometry = buildScorchGeometry(1.04)
    const color = geometry.getAttribute('color')
    expect(color.itemSize).toBe(4)
    expect(color.getW(0)).toBeGreaterThan(0.5)
    for (let i = color.count - 20; i < color.count; i++) {
      expect(color.getW(i)).toBe(0)
    }
  })
})

describe('ring buffer', () => {
  test('caps at CRATER_CAP and reuses the oldest slot with a gen bump', () => {
    const world = greenWorld()
    for (let i = 0; i < CRATER_CAP + 3; i++) {
      expect(spawnCrater(world, new Vector3(30 + i, 0.1, 0), 3.2)).toBe(true)
    }
    expect(liveCraters()).toBe(CRATER_CAP)
    const slots = craterSlots()
    // Slots 0–2 were reclaimed by booms 17–19…
    expect(slots[0]!.x).toBe(30 + CRATER_CAP)
    expect(slots[2]!.x).toBe(32 + CRATER_CAP)
    expect(slots[0]!.gen).toBe(2)
    // …slot 3 still holds boom 4.
    expect(slots[3]!.x).toBe(33)
    expect(slots[3]!.gen).toBe(1)
  })

  test('ineligible blasts spawn nothing and consume no slot', () => {
    const world = greenWorld({ road: [roadRect()] })
    expect(spawnCrater(world, new Vector3(10, 0.1, 0), 3.2)).toBe(false)
    expect(liveCraters()).toBe(0)
    expect(spawnCrater(world, new Vector3(30, 0.1, 0), 3.2)).toBe(true)
    expect(craterSlots()[0]!.alive).toBe(true)
  })

  test('resetCraters clears every slot and restarts the cursor', () => {
    const world = greenWorld()
    spawnCrater(world, new Vector3(30, 0.1, 0), 3.2)
    spawnCrater(world, new Vector3(31, 0.1, 0), 3.2)
    resetCraters()
    expect(liveCraters()).toBe(0)
    spawnCrater(world, new Vector3(40, 0.1, 0), 3.2)
    expect(craterSlots()[0]!.x).toBe(40)
  })
})

describe('scatter clearing', () => {
  test('clearScatterInRadius zero-scales blades in range, once', () => {
    const { mesh, matrices } = field([
      [0, 0, 0],
      [0.5, 0, 0.2],
      [3, 0, 0],
      [10, 0, 5],
    ])
    expect(scatterFieldCount()).toBe(1)
    expect(clearScatterInRadius(0, 0, 1)).toBe(2)
    const check = new Matrix4()
    mesh.getMatrixAt(0, check)
    expect(check.elements[0]).toBe(0)
    mesh.getMatrixAt(2, check)
    expect(check.elements[0]).toBe(1)
    // Source matrices zeroed too — a mesh re-attach must not regrow them.
    expect(matrices[1]!.elements[5]).toBe(0)
    // Second pass: already-cleared blades are skipped, not re-counted.
    expect(clearScatterInRadius(0, 0, 1)).toBe(0)
  })

  test('spawnCrater strips blades inside the scar, spares the far field', () => {
    const { matrices } = field([
      [100, 0, 100],
      [100.6, 0, 99.8],
      [105, 0, 100],
    ])
    expect(spawnCrater(greenWorld(), new Vector3(100, 0.1, 100), 3.2)).toBe(true)
    // Scar clearing reaches radius × 1.05 = 1.092 m.
    expect(matrices[0]!.elements[0]).toBe(0)
    expect(matrices[1]!.elements[0]).toBe(0)
    expect(matrices[2]!.elements[0]).toBe(1)
  })
})
