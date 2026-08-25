import { describe, expect, test } from 'bun:test'
import { Vector3 } from 'three'
import {
  BURN_SECONDS,
  buildTreesFrom,
  CHAR_HITS,
  type CombatTree,
  damageTree,
  IGNITE_CANOPY,
  raycastTrees,
  TREE_HP,
  type TreePlacement,
  updateBurning,
} from './trees-destruct'

/**
 * Combat-tree state machine + analytic raycasts, headless. The rendering /
 * sfx side (bursts, crackle, smoke) is effect-only and reviewed in the
 * component; everything decision-shaped lives in these pure helpers.
 */

const PLACEMENT: TreePlacement = { x: 10, z: 0, scale: 1, yaw: 0, color: [0.25, 0.43, 0.2] }

function tree(overrides: Partial<TreePlacement> = {}): CombatTree {
  return buildTreesFrom([{ ...PLACEMENT, ...overrides }])[0]!
}

const ORIGIN = new Vector3(0, 1.2, 0)
const PLUS_X = new Vector3(1, 0, 0)

describe('buildTreesFrom', () => {
  test('ids are array indices and every tree starts healthy at full hp', () => {
    const trees = buildTreesFrom([PLACEMENT, { ...PLACEMENT, x: 20 }, { ...PLACEMENT, x: 30 }])
    expect(trees.map((t) => t.id)).toEqual([0, 1, 2])
    for (const t of trees) {
      expect(t.state).toBe('healthy')
      expect(t.hp).toBe(TREE_HP)
      expect(t.canopyDamage).toBe(0)
      expect(t.charHits).toBe(CHAR_HITS)
    }
  })
})

describe('raycastTrees', () => {
  test('level shot at the trunk hits part trunk at cylinder range', () => {
    const hit = raycastTrees([tree()], ORIGIN, PLUS_X, 90)
    expect(hit).not.toBeNull()
    expect(hit!.part).toBe('trunk')
    // Trunk front face: x = 10 - 0.2 (base radius) from x = 0.
    expect(hit!.distance).toBeCloseTo(9.8, 5)
    expect(hit!.point.x).toBeCloseTo(9.8, 5)
  })

  test('high shot hits the canopy sphere, not the trunk', () => {
    const origin = new Vector3(0, 3.4, 0) // canopy center height (scale 1)
    const hit = raycastTrees([tree()], origin, PLUS_X, 90)
    expect(hit).not.toBeNull()
    expect(hit!.part).toBe('canopy')
    expect(hit!.distance).toBeCloseTo(10 - 1.55, 5)
  })

  test('mid-height shot clears the trunk and takes the nearer canopy', () => {
    // Trunk tops scale with the tree: 2.4 m at scale 1. A shot at y 3.0
    // sails over the small tree's trunk but clips its crown before ever
    // reaching the taller tree behind it.
    const small = tree({ scale: 1 })
    const big = { ...tree({ x: 20, scale: 1.5 }), id: 1 }
    const origin = new Vector3(0, 3.0, 0)
    const hit = raycastTrees([small, big], origin, PLUS_X, 90)
    expect(hit).not.toBeNull()
    // y 3.0 is inside the SMALL tree's canopy sphere (center 3.4 r 1.55).
    expect(hit!.treeId).toBe(0)
    expect(hit!.part).toBe('canopy')
  })

  test('stumps never block shots; charred trees lose the canopy ball', () => {
    const stump = tree()
    stump.state = 'stump'
    expect(raycastTrees([stump], ORIGIN, PLUS_X, 90)).toBeNull()

    const charred = tree()
    charred.state = 'charred'
    const high = raycastTrees([charred], new Vector3(0, 3.4, 0), PLUS_X, 90)
    expect(high).toBeNull() // no crown left up there
    const low = raycastTrees([charred], ORIGIN, PLUS_X, 90)
    expect(low?.part).toBe('trunk') // the black trunk still stands
  })

  test('maxDist culls', () => {
    expect(raycastTrees([tree()], ORIGIN, PLUS_X, 5)).toBeNull()
  })
})

describe('damageTree state machine', () => {
  test('trunk fire fells at hp 0 — voxel collapse to a stump', () => {
    const t = tree()
    expect(damageTree(t, 'trunk', 24)).toBe('chip')
    expect(damageTree(t, 'trunk', 24)).toBe('chip')
    expect(damageTree(t, 'trunk', 24)).toBe('fell') // 72 ≥ TREE_HP
    expect(t.state).toBe('stump')
    // A stump takes no further damage.
    expect(damageTree(t, 'trunk', 24)).toBe('none')
  })

  test('canopy damage ignites at the threshold instead of felling', () => {
    const t = tree()
    expect(damageTree(t, 'canopy', 24)).toBe('chip')
    expect(damageTree(t, 'canopy', 24)).toBe('ignite') // 48 ≥ IGNITE_CANOPY
    expect(t.state).toBe('burning')
    expect(t.canopyDamage).toBeGreaterThanOrEqual(IGNITE_CANOPY)
  })

  test('a burning tree can still be shot down early (charcoal fell)', () => {
    const t = tree()
    damageTree(t, 'canopy', 24)
    damageTree(t, 'canopy', 24) // ignite at hp 22
    expect(t.state).toBe('burning')
    expect(damageTree(t, 'trunk', 24)).toBe('fell')
    expect(t.state).toBe('stump')
  })

  test('burning runs its clock then chars; charred snaps branch by branch', () => {
    const t = tree()
    damageTree(t, 'canopy', 24)
    damageTree(t, 'canopy', 24)
    const finished: number[] = []
    // Half the burn: still burning, nothing finished.
    expect(updateBurning([t], BURN_SECONDS / 2, finished)).toBe(1)
    expect(finished).toEqual([])
    // The rest of the burn: crown done, tree charred, branches restocked.
    expect(updateBurning([t], BURN_SECONDS, finished)).toBe(0)
    expect(finished).toEqual([t.id])
    expect(t.state).toBe('charred')
    expect(t.charHits).toBe(CHAR_HITS)
    // Charcoal sticks: each hit snaps one branch, the last breaks the trunk.
    expect(damageTree(t, 'trunk', 10)).toBe('charHit')
    expect(damageTree(t, 'trunk', 10)).toBe('charHit')
    expect(damageTree(t, 'trunk', 10)).toBe('collapse')
    expect(t.state).toBe('stump')
  })

  test('updateBurning ignores healthy/charred/stump trees', () => {
    const healthy = tree()
    const charred = tree({ x: 20 })
    charred.state = 'charred'
    const finished: number[] = []
    expect(updateBurning([healthy, charred], 10, finished)).toBe(0)
    expect(finished).toEqual([])
    expect(healthy.state).toBe('healthy')
    expect(charred.state).toBe('charred')
  })
})
