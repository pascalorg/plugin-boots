import { afterEach, describe, expect, test } from 'bun:test'
import { sceneRegistry, useScene } from '@pascal-app/core'
import { BoxGeometry, Group, Mesh, MeshBasicMaterial } from 'three'
import { collectMeshes, collectSolidRoots, collectWorld } from './world'

/**
 * Hosted-child mesh ownership (QA round-2 door walk-through bug): doors,
 * windows and wall-mounted items render NESTED inside their host wall's
 * registered root, so a plain subtree sweep hands the wall every child
 * mesh too. The wall then voxelizes WITH the closed door leaf + frame
 * baked in — the doorway reads as an unbroken voxel sheet that never
 * clears when the door opens, the capsule climbs invisible cells, and
 * bullets on the door misattribute to the wall. collectWorld must fence
 * each node's sweep at any OTHER collected solid node's root: the wall
 * keeps only its own meshes, and each hosted child is collected under its
 * OWN nodeId by its own pass.
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

/** One level hosting one wall; the wall root (a Mesh, like the host's
 * WallRenderer) nests a registered door root (leaf + frame meshes) and a
 * registered window root (sash mesh + a transparent glass pane). */
function buildWallWithHostedChildren() {
  const level = new Group()
  level.userData.__testTrueY = 0

  // Wall: 4 m long, 2.8 m high, 0.2 m thick — its own render mesh.
  const wall = new Mesh(new BoxGeometry(4, 2.8, 0.2))
  wall.position.set(0, 1.4, 0)
  level.add(wall)

  // Door nested INSIDE the wall root, the way NodeRenderer mounts hosted
  // children in the host editor.
  const door = new Group()
  const doorLeaf = new Mesh(new BoxGeometry(0.8, 2.0, 0.04))
  const doorFrame = new Mesh(new BoxGeometry(0.9, 2.1, 0.07))
  door.add(doorLeaf)
  door.add(doorFrame)
  door.position.set(1, -0.35, 0)
  wall.add(door)

  // Window nested inside the wall root too: one solid sash + one glass pane
  // + the host's full-rect interaction HITBOX (mesh.visible = true, MATERIAL
  // invisible — never rendered/raycast by three, must never become a
  // collider that eats glazing shots; QA p4r3 bug 2).
  const window = new Group()
  const sash = new Mesh(new BoxGeometry(1.2, 1.2, 0.05))
  const glassPane = new Mesh(
    new BoxGeometry(1.1, 1.1, 0.01),
    new MeshBasicMaterial({ transparent: true, opacity: 0.3 }),
  )
  const hitbox = new Mesh(new BoxGeometry(1.2, 1.2, 0.06), new MeshBasicMaterial())
  hitbox.material.visible = false
  window.add(sash)
  window.add(glassPane)
  window.add(hitbox)
  window.position.set(-1, 0.2, 0)
  wall.add(window)

  level.updateMatrixWorld(true)

  register('level_1', 'level', level)
  register('wall_1', 'wall', wall)
  register('door_1', 'door', door)
  register('window_1', 'window', window)

  useScene.getState().setScene(
    {
      level_1: {
        id: 'level_1',
        type: 'level',
        parentId: null,
        visible: true,
        level: 0,
        children: ['wall_1'],
      },
      wall_1: {
        id: 'wall_1',
        type: 'wall',
        parentId: 'level_1',
        visible: true,
        start: [-2, 0],
        end: [2, 0],
        height: 2.8,
        thickness: 0.2,
        children: ['door_1', 'window_1'],
      },
      door_1: {
        id: 'door_1',
        type: 'door',
        parentId: 'wall_1',
        visible: true,
        doorType: 'hinged',
        openingKind: 'door',
      },
      window_1: {
        id: 'window_1',
        type: 'window',
        parentId: 'wall_1',
        visible: true,
        windowType: 'sliding',
        openingKind: 'window',
      },
    } as never,
    ['level_1'] as never,
  )

  return { wall, doorLeaf, doorFrame, sash, glassPane, hitbox }
}

describe('collectWorld hosted-child mesh ownership', () => {
  test('wall keeps ONLY its own mesh — hosted door/window meshes never join the wall (voxelize source)', () => {
    const { wall } = buildWallWithHostedChildren()
    const world = collectWorld()

    const wallEntry = world.walls.get('wall_1')!
    expect(wallEntry).toBeDefined()
    expect(wallEntry.meshes).toEqual([wall])
  })

  test('wall colliders carry no door/window meshes; children collect under their OWN nodeId', () => {
    const { wall, doorLeaf, doorFrame, sash } = buildWallWithHostedChildren()
    const world = collectWorld()

    const byNode = (id: string) =>
      world.colliders.filter((c) => c.nodeId === id).map((c) => c.mesh)
    expect(byNode('wall_1')).toEqual([wall])
    expect(new Set(byNode('door_1'))).toEqual(new Set([doorLeaf, doorFrame]))
    expect(byNode('window_1')).toEqual([sash])
  })

  test('door entry present with its own colliders; window glass routes to the glass list', () => {
    const { glassPane } = buildWallWithHostedChildren()
    const world = collectWorld()

    const door = world.doors.find((d) => d.nodeId === 'door_1')!
    expect(door).toBeDefined()
    expect(door.colliderIndices.length).toBe(2)
    for (const i of door.colliderIndices) {
      expect(world.colliders[i]!.nodeId).toBe('door_1')
    }

    expect(world.glass.map((g) => g.mesh)).toEqual([glassPane])
    expect(world.glass[0]!.nodeId).toBe('window_1')

    const window = world.operables?.find((o) => o.nodeId === 'window_1')!
    expect(window).toBeDefined()
    expect(window.kind).toBe('window')
  })

  test('material-invisible interaction hitboxes never become colliders or glass (QA p4r3 bug 2)', () => {
    const { hitbox } = buildWallWithHostedChildren()
    const world = collectWorld()

    expect(world.colliders.some((c) => c.mesh === hitbox)).toBe(false)
    expect(world.glass.some((g) => g.mesh === hitbox)).toBe(false)
  })

  test('ResurrectionSweep lane: collectMeshes fenced by collectSolidRoots keeps hosted children out of the wall sweep', () => {
    const { wall, hitbox } = buildWallWithHostedChildren()
    collectWorld()

    const fence = collectSolidRoots()
    expect(fence.has(wall)).toBe(true)
    const swept = collectMeshes(wall, fence)
    // Only the wall's own mesh — never the nested door/window meshes, and
    // never the material-invisible hitbox (game-root.tsx bug 1 fix).
    expect(swept).toEqual([wall])
    expect(swept.includes(hitbox)).toBe(false)

    // collectWorld exposes the same fence on the snapshot.
    const world = collectWorld()
    expect(world.solidRoots?.has(wall)).toBe(true)
  })
})
