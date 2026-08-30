import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { useBoots } from '../store'
import {
  attachBuildSync,
  detachBuildSync,
  pieceRecordOf,
  placementRecordOf,
  publishItem,
  reconcileSharedPieces,
  resetSharedBuild,
} from './shared-build'
import {
  applySharedDamage,
  publishBrokenSegments,
  publishKilledNode,
  publishNodeReset,
  publishRemovedKeys,
  resetSharedDamage,
  setDamageRuntime,
  setDamageSync,
  type DamageGrid,
  type DamageRuntime,
} from './shared-damage'
import {
  cellKey,
  createSharedWorld,
  emptyEffects,
  ITEM_TARGET_PREFIX,
  localWork,
  PIECE_TARGET_PREFIX,
  snapshotOf,
  type CellKey,
  type NodeId,
  type SharedDelta,
  type SharedWorld,
} from './shared-world'

/**
 * WHOSE WALL IS `__boots-piece-3`?
 *
 * Both of ours, and that is the bug this file exists to keep fixed.
 *
 * A host scene node is named by the document, so its id means the same thing in
 * every browser in the room. A piece BUILT IN A SESSION is not: store.ts mints
 * `__boots-piece-<n>` from a counter that starts at 1 on every page load, so my
 * third wall and yours are both `__boots-piece-3`. Publish damage under that
 * name and the receiver carves a hole in a different wall — a frame that merges
 * perfectly into geometry that never converges, with no error anywhere.
 *
 * shared-world.ts had already fixed the naming (`pieceTargetId`, keyed off the
 * record id, which carries its author); what was missing was the TRANSLATION.
 * It happens at the wire boundary and nowhere else: the runtime keeps its
 * numeric ids — which is why destruction.ts's `__boots-piece-<n>` death parse
 * needed no change — and only the frame speaks record ids.
 *
 * The other half of the rule is what happens when there is no room-wide name:
 * nothing is published, ever, rather than something published under a guess.
 */

// ── fixtures ────────────────────────────────────────────────────────────────

function fakeGrid(nx: number, ny: number, nz: number): DamageGrid {
  const coords: number[] = []
  const index = new Map<number, number>()
  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        index.set(ix + nx * (iy + ny * iz), coords.length / 3)
        coords.push(ix, iy, iz)
      }
    }
  }
  const count = coords.length / 3
  return {
    nx,
    ny,
    nz,
    count,
    coords: new Int16Array(coords),
    alive: new Uint8Array(count).fill(1),
    index,
  }
}

type Recorded = {
  materialized: NodeId[]
  removed: Array<{ nodeId: NodeId; indices: number[] }>
  broken: Array<{ nodeId: NodeId; ids: number[] }>
  killed: NodeId[]
  reset: NodeId[]
}

function recordingRuntime(grids: Map<NodeId, DamageGrid>): {
  runtime: DamageRuntime
  log: Recorded
} {
  const log: Recorded = { materialized: [], removed: [], broken: [], killed: [], reset: [] }
  const runtime: DamageRuntime = {
    materialize: (nodeId) => {
      const grid = grids.get(nodeId)
      if (grid === undefined) return null
      log.materialized.push(nodeId)
      return { nodeId, grid }
    },
    removeCells: (target, indices) => {
      log.removed.push({ nodeId: target.nodeId, indices: [...indices] })
      for (const i of indices) target.grid.alive[i] = 0
    },
    breakSegments: (target, ids) => log.broken.push({ nodeId: target.nodeId, ids: [...ids] }),
    killNode: (nodeId) => log.killed.push(nodeId),
    resetNode: (nodeId) => log.reset.push(nodeId),
  }
  return { runtime, log }
}

/** The damage lane, with an array for a network. */
function damageLane(self = 'me'): { world: SharedWorld; sent: SharedDelta[] } {
  const world = createSharedWorld(self)
  const sent: SharedDelta[] = []
  setDamageSync({ world, publish: (delta) => sent.push(delta) })
  return { world, sent }
}

/**
 * Place a piece and get it a room-wide identity, the way the game does: the
 * build lane mints a record for it and binds it to the runtime id. Returns both
 * names for the same wall.
 *
 * The build lane's world and the damage lane's world are deliberately THE SAME
 * world here, because that is the arrangement in the game — one shared world
 * per session, two bridges onto it.
 */
function placeSharedPiece(slotId: string): { runtimeId: number; record: string } {
  const piece = useBoots.getState().addPlaced({ piece: 'wall', position: [0, 0, 0], yaw: 0, slotId })
  reconcileSharedPieces()
  const record = pieceRecordOf(piece.id)
  expect(record).not.toBeNull()
  return { runtimeId: piece.id, record: record as string }
}

const CELLS: CellKey[] = [cellKey(0, 0, 0), cellKey(1, 0, 0)]

let incumbent: DamageRuntime | null = null

beforeEach(() => {
  incumbent = setDamageRuntime(null)
  useBoots.setState({ placed: [] })
})

afterEach(() => {
  setDamageSync(null)
  setDamageRuntime(incumbent)
  resetSharedDamage()
  detachBuildSync()
  resetSharedBuild()
  useBoots.setState({ placed: [] })
})

// ── outbound ────────────────────────────────────────────────────────────────

describe('publishing a session-built target', () => {
  test('a placed piece is published under its RECORD id, never its local number', () => {
    const { world, sent } = damageLane('me')
    attachBuildSync(world)
    const wall = placeSharedPiece('Wz:0,0,0')

    publishRemovedKeys(`${PIECE_TARGET_PREFIX}${wall.runtimeId}`, CELLS)

    expect(sent.length).toBe(1)
    expect(sent[0]!.nodes.map((n) => n.nodeId)).toEqual([`${PIECE_TARGET_PREFIX}${wall.record}`])
    // And the local number is nowhere on the wire — not as a node id, and not
    // hiding in the world the frame was built from.
    expect(snapshotOf(world).nodes.map((d) => d.nodeId)).toEqual([
      `${PIECE_TARGET_PREFIX}${wall.record}`,
    ])
    expect(JSON.stringify(sent[0])).not.toContain(`${PIECE_TARGET_PREFIX}${wall.runtimeId}"`)
  })

  test('two peers with the same local number publish two DIFFERENT walls', () => {
    // The whole point, stated as the collision it prevents: both clients are
    // damaging their own `__boots-piece-<n>` with the same n, and the two
    // frames must not name the same node.
    const mine = damageLane('me')
    attachBuildSync(mine.world)
    const a = placeSharedPiece('Wz:0,0,0')
    publishRemovedKeys(`${PIECE_TARGET_PREFIX}${a.runtimeId}`, CELLS)

    // A second client, in the same process: its own world, its own bindings,
    // and — the setup that used to break — a piece with the SAME runtime id.
    setDamageSync(null)
    detachBuildSync()
    resetSharedBuild()
    resetSharedDamage()
    useBoots.setState({ placed: [] })

    const theirs = damageLane('you')
    attachBuildSync(theirs.world)
    const b = useBoots
      .getState()
      .addPlaced({ piece: 'wall', position: [9, 0, 0], yaw: 0, slotId: 'Wz:9,0,0' })
    // Force the collision rather than hoping the counter obliges.
    useBoots.setState({ placed: [{ ...b, id: a.runtimeId }] })
    reconcileSharedPieces()
    const theirRecord = pieceRecordOf(a.runtimeId)
    expect(theirRecord).not.toBeNull()
    publishRemovedKeys(`${PIECE_TARGET_PREFIX}${a.runtimeId}`, CELLS)

    const nameOf = (sent: SharedDelta[]) => sent[0]!.nodes[0]!.nodeId
    expect(nameOf(mine.sent)).not.toBe(nameOf(theirs.sent))
    expect(nameOf(mine.sent)).toBe(`${PIECE_TARGET_PREFIX}${a.record}`)
    expect(nameOf(theirs.sent)).toBe(`${PIECE_TARGET_PREFIX}${theirRecord}`)
  })

  test('every publish entry point translates, not just the cell one', () => {
    const { world, sent } = damageLane('me')
    attachBuildSync(world)
    const wall = placeSharedPiece('Wz:0,0,0')
    const local = `${PIECE_TARGET_PREFIX}${wall.runtimeId}`
    const wire = `${PIECE_TARGET_PREFIX}${wall.record}`

    publishRemovedKeys(local, CELLS)
    publishBrokenSegments(local, [3, 4])
    publishKilledNode(local)

    // The projection the Save gate reads is keyed the same way — one wall, one
    // name, whichever door the evidence came in through.
    const work = localWork(world)
    expect([...work.cells.keys()]).toEqual([wire])
    expect([...work.segments.keys()]).toEqual([wire])

    // The reset comes last because it is the one that CLEARS the claims above
    // (a new epoch is pristine); what matters here is only that it, too,
    // announces the record name.
    publishNodeReset(local)

    const named = new Set(sent.flatMap((d) => d.nodes.map((n) => n.nodeId)))
    expect([...named]).toEqual([wire])
    expect(sent.some((d) => d.nodes.some((n) => n.reset))).toBe(true)
  })

  test('a piece with no room-wide identity publishes NOTHING', () => {
    // A legacy/off-grid piece carries no slot, so the build lane cannot mint a
    // record for it: it renders and collides, but it is not shared. Its damage
    // must stay home rather than travel under a number that means another
    // wall somewhere else.
    const { world, sent } = damageLane('me')
    attachBuildSync(world)
    const orphan = useBoots.getState().addPlaced({ piece: 'wall', position: [0, 0, 0], yaw: 0 })
    reconcileSharedPieces()
    expect(pieceRecordOf(orphan.id)).toBeNull()

    publishRemovedKeys(`${PIECE_TARGET_PREFIX}${orphan.id}`, CELLS)
    publishBrokenSegments(`${PIECE_TARGET_PREFIX}${orphan.id}`, [1])
    publishKilledNode(`${PIECE_TARGET_PREFIX}${orphan.id}`)

    expect(sent).toEqual([])
    expect(snapshotOf(world).nodes).toEqual([])
    // Not claimed either: an unpublished carve is not evidence of anything.
    expect(localWork(world).cells.size).toBe(0)
  })

  test('spawn fixtures are refused, and host nodes are untouched', () => {
    const { world, sent } = damageLane('me')
    attachBuildSync(world)

    // `__boots-table1` / `__boots-switch` are the spawn fixtures, which every
    // client builds for itself at its own spawn point — they are not the same
    // object in two browsers at all, so their damage means nothing to anyone
    // else. `__boots-item-4` is an item nobody published: no record, no name.
    // `__boots-piece-` is malformed, and must not read as piece number zero.
    for (const id of ['__boots-item-4', '__boots-table1', '__boots-switch', '__boots-piece-']) {
      publishRemovedKeys(id, CELLS)
      publishKilledNode(id)
    }
    expect(sent).toEqual([])

    // A host node's id comes from the document. It is already room-wide, and it
    // must arrive on the wire spelled exactly as the scene spells it — this is
    // the case that matters for Save, and the one that must not regress.
    publishRemovedKeys('wall-1', CELLS)
    expect(sent.length).toBe(1)
    expect(sent[0]!.nodes[0]!.nodeId).toBe('wall-1')
  })

  test('an already-record-keyed target passes through unchanged (translation is idempotent)', () => {
    const { world, sent } = damageLane('me')
    attachBuildSync(world)
    const wall = placeSharedPiece('Wz:0,0,0')
    const wire = `${PIECE_TARGET_PREFIX}${wall.record}`

    // If the runtime ever adopts record-keyed target ids, translating twice
    // must be the same as translating once. `#` is illegal in a peer id, so
    // the two id spaces can always be told apart.
    publishRemovedKeys(wire, CELLS)
    expect(sent.length).toBe(1)
    expect(sent[0]!.nodes[0]!.nodeId).toBe(wire)
  })
})

// ── inbound ─────────────────────────────────────────────────────────────────

describe('applying damage to a session-built target', () => {
  test("a record-named frame lands on THIS client's differently-numbered piece", () => {
    const { world } = damageLane('me')
    attachBuildSync(world)
    // Three pieces, so the runtime number and the record sequence cannot
    // accidentally agree and let a by-number resolution pass this test.
    placeSharedPiece('Wz:0,0,0')
    placeSharedPiece('Wz:1,0,0')
    const victim = placeSharedPiece('Wz:2,0,0')
    const local = `${PIECE_TARGET_PREFIX}${victim.runtimeId}`

    const grids = new Map<NodeId, DamageGrid>([[local, fakeGrid(2, 2, 1)]])
    const { runtime, log } = recordingRuntime(grids)
    setDamageRuntime(runtime)

    const fx = emptyEffects()
    fx.removedCells.set(`${PIECE_TARGET_PREFIX}${victim.record}`, [cellKey(1, 1, 0)])
    fx.brokenSegments.set(`${PIECE_TARGET_PREFIX}${victim.record}`, [2])
    fx.killedNodes.push(`${PIECE_TARGET_PREFIX}${victim.record}`)
    const report = applySharedDamage(fx)

    expect(report.unresolved).toBe(0)
    expect(report.cells).toBe(1)
    expect(report.segments).toBe(1)
    expect(report.kills).toBe(1)
    expect(log.removed.map((r) => r.nodeId)).toEqual([local])
    expect(log.broken.map((r) => r.nodeId)).toEqual([local])
    expect(log.killed).toEqual([local])
    // And it is the LOCAL wall that lost a cell, addressed by the wire's
    // lattice key — no by-number coincidence involved.
    expect(grids.get(local)!.alive[3]).toBe(0)
  })

  test('a peer-numbered target is refused, never resolved by number', () => {
    const { world } = damageLane('me')
    attachBuildSync(world)
    const mineWall = placeSharedPiece('Wz:0,0,0')
    const local = `${PIECE_TARGET_PREFIX}${mineWall.runtimeId}`

    const grids = new Map<NodeId, DamageGrid>([[local, fakeGrid(2, 2, 1)]])
    const { runtime, log } = recordingRuntime(grids)
    setDamageRuntime(runtime)

    // An old build, or a hostile peer: a frame naming the piece by NUMBER,
    // and the number happens to be mine. Resolving it would let a stranger
    // aim at my walls by guessing small integers.
    const fx = emptyEffects()
    fx.removedCells.set(local, [cellKey(0, 0, 0)])
    fx.killedNodes.push(local)
    const report = applySharedDamage(fx)

    expect(report.unresolved).toBe(2)
    expect(report.cells).toBe(0)
    expect(report.kills).toBe(0)
    expect(log.materialized).toEqual([])
    expect(log.killed).toEqual([])
    expect(grids.get(local)!.alive[0]).toBe(1)
  })

  test('a record this client has never installed is dropped, countably', () => {
    const { world } = damageLane('me')
    attachBuildSync(world)
    const { runtime, log } = recordingRuntime(new Map())
    setDamageRuntime(runtime)

    const fx = emptyEffects()
    fx.resetNodes.push(`${PIECE_TARGET_PREFIX}you#7`)
    fx.removedCells.set(`${PIECE_TARGET_PREFIX}you#7`, [cellKey(0, 0, 0)])
    fx.brokenSegments.set(`${PIECE_TARGET_PREFIX}you#7`, [1])
    fx.killedNodes.push(`${PIECE_TARGET_PREFIX}you#7`)
    const report = applySharedDamage(fx)

    // Four effects, four drops — and `deferred` stays clean, because this is
    // not "a node I could not voxelize", it is "a node I do not have".
    expect(report.unresolved).toBe(4)
    expect(report.deferred).toBe(0)
    expect(log.materialized).toEqual([])
    expect(report.resets).toBe(0)
  })

  test('host nodes still apply exactly as before', () => {
    const { world } = damageLane('me')
    attachBuildSync(world)
    const grids = new Map<NodeId, DamageGrid>([['wall-1', fakeGrid(2, 2, 1)]])
    const { runtime, log } = recordingRuntime(grids)
    setDamageRuntime(runtime)

    const fx = emptyEffects()
    fx.removedCells.set('wall-1', [cellKey(0, 0, 0)])
    fx.killedNodes.push('wall-1')
    const report = applySharedDamage(fx)

    expect(report.unresolved).toBe(0)
    expect(report.cells).toBe(1)
    expect(log.killed).toEqual(['wall-1'])
  })
})

// ── placed catalog items ────────────────────────────────────────────────────

describe('a placed item is destructible, so its damage travels too', () => {
  // destruction.ts keeps `__boots-item-*` out of PREVOXELIZATION only — its own
  // comment says items re-voxelize "on proxy→GLB swaps and first hits" — so a
  // player shooting a sofa destroys it locally. Under a wholesale refusal that
  // destruction reached nobody, which is half of "builds and destruction both
  // replicate" quietly missing.

  test('a published item is damaged under its record id, never its local number', () => {
    const { world, sent } = damageLane('me')
    attachBuildSync(world)
    const record = publishItem(7, 'sofa-2', [1, 0, 2], 0)
    expect(record).not.toBeNull()
    sent.length = 0

    publishRemovedKeys(`${ITEM_TARGET_PREFIX}7`, CELLS)
    publishKilledNode(`${ITEM_TARGET_PREFIX}7`)

    const named = new Set(sent.flatMap((d) => d.nodes.map((n) => n.nodeId)))
    expect([...named]).toEqual([`${ITEM_TARGET_PREFIX}${record}`])
    expect([...localWork(world).cells.keys()]).toEqual([`${ITEM_TARGET_PREFIX}${record}`])
  })

  test('two clients whose item counters both minted 7 damage two DIFFERENT sofas', () => {
    const mine = damageLane('me')
    attachBuildSync(mine.world)
    const myRecord = publishItem(7, 'sofa-2', [1, 0, 2], 0)
    mine.sent.length = 0
    publishRemovedKeys(`${ITEM_TARGET_PREFIX}7`, CELLS)

    setDamageSync(null)
    detachBuildSync()
    resetSharedBuild()
    resetSharedDamage()

    const theirs = damageLane('you')
    attachBuildSync(theirs.world)
    // Same number, different piece of furniture, on the far side of the lot.
    const theirRecord = publishItem(7, 'armchair-1', [40, 0, 9], 90)
    theirs.sent.length = 0
    publishRemovedKeys(`${ITEM_TARGET_PREFIX}7`, CELLS)

    expect(myRecord).not.toBe(theirRecord)
    const nameOf = (sent: SharedDelta[]) => sent[0]!.nodes[0]!.nodeId
    expect(nameOf(mine.sent)).toBe(`${ITEM_TARGET_PREFIX}${myRecord}`)
    expect(nameOf(theirs.sent)).toBe(`${ITEM_TARGET_PREFIX}${theirRecord}`)
    expect(nameOf(mine.sent)).not.toBe(nameOf(theirs.sent))
  })

  test("a record-named item frame lands on THIS client's item, and a numbered one never does", () => {
    const { world } = damageLane('me')
    attachBuildSync(world)
    const record = publishItem(7, 'sofa-2', [1, 0, 2], 0) as string
    expect(placementRecordOf(7)).toBe(record)

    const local = `${ITEM_TARGET_PREFIX}7`
    const grids = new Map<NodeId, DamageGrid>([[local, fakeGrid(2, 2, 1)]])
    const { runtime, log } = recordingRuntime(grids)
    setDamageRuntime(runtime)

    const fx = emptyEffects()
    fx.removedCells.set(`${ITEM_TARGET_PREFIX}${record}`, [cellKey(1, 0, 0)])
    fx.killedNodes.push(`${ITEM_TARGET_PREFIX}${record}`)
    expect(applySharedDamage(fx)).toMatchObject({ unresolved: 0, cells: 1, kills: 1 })
    expect(log.removed.map((r) => r.nodeId)).toEqual([local])
    expect(log.killed).toEqual([local])

    // The same shot, named by number instead: refused, counted, not applied.
    const numbered = emptyEffects()
    numbered.removedCells.set(local, [cellKey(0, 0, 0)])
    numbered.killedNodes.push(local)
    const report = applySharedDamage(numbered)
    expect(report.unresolved).toBe(2)
    expect(report.cells).toBe(0)
    expect(grids.get(local)!.alive[0]).toBe(1)
  })

  test('an item record this client has never installed is dropped, not guessed at', () => {
    const { world } = damageLane('me')
    attachBuildSync(world)
    publishItem(7, 'sofa-2', [1, 0, 2], 0)
    const grids = new Map<NodeId, DamageGrid>([[`${ITEM_TARGET_PREFIX}7`, fakeGrid(2, 2, 1)]])
    const { runtime, log } = recordingRuntime(grids)
    setDamageRuntime(runtime)

    // A peer's sofa, which never arrived here. The tempting wrong answer is to
    // fall back on the only item we do have.
    const fx = emptyEffects()
    fx.removedCells.set(`${ITEM_TARGET_PREFIX}you#3`, [cellKey(0, 0, 0)])
    const report = applySharedDamage(fx)
    expect(report.unresolved).toBe(1)
    expect(log.materialized).toEqual([])
    expect(grids.get(`${ITEM_TARGET_PREFIX}7`)!.alive[0]).toBe(1)
  })
})

// ── the naming contract these two halves share ──────────────────────────────

describe('the id spaces cannot be confused', () => {
  test("the game's session namespace is the prefix both shared-world target ids start with", () => {
    // shared-damage recognises a session-built target by the `__boots` prefix.
    // If shared-world ever renames its target prefixes out from under that,
    // this fails here rather than by silently publishing a per-client id.
    expect(PIECE_TARGET_PREFIX.startsWith('__boots')).toBe(true)
    expect(ITEM_TARGET_PREFIX.startsWith('__boots')).toBe(true)
    expect(PIECE_TARGET_PREFIX).toBe('__boots-piece-')
    expect(ITEM_TARGET_PREFIX).toBe('__boots-item-')
    // And they must stay distinguishable from each other by prefix alone.
    expect(PIECE_TARGET_PREFIX.startsWith(ITEM_TARGET_PREFIX)).toBe(false)
    expect(ITEM_TARGET_PREFIX.startsWith(PIECE_TARGET_PREFIX)).toBe(false)
  })

  test('a record id always carries the `#` a runtime id never can', () => {
    const world = createSharedWorld('me')
    attachBuildSync(world)
    setDamageSync({ world, publish: () => {} })
    const wall = placeSharedPiece('Wz:0,0,0')
    expect(wall.record).toContain('#')
    expect(String(wall.runtimeId)).not.toContain('#')
    // The peer half is opaque here on purpose: this bridge never parses or
    // splits a record id, so the sync core is free to change what a peer id
    // looks like without touching the damage lane.
    expect(wall.record.endsWith(`#${wall.record.split('#')[1]}`)).toBe(true)
  })
})
