import { afterEach, describe, expect, test } from 'bun:test'
import { sceneRegistry, useScene } from '@pascal-app/core'
import { BoxGeometry, Group, Mesh } from 'three'
import { collectWorld } from './world'

/**
 * Phase A (whole-building presence): collectWorld must snapshot the ENTIRE
 * stacked building — every storey's geometry at its TRUE stacked elevation —
 * no matter what the level groups looked like a moment earlier (solo-hidden,
 * exploded/mid-lerp Y). world.ts does that by snapping level groups through
 * the host's `snapLevelsToTruePositions` BEFORE the visibility walk; the
 * test-preload viewer stub mirrors that util's contract via the
 * `userData.__testTrueY` convention (snap to that Y + visible), so these
 * fixtures prove the ordering: a level left hidden at a wrong Y would be
 * skipped by the walk or baked with wrong collider matrices.
 *
 * Also pins the Phase-A spawn rule: the ring stays OUTSIDE the full-building
 * AABB on XZ, but its Y is the LOWEST level's ground (clamped to the terrain
 * plane at 0 — basements must not sink the spawn underground), and the dead
 * `useScene.selectedLevelId` read is gone: levelId now mirrors the viewer's
 * selection (the preload stub pins it to 'level-test').
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
})

/** A 4×2.8×0.2 wall mesh whose base sits on its level's floor. */
function wallMesh(): Mesh {
  const mesh = new Mesh(new BoxGeometry(4, 2.8, 0.2))
  mesh.position.set(0, 1.4, 0)
  return mesh
}

function wallNode(id: string, parentId: string): Record<string, unknown> {
  return {
    id,
    type: 'wall',
    parentId,
    visible: true,
    start: [-2, 0],
    end: [2, 0],
    height: 2.8,
    thickness: 0.2,
  }
}

/** Two-storey fixture. Level B starts the way a jump-in from solo/exploded
 * finds it: HIDDEN and mid-lerp at the wrong Y. Returns the groups. */
function buildTwoStoreys(trueYA: number, trueYB: number): { levelA: Group; levelB: Group } {
  const levelA = new Group()
  levelA.userData.__testTrueY = trueYA
  levelA.position.y = trueYA
  const wallA = wallMesh()
  levelA.add(wallA)
  levelA.updateMatrixWorld(true)

  const levelB = new Group()
  levelB.userData.__testTrueY = trueYB
  levelB.position.y = trueYB * 0.4 + 0.1 // mid-lerp, nowhere near true Y
  levelB.visible = false // solo mode had it hidden
  const wallB = wallMesh()
  levelB.add(wallB)
  levelB.updateMatrixWorld(true)

  register('level_a', 'level', levelA)
  register('level_b', 'level', levelB)
  register('wall_a', 'wall', wallA)
  register('wall_b', 'wall', wallB)
  const levelNode = (id: string, level: number): Record<string, unknown> => ({
    id,
    type: 'level',
    parentId: null,
    visible: true,
    level,
    children: [level === 0 ? 'wall_a' : 'wall_b'],
  })
  useScene.getState().setScene(
    {
      level_a: levelNode('level_a', 0),
      level_b: levelNode('level_b', 1),
      wall_a: wallNode('wall_a', 'level_a'),
      wall_b: wallNode('wall_b', 'level_b'),
    } as never,
    ['level_a', 'level_b'] as never,
  )
  return { levelA, levelB }
}

describe('collectWorld across stacked levels', () => {
  test('snaps hidden/mid-lerp levels to true Y BEFORE the walk — both storeys collected at stacked elevations', () => {
    const { levelB } = buildTwoStoreys(0, 2.8)
    const world = collectWorld()

    // The snap ran first: level B is visible again and at its true Y.
    expect(levelB.visible).toBe(true)
    expect(levelB.position.y).toBe(2.8)

    // Both storeys' walls made it into the snapshot.
    expect(world.walls.size).toBe(2)
    expect([...world.walls.keys()].sort()).toEqual(['wall_a', 'wall_b'])

    // Collider matrices baked at TRUE stacked Y, not the mid-lerp Y.
    const wallB = world.colliders.find((c) => c.nodeId === 'wall_b')!
    expect(wallB.worldBox.min.y).toBeCloseTo(2.8, 5)
    expect(wallB.worldBox.max.y).toBeCloseTo(5.6, 5)

    // buildingAabb spans the whole 2-storey building.
    expect(world.buildingAabb.min.y).toBeCloseTo(0, 5)
    expect(world.buildingAabb.max.y).toBeCloseTo(5.6, 5)
  })

  test('spawn ring stays outside the full-building AABB, at the lowest level ground (y=0)', () => {
    buildTwoStoreys(0, 2.8)
    const world = collectWorld()
    expect(world.spawn.y).toBe(0)
    // Outside on XZ even though the AABB now spans two storeys vertically.
    expect(world.buildingAabb.containsPoint(world.spawn)).toBe(false)
    const size = world.buildingAabb.getSize(world.spawn.clone())
    expect(Math.abs(world.spawn.x)).toBeGreaterThan(size.x / 2)
  })

  test('elevated building: spawn ground follows the lowest level up', () => {
    buildTwoStoreys(1.2, 4.0)
    const world = collectWorld()
    expect(world.spawn.y).toBeCloseTo(1.2, 5)
  })

  test('basement building: spawn ground clamps to the terrain plane at 0', () => {
    buildTwoStoreys(-2.5, 0)
    const world = collectWorld()
    expect(world.spawn.y).toBe(0)
  })

  test('levelId mirrors the viewer selection (dead useScene.selectedLevelId read is gone)', () => {
    buildTwoStoreys(0, 2.8)
    const world = collectWorld()
    expect(world.levelId).toBe('level-test')
  })
})
