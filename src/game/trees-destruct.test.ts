import { describe, expect, test } from 'bun:test'
import { sceneRegistry } from '@pascal-app/core'
import { BoxGeometry, Group, InstancedMesh, Matrix4, Mesh, type Object3D, Vector3 } from 'three'
import {
  BURN_SECONDS,
  buildTreesFrom,
  CHAR_HITS,
  COMBAT_TREE_APEX,
  type CombatTree,
  damageTree,
  HOST_TREE_CLEARANCE,
  hostTreePlacements,
  IGNITE_CANOPY,
  raycastTrees,
  TREE_HP,
  type TreePlacement,
  updateBurning,
  withoutHostOverlap,
} from './trees-destruct'
import {
  collectHostForestMeshes,
  collectHostTrees,
  type HostTreeNode,
  isForestInstancedMesh,
  isTreeKind,
} from './world'

/**
 * Combat-tree state machine + analytic raycasts, headless — plus the
 * phase-4 host-tree lane: the node-detection predicate (isTreeKind), the
 * registry collector (collectHostTrees), the collective-forest
 * InstancedMesh matcher (the meshes the session hides through the restore
 * ledger), and the transform-parity placement mapping. The rendering /
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

// ── Host-tree lane (phase 4) ────────────────────────────────────────────────

describe('elevated trees (host base y)', () => {
  test('a deck tree lifts its trunk and canopy; ground-height shots miss', () => {
    const deckTree = tree({ y: 4 })
    expect(deckTree.y).toBe(4)
    // Old ground-level trunk shot passes under the lifted tree.
    expect(raycastTrees([deckTree], ORIGIN, PLUS_X, 90)).toBeNull()
    // Same shot at deck height hits the trunk.
    const trunk = raycastTrees([deckTree], new Vector3(0, 4 + 1.2, 0), PLUS_X, 90)
    expect(trunk?.part).toBe('trunk')
    // Canopy sphere rides up with the base (center y + 3.4, r 1.55).
    const canopy = raycastTrees([deckTree], new Vector3(0, 4 + 3.4, 0), PLUS_X, 90)
    expect(canopy?.part).toBe('canopy')
    expect(canopy!.distance).toBeCloseTo(10 - 1.55, 5)
  })

  test('placements without y stay ground trees (default 0)', () => {
    expect(tree().y).toBe(0)
  })
})

describe('isTreeKind (node-detection predicate)', () => {
  test('matches exact tree/vegetation kinds and plugin-namespaced ones', () => {
    expect(isTreeKind('tree')).toBe(true)
    expect(isTreeKind('vegetation')).toBe(true)
    // The community vegetation plugin registers this kind.
    expect(isTreeKind('trees:tree')).toBe(true)
    expect(isTreeKind('landscape:vegetation')).toBe(true)
  })

  test('never matches ground flora, host solids, or lookalike names', () => {
    expect(isTreeKind('trees:grass')).toBe(false)
    expect(isTreeKind('trees:flower')).toBe(false)
    expect(isTreeKind('wall')).toBe(false)
    expect(isTreeKind('item')).toBe(false)
    expect(isTreeKind('streetscape:road-network')).toBe(false)
    expect(isTreeKind('bones:framing')).toBe(false)
    // Suffix requires the plugin namespace colon — a kind merely ENDING in
    // "tree" is not vegetation.
    expect(isTreeKind('mytree')).toBe(false)
    expect(isTreeKind('')).toBe(false)
  })
})

/** Register a root under a kind the way the host's useRegistry does. */
function register(id: string, kind: string, root: Object3D): () => void {
  sceneRegistry.nodes.set(id, root)
  sceneRegistry.byType[kind]!.add(id)
  return () => {
    sceneRegistry.nodes.delete(id)
    sceneRegistry.byType[kind]!.delete(id)
  }
}

describe('collectHostTrees', () => {
  test('captures world transform, yaw, height and the hidden flag', () => {
    const level = new Group()
    level.position.set(10, 0, 2)
    const treeRoot = new Group()
    treeRoot.position.set(1, 0.5, 1)
    level.add(treeRoot)

    const hiddenLevel = new Group()
    hiddenLevel.visible = false
    const hiddenRoot = new Group()
    hiddenLevel.add(hiddenRoot)

    const grassRoot = new Group()
    const cleanups = [
      register('t-oak', 'trees:tree', treeRoot),
      register('t-hidden', 'trees:tree', hiddenRoot),
      register('t-grass', 'trees:grass', grassRoot),
    ]
    try {
      const hostTrees = collectHostTrees({
        't-oak': { rotation: [0, 1.2, 0], height: 7.95 },
        't-hidden': { rotation: [0, 0, 0], height: 7 },
        't-grass': { height: 0.4 },
      })
      expect(hostTrees.map((t) => t.nodeId).sort()).toEqual(['t-hidden', 't-oak'])
      const oak = hostTrees.find((t) => t.nodeId === 't-oak')!
      expect(oak.x).toBeCloseTo(11, 6)
      expect(oak.y).toBeCloseTo(0.5, 6)
      expect(oak.z).toBeCloseTo(3, 6)
      expect(oak.yaw).toBeCloseTo(1.2, 6)
      expect(oak.height).toBeCloseTo(7.95, 6)
      expect(oak.hidden).toBe(false)
      // Hidden branches are captured (forest matching needs every instance)
      // but flagged so no combat replacement spawns for them.
      expect(hostTrees.find((t) => t.nodeId === 't-hidden')!.hidden).toBe(true)
    } finally {
      for (const cleanup of cleanups) cleanup()
    }
  })

  test('defaults height when the node carries none and skips rootless ids', () => {
    const root = new Group()
    const cleanups = [register('t-bare', 'tree', root)]
    sceneRegistry.byType['tree']!.add('t-ghost') // id with no registered root
    try {
      const hostTrees = collectHostTrees({ 't-bare': {}, 't-ghost': { height: 9 } })
      expect(hostTrees).toHaveLength(1)
      expect(hostTrees[0]!.height).toBe(6)
      expect(hostTrees[0]!.yaw).toBe(0)
    } finally {
      sceneRegistry.byType['tree']!.delete('t-ghost')
      for (const cleanup of cleanups) cleanup()
    }
  })
})

/** A HostTreeNode fixture without registry plumbing (matching is pure). */
function hostTree(overrides: Partial<HostTreeNode> = {}): HostTreeNode {
  return {
    nodeId: 'h',
    root: new Group(),
    x: 5,
    y: 0,
    z: 5,
    yaw: 0,
    height: 7,
    hidden: false,
    ...overrides,
  }
}

/** An InstancedMesh with `count` live instances at the given translations
 * (capacity padded past count, the way instanced plant systems allocate). */
function forestMesh(positions: Array<[number, number, number]>): InstancedMesh {
  const mesh = new InstancedMesh(new BoxGeometry(1, 1, 1), undefined, positions.length + 8)
  const matrix = new Matrix4()
  positions.forEach((p, i) => mesh.setMatrixAt(i, matrix.makeTranslation(p[0], p[1], p[2])))
  mesh.count = positions.length
  return mesh
}

describe('isForestInstancedMesh + collectHostForestMeshes', () => {
  const trees = [hostTree({ nodeId: 'a', x: 5, z: 5 }), hostTree({ nodeId: 'b', x: 8, z: 2 })]

  test('matches exactly when every live instance stands on a captured tree', () => {
    expect(isForestInstancedMesh(forestMesh([[5, 0, 5], [8, 0, 2]]), trees)).toBe(true)
    // Variant buckets are subsets of the forest — one instance still matches.
    expect(isForestInstancedMesh(forestMesh([[8, 0, 2]]), trees)).toBe(true)
    // Floor-lift wobble on y is tolerated; xz is tight.
    expect(isForestInstancedMesh(forestMesh([[5, 0.8, 5]]), trees)).toBe(true)
  })

  test('rejects strangers: off-tree instances, over-count, empty, non-instanced', () => {
    expect(isForestInstancedMesh(forestMesh([[5, 0, 5], [20, 0, 20]]), trees)).toBe(false)
    expect(isForestInstancedMesh(forestMesh([[5.5, 0, 5]]), trees)).toBe(false)
    expect(isForestInstancedMesh(forestMesh([[5, 0, 5], [8, 0, 2], [6, 0, 6]]), trees)).toBe(false)
    expect(isForestInstancedMesh(forestMesh([]), trees)).toBe(false)
    expect(isForestInstancedMesh(new Mesh(new BoxGeometry(1, 1, 1)), trees)).toBe(false)
    expect(isForestInstancedMesh(forestMesh([[5, 0, 5]]), [])).toBe(false)
  })

  test('scene walk finds forest meshes but never inside __boots subtrees', () => {
    const sceneRoot = new Group()
    const forest = forestMesh([[5, 0, 5], [8, 0, 2]])
    const stranger = forestMesh([[40, 0, 40]])
    sceneRoot.add(forest, stranger)
    // The combat grove stands at the SAME transforms — must never match.
    const boots = new Group()
    boots.userData.__boots = true
    boots.add(forestMesh([[5, 0, 5], [8, 0, 2]]))
    sceneRoot.add(boots)

    const found = collectHostForestMeshes(sceneRoot, trees)
    expect(found).toEqual([forest])
    expect(collectHostForestMeshes(sceneRoot, [])).toEqual([])
  })
})

describe('hostTreePlacements + withoutHostOverlap', () => {
  test('replacement placements keep the host transform; hidden trees skipped', () => {
    const placements = hostTreePlacements([
      hostTree({ nodeId: 'a', x: 3, y: 1.5, z: -4, yaw: 0.7, height: COMBAT_TREE_APEX }),
      hostTree({ nodeId: 'gone', hidden: true }),
      hostTree({ nodeId: 'big', x: 9, z: 9, height: 100 }),
    ])
    expect(placements.map((p) => p.nodeId)).toEqual(['a', 'big'])
    const a = placements[0]!
    expect(a.x).toBe(3)
    expect(a.y).toBe(1.5)
    expect(a.z).toBe(-4)
    expect(a.yaw).toBeCloseTo(0.7, 6)
    // height / COMBAT_TREE_APEX → a same-height combat tree.
    expect(a.scale).toBeCloseTo(1, 6)
    for (const c of a.color) expect(c).toBeGreaterThan(0)
    // Absurd heights clamp instead of spawning an unraycastable monster.
    expect(placements[1]!.scale).toBeLessThanOrEqual(2.6)
  })

  test('scattered trees clear off host-tree spots (and only those)', () => {
    const host = [hostTree({ x: 10, z: 0 })]
    const near: TreePlacement = { ...PLACEMENT, x: 10 + HOST_TREE_CLEARANCE * 0.6, z: 0 }
    const far: TreePlacement = { ...PLACEMENT, x: 10 + HOST_TREE_CLEARANCE * 1.4, z: 0 }
    expect(withoutHostOverlap([near, far], host)).toEqual([far])
    // No host trees → untouched (same array back, no copies).
    const all = [near, far]
    expect(withoutHostOverlap(all, [])).toBe(all)
  })
})
