import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, InstancedMesh, Matrix4, Vector3 } from 'three'
import {
  BREACH_LIFT,
  BREACH_MAX_BASE_Y,
  BREACH_MIN_Y,
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
  spawnFloorBreach,
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
    // Gens are CUMULATIVE module state (React keys must never repeat), so
    // other suites' spawns in the same process count too — assert deltas.
    const gen0 = craterSlots()[0]!.gen
    const gen3 = craterSlots()[3]!.gen
    for (let i = 0; i < CRATER_CAP + 3; i++) {
      expect(spawnCrater(world, new Vector3(30 + i, 0.1, 0), 3.2)).toBe(true)
    }
    expect(liveCraters()).toBe(CRATER_CAP)
    const slots = craterSlots()
    // Slots 0–2 were reclaimed by booms 17–19…
    expect(slots[0]!.x).toBe(30 + CRATER_CAP)
    expect(slots[2]!.x).toBe(32 + CRATER_CAP)
    expect(slots[0]!.gen).toBe(gen0 + 2)
    // …slot 3 still holds boom 4.
    expect(slots[3]!.x).toBe(33)
    expect(slots[3]!.gen).toBe(gen3 + 1)
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

describe('floor breach decals (owner: "broken floor looks broken")', () => {
  test('bypasses the green veto: stamps where craterEligible says no', () => {
    // Under the building AABB and on a road footprint — both blast-crater
    // vetoes, both by definition where a breached slab sits.
    const building = new Box3(new Vector3(5, 0, -6), new Vector3(15, 3, 6))
    const world = greenWorld({ road: [roadRect()], building })
    expect(craterEligible(world, 10, 0.1, 0)).toBe(false)
    expect(spawnFloorBreach(10, 0, 0, 0.7)).toBe(true)
    const slot = craterSlots().find((s) => s.alive && s.breach)!
    expect(slot.x).toBe(10)
    // Ground slab (base 0): the decal floats in the lawn-plane band —
    // above the grass disc at 0.05, below the crater profile's rim reach.
    expect(slot.y).toBeCloseTo(BREACH_MIN_Y, 10)
    // Modest: carve radius × 1.2, never the blast-crater diameter clamps.
    expect(slot.radius).toBeCloseTo(0.7 * 1.2, 5)
  })

  test('upper storeys never stamp; raised ground slabs lift the decal over their underlay', () => {
    expect(spawnFloorBreach(0, 0, BREACH_MAX_BASE_Y + 0.01, 0.7)).toBe(false)
    expect(liveCraters()).toBe(0)
    // A slab based at 0.3 m: decal rides the slab, not the lawn plane.
    expect(spawnFloorBreach(0, 0, 0.3, 0.7)).toBe(true)
    const slot = craterSlots().find((s) => s.alive && s.breach)!
    expect(slot.y).toBeCloseTo(0.3 + BREACH_LIFT, 10)
  })

  test('same-hole carves grow the decal in place; distinct holes claim distinct slots', () => {
    expect(spawnFloorBreach(0, 0, 0, 0.5)).toBe(true)
    const gen = craterSlots()[0]!.gen
    // Overlapping follow-up (0.4 m off, within reach): no new slot…
    expect(spawnFloorBreach(0.4, 0, 0, 0.5)).toBe(false)
    expect(liveCraters()).toBe(1)
    // …a WIDER overlap grows the existing decal (gen bump = remount)…
    expect(spawnFloorBreach(0.2, 0, 0, 0.9)).toBe(false)
    expect(liveCraters()).toBe(1)
    expect(craterSlots()[0]!.radius).toBeCloseTo(0.9 * 1.2, 5)
    expect(craterSlots()[0]!.gen).toBe(gen + 1)
    // …and a hole across the room is its own scar.
    expect(spawnFloorBreach(5, 5, 0, 0.5)).toBe(true)
    expect(liveCraters()).toBe(2)
  })

  test('size caps at the crater max; blast craters keep their own slot fields', () => {
    expect(spawnFloorBreach(20, 20, 0, 3)).toBe(true)
    const breach = craterSlots().find((s) => s.alive && s.breach)!
    expect(breach.radius).toBeCloseTo(CRATER_MAX_DIAMETER / 2, 5)
    // A lawn crater spawned after a breach stays a lawn crater (base y,
    // no breach flag) — the shared ring buffer never leaks variant state.
    expect(spawnCrater(greenWorld(), new Vector3(40, 0.1, 0), 3.2)).toBe(true)
    const crater = craterSlots().find((s) => s.alive && !s.breach)!
    expect(crater.y).toBeCloseTo(0.058, 10)
  })

  test('breach geometry wears the soil palette, not explosion char', () => {
    const char = buildCraterGeometry(1, 5)
    const soil = buildCraterGeometry(1, 5, true)
    // Same seed → same shade jitter; the breach center is earth (lighter,
    // warmer) while the rim converges on the same soil family.
    expect(soil.getAttribute('color').getX(0)).toBeGreaterThan(char.getAttribute('color').getX(0))
    const last = soil.getAttribute('color').count - 1
    expect(soil.getAttribute('color').getX(last)).toBeCloseTo(
      char.getAttribute('color').getX(last),
      10,
    )
    // The breach scorch centers on dark earth (still translucent, still
    // fading to zero at the outer ring).
    const scorch = buildScorchGeometry(1, true)
    const color = scorch.getAttribute('color')
    expect(color.getX(0)).toBeGreaterThan(buildScorchGeometry(1).getAttribute('color').getX(0))
    expect(color.getW(0)).toBeLessThan(1)
    expect(color.getW(color.count - 1)).toBe(0)
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
