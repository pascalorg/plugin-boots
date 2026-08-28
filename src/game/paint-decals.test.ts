import { afterEach, describe, expect, test } from 'bun:test'
import { Mesh, PlaneGeometry, SphereGeometry, Vector3 } from 'three'
import { useDestruction, type VoxelTarget } from './destruction'
import {
  DECAL_CAP,
  DECAL_MAX_TRIS,
  DECAL_NODE_CAP,
  decalCensus,
  decalEligibleTris,
  decalMaterialFor,
  convertDecalsForNode,
  flushRetiredDecalGeometries,
  getDecalVotesByNode,
  getPaintedByNode,
  PAINT_PALETTE,
  paintColorOf,
  paintStrengthOf,
  releaseNodeDecals,
  resetPaint,
  resetPaintDecals,
  retiredDecalCensus,
  spawnPaintDecal,
} from './paint'
import { capturePaint, DECAL_VOTE_PER_M2, usePaintKeep } from './paint-keep'

/**
 * P5 decal lane pins: the DecalGeometry clip runs pure-CPU, so caps,
 * per-node recycling, area votes, the ledger conversion and the material
 * cache all test headless against real meshes.
 */

afterEach(() => {
  resetPaintDecals()
  resetPaint()
  useDestruction.getState().reset()
  usePaintKeep.getState().clear()
})

/** A 6×6 host wall facing +Z at the origin (2 triangles — always clips). */
const wallMesh = () => {
  const mesh = new Mesh(new PlaneGeometry(6, 6))
  mesh.updateMatrixWorld(true)
  return mesh
}
const N = new Vector3(0, 0, 1)
const at = (x: number, y = 0) => new Vector3(x, y, 0)

describe('spawnPaintDecal (pristine hosts, P5)', () => {
  test('clips a splat, tracks the census, votes its area', () => {
    const mesh = wallMesh()
    expect(spawnPaintDecal(mesh, 'wall_a', at(0), N, 0.4, 2)).toBe(true)
    expect(decalCensus()).toBe(1)
    expect(decalCensus('wall_a')).toBe(1)
    const votes = getDecalVotesByNode().get('wall_a')!
    expect(votes.get(2)!).toBeCloseTo(Math.PI * 0.4 * 0.4, 10)
    // A second coat of another color votes separately.
    expect(spawnPaintDecal(mesh, 'wall_a', at(1), N, 0.2, 5)).toBe(true)
    expect(getDecalVotesByNode().get('wall_a')!.get(5)!).toBeCloseTo(Math.PI * 0.04, 10)
  })

  test('triangle guard: heavy meshes fall back (spawn refuses)', () => {
    expect(decalEligibleTris(DECAL_MAX_TRIS)).toBe(true)
    expect(decalEligibleTris(DECAL_MAX_TRIS + 1)).toBe(false)
    const heavy = new Mesh(new SphereGeometry(1, 96, 96)) // ~18k tris
    heavy.updateMatrixWorld(true)
    expect(spawnPaintDecal(heavy, 'dome', at(0, 1), N, 0.3, 1)).toBe(false)
    expect(decalCensus()).toBe(0)
  })

  test('a clip that misses the surface spawns nothing', () => {
    const mesh = wallMesh()
    expect(spawnPaintDecal(mesh, 'wall_a', at(50), N, 0.3, 1)).toBe(false)
    expect(decalCensus()).toBe(0)
  })

  test('per-node cap recycles the NODE\'s oldest — never the neighbors', () => {
    const mesh = wallMesh()
    expect(spawnPaintDecal(mesh, 'wall_b', at(-2), N, 0.2, 1)).toBe(true)
    for (let i = 0; i < DECAL_NODE_CAP + 6; i++) {
      expect(spawnPaintDecal(mesh, 'wall_a', at((i % 12) * 0.25 - 1.5), N, 0.2, 2)).toBe(true)
    }
    expect(decalCensus('wall_a')).toBe(DECAL_NODE_CAP)
    // The other node's splat survived the churn.
    expect(decalCensus('wall_b')).toBe(1)
    expect(decalCensus()).toBe(DECAL_NODE_CAP + 1)
  })

  test('global ring cap holds at DECAL_CAP across many nodes', () => {
    const mesh = wallMesh()
    const nodes = 6
    const per = 50 // 6 × 50 = 300 > 256, per-node stays under 64
    for (let n = 0; n < nodes; n++) {
      for (let i = 0; i < per; i++) {
        expect(spawnPaintDecal(mesh, `wall_${n}`, at((i % 10) * 0.3 - 1.5, n * 0.4 - 1), N, 0.15, n % 7)).toBe(true)
      }
    }
    expect(decalCensus()).toBe(DECAL_CAP)
  })
})

describe('decal slot lifecycle (deferred dispose + operable release)', () => {
  test('eviction DEFERS geometry disposal until the flush (VAO-leak regression)', () => {
    const mesh = wallMesh()
    expect(spawnPaintDecal(mesh, 'wall_a', at(0), N, 0.3, 1)).toBe(true)
    flushRetiredDecalGeometries() // clear anything earlier tests queued
    // Over-spray the node past its cap: each eviction retires a geometry
    // but must NOT dispose it inside the tick (the slot mesh still renders
    // once more this frame).
    for (let i = 0; i < DECAL_NODE_CAP; i++) {
      expect(spawnPaintDecal(mesh, 'wall_a', at((i % 12) * 0.25 - 1.5), N, 0.2, 1)).toBe(true)
    }
    expect(decalCensus('wall_a')).toBe(DECAL_NODE_CAP)
    expect(retiredDecalCensus()).toBe(1)
    flushRetiredDecalGeometries()
    expect(retiredDecalCensus()).toBe(0)
  })

  test('releaseNodeDecals frees exactly one node (the door-toggle hook)', () => {
    const mesh = wallMesh()
    expect(spawnPaintDecal(mesh, 'door_1', at(0), N, 0.3, 2)).toBe(true)
    expect(spawnPaintDecal(mesh, 'wall_z', at(1), N, 0.3, 2)).toBe(true)
    releaseNodeDecals('door_1')
    expect(decalCensus('door_1')).toBe(0)
    expect(decalCensus('wall_z')).toBe(1)
    releaseNodeDecals('never_painted') // cheap no-op
  })
})

describe('decal material/texture cache', () => {
  test('bounded to the palette, shared per coat', () => {
    for (let i = 0; i < PAINT_PALETTE.length; i++) {
      const material = decalMaterialFor(i)
      expect(material).not.toBeNull()
      expect(decalMaterialFor(i)).toBe(material!) // cached, never re-minted
      expect(material!.polygonOffsetFactor).toBe(-4)
      expect(material!.depthWrite).toBe(false)
    }
    expect(decalMaterialFor(PAINT_PALETTE.length)).toBeNull()
    expect(decalMaterialFor(-1)).toBeNull()
  })
})

/** Minimal live target: a row of 5 cells along X at z = 0, spacing 0.15. */
const fakeTarget = (nodeId: string): VoxelTarget => {
  const count = 5
  const centers = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) centers[i * 3] = (i - 2) * 0.15
  return {
    nodeId,
    kind: 'wall',
    dormant: false,
    grid: { count, alive: new Uint8Array(count).fill(1), centers },
  } as unknown as VoxelTarget
}

describe('decal → ledger conversion (the target-live hook body)', () => {
  test('decals become full falloff coats in the cell ledger, slots free', () => {
    const mesh = wallMesh()
    const target = fakeTarget('wall_a')
    useDestruction.getState().targets.set('wall_a', target)
    expect(spawnPaintDecal(mesh, 'wall_a', at(0), N, 0.4, 3)).toBe(true)
    convertDecalsForNode('wall_a')
    const cells = getPaintedByNode().get('wall_a')!
    expect(cells.size).toBeGreaterThan(0)
    // The cell under the splat center took a FULL coat of the decal color.
    const center = cells.get(2)!
    expect(paintColorOf(center)).toBe(3)
    expect(paintStrengthOf(center)).toBe(1)
    // Off-center cells feathered below it (the splatCoat curve / COAT_ADD).
    const side = cells.get(1)
    if (side !== undefined) {
      expect(paintStrengthOf(side)).toBeLessThanOrEqual(1)
      expect(paintStrengthOf(side)).toBeGreaterThan(0)
    }
    // Slots freed — the replica's drain owns the paint now.
    expect(decalCensus('wall_a')).toBe(0)
    expect(getDecalVotesByNode().has('wall_a')).toBe(false)
  })

  test('dormant members and foreign nodes are untouched', () => {
    const mesh = wallMesh()
    const dormant = fakeTarget('wall_d')
    ;(dormant as { dormant?: boolean }).dormant = true
    useDestruction.getState().targets.set('wall_d', dormant)
    expect(spawnPaintDecal(mesh, 'wall_d', at(0), N, 0.4, 1)).toBe(true)
    expect(spawnPaintDecal(mesh, 'wall_e', at(1), N, 0.3, 2)).toBe(true)
    convertDecalsForNode('wall_d')
    // Dormant grid caught nothing, but the node's slots still freed (its
    // host surface is gone); the OTHER node's decal survives.
    expect(getPaintedByNode().get('wall_d')).toBeUndefined()
    expect(decalCensus('wall_d')).toBe(0)
    expect(decalCensus('wall_e')).toBe(1)
  })
})

describe('capturePaint with live decals (area-weighted votes)', () => {
  test('a decal-only node is captured with its coat', () => {
    const mesh = wallMesh()
    expect(spawnPaintDecal(mesh, 'wall_p2', at(0), N, 0.4, 4)).toBe(true)
    expect(capturePaint()).toBe(1)
    const captured = usePaintKeep.getState().painted[0]!
    expect(captured.nodeId).toBe('wall_p2')
    expect(captured.color).toBe(PAINT_PALETTE[4]!.hex)
    const expectedCells = Math.round((Math.PI * 0.16 * DECAL_VOTE_PER_M2) / 255)
    expect(captured.cells).toBe(expectedCells)
  })

  test('REGRESSION: roof member-id ledger entries save under the BARE scene id', () => {
    // Roof shells voxelize into `<sceneId>#p<n>` member targets; the
    // decal→ledger conversion (and plain spraying of a voxelized roof)
    // keys the ledger by those ids. Save must merge them into the bare id —
    // buildPaintPatches can only patch real scene nodes.
    const p0 = fakeTarget('roof1#p0')
    const p1 = fakeTarget('roof1#p1')
    useDestruction.getState().targets.set('roof1#p0', p0)
    useDestruction.getState().targets.set('roof1#p1', p1)
    const ledger = getPaintedByNode() as Map<string, Map<number, number>>
    ledger.set('roof1#p0', new Map([[0, (2 << 8) | 255]]))
    ledger.set('roof1#p1', new Map([[1, (2 << 8) | 200], [2, (4 << 8) | 40]]))
    expect(capturePaint()).toBe(1)
    const captured = usePaintKeep.getState().painted[0]!
    expect(captured.nodeId).toBe('roof1')
    expect(captured.color).toBe(PAINT_PALETTE[2]!.hex)
    expect(captured.cells).toBe(3)
  })

  test('REGRESSION: decals converted on a roof member reach the Save patch', () => {
    const mesh = wallMesh()
    // The plane family lives ONLY under member ids (destruction.ts:1513).
    const member = fakeTarget('roof2#p0')
    useDestruction.getState().targets.set('roof2#p0', member)
    // Spray the pristine roof (decals key by the scene id the collider has)…
    expect(spawnPaintDecal(mesh, 'roof2', at(0), N, 0.4, 3)).toBe(true)
    // …then a bullet voxelizes it: the target-live hook converts.
    convertDecalsForNode('roof2')
    expect(decalCensus('roof2')).toBe(0)
    expect(getPaintedByNode().has('roof2#p0')).toBe(true) // drain keeps rendering
    expect(capturePaint()).toBe(1)
    expect(usePaintKeep.getState().painted[0]!.nodeId).toBe('roof2') // Save patches
  })

  test('decal area outvotes a couple of faint ledger cells', () => {
    const mesh = wallMesh()
    const target = fakeTarget('wall_mix')
    useDestruction.getState().targets.set('wall_mix', target)
    // Faint navy cells in the voxel ledger…
    const ledger = getPaintedByNode() as Map<string, Map<number, number>>
    ledger.set(
      'wall_mix',
      new Map([
        [0, (4 << 8) | 30],
        [1, (4 << 8) | 30],
      ]),
    )
    // …versus one broad sage decal: ~0.5 m² ≈ 22 saturated cells.
    expect(spawnPaintDecal(mesh, 'wall_mix', at(0), N, 0.4, 2)).toBe(true)
    expect(capturePaint()).toBe(1)
    expect(usePaintKeep.getState().painted[0]!.color).toBe(PAINT_PALETTE[2]!.hex)
  })
})
