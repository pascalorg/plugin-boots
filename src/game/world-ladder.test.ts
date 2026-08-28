import { afterEach, describe, expect, test } from 'bun:test'
import { sceneRegistry, useScene } from '@pascal-app/core'
import { BoxGeometry, Group, Mesh } from 'three'
import { resetStoreyLadder, setStoreyLadder, slotPose, STOREY } from './grid'
import { collectStackedLevels, collectWorld, deriveStoreyLadder } from './world'

/**
 * ADAPTIVE STOREYS — the ladder DERIVATION (world.ts): the post-snap level
 * group Ys are the storey bases, the top level closes at its own measured
 * height (tallest wall/ceiling child), and LADDER_SKY_RUNGS pure-STOREY
 * rungs extend above. Fixtures mirror world-levels.test.ts (registered
 * level groups + the preload stub's `__testTrueY` snap convention), so the
 * ladder is proven against the exact read collectWorld performs.
 */

type Registered = { id: string; kind: string }
const registered: Registered[] = []

function register(id: string, kind: string, root: Group | Mesh): void {
  sceneRegistry.nodes.set(id, root)
  sceneRegistry.byType[kind]!.add(id)
  registered.push({ id, kind })
}

afterEach(() => {
  for (const { id, kind } of registered.splice(0)) {
    sceneRegistry.nodes.delete(id)
    sceneRegistry.byType[kind]!.delete(id)
  }
  useScene.getState().setScene({}, [])
  resetStoreyLadder()
})

/** A wallHeight-tall wall mesh whose base sits on its level's floor. */
function wallMesh(wallHeight: number): Mesh {
  const mesh = new Mesh(new BoxGeometry(4, wallHeight, 0.2))
  mesh.position.set(0, wallHeight / 2, 0)
  return mesh
}

/** A REAL 2.5 m host building: two levels at 0 / 2.5 with 2.5 m walls. */
function buildHostBuilding(): void {
  const heights = [2.5, 2.5]
  const bases = [0, 2.5]
  const nodes: Record<string, Record<string, unknown>> = {}
  for (let index = 0; index < bases.length; index++) {
    const levelId = `level_${index}`
    const wallId = `wall_${index}`
    const level = new Group()
    level.userData.__testTrueY = bases[index]!
    level.position.y = bases[index]!
    const wall = wallMesh(heights[index]!)
    level.add(wall)
    level.updateMatrixWorld(true)
    register(levelId, 'level', level)
    register(wallId, 'wall', wall)
    nodes[levelId] = {
      id: levelId,
      type: 'level',
      parentId: null,
      visible: true,
      level: index,
      children: [wallId],
    }
    nodes[wallId] = {
      id: wallId,
      type: 'wall',
      parentId: levelId,
      visible: true,
      start: [-2, 0],
      end: [2, 0],
      height: heights[index]!,
      thickness: 0.2,
    }
  }
  useScene.getState().setScene(nodes as never, ['level_0', 'level_1'] as never)
}

describe('deriveStoreyLadder (pure)', () => {
  test('no levels → null (the grid keeps its uniform fallback)', () => {
    expect(deriveStoreyLadder([], {})).toBeNull()
  })

  test('level bases become rungs; the top span comes from the tallest wall', () => {
    const nodes = {
      level_top: { type: 'level', children: ['w1', 'w2'] },
      w1: { type: 'wall', height: 2.5 },
      w2: { type: 'wall', height: 2.2 },
    } as unknown as Record<string, Record<string, unknown>>
    const ladder = deriveStoreyLadder(
      [
        { id: 'level_ground', y: 0 },
        { id: 'level_top', y: 2.5 },
      ],
      nodes,
    )!
    expect(ladder.slice(0, 3)).toEqual([0, 2.5, 5])
    // Sky rungs: pure STOREY multiples above the top boundary.
    expect(ladder.length).toBe(6)
    expect(ladder[3]).toBeCloseTo(5 + STOREY, 10)
    expect(ladder[5]).toBeCloseTo(5 + 3 * STOREY, 10)
  })

  test('height-less walls → the top span falls back to the LEVEL node height', () => {
    // Fresh host scene: the level carries height 2.5 (host default) but
    // its wall children have NO height property. The ladder must read the
    // real 2.5, not the 2.8 STOREY constant (Gate D, QA round 2).
    const nodes = {
      level_top: { type: 'level', height: 2.5, children: ['w1'] },
      w1: { type: 'wall' },
    } as unknown as Record<string, Record<string, unknown>>
    const ladder = deriveStoreyLadder([{ id: 'level_top', y: 0 }], nodes)!
    expect(ladder.slice(0, 2)).toEqual([0, 2.5])
    expect(ladder[2]).toBeCloseTo(2.5 + STOREY, 10)
  })

  test('no measurable top-level children → the top span falls back to 2.8', () => {
    const ladder = deriveStoreyLadder([{ id: 'level_only', y: 0 }], {})!
    expect(ladder[0]).toBe(0)
    expect(ladder[1]).toBeCloseTo(STOREY, 10)
    expect(ladder[2]).toBeCloseTo(2 * STOREY, 10)
  })

  test('ceilings measure the top span too; sub-1 m level gaps merge', () => {
    const nodes = {
      level_top: { type: 'level', children: ['c1'] },
      c1: { type: 'ceiling', height: 3.1 },
    } as unknown as Record<string, Record<string, unknown>>
    const ladder = deriveStoreyLadder(
      [
        { id: 'level_ground', y: 0 },
        { id: 'level_mezzanine', y: 0.4 }, // data artifact — merges away
        { id: 'level_top', y: 2.5 },
      ],
      nodes,
    )!
    expect(ladder.slice(0, 3)).toEqual([0, 2.5, 5.6])
  })
})

describe('collectWorld ladder + grid integration', () => {
  test('the 2.5 m host building yields the exact ladder', () => {
    buildHostBuilding()
    const world = collectWorld()
    expect(world.storeyLadder).toBeDefined()
    expect(world.storeyLadder!.slice(0, 3)).toEqual([0, 2.5, 5])
    expect(world.storeyLadder![3]).toBeCloseTo(5 + STOREY, 10)
    // collectStackedLevels reads the same post-snap truth.
    expect(collectStackedLevels()).toEqual([
      { id: 'level_0', y: 0 },
      { id: 'level_1', y: 2.5 },
    ])
  })

  test('installed in the grid, slot poses land on the REAL second floor', () => {
    buildHostBuilding()
    const world = collectWorld()
    setStoreyLadder(world.storeyLadder ?? null)
    // The bug this feature kills: s=1 used to float at 2.8 — 0.3 m above
    // the real 2.5 m second floor.
    expect(slotPose({ kind: 'F', i: 0, k: 0, s: 1 }).position[1]).toBe(2.5)
    expect(slotPose({ kind: 'Wx', i: 1, k: 0, s: 1 }).position[1]).toBe(2.5)
  })

  test('a scene without levels leaves the ladder unset', () => {
    const world = collectWorld()
    expect(world.storeyLadder).toBeUndefined()
  })
})
