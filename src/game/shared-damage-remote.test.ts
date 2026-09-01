import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { useScene } from '@pascal-app/core'
import { Box3, BoxGeometry, Matrix4, Mesh, Vector3 } from 'three'
import { useBoots } from '../store'
import { resetCraters } from './craters'
import { clearDebris } from './debris'
import {
  collapseWholeTarget,
  damageSegment,
  prevoxelizeTick,
  resetDestruction,
  setPrevoxelizeClock,
  setShellFlag,
  useDestruction,
} from './destruction'
import {
  captureDemolition,
  deleteDestroyed,
  discardDemolition,
  isFullyDestroyed,
  useDemolition,
} from './save-demolition'
import { armSceneWriteSentinel } from './session'
import { applySharedDamage, keysOfIndices, setDamageSync } from './shared-damage'
import {
  createSharedWorld,
  emptyEffects,
  localWork,
  mergeDelta,
  noteLocalKill,
  noteLocalRemoval,
  noteLocalReset,
  noteLocalSegments,
  snapshotOf,
  type SharedWorld,
} from './shared-world'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

/**
 * THE STRANGER'S RUBBLE, AND WHERE IT IS ALLOWED TO GO.
 *
 * Two invariants meet in this file, and both of them protect somebody's real
 * building rather than the game:
 *
 *  1. Remote damage lands in the local runtime — that is the entire point of a
 *     shared world — but `deleteDestroyed()` writes the OWNER'S DOCUMENT. A
 *     visitor who levels a garage must not be able to ride that into the
 *     owner's saved scene, and neither must a peer's kill of a node this
 *     player never touched become "what I destroyed".
 *
 *  2. Nothing in a game session may write the host scene document at all. A
 *     remote kill has to take the node off this player's screen while leaving
 *     it, byte for byte, in the editor's graph — so the scene-write sentinel
 *     must stay silent through the whole exchange.
 */

// ── the world ────────────────────────────────────────────────────────────────

function boxCollider(
  nodeId: string,
  nodeType: string,
  size: [number, number, number],
  center: [number, number, number],
): ColliderEntry {
  const mesh = new Mesh(new BoxGeometry(size[0], size[1], size[2]))
  mesh.position.set(center[0], center[1], center[2])
  mesh.updateMatrixWorld(true)
  mesh.geometry.computeBoundingBox()
  const worldBox = mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld)
  return {
    mesh,
    bvh: bvhFor(mesh),
    inverse: new Matrix4().copy(mesh.matrixWorld).invert(),
    worldBox,
    root: mesh,
    nodeId,
    nodeType,
  }
}

function makeWorld(): GameWorld {
  const wallA = boxCollider('wall-1', 'wall', [2, 2.7, 0.12], [0, 1.35, 0])
  const wallB = boxCollider('wall-2', 'wall', [2, 2.7, 0.12], [6, 1.35, 0])
  const colliders = [wallA, wallB]
  const buildingAabb = new Box3()
  for (const c of colliders) buildingAabb.union(c.worldBox)
  const wallEntry = (c: ColliderEntry, start: [number, number], end: [number, number]) => ({
    node: { id: c.nodeId, start, end, height: 2.7, thickness: 0.12 },
    root: c.root,
    meshes: [c.mesh],
  })
  return {
    colliders,
    walls: new Map([
      ['wall-1', wallEntry(wallA, [-1, 0], [1, 0])],
      ['wall-2', wallEntry(wallB, [5, 0], [7, 0])],
    ]),
    glass: [],
    doors: [],
    overlayRoots: [],
    buildingAabb,
    spawn: new Vector3(0, 0, 6),
    spawnYaw: 0,
    levelId: null,
  }
}

type SceneStore = {
  getState: () => {
    setScene: (nodes: Record<string, unknown>, roots: string[]) => void
    nodes: Record<string, unknown>
    setReadOnly?: (readOnly: boolean) => void
  }
}
const scene = useScene as unknown as SceneStore

// ── the peer ─────────────────────────────────────────────────────────────────

/** A second peer's model, so every remote frame is authored somewhere real. */
function peer(): SharedWorld {
  return createSharedWorld('them')
}

/** Ship everything `them` knows into `mine` and apply it, as the bus would. */
function receive(mine: SharedWorld, them: SharedWorld): void {
  const fx = emptyEffects()
  const delta = snapshotOf(them)
  // The sender is the ENVELOPE's peer id, never the payload's: that is the
  // authorship gate, and it is why applySharedDamage needs no sender at all.
  mergeDelta(mine, delta, 'them', fx)
  applySharedDamage(fx)
}

/** Every cell key of a materialized target, as a peer would have to send. */
function allCellsOf(nodeId: string): number[] {
  const target = useDestruction.getState().targets.get(nodeId)
  if (!target) return []
  const indices: number[] = []
  for (let i = 0; i < target.grid.count; i++) indices.push(i)
  return keysOfIndices(target.grid, indices)
}

function allSegmentsOf(nodeId: string): number[] {
  const target = useDestruction.getState().targets.get(nodeId)
  return target ? target.segments.map((s) => s.id) : []
}

function prevoxelize(world: GameWorld): void {
  setPrevoxelizeClock(() => 0)
  let done = false
  for (let i = 0; i < 80 && !done; i++) done = prevoxelizeTick(world, 8)
}

// ── setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  // The destruction ledger and the pending-demolition list are singletons, and
  // the Save assertions here count rows across the WHOLE of both ("only wall-1
  // is offered"). A leftover leveled node from another file is offered too:
  // seed 88888 saw 2 where the test names 1.
  discardDemolition()
  resetDestruction()
  setShellFlag('wall', false)
  setShellFlag('roof', false)
  setShellFlag('slab', false)
  // Real wall nodes: the host's deleteNodes walks junctions to re-merge the
  // neighbours of a deleted wall, so `start`/`end` have to be there.
  scene.getState().setScene(
    {
      'wall-1': {
        id: 'wall-1',
        type: 'wall',
        name: 'North wall',
        start: [-1, 0],
        end: [1, 0],
        height: 2.7,
        thickness: 0.12,
      },
      'wall-2': {
        id: 'wall-2',
        type: 'wall',
        name: 'South wall',
        start: [5, 0],
        end: [7, 0],
        height: 2.7,
        thickness: 0.12,
      },
    },
    ['wall-1', 'wall-2'],
  )
})

afterEach(() => {
  setDamageSync(null)
  setPrevoxelizeClock(null)
  discardDemolition()
  resetDestruction()
  resetCraters()
  clearDebris()
  useBoots.getState().setPhase('editor')
  scene.getState().setReadOnly?.(false)
  scene.getState().setScene({}, [])
  setShellFlag('wall', true)
  setShellFlag('roof', true)
  setShellFlag('slab', true)
})

// ── 1. the ownership gate ────────────────────────────────────────────────────

describe("a stranger's rubble cannot reach Save", () => {
  test('I leveled wall-1, they leveled wall-2: only wall-1 is offered, and only wall-1 dies', () => {
    const mine = createSharedWorld('me')
    setDamageSync({ world: mine, publish: () => {} })
    const world = makeWorld()
    prevoxelize(world)

    // Mine, entirely: every stick snapped, then every cell.
    for (const id of allSegmentsOf('wall-1')) {
      damageSegment(world, 'wall-1', id, 9999, new Vector3(0, 1.35, 0))
    }
    collapseWholeTarget('wall-1')

    // Theirs, entirely — authored in their model and shipped over.
    const them = peer()
    noteLocalRemoval(them, 'wall-2', allCellsOf('wall-2'))
    noteLocalSegments(them, 'wall-2', allSegmentsOf('wall-2'))
    noteLocalKill(them, 'wall-2')
    receive(mine, them)

    // Both walls are rubble on this screen. That much SHOULD be true.
    const targets = useDestruction.getState().targets
    expect(isFullyDestroyed(targets.get('wall-1')!)).toBe(true)
    expect(isFullyDestroyed(targets.get('wall-2')!)).toBe(true)

    // Only one of them is this peer's to give away.
    expect(captureDemolition()).toBe(1)
    expect(useDemolition.getState().destroyed).toEqual([{ nodeId: 'wall-1', kind: 'wall' }])
    expect(useDemolition.getState().mine).toEqual(['wall-1'])
    expect(useDemolition.getState().foreign).toBe(1)

    // And the delete really only touches the one.
    expect(deleteDestroyed()).toBe(1)
    const nodes = scene.getState().nodes
    expect(nodes['wall-1']).toBeUndefined()
    expect(nodes['wall-2']).toBeDefined()
  })

  test('one remote cell in a wall I otherwise leveled myself withholds the whole node', () => {
    const mine = createSharedWorld('me')
    setDamageSync({ world: mine, publish: () => {} })
    const world = makeWorld()
    prevoxelize(world)

    // A single cell, killed by someone else, BEFORE I get to work. This is the
    // adversarial case: I finish the wall off, the local runtime records a
    // clean total collapse, and the finishing blow is genuinely mine — but one
    // cell of that node's destruction is not, so the node stays in the editor.
    const cells = allCellsOf('wall-2')
    const them = peer()
    noteLocalRemoval(them, 'wall-2', [cells[0]!])
    receive(mine, them)

    for (const id of allSegmentsOf('wall-2')) {
      damageSegment(world, 'wall-2', id, 9999, new Vector3(6, 1.35, 0))
    }
    collapseWholeTarget('wall-2')

    expect(isFullyDestroyed(useDestruction.getState().targets.get('wall-2')!)).toBe(true)
    // My record is one cell short of the grid — that is the whole test.
    const work = localWork(mine)
    expect(work.cells.get('wall-2')?.length).toBe(cells.length - 1)
    expect(captureDemolition()).toBe(0)
    expect(useDemolition.getState().foreign).toBe(1)
    expect(deleteDestroyed()).toBe(0)
    expect(scene.getState().nodes['wall-2']).toBeDefined()
  })

  test('single player: no sync, no gate, everything I level is mine', () => {
    // The pre-shared-world behaviour, unchanged. `workOf` is null, so capture
    // takes the loop that shipped and nothing is ever withheld.
    const world = makeWorld()
    prevoxelize(world)
    for (const id of allSegmentsOf('wall-1')) {
      damageSegment(world, 'wall-1', id, 9999, new Vector3(0, 1.35, 0))
    }
    collapseWholeTarget('wall-1')
    expect(captureDemolition()).toBe(1)
    expect(useDemolition.getState().foreign).toBe(0)
    expect(useDemolition.getState().mine).toEqual(['wall-1'])
  })

  test('no inbound frame can ADD to what this peer owns, whatever it claims', () => {
    // The gate rests on one property of the frozen model: dmg.mine /
    // dmg.mySegments / dmg.killedByMe are written ONLY by the noteLocal* author
    // path. mergeDelta never adds to them — it can only CLEAR them on a higher
    // epoch. Reading that out of shared-world.ts is not the same as holding it,
    // so hold it here: an adversarial peer claims cells, sticks, a kill and a
    // fresh epoch on both walls, and this client's ownership record stays empty.
    const mine = createSharedWorld('me')
    setDamageSync({ world: mine, publish: () => {} })
    const world = makeWorld()
    prevoxelize(world)

    const them = peer()
    for (const nodeId of ['wall-1', 'wall-2']) {
      noteLocalRemoval(them, nodeId, allCellsOf(nodeId))
      noteLocalSegments(them, nodeId, allSegmentsOf(nodeId))
      noteLocalKill(them, nodeId)
    }
    receive(mine, them)
    // A second peer, and a reset that bumps the epoch past everything above.
    const other = createSharedWorld('other')
    noteLocalReset(other, 'wall-1')
    noteLocalRemoval(other, 'wall-1', allCellsOf('wall-1'))
    receive(mine, other)

    const work = localWork(mine)
    expect(work.cells.size).toBe(0)
    expect(work.segments.size).toBe(0)
    expect(work.killed).toEqual([])
    // Nothing to give away, so nothing is offered and nothing is deleted.
    expect(captureDemolition()).toBe(0)
    expect(deleteDestroyed()).toBe(0)
    expect(Object.keys(scene.getState().nodes).sort()).toEqual(['wall-1', 'wall-2'])
  })

  test('a remote epoch bump erases my ownership, and withholding is the safe direction', () => {
    // I level a wall entirely — it is unambiguously mine. Then a peer restores
    // it, which is the one non-monotone operation: a higher epoch clears the
    // whole node, my ownership record included. Whether the local runtime
    // revives the grid or not, the answer must be the same — the node is NOT
    // offered for deletion. Losing a legitimate Save offer is acceptable;
    // deleting a node whose ownership we can no longer prove is not.
    const mine = createSharedWorld('me')
    setDamageSync({ world: mine, publish: () => {} })
    const world = makeWorld()
    prevoxelize(world)
    for (const id of allSegmentsOf('wall-1')) {
      damageSegment(world, 'wall-1', id, 9999, new Vector3(0, 1.35, 0))
    }
    collapseWholeTarget('wall-1')
    expect(localWork(mine).cells.get('wall-1')?.length).toBe(
      useDestruction.getState().targets.get('wall-1')!.grid.count,
    )

    const them = peer()
    noteLocalReset(them, 'wall-1')
    receive(mine, them)

    expect(localWork(mine).cells.get('wall-1')).toBeUndefined()
    expect(localWork(mine).killed).toEqual([])
    expect(captureDemolition()).toBe(0)
    expect(deleteDestroyed()).toBe(0)
    expect(scene.getState().nodes['wall-1']).toBeDefined()
  })

  test('THE EXIT ORDER: the lane is torn down before Save asks, and the gate still answers', () => {
    // THIS IS THE ONE A LIVE RUN CAUGHT AND NO UNIT TEST DID.
    //
    // exitGame does not ask first and tear down after. session.ts calls
    // stopWorldSync() — setDamageSync(null) — at line 714, and only reaches
    // captureDemolition() at 742. So on the REAL exit path the gate was being
    // consulted after it had been switched off: `sharedLocalWork()` answered
    // null, capture took the single-player loop, and every fully destroyed node
    // was offered — including a wall a peer had leveled. In the browser that
    // showed up as "You fully leveled 2 building elements" with only one of them
    // mine. Encode the order here so it cannot come back.
    const mine = createSharedWorld('me')
    setDamageSync({ world: mine, publish: () => {} })
    const world = makeWorld()
    prevoxelize(world)

    for (const id of allSegmentsOf('wall-1')) {
      damageSegment(world, 'wall-1', id, 9999, new Vector3(0, 1.35, 0))
    }
    collapseWholeTarget('wall-1')

    const them = peer()
    noteLocalRemoval(them, 'wall-2', allCellsOf('wall-2'))
    noteLocalSegments(them, 'wall-2', allSegmentsOf('wall-2'))
    noteLocalKill(them, 'wall-2')
    receive(mine, them)

    const targets = useDestruction.getState().targets
    expect(isFullyDestroyed(targets.get('wall-1')!)).toBe(true)
    expect(isFullyDestroyed(targets.get('wall-2')!)).toBe(true)

    // ── exitGame, in its real order ──
    setDamageSync(null) // session.ts:714
    expect(captureDemolition()).toBe(1) // session.ts:742
    expect(useDemolition.getState().mine).toEqual(['wall-1'])
    expect(useDemolition.getState().foreign).toBe(1)
    expect(deleteDestroyed()).toBe(1)
    expect(scene.getState().nodes['wall-1']).toBeUndefined()
    expect(scene.getState().nodes['wall-2']).toBeDefined()
  })

  test('a new session inherits no claims from the last one', () => {
    // The evidence outliving the detach must not outlive the SESSION, or a
    // second Jump-in would offer the first session's rubble as this one's work.
    const first = createSharedWorld('me')
    setDamageSync({ world: first, publish: () => {} })
    const world = makeWorld()
    prevoxelize(world)
    for (const id of allSegmentsOf('wall-1')) {
      damageSegment(world, 'wall-1', id, 9999, new Vector3(0, 1.35, 0))
    }
    collapseWholeTarget('wall-1')
    setDamageSync(null)
    expect(captureDemolition()).toBe(1) // still mine, same session

    // A fresh lane: the wall is rubble in the runtime but nothing in this
    // world's ledger says I did it, so it is withheld rather than offered.
    discardDemolition()
    setDamageSync({ world: createSharedWorld('me'), publish: () => {} })
    expect(captureDemolition()).toBe(0)
    expect(useDemolition.getState().foreign).toBe(1)
    expect(deleteDestroyed()).toBe(0)
    expect(scene.getState().nodes['wall-1']).toBeDefined()
  })

  test('the allow-list is re-checked at click time, not trusted from capture', () => {
    // Belt and braces: even if something put a node into `destroyed` behind
    // capture's back, the delete filters against `mine` again.
    useDemolition.getState().setDestroyed(
      [
        { nodeId: 'wall-1', kind: 'wall' },
        { nodeId: 'wall-2', kind: 'wall' },
      ],
      ['wall-1'],
      1,
    )
    expect(deleteDestroyed()).toBe(1)
    expect(scene.getState().nodes['wall-1']).toBeUndefined()
    expect(scene.getState().nodes['wall-2']).toBeDefined()
  })

  test('unwiring the sync unwires the gate (leaving a session)', () => {
    const mine = createSharedWorld('me')
    setDamageSync({ world: mine, publish: () => {} })
    const world = makeWorld()
    prevoxelize(world)
    const them = peer()
    noteLocalRemoval(them, 'wall-2', allCellsOf('wall-2'))
    noteLocalSegments(them, 'wall-2', allSegmentsOf('wall-2'))
    noteLocalKill(them, 'wall-2')
    receive(mine, them)
    expect(captureDemolition()).toBe(0)

    // Back to solo. The foreign rubble is still in the runtime, and without a
    // shared model there is no evidence either way — but the SESSION is over,
    // and the next capture is a fresh single-player one.
    setDamageSync(null)
    resetDestruction()
    const solo = makeWorld()
    prevoxelize(solo)
    for (const id of allSegmentsOf('wall-1')) {
      damageSegment(solo, 'wall-1', id, 9999, new Vector3(0, 1.35, 0))
    }
    collapseWholeTarget('wall-1')
    expect(captureDemolition()).toBe(1)
    expect(useDemolition.getState().foreign).toBe(0)
  })
})

// ── 2. the non-destructive fence, live ───────────────────────────────────────

describe('a remote kill clears the screen, not the document', () => {
  function armed() {
    useBoots.getState().setPhase('game')
    const teardown: Array<() => void> = []
    armSceneWriteSentinel(teardown)
    return {
      teardown,
      error: spyOn(console, 'error').mockImplementation(() => {}),
    }
  }

  test('a wall this player has never been near loses every cell, and stays in the graph', () => {
    const before = scene.getState().nodes
    const wallNode = before['wall-1']
    const { teardown, error } = armed()

    const mine = createSharedWorld('me')
    setDamageSync({ world: mine, publish: () => {} })
    const world = makeWorld()
    // The session has STARTED but nothing has been built yet: one zero-budget
    // tick, which stamps the world and voxelizes nothing. Both walls are still
    // being drawn entirely by their host meshes.
    setPrevoxelizeClock(() => 0)
    prevoxelizeTick(world, 0)
    expect(useDestruction.getState().targets.size).toBe(0)

    const them = peer()
    noteLocalKill(them, 'wall-1')
    receive(mine, them)

    // Materialized on demand, and gone from the screen: every cell dead and
    // the host mesh handed over (a live host would keep drawing the wall).
    const target = useDestruction.getState().targets.get('wall-1')
    expect(target).toBeDefined()
    expect(target!.grid.count).toBeGreaterThan(0)
    expect(target!.grid.aliveCount).toBe(0)
    expect(target!.dormant).toBeFalsy()
    const collider = world.colliders.find((c) => c.nodeId === 'wall-1')!
    expect(Boolean(collider.disabled)).toBe(true)

    // The document did not move. Same object, same identity, same keys.
    expect(scene.getState().nodes['wall-1']).toBe(wallNode)
    expect(Object.keys(scene.getState().nodes).sort()).toEqual(['wall-1', 'wall-2'])
    // And the sentinel never screamed.
    expect(error).not.toHaveBeenCalled()

    error.mockRestore()
    for (const fn of teardown.splice(0)) fn()
  })

  test('remote cells materialize the target and kill exactly those cells', () => {
    const { teardown, error } = armed()
    const mine = createSharedWorld('me')
    setDamageSync({ world: mine, publish: () => {} })
    const world = makeWorld()
    prevoxelize(world)
    const target = useDestruction.getState().targets.get('wall-2')!
    const full = target.grid.aliveCount
    const cells = allCellsOf('wall-2').slice(0, 12)

    const them = peer()
    noteLocalRemoval(them, 'wall-2', cells)
    receive(mine, them)

    expect(target.grid.aliveCount).toBe(full - cells.length)
    // Idempotent: the same frame twice changes nothing.
    receive(mine, them)
    expect(target.grid.aliveCount).toBe(full - cells.length)
    // Not published back as mine — this is the ownership root.
    expect(localWork(mine).cells.get('wall-2')).toBeUndefined()
    expect(scene.getState().nodes['wall-2']).toBeDefined()
    expect(error).not.toHaveBeenCalled()

    error.mockRestore()
    for (const fn of teardown.splice(0)) fn()
  })

  test('a remote stud snap breaks the stick and writes nothing to the scene', () => {
    const { teardown, error } = armed()
    const mine = createSharedWorld('me')
    setDamageSync({ world: mine, publish: () => {} })
    const world = makeWorld()
    prevoxelize(world)
    const target = useDestruction.getState().targets.get('wall-1')!
    const ids = allSegmentsOf('wall-1').slice(0, 3)
    expect(ids.length).toBe(3)

    const them = peer()
    noteLocalSegments(them, 'wall-1', ids)
    receive(mine, them)

    for (const id of ids) {
      expect(target.segments.find((s) => s.id === id)?.broken).toBe(true)
    }
    expect(target.segments.filter((s) => s.broken).length).toBe(3)
    expect(localWork(mine).segments.get('wall-1')).toBeUndefined()
    expect(error).not.toHaveBeenCalled()

    error.mockRestore()
    for (const fn of teardown.splice(0)) fn()
  })
})
