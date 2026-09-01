import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  type AnyNodeDefinition,
  nodeRegistry,
  RoofSegmentNode,
  SlabNode,
  useScene,
  WallNode,
  WindowNode,
} from '@pascal-app/core'
import { useViewer } from '@pascal-app/viewer'
import { FULL_MASK, useBoots } from '../store'
import { parseSlotId, slotPose } from './grid'
import { keepPlaced } from './keep'

/**
 * Keep bridge contract (docs/BUILD-GRAMMAR-V2-REVIEW.md, agent 4):
 * - wall mask→node mapping unchanged (pure planning covered in
 *   builder.test.ts; here the real WallNode schema round-trip),
 * - floors ATTEMPT a real 'slab' node (3×3 footprint polygon at the slot
 *   pose, elevation = base y) — missing kind / schema failure counts
 *   skipped exactly like roofs, never throws,
 * - roofs unchanged.
 * The registry singleton is empty under bun test (only the HOST registers
 * kinds), so each block installs exactly what it needs — with the REAL
 * @pascal-app/core zod schemas, proving our payloads are host-valid.
 * useScene is the real core store; the viewer is the test-preload stub,
 * whose selection we re-pin per test (ids follow the host's `level_…`
 * template so the real ViewerState types accept them).
 */

const setLevel = (levelId: `level_${string}` | null) =>
  useViewer.setState({
    selection: { buildingId: null, levelId, zoneId: null, selectedIds: [] },
  })

type SceneNode = Record<string, unknown> & { id: string; type: string; parentId: string | null }

const sceneNodes = (): SceneNode[] => Object.values(useScene.getState().nodes) as SceneNode[]
const nodesOf = (type: string): SceneNode[] => sceneNodes().filter((n) => n.type === type)

const register = (kind: string, schema: unknown, defaults?: () => Record<string, unknown>) => {
  if (nodeRegistry.has(kind)) return
  nodeRegistry._register({ kind, schemaVersion: 1, schema, defaults } as unknown as AnyNodeDefinition)
}

const seed = (
  piece: 'wall' | 'floor' | 'stairs' | 'roof',
  position: [number, number, number],
  yaw = 0,
  mask = FULL_MASK,
  slotId?: string,
  corners?: [number, number, number, number],
) => useBoots.getState().addPlaced({ piece, position, yaw, mask, slotId, corners })

beforeEach(() => {
  useBoots.getState().resolvePlaced()
  useScene.getState().setScene({}, [])
  setLevel('level_test')
})

/** Hand the viewer stub's selection back the way the preload set it. The store
 * is process-wide and the block above re-pins it per test (including to null),
 * so a file that reads `selection.levelId` after this one — world-levels does —
 * would otherwise read OUR level id. */
afterEach(() => {
  useViewer.setState({ selection: { levelId: 'level-test' } } as never)
})

describe('keepPlaced with an EMPTY registry (host never registered kinds)', () => {
  test('everything counts skipped, nothing throws, session resolves', () => {
    nodeRegistry._reset()
    seed('wall', [1.5, 0, 0])
    seed('floor', [1.5, 0, 1.5], 0, FULL_MASK, 'F:0,0,0')
    seed('stairs', [4.5, 0, 1.5])
    const result = keepPlaced()
    expect(result).toEqual({ kept: 0, skipped: 3, windows: 0, doors: 0, roofs: 0, floors: 0 })
    expect(useBoots.getState().placed).toEqual([])
    expect(sceneNodes()).toEqual([])
  })
})

describe('keepPlaced against the REAL host schemas', () => {
  beforeAll(() => {
    nodeRegistry._reset()
    register('wall', WallNode, () => ({}))
    register('window', WindowNode, () => ({}))
    register('roof-segment', RoofSegmentNode, () => ({}))
    register('slab', SlabNode, () => ({}))
  })

  test('floor → slab node: 3×3 footprint polygon at the slot pose', () => {
    // Slot F:0,0,1 pose — center [1.5, 2.8, 1.5] (storey 1 ceiling flow).
    seed('floor', [1.5, 2.8, 1.5], 0, FULL_MASK, 'F:0,0,1')
    const result = keepPlaced()
    expect(result.kept).toBe(1)
    expect(result.floors).toBe(1)
    expect(result.skipped).toBe(0)
    const [slab] = nodesOf('slab')
    expect(slab).toBeDefined()
    expect(slab!.parentId).toBe('level_test')
    expect(slab!.elevation).toBe(2.8)
    expect(slab!.autoFromWalls).toBe(false)
    expect(slab!.holes).toEqual([])
    expect(slab!.polygon).toEqual([
      [0, 0],
      [3, 0],
      [3, 3],
      [0, 3],
    ])
  })

  test('floor yaw is honored: 90° rotation covers the same square cell', () => {
    seed('floor', [1.5, 0, 1.5], Math.PI / 2, FULL_MASK, 'F:0,0,0')
    expect(keepPlaced().floors).toBe(1)
    const [slab] = nodesOf('slab')
    const sorted = (slab!.polygon as [number, number][])
      .map(([x, z]) => [x, z] as const)
      .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    const want = [
      [0, 0],
      [0, 3],
      [3, 0],
      [3, 3],
    ]
    for (let c = 0; c < 4; c++) {
      expect(sorted[c]![0]).toBeCloseTo(want[c]![0]!, 9)
      expect(sorted[c]![1]).toBeCloseTo(want[c]![1]!, 9)
    }
  })

  test('fully-dead floor is skipped without touching the scene', () => {
    seed('floor', [1.5, 0, 1.5], 0, 0)
    const result = keepPlaced()
    expect(result).toEqual({ kept: 0, skipped: 1, windows: 0, doors: 0, roofs: 0, floors: 0 })
    expect(nodesOf('slab')).toEqual([])
  })

  test('wall mapping unchanged: intact wall + window pocket still land', () => {
    seed('wall', [1.5, 0, 0], 0, FULL_MASK, 'Wz:0,0,0')
    seed('wall', [4.5, 0, 0], 0, FULL_MASK & ~(1 << 4)) // center dead → window
    const result = keepPlaced()
    expect(result.kept).toBe(2)
    expect(result.windows).toBe(1)
    expect(result.skipped).toBe(0)
    const walls = nodesOf('wall')
    expect(walls.length).toBe(2)
    const intact = walls.find((w) => (w.start as number[])[0] === 0)
    expect(intact!.start).toEqual([0, 0])
    expect(intact!.end).toEqual([3, 0])
    const [win] = nodesOf('window')
    expect(win).toBeDefined()
    expect(walls.some((w) => w.id === win!.parentId)).toBe(true)
  })

  test('stairs mapping = the old roof plank: shed roof-segment at the piece pose', () => {
    seed('stairs', [1.5, 0, 1.5], Math.PI / 2, FULL_MASK, 'R:0,0,0')
    const result = keepPlaced()
    expect(result.kept).toBe(1)
    expect(result.roofs).toBe(1)
    const [roof] = nodesOf('roof-segment')
    expect(roof!.roofType).toBe('shed')
    expect(roof!.rotation).toBeCloseTo(Math.PI / 2, 9)
  })

  test('roof flat cap → slab terrace at ridge elevation (exact)', () => {
    seed('roof', [1.5, 2.8, 1.5], 0, FULL_MASK, 'R:0,0,1', [1, 1, 1, 1])
    const result = keepPlaced()
    expect(result.kept).toBe(1)
    expect(result.roofs).toBe(1)
    expect(result.skipped).toBe(0)
    const [slab] = nodesOf('slab')
    expect(slab).toBeDefined()
    expect(slab!.elevation).toBeCloseTo(2.8 + 2.8) // base + CORNER_RISE
  })

  test('roof slope preset keeps an exact shed; corner-tip approximates (skipped++)', () => {
    seed('roof', [1.5, 0, 1.5], Math.PI / 2, FULL_MASK, 'R:0,0,0', [0, 0, 1, 1])
    seed('roof', [4.5, 0, 1.5], 0, FULL_MASK, 'R:1,0,0', [0, 0, 1, 0])
    const result = keepPlaced()
    expect(result.kept).toBe(2)
    expect(result.roofs).toBe(2)
    expect(result.skipped).toBe(1) // the corner-tip counted as approximated
    const sheds = nodesOf('roof-segment')
    expect(sheds.length).toBe(2)
    const exact = sheds.find((s) => Math.abs((s.rotation as number) - Math.PI / 2) < 1e-9)
    expect(exact).toBeDefined() // slope quarter 0 → piece yaw untouched
  })

  test('mixed batch counts: legacy no-slotId pieces flow like any other', () => {
    seed('wall', [1.5, 0, 0]) // legacy: no slotId
    seed('floor', [1.5, 0, 1.5], 0, FULL_MASK, 'F:0,0,0')
    seed('floor', [4.5, 0, 1.5], 0, 0) // dead → skipped
    seed('stairs', [1.5, 0, 4.5], 0, FULL_MASK, 'R:0,1,0')
    const result = keepPlaced()
    expect(result).toEqual({ kept: 3, skipped: 1, windows: 0, doors: 0, roofs: 1, floors: 1 })
  })

  test('no level selected → everything skipped, session still resolves', () => {
    setLevel(null)
    seed('floor', [1.5, 0, 1.5], 0, FULL_MASK, 'F:0,0,0')
    const result = keepPlaced()
    expect(result).toEqual({ kept: 0, skipped: 1, windows: 0, doors: 0, roofs: 0, floors: 0 })
    expect(useBoots.getState().placed).toEqual([])
  })
})

describe('keepPlaced when the HOST defaults() throws (p5r1 gate g: 8/8 roofs skipped)', () => {
  beforeAll(() => {
    nodeRegistry._reset()
    register('wall', WallNode, () => ({}))
    // Reproduce the LIVE editor's roof-segment definition VERBATIM: its
    // defaults() schema-parses a stub id 'roof-segment_default', which fails
    // core's `rseg_…` template-literal id check — so defaults() THROWS on
    // every call. Keep must survive this (safeDefaults) and still land the
    // node via the schema's own field defaults (generated `rseg_` id).
    register('roof-segment', RoofSegmentNode, () => {
      const stub = RoofSegmentNode.parse({ id: 'roof-segment_default', type: 'roof-segment' })
      const { id: _id, type: _type, ...rest } = stub
      return rest as Record<string, unknown>
    })
  })

  test('placed stairs at a v2 R slot (nonzero i/k, rotQuarter 1) keep as a real roof-segment', () => {
    const slot = parseSlotId('R:2,3,0')
    expect(slot).not.toBeNull()
    const pose = slotPose(slot!, 1) // rotQuarter 1 → ascends toward +X
    seed('stairs', pose.position, pose.yaw, FULL_MASK, 'R:2,3,0')
    const result = keepPlaced()
    expect(result.kept).toBe(1)
    expect(result.roofs).toBe(1)
    expect(result.skipped).toBe(0)
    const [roof] = nodesOf('roof-segment')
    expect(roof).toBeDefined()
    expect(roof!.parentId).toBe('level_test')
    expect(roof!.roofType).toBe('shed')
    expect(roof!.position).toEqual([7.5, 0, 10.5]) // cell (2,3) center, storey 0
    expect(roof!.rotation).toBeCloseTo(Math.PI / 2, 9)
    expect(roof!.width).toBe(3)
    expect(roof!.depth).toBe(3)
    expect(roof!.wallHeight).toBe(0)
    expect(roof!.pitch as number).toBeCloseTo((Math.atan2(2.8, 3) * 180) / Math.PI, 9)
    expect((roof!.id as string).startsWith('rseg_')).toBe(true) // schema-generated id
  })

  test('storey s=1 stairs: baseY = 1·2.8 lands in the node position, skipped stays 0', () => {
    const slot = parseSlotId('R:1,1,1')
    const pose = slotPose(slot!, 3) // rotQuarter 3 → ascends toward −X
    seed('stairs', pose.position, pose.yaw, FULL_MASK, 'R:1,1,1')
    const result = keepPlaced()
    expect(result.kept).toBe(1)
    expect(result.roofs).toBe(1)
    expect(result.skipped).toBe(0)
    const [roof] = nodesOf('roof-segment')
    expect(roof!.position).toEqual([4.5, 2.8, 4.5])
    expect(roof!.rotation).toBeCloseTo((3 * Math.PI) / 2, 9)
  })
})

describe('keepPlaced when the slab schema REJECTS (host wants more)', () => {
  beforeAll(() => {
    nodeRegistry._reset()
    register('wall', WallNode, () => ({}))
    register('slab', {
      parse: () => {
        throw new Error('host slab schema wants fields we cannot guess')
      },
    })
  })

  test('schema failure counts skipped exactly like roofs; walls unaffected', () => {
    seed('wall', [1.5, 0, 0])
    seed('floor', [1.5, 0, 1.5], 0, FULL_MASK, 'F:0,0,0')
    const result = keepPlaced()
    expect(result).toEqual({ kept: 1, skipped: 1, windows: 0, doors: 0, roofs: 0, floors: 0 })
    expect(nodesOf('slab')).toEqual([])
    expect(nodesOf('wall').length).toBe(1)
  })
})
