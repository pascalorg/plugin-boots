import { afterEach, describe, expect, test } from 'bun:test'
import { BoxGeometry, Mesh } from 'three'
import {
  applySharedDamage,
  beginDamageBatch,
  endDamageBatch,
  gridIsShareable,
  indexOfKey,
  inDamageBatch,
  keyOfIndex,
  keysOfIndices,
  publishBrokenSegments,
  publishKilledNode,
  publishNodeReset,
  publishRemovedCells,
  resetSharedDamage,
  setDamageRuntime,
  setDamageSync,
  sharedDamageDebug,
  type DamageGrid,
  type DamageRuntime,
  type DamageTargetLike,
} from './shared-damage'
import {
  brokenSegments,
  cellKey,
  createSharedWorld,
  emptyEffects,
  localWork,
  MAX_CELLS_PER_NODE,
  mergeDelta,
  nodeDamage,
  removedCells,
  sharedWorldDebug,
  snapshotOf,
  type CellKey,
  type NodeId,
  type SharedDelta,
  type SharedWorld,
} from './shared-world'
import { decodeDelta, encodeDelta } from './shared-wire'
import { buildVoxelGrid, removeSphere, type VoxelGridData } from './voxel'
import { bvhFor } from './world'

/**
 * The damage bridge, unit-tested with no renderer and no network.
 *
 * Two things are being pinned here. The first is the CELL ADDRESS: a wire cell
 * is a lattice coordinate, and the conversion to and from voxel.ts's compact
 * index has to survive voxel.ts changing its mind about how it linearizes the
 * lattice (which it does privately, so the mirror in shared-damage.ts is the
 * one line of duplication in the whole bridge — the round-trip test below is
 * its tripwire). The second is CONVERGENCE: a carve on one peer, put on the
 * wire, merged and applied on another, has to leave the second peer's grid
 * bit-identical to the first — without the second peer ever re-running the
 * random-nibble carve that produced it.
 */

// ── Fixtures ────────────────────────────────────────────────────────────────

/** A real grid from the real voxelizer — not a hand-rolled literal, because
 * the point is to catch voxel.ts drifting away from the mirror. */
function realGrid(size: [number, number, number], cell = 0.15): VoxelGridData {
  const mesh = new Mesh(new BoxGeometry(size[0], size[1], size[2]))
  mesh.position.set(0, size[1] / 2, 0)
  mesh.updateMatrixWorld(true)
  mesh.geometry.computeBoundingBox()
  const bounds = mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld)
  return buildVoxelGrid([{ bvh: bvhFor(mesh), matrixWorld: mesh.matrixWorld }], bounds, cell)
}

/** A grid literal, for the cases where the lattice shape is the subject. */
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

/** Voxels still standing, read off the bitmap — the recording runtime below
 * does not maintain voxel.ts's aliveCount counter, only the truth it caches. */
const liveCells = (grid: DamageGrid): number => {
  let live = 0
  for (let i = 0; i < grid.count; i++) if (grid.alive[i] === 1) live++
  return live
}

type Recorded = {
  materialized: NodeId[]
  removed: Array<{ nodeId: NodeId; indices: number[] }>
  broken: Array<{ nodeId: NodeId; ids: number[] }>
  killed: NodeId[]
  reset: NodeId[]
}

/**
 * A runtime that records instead of rendering, and that can be told a node is
 * not materializable yet — the dormant / shellPending case, which is the
 * normal case for remote damage.
 */
function recordingRuntime(
  grids: Map<NodeId, DamageGrid>,
  opts: { unknown?: Set<NodeId> } = {},
): { runtime: DamageRuntime; log: Recorded } {
  const log: Recorded = { materialized: [], removed: [], broken: [], killed: [], reset: [] }
  const runtime: DamageRuntime = {
    materialize: (nodeId) => {
      if (opts.unknown?.has(nodeId)) return null
      const grid = grids.get(nodeId)
      if (grid === undefined) return null
      log.materialized.push(nodeId)
      return { nodeId, grid }
    },
    removeCells: (target, indices) => {
      log.removed.push({ nodeId: target.nodeId, indices: [...indices] })
      for (const index of indices) target.grid.alive[index] = 0
    },
    breakSegments: (target, ids) => {
      log.broken.push({ nodeId: target.nodeId, ids: [...ids] })
    },
    killNode: (nodeId) => {
      log.killed.push(nodeId)
      const grid = grids.get(nodeId)
      if (grid !== undefined) grid.alive.fill(0)
    },
    resetNode: (nodeId) => {
      log.reset.push(nodeId)
      const grid = grids.get(nodeId)
      if (grid !== undefined) grid.alive.fill(1)
    },
  }
  return { runtime, log }
}

/** A sync whose "network" is an array. */
function capturingSync(self = 'peer-a'): { world: SharedWorld; sent: SharedDelta[] } {
  const world = createSharedWorld(self)
  const sent: SharedDelta[] = []
  setDamageSync({ world, publish: (delta) => sent.push(delta) })
  return { world, sent }
}

afterEach(() => {
  setDamageSync(null)
  setDamageRuntime(null)
  resetSharedDamage()
})

// ── The cell address ────────────────────────────────────────────────────────

describe('the cell address', () => {
  test('every voxel of a real grid round-trips index → key → index', () => {
    const grid = realGrid([2, 2.7, 0.12])
    expect(grid.count).toBeGreaterThan(200)
    let checked = 0
    for (let index = 0; index < grid.count; index++) {
      const key = keyOfIndex(grid, index)
      expect(key).not.toBe(-1)
      // The tripwire: this lookup goes through shared-damage's MIRROR of
      // voxel.ts's private lattice linearization. If voxel.ts ever changes it,
      // grid.index is keyed differently and this fails on the first cell.
      expect(indexOfKey(grid, key as CellKey)).toBe(index)
      checked++
    }
    expect(checked).toBe(grid.count)
  })

  test('a key names the same lattice cell the grid does', () => {
    const grid = realGrid([2, 2.7, 0.12])
    for (let index = 0; index < grid.count; index += 7) {
      const key = keyOfIndex(grid, index) as CellKey
      expect(key).toBe(
        cellKey(grid.coords[index * 3]!, grid.coords[index * 3 + 1]!, grid.coords[index * 3 + 2]!),
      )
    }
  })

  test('out-of-range indices and foreign keys are refused, not guessed', () => {
    const grid = fakeGrid(3, 3, 2)
    expect(keyOfIndex(grid, -1)).toBe(-1)
    expect(keyOfIndex(grid, grid.count)).toBe(-1)
    expect(keyOfIndex(grid, 1.5)).toBe(-1)
    // A cell that exists on the sender's larger grid but not on ours.
    expect(indexOfKey(grid, cellKey(9, 0, 0))).toBe(-1)
    expect(indexOfKey(grid, cellKey(0, 9, 0))).toBe(-1)
    expect(indexOfKey(grid, cellKey(0, 0, 9))).toBe(-1)
    expect(indexOfKey(grid, -5 as CellKey)).toBe(-1)
  })

  test('keysOfIndices is canonical and drops what it cannot name', () => {
    const grid = fakeGrid(4, 4, 1)
    const keys = keysOfIndices(grid, [9, 2, 999, 0, -3, 5])
    expect(keys).toEqual([...keys].sort((a, b) => a - b))
    expect(keys.length).toBe(4)
  })

  test('a lattice too big for a 10-bit axis is refused rather than aliased', () => {
    expect(gridIsShareable(fakeGrid(4, 4, 1))).toBe(true)
    expect(gridIsShareable({ ...fakeGrid(2, 2, 1), nx: 2048 })).toBe(false)
    expect(gridIsShareable({ ...fakeGrid(2, 2, 1), ny: 0 })).toBe(false)
  })
})

// ── Single player ───────────────────────────────────────────────────────────

describe('with sync off', () => {
  test('publishing is completely inert', () => {
    const grid = fakeGrid(4, 4, 2)
    const target: DamageTargetLike = { nodeId: 'wall-1', grid }
    // No sync injected. None of this may allocate, sort, or read a grid.
    publishRemovedCells(target, [0, 1, 2])
    publishBrokenSegments('wall-1', [0, 1])
    publishKilledNode('wall-1')
    publishNodeReset('wall-1')
    beginDamageBatch()
    endDamageBatch()
    const debug = sharedDamageDebug()
    expect(debug.active).toBe(false)
    expect(debug.batchDepth).toBe(0)
    expect(debug.pendingNodes).toBe(0)
    expect(debug.pendingCells).toBe(0)
  })

  test('inDamageBatch still runs its body exactly once', () => {
    let ran = 0
    const out = inDamageBatch(() => {
      ran++
      return 41 + 1
    })
    expect(ran).toBe(1)
    expect(out).toBe(42)
  })

  test('applying does nothing without a runtime', () => {
    const fx = emptyEffects()
    fx.killedNodes.push('wall-1')
    const report = applySharedDamage(fx)
    expect(report.kills).toBe(0)
  })
})

// ── Publishing ──────────────────────────────────────────────────────────────

describe('publishing', () => {
  test('a carve becomes one frame of lattice keys, in canonical order', () => {
    const { world, sent } = capturingSync()
    const grid = fakeGrid(4, 4, 2)
    publishRemovedCells({ nodeId: 'wall-1', grid }, [9, 3, 17, 0])
    expect(sent.length).toBe(1)
    const frame = sent[0]!
    expect(frame.from).toBe('peer-a')
    expect(frame.nodes.length).toBe(1)
    const node = frame.nodes[0]!
    expect(node.nodeId).toBe('wall-1')
    expect(node.removed.length).toBe(4)
    expect(node.removed).toEqual([...node.removed].sort((a, b) => a - b))
    // Keys, never indices: the sender's index 9 is not on the wire as 9.
    expect(node.removed).toEqual(keysOfIndices(grid, [9, 3, 17, 0]))
    expect(removedCells(world, 'wall-1').length).toBe(4)
  })

  test('restating a cell publishes nothing — deltas, not restatements', () => {
    const { sent } = capturingSync()
    const grid = fakeGrid(4, 4, 2)
    const target = { nodeId: 'wall-1', grid }
    publishRemovedCells(target, [0, 1, 2])
    publishRemovedCells(target, [0, 1, 2])
    publishRemovedCells(target, [2, 3])
    expect(sent.length).toBe(2)
    expect(sent[1]!.nodes[0]!.removed.length).toBe(1)
  })

  test('a batch coalesces a whole trigger pull into one frame', () => {
    const { sent } = capturingSync()
    const grid = fakeGrid(6, 6, 2)
    const target = { nodeId: 'wall-1', grid }
    inDamageBatch(() => {
      // The five random nibbles of one SMASH hit.
      publishRemovedCells(target, [0, 1])
      publishRemovedCells(target, [2, 3])
      publishRemovedCells(target, [4])
      publishBrokenSegments('wall-1', [3, 1])
      publishRemovedCells(target, [5, 6])
    })
    expect(sent.length).toBe(1)
    const node = sent[0]!.nodes[0]!
    expect(node.removed.length).toBe(7)
    expect(node.segments).toEqual([1, 3])
  })

  test('nested batches send once, at the outermost close', () => {
    const { sent } = capturingSync()
    const grid = fakeGrid(4, 4, 2)
    inDamageBatch(() => {
      publishRemovedCells({ nodeId: 'roof-1#p0', grid }, [0])
      inDamageBatch(() => {
        publishRemovedCells({ nodeId: 'roof-1#p1', grid }, [1])
      })
      expect(sent.length).toBe(0)
    })
    expect(sent.length).toBe(1)
    expect(sent[0]!.nodes.map((n) => n.nodeId)).toEqual(['roof-1#p0', 'roof-1#p1'])
  })

  test('a throw inside a batch still closes it', () => {
    const { sent } = capturingSync()
    const grid = fakeGrid(4, 4, 2)
    expect(() =>
      inDamageBatch(() => {
        publishRemovedCells({ nodeId: 'wall-1', grid }, [0])
        throw new Error('carve blew up')
      }),
    ).toThrow('carve blew up')
    expect(sent.length).toBe(1)
    expect(sharedDamageDebug().batchDepth).toBe(0)
  })

  test('node order in a frame is canonical, not the order they were hit', () => {
    const { sent } = capturingSync()
    const grid = fakeGrid(4, 4, 2)
    inDamageBatch(() => {
      for (const nodeId of ['wall-9', 'wall-2', 'roof-1', 'slab-5']) {
        publishRemovedCells({ nodeId, grid }, [0, 1])
      }
    })
    expect(sent[0]!.nodes.map((n) => n.nodeId)).toEqual(['roof-1', 'slab-5', 'wall-2', 'wall-9'])
  })

  test('a whole-node collapse publishes the bit AND the cells', () => {
    const { sent } = capturingSync()
    const grid = fakeGrid(4, 4, 2)
    const all = Array.from({ length: grid.count }, (_, i) => i)
    inDamageBatch(() => {
      publishRemovedCells({ nodeId: 'wall-1', grid }, all)
      publishKilledNode('wall-1')
    })
    expect(sent.length).toBe(1)
    const node = sent[0]!.nodes[0]!
    expect(node.killed).toBe(true)
    // The bit is what a peer who never materialized the wall can obey; the
    // cells are what keeps the Save ownership gate truthful.
    expect(node.removed.length).toBe(grid.count)
  })

  test('a second kill of the same node publishes nothing', () => {
    const { sent } = capturingSync()
    publishKilledNode('wall-1')
    publishKilledNode('wall-1')
    expect(sent.length).toBe(1)
  })

  test('a reset announces its own epoch and wipes the old damage', () => {
    const { world, sent } = capturingSync()
    const grid = fakeGrid(4, 4, 2)
    publishRemovedCells({ nodeId: 'door-1', grid }, [0, 1, 2])
    publishBrokenSegments('door-1', [0])
    sent.length = 0
    publishNodeReset('door-1')
    expect(sent.length).toBe(1)
    const node = sent[0]!.nodes[0]!
    expect(node.reset).toBe(true)
    expect(node.epoch).toBe(1)
    expect(node.removed.length).toBe(0)
    expect(removedCells(world, 'door-1').length).toBe(0)
    expect(brokenSegments(world, 'door-1').length).toBe(0)
  })

  test('a reset flushes staged damage first, at the OLD epoch', () => {
    const { sent } = capturingSync()
    const grid = fakeGrid(4, 4, 2)
    beginDamageBatch()
    publishRemovedCells({ nodeId: 'door-1', grid }, [0, 1])
    publishNodeReset('door-1')
    endDamageBatch()
    // Two frames: the holes at epoch 0, then the restore at epoch 1. Batched
    // together they would have been stamped epoch 1 and survived the restore.
    expect(sent.length).toBe(2)
    expect(sent[0]!.nodes[0]!.epoch).toBe(0)
    expect(sent[0]!.nodes[0]!.removed.length).toBe(2)
    expect(sent[1]!.nodes[0]!.epoch).toBe(1)
    expect(sent[1]!.nodes[0]!.reset).toBe(true)
  })

  test('damage after a reset carries the new epoch', () => {
    const { sent } = capturingSync()
    const grid = fakeGrid(4, 4, 2)
    publishNodeReset('door-1')
    sent.length = 0
    publishRemovedCells({ nodeId: 'door-1', grid }, [0])
    expect(sent[0]!.nodes[0]!.epoch).toBe(1)
    expect(sent[0]!.nodes[0]!.reset).toBe(false)
  })

  test('more cells than a frame may carry go out over several frames, none lost', () => {
    const { world, sent } = capturingSync()
    // A lattice big enough to exceed the per-node cell cap.
    const grid = fakeGrid(20, 20, 20)
    expect(grid.count).toBeGreaterThan(MAX_CELLS_PER_NODE)
    const all = Array.from({ length: grid.count }, (_, i) => i)
    inDamageBatch(() => {
      publishRemovedCells({ nodeId: 'tower-1', grid }, all)
    })
    expect(sent.length).toBeGreaterThan(1)
    const seen = new Set<CellKey>()
    for (const frame of sent) {
      for (const node of frame.nodes) {
        expect(node.removed.length).toBeLessThanOrEqual(MAX_CELLS_PER_NODE)
        for (const key of node.removed) seen.add(key)
      }
    }
    expect(seen.size).toBe(grid.count)
    expect(removedCells(world, 'tower-1').length).toBe(grid.count)
  })

  test('a grid too big to address on the wire publishes nothing', () => {
    const { world, sent } = capturingSync()
    const grid = { ...fakeGrid(2, 2, 1), nx: 4096 }
    publishRemovedCells({ nodeId: 'wall-1', grid }, [0, 1])
    expect(sent.length).toBe(0)
    expect(sharedWorldDebug(world).cells).toBe(0)
  })
})

// ── Applying ────────────────────────────────────────────────────────────────

describe('applying', () => {
  test('a remote hole materializes the target and lands on it', () => {
    const grids = new Map<NodeId, DamageGrid>([['wall-7', fakeGrid(4, 4, 2)]])
    const { runtime, log } = recordingRuntime(grids)
    setDamageRuntime(runtime)
    const fx = emptyEffects()
    const grid = grids.get('wall-7')!
    fx.removedCells.set('wall-7', keysOfIndices(grid, [0, 5, 9]))
    const report = applySharedDamage(fx)
    expect(report.materialized).toBe(1)
    expect(report.cells).toBe(3)
    expect(log.removed[0]!.indices).toEqual([0, 5, 9])
    expect(grid.alive[0]).toBe(0)
    expect(grid.alive[5]).toBe(0)
    expect(grid.alive[1]).toBe(1)
  })

  test('applying twice is a no-op the second time', () => {
    const grids = new Map<NodeId, DamageGrid>([['wall-7', fakeGrid(4, 4, 2)]])
    const { runtime, log } = recordingRuntime(grids)
    setDamageRuntime(runtime)
    const keys = keysOfIndices(grids.get('wall-7')!, [0, 5, 9])
    const fx = emptyEffects()
    fx.removedCells.set('wall-7', keys)
    applySharedDamage(fx)
    const again = emptyEffects()
    again.removedCells.set('wall-7', keys)
    const report = applySharedDamage(again)
    expect(report.cells).toBe(0)
    expect(log.removed.length).toBe(1)
  })

  test('a node this client cannot voxelize yet is deferred, not crashed on', () => {
    const grids = new Map<NodeId, DamageGrid>([['wall-7', fakeGrid(4, 4, 2)]])
    const { runtime } = recordingRuntime(grids, { unknown: new Set(['wall-7']) })
    setDamageRuntime(runtime)
    const fx = emptyEffects()
    fx.removedCells.set('wall-7', [cellKey(0, 0, 0)])
    fx.brokenSegments.set('wall-7', [1])
    const report = applySharedDamage(fx)
    expect(report.deferred).toBe(2)
    expect(report.cells).toBe(0)
  })

  test('cells this client has no voxel for are counted and skipped', () => {
    const grids = new Map<NodeId, DamageGrid>([['wall-7', fakeGrid(4, 4, 2)]])
    const { runtime } = recordingRuntime(grids)
    setDamageRuntime(runtime)
    const fx = emptyEffects()
    fx.removedCells.set('wall-7', [cellKey(0, 0, 0), cellKey(99, 0, 0), cellKey(0, 99, 0)])
    const report = applySharedDamage(fx)
    expect(report.unknownCells).toBe(2)
    expect(report.cells).toBe(1)
  })

  test('order is reset, then cells, then segments, then the kill', () => {
    const grids = new Map<NodeId, DamageGrid>([
      ['a', fakeGrid(3, 3, 1)],
      ['b', fakeGrid(3, 3, 1)],
    ])
    const { runtime } = recordingRuntime(grids)
    const order: string[] = []
    setDamageRuntime({
      materialize: runtime.materialize,
      removeCells: (t, i) => {
        order.push(`cells:${t.nodeId}`)
        runtime.removeCells(t, i)
      },
      breakSegments: (t, i) => {
        order.push(`segs:${t.nodeId}`)
        runtime.breakSegments(t, i)
      },
      killNode: (n) => {
        order.push(`kill:${n}`)
        runtime.killNode(n)
      },
      resetNode: (n) => {
        order.push(`reset:${n}`)
        runtime.resetNode(n)
      },
    })
    const fx = emptyEffects()
    fx.killedNodes.push('b')
    fx.brokenSegments.set('a', [2])
    fx.removedCells.set('a', [cellKey(0, 0, 0)])
    fx.resetNodes.push('a')
    applySharedDamage(fx)
    expect(order).toEqual(['reset:a', 'cells:a', 'segs:a', 'kill:b'])
  })

  test('walks are canonical, not Map order', () => {
    const grids = new Map<NodeId, DamageGrid>()
    for (const id of ['wall-9', 'wall-2', 'roof-1']) grids.set(id, fakeGrid(3, 3, 1))
    const { runtime, log } = recordingRuntime(grids)
    setDamageRuntime(runtime)
    const fx = emptyEffects()
    for (const id of ['wall-9', 'roof-1', 'wall-2']) {
      fx.removedCells.set(id, [cellKey(0, 0, 0)])
      fx.killedNodes.push(id)
    }
    applySharedDamage(fx)
    expect(log.removed.map((r) => r.nodeId)).toEqual(['roof-1', 'wall-2', 'wall-9'])
    expect(log.killed).toEqual(['roof-1', 'wall-2', 'wall-9'])
  })

  test("a stranger's damage is never re-published as ours", () => {
    const { world, sent } = capturingSync()
    const grids = new Map<NodeId, DamageGrid>([['wall-7', fakeGrid(4, 4, 2)]])
    const base = recordingRuntime(grids).runtime
    // The live runtime publishes as it damages — a derived local cascade calls
    // straight back into the publish path. While applying, that must be inert.
    setDamageRuntime({
      ...base,
      removeCells: (target, indices) => {
        base.removeCells(target, indices)
        publishRemovedCells(target, indices)
        publishKilledNode(target.nodeId)
      },
    })
    const fx = emptyEffects()
    fx.removedCells.set('wall-7', keysOfIndices(grids.get('wall-7')!, [0, 1, 2]))
    applySharedDamage(fx)
    expect(sent.length).toBe(0)
    expect(localWork(world).cells.size).toBe(0)
    expect(localWork(world).killed.length).toBe(0)
    // …and publishing works again the moment the pass is over.
    publishRemovedCells({ nodeId: 'wall-8', grid: grids.get('wall-7')! }, [3])
    expect(sent.length).toBe(1)
  })

  test('a garbage segment id is refused, the sane ones still land', () => {
    const grids = new Map<NodeId, DamageGrid>([['wall-7', fakeGrid(3, 3, 1)]])
    const { runtime, log } = recordingRuntime(grids)
    setDamageRuntime(runtime)
    const fx = emptyEffects()
    fx.brokenSegments.set('wall-7', [5, -1, 2, 1e9, 0.5])
    const report = applySharedDamage(fx)
    expect(report.segments).toBe(2)
    expect(log.broken[0]!.ids).toEqual([2, 5])
  })
})

// ── The whole loop ──────────────────────────────────────────────────────────

describe('two peers, one wall', () => {
  /**
   * The convergence test that matters: peer A carves a REAL wall with the real
   * random-nibble machinery, the frame goes through the real codec, peer B
   * merges and applies — and B's grid ends up bit-identical to A's, having
   * never drawn a random number.
   */
  test('a random carve on A reproduces exactly on B, through the wire', () => {
    const gridA = realGrid([2, 2.7, 0.12])
    const gridB = realGrid([2, 2.7, 0.12])
    expect(gridB.count).toBe(gridA.count)

    const { world: worldA, sent } = capturingSync('peer-a')
    inDamageBatch(() => {
      // Exactly the shape of a SMASH hit: several nibbles at random offsets.
      for (let n = 0; n < 6; n++) {
        const x = (Math.random() - 0.5) * 1.6
        const y = 0.4 + Math.random() * 1.8
        const removed = removeSphere(gridA, x, y, 0, 0.12 + Math.random() * 0.1)
        publishRemovedCells({ nodeId: 'wall-1', grid: gridA }, removed)
      }
    })
    expect(sent.length).toBe(1)
    expect(gridA.aliveCount).toBeLessThan(gridA.count)

    const bytes = encodeDelta(sent[0]!)
    const decoded = decodeDelta(bytes)
    expect(decoded).not.toBeNull()

    const worldB = createSharedWorld('peer-b')
    const fx = mergeDelta(worldB, decoded!, 'peer-a')
    const grids = new Map<NodeId, DamageGrid>([['wall-1', gridB]])
    const { runtime, log } = recordingRuntime(grids)
    setDamageRuntime(runtime)
    applySharedDamage(fx)

    expect(gridB.alive).toEqual(gridA.alive)
    expect(log.removed[0]!.indices.length).toBe(gridA.count - gridA.aliveCount)
    // B did the work as a pure application of A's outcome.
    expect(removedCells(worldB, 'wall-1')).toEqual(removedCells(worldA, 'wall-1'))
  })

  test('a late joiner folding a snapshot lands where the live client is', () => {
    const gridA = realGrid([2, 2.7, 0.12])
    const gridLate = realGrid([2, 2.7, 0.12])
    const { world: worldA } = capturingSync('peer-a')
    for (let n = 0; n < 8; n++) {
      const removed = removeSphere(gridA, (Math.random() - 0.5) * 1.6, 0.3 + Math.random() * 2, 0, 0.2)
      publishRemovedCells({ nodeId: 'wall-1', grid: gridA }, removed)
    }
    publishBrokenSegments('wall-1', [0, 4, 9])

    const worldLate = createSharedWorld('peer-late')
    const fx = mergeDelta(worldLate, snapshotOf(worldA), 'peer-a')
    const grids = new Map<NodeId, DamageGrid>([['wall-1', gridLate]])
    const { runtime, log } = recordingRuntime(grids)
    setDamageRuntime(runtime)
    applySharedDamage(fx)

    expect(gridLate.alive).toEqual(gridA.alive)
    expect(log.broken[0]!.ids).toEqual([0, 4, 9])
  })

  test('a remote kill collapses a wall this client never went near', () => {
    // No grid for the node at materialize time — the dormant / shellPending
    // case. The kill bit still has to land, because it needs no grid.
    const grids = new Map<NodeId, DamageGrid>()
    const { runtime, log } = recordingRuntime(grids)
    setDamageRuntime(runtime)
    const fx = emptyEffects()
    fx.killedNodes.push('wall-far')
    const report = applySharedDamage(fx)
    expect(report.kills).toBe(1)
    expect(log.killed).toEqual(['wall-far'])
    expect(log.materialized.length).toBe(0)
  })

  test('a door restored on A comes back on B, holes and all gone', () => {
    const gridA = realGrid([0.9, 2.1, 0.1])
    const gridB = realGrid([0.9, 2.1, 0.1])
    const { world: worldA, sent } = capturingSync('peer-a')
    const worldB = createSharedWorld('peer-b')
    const grids = new Map<NodeId, DamageGrid>([['door-1', gridB]])
    const { runtime, log } = recordingRuntime(grids)
    setDamageRuntime(runtime)

    const removed = removeSphere(gridA, 0, 1, 0, 0.4)
    expect(removed.length).toBeGreaterThan(0)
    publishRemovedCells({ nodeId: 'door-1', grid: gridA }, removed)
    for (const frame of sent) applySharedDamage(mergeDelta(worldB, frame, 'peer-a'))
    expect(liveCells(gridB)).toBeLessThan(gridB.count)
    expect(gridB.alive).toEqual(gridA.alive)
    sent.length = 0

    // The sealed-door handback: the one non-monotone operation.
    publishNodeReset('door-1')
    for (const frame of sent) applySharedDamage(mergeDelta(worldB, frame, 'peer-a'))
    expect(log.reset).toEqual(['door-1'])
    expect(nodeDamage(worldB, 'door-1').epoch).toBe(1)
    expect(removedCells(worldB, 'door-1').length).toBe(0)
    expect(nodeDamage(worldA, 'door-1').epoch).toBe(1)
  })
})

// ── Sanity on the fixtures themselves ───────────────────────────────────────

test('the real voxelizer is producing the grid these tests assume', () => {
  const grid = realGrid([2, 2.7, 0.12])
  expect(grid.count).toBe(grid.aliveCount)
  expect(grid.coords.length).toBe(grid.count * 3)
  expect(grid.index.size).toBe(grid.count)
  expect(gridIsShareable(grid)).toBe(true)
  // Every voxel is addressable: no cell of a real wall is beyond a 10-bit axis.
  expect(grid.nx).toBeLessThan(1024)
  expect(grid.ny).toBeLessThan(1024)
  expect(grid.nz).toBeLessThan(1024)
})
