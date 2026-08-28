import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  type AnyNodeDefinition,
  nodeRegistry,
  RoofSegmentNode,
  sceneRegistry,
  SlabNode,
  useScene,
  WallNode,
  WindowNode,
} from '@pascal-app/core'
import { useViewer } from '@pascal-app/viewer'
import { Group } from 'three'
import { FULL_MASK, useBoots } from '../store'
import { keepPlaced } from './keep'

/**
 * ADAPTIVE STOREYS — the Keep bridge:
 * - pieces parent to the LEVEL their storey maps to (piece base elevation =
 *   ladder rung = stacked level base), not blindly to the viewer selection —
 *   the pre-ladder latent bug parented a storey-1 wall to the ground level,
 *   where wall nodes (which carry no Y) rendered at ground elevation;
 * - Y-carrying payloads (slab elevation, roof-segment position) are written
 *   LEVEL-LOCAL against the parent's stacked base;
 * - kept nodes conform to the piece's own span (PlacedPiece.height): wall
 *   height, shed pitch, flat-cap terrace rise, window pocket center/size;
 * - terrain / extended-sky storeys match no level and fall back to the
 *   selection level — the exact old behavior (keep.test.ts pins it for
 *   scenes with no registered levels at all).
 * Fixtures: real @pascal-app/core schemas + registered level groups read
 * through collectStackedLevels (the preload viewer stub's snap contract).
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
  height?: number,
  extra?: { yaw?: number; mask?: number; corners?: [number, number, number, number] },
) =>
  useBoots.getState().addPlaced({
    piece,
    position,
    yaw: extra?.yaw ?? 0,
    mask: extra?.mask ?? FULL_MASK,
    height,
    corners: extra?.corners,
  })

/** Two stacked 2.5 m levels registered the way collectStackedLevels reads
 * them (the preload stub snaps any level group carrying __testTrueY). */
const levelGroups: Array<{ id: string; group: Group }> = []
function registerLevels(bases: Record<string, number>): void {
  for (const [id, y] of Object.entries(bases)) {
    const group = new Group()
    group.userData.__testTrueY = y
    group.position.y = y
    group.updateMatrixWorld(true)
    sceneRegistry.nodes.set(id, group)
    sceneRegistry.byType.level!.add(id)
    levelGroups.push({ id, group })
  }
}

beforeAll(() => {
  nodeRegistry._reset()
  register('wall', WallNode, () => ({}))
  register('window', WindowNode, () => ({}))
  register('roof-segment', RoofSegmentNode, () => ({}))
  register('slab', SlabNode, () => ({}))
})

beforeEach(() => {
  useBoots.getState().resolvePlaced()
  useScene.getState().setScene({}, [])
  registerLevels({ level_a: 0, level_b: 2.5 })
  setLevel('level_a')
})

afterEach(() => {
  for (const { id } of levelGroups.splice(0)) {
    sceneRegistry.nodes.delete(id)
    sceneRegistry.byType.level!.delete(id)
  }
})

describe('level parenting: pieces land on the level their storey maps to', () => {
  test('a storey-1 wall parents to the UPPER level with its own span height', () => {
    seed('wall', [1.5, 0, 0], 2.5)
    seed('wall', [1.5, 2.5, 0], 2.5)
    const result = keepPlaced()
    expect(result.kept).toBe(2)
    expect(result.skipped).toBe(0)
    const walls = nodesOf('wall')
    expect(walls.map((w) => w.parentId).sort()).toEqual(['level_a', 'level_b'])
    for (const wall of walls) expect(wall.height).toBe(2.5)
  })

  test('slab elevation is LEVEL-LOCAL: a second-storey floor keeps elevation 0', () => {
    seed('floor', [1.5, 2.5, 1.5], 2.5)
    const result = keepPlaced()
    expect(result.floors).toBe(1)
    const [slab] = nodesOf('slab')
    expect(slab!.parentId).toBe('level_b')
    expect(slab!.elevation).toBeCloseTo(0, 9)
  })

  test('roof-segment position is LEVEL-LOCAL; pitch follows the span', () => {
    seed('stairs', [1.5, 2.5, 1.5], 2.5)
    const result = keepPlaced()
    expect(result.roofs).toBe(1)
    const [shed] = nodesOf('roof-segment')
    // No 'roof' container kind registered here → the documented fallback
    // parents the segment to the level directly.
    expect(shed!.parentId).toBe('level_b')
    expect(shed!.position).toEqual([1.5, 0, 1.5])
    expect(shed!.pitch as number).toBeCloseTo((Math.atan2(2.5, 3) * 180) / Math.PI, 9)
  })

  test('flat-cap roof terrace rises by the PIECE span above its local base', () => {
    seed('roof', [1.5, 2.5, 1.5], 2.5, { corners: [1, 1, 1, 1] })
    const result = keepPlaced()
    expect(result.roofs).toBe(1)
    expect(result.skipped).toBe(0)
    const [slab] = nodesOf('slab')
    expect(slab!.parentId).toBe('level_b')
    expect(slab!.elevation).toBeCloseTo(2.5, 9) // local 0 + the 2.5 span
  })

  test('extended-sky storeys fall back to the selection level, world Y kept', () => {
    setLevel('level_b')
    seed('floor', [1.5, 7.8, 1.5], 2.8) // two sky rungs above the roof line
    const result = keepPlaced()
    expect(result.floors).toBe(1)
    const [slab] = nodesOf('slab')
    expect(slab!.parentId).toBe('level_b')
    // Local against the SELECTION level's stacked base: 7.8 − 2.5.
    expect(slab!.elevation).toBeCloseTo(5.3, 9)
  })
})

describe('span-conforming node math', () => {
  test('half-wall trim keeps span/3: mask 7 on a 2.5 m wall → 0.833 m', () => {
    seed('wall', [1.5, 0, 0], 2.5, { mask: 0b000000111 })
    expect(keepPlaced().kept).toBe(1)
    const [wall] = nodesOf('wall')
    expect(wall!.height).toBeCloseTo(2.5 / 3, 9)
  })

  test('window pocket centers on span/2 and sizes to span/3 cells', () => {
    seed('wall', [1.5, 2.5, 0], 2.5, { mask: FULL_MASK & ~(1 << 4) })
    const result = keepPlaced()
    expect(result.windows).toBe(1)
    const [win] = nodesOf('window')
    expect((win!.position as number[])[1]).toBeCloseTo(1.25, 9)
    expect(win!.height).toBeCloseTo(2.5 / 3, 9)
    const [wall] = nodesOf('wall')
    expect(wall!.parentId).toBe('level_b')
  })

  test('legacy pieces (no height) keep the classic 2.8 everywhere', () => {
    seed('wall', [1.5, 0, 0])
    seed('stairs', [4.5, 0, 1.5])
    const result = keepPlaced()
    expect(result.kept).toBe(2)
    const [wall] = nodesOf('wall')
    expect(wall!.height).toBeCloseTo(2.8, 9)
    const [shed] = nodesOf('roof-segment')
    expect(shed!.pitch as number).toBeCloseTo((Math.atan2(2.8, 3) * 180) / Math.PI, 9)
  })
})
