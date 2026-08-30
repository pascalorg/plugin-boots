import { describe, expect, test } from 'bun:test'
import {
  addLocalAperture,
  addLocalItem,
  addLocalPiece,
  addLocalStroke,
  authorOf,
  brokenSegments,
  CELL_AXIS_MAX,
  CELL_KEY_MAX,
  cellIx,
  cellIy,
  cellIz,
  cellKey,
  createSharedWorld,
  damagedNodes,
  emptyDelta,
  emptyEffects,
  effectsAreEmpty,
  isAuthoredBy,
  isSafeId,
  isSafePeerId,
  itemTargetId,
  killRecord,
  liveRecords,
  localWork,
  MAX_MODEL_NODES,
  MAX_NODES_PER_FRAME,
  MAX_PEER_ID_LEN,
  mergeDelta,
  mintRecordId,
  noteLocalKill,
  noteLocalRemoval,
  noteLocalReset,
  noteLocalSegments,
  pieceTargetId,
  quantPos,
  quantYaw,
  removedCells,
  resetSharedWorld,
  setGridStamp,
  sharedWorldDebug,
  snapshotOf,
  type NodeDelta,
  type PieceRec,
  type SharedDelta,
  type SharedWorld,
} from './shared-world'

// ── Fixtures ────────────────────────────────────────────────────────────────

const ALICE = 'alice'
const BOB = 'bob'
const WALL = '__boots-node-wall-1'

const worldFor = (self: string, stamp = 7): SharedWorld => {
  const world = createSharedWorld(self)
  setGridStamp(world, stamp)
  return world
}

const nodeDelta = (over: Partial<NodeDelta> & { nodeId: string }): NodeDelta => ({
  epoch: 0,
  removed: [],
  segments: [],
  killed: false,
  reset: false,
  ...over,
})

const deltaWith = (from: string, over: Partial<SharedDelta> = {}, stamp = 7): SharedDelta => ({
  ...emptyDelta(from),
  gridStamp: stamp,
  ...over,
})

/** A record helper never returns undefined in these tests; assert it once. */
const idOf = (rec: { id: string } | null): string => {
  if (!rec) throw new Error('record was refused by validation')
  return rec.id
}

const piece = (id: string, over: Partial<PieceRec> = {}): PieceRec => ({
  id,
  lamport: 1,
  kind: 'wall',
  slot: 'Wx:0,0,0',
  mask: 511,
  yaw: 0,
  height: 2.7,
  corners: null,
  ...over,
})

// ── Cell addressing ─────────────────────────────────────────────────────────

describe('cell keys', () => {
  test('pack and unpack the whole 10-bit range', () => {
    for (const [ix, iy, iz] of [
      [0, 0, 0],
      [1, 2, 3],
      [1023, 1023, 1023],
      [1023, 0, 1],
      [0, 1023, 0],
    ] as const) {
      const key = cellKey(ix, iy, iz)
      expect(key).toBeGreaterThanOrEqual(0)
      expect(key).toBeLessThanOrEqual(CELL_KEY_MAX)
      expect([cellIx(key), cellIy(key), cellIz(key)]).toEqual([ix, iy, iz])
    }
  })

  test('distinct coordinates never collide', () => {
    const seen = new Set<number>()
    for (let ix = 0; ix < 12; ix++) {
      for (let iy = 0; iy < 12; iy++) {
        for (let iz = 0; iz < 12; iz++) seen.add(cellKey(ix, iy, iz))
      }
    }
    expect(seen.size).toBe(12 * 12 * 12)
  })

  test('CELL_AXIS_MAX bounds what a grid may address', () => {
    // MAX_VOXELS is 1600 and the biggest item budget 2600, so a real grid is
    // nowhere near 1024 cells on an axis; the headroom is deliberate.
    expect(CELL_AXIS_MAX).toBe(1024)
  })
})

// ── Identity ────────────────────────────────────────────────────────────────

describe('identity', () => {
  test('minted ids carry their author and never collide across peers', () => {
    const a = worldFor(ALICE)
    const b = worldFor(BOB)
    const first = [mintRecordId(a), mintRecordId(b)]
    expect(first[0]).not.toBe(first[1])
    expect(authorOf(first[0] as string)).toBe(ALICE)
    expect(isAuthoredBy(first[0] as string, ALICE)).toBe(true)
    expect(isAuthoredBy(first[0] as string, BOB)).toBe(false)
  })

  test('a peer prefix cannot be spoofed by a longer name', () => {
    expect(isAuthoredBy('alice2#7', 'alice')).toBe(false)
    expect(isAuthoredBy('alice#7', 'alice')).toBe(true)
    expect(isAuthoredBy('alice', 'alice')).toBe(false)
  })

  test('a peer id may not contain the record separator', () => {
    expect(isSafePeerId('alice')).toBe(true)
    expect(isSafePeerId('alice#1')).toBe(false)
    expect(isSafePeerId('')).toBe(false)
    expect(isSafePeerId('a'.repeat(MAX_PEER_ID_LEN + 1))).toBe(false)
    // ...and a world built from one falls back rather than trusting it.
    expect(createSharedWorld('alice#1').self).toBe('local')
  })

  test('hostile id shapes are refused', () => {
    for (const bad of ['', 'a b', 'a\nb', '<script>', 'ü', 'a;b', null, 42, {}]) {
      expect(isSafeId(bad, 64)).toBe(false)
    }
    expect(isSafeId('__boots-node-3f/2:1.4#p2', 64)).toBe(true)
  })

  test('target ids are derived from the record id, not a local counter', () => {
    expect(pieceTargetId('alice#3')).toBe('__boots-piece-alice#3')
    expect(itemTargetId('bob#3')).toBe('__boots-item-bob#3')
    expect(pieceTargetId('alice#3')).not.toBe(pieceTargetId('bob#3'))
  })
})

// ── Quantization ────────────────────────────────────────────────────────────

describe('canonical numeric form', () => {
  test('positions land on the millimetre and are stable under re-quantizing', () => {
    for (const v of [0, 1.23456, -7.7777, 1024.00049, -0.0004]) {
      const q = quantPos(v)
      expect(quantPos(q)).toBe(q)
      expect(Math.abs(q - v)).toBeLessThanOrEqual(0.0005 + 1e-9)
      expect(Math.round(q * 1000)).toBe(Math.round(v * 1000))
    }
  })

  test('yaw wraps into one turn and is stable under re-quantizing', () => {
    for (const v of [0, 0.1, Math.PI, -Math.PI, 7 * Math.PI, -13.37]) {
      const q = quantYaw(v)
      expect(q).toBeGreaterThanOrEqual(0)
      expect(q).toBeLessThan(Math.PI * 2)
      expect(quantYaw(q)).toBeCloseTo(q, 12)
    }
  })

  test('local records are quantized on mint, so the wire is lossless later', () => {
    const world = worldFor(ALICE)
    const item = addLocalItem(world, { catalogId: 'sofa', x: 1.23456789, y: 0, z: -2.5001, yaw: 9 })
    expect(item).not.toBeNull()
    expect(item?.x).toBe(1.235)
    expect(item?.z).toBe(-2.5)
    expect(item?.yaw).toBeLessThan(Math.PI * 2)
  })
})

// ── Damage: the G-Set ───────────────────────────────────────────────────────

describe('voxel damage', () => {
  test('local removal reports only genuinely new cells', () => {
    const world = worldFor(ALICE)
    expect(noteLocalRemoval(world, WALL, [5, 6, 7])).toEqual([5, 6, 7])
    expect(noteLocalRemoval(world, WALL, [6, 7])).toEqual([])
    expect(noteLocalRemoval(world, WALL, [7, 8])).toEqual([8])
    expect(removedCells(world, WALL)).toEqual([5, 6, 7, 8])
  })

  test('removal ignores out-of-range and non-integer keys', () => {
    const world = worldFor(ALICE)
    expect(noteLocalRemoval(world, WALL, [-1, 1.5, CELL_KEY_MAX + 1, Number.NaN, 9])).toEqual([9])
  })

  test('segments are a second grow-only lane', () => {
    const world = worldFor(ALICE)
    expect(noteLocalSegments(world, WALL, [3, 1, 3])).toEqual([3, 1])
    expect(brokenSegments(world, WALL)).toEqual([1, 3])
    expect(noteLocalSegments(world, WALL, [1])).toEqual([])
  })

  test('kill is monotone and only announced once', () => {
    const world = worldFor(ALICE)
    expect(noteLocalKill(world, WALL)).toBe(true)
    expect(noteLocalKill(world, WALL)).toBe(false)
  })

  test('damagedNodes is canonically ordered', () => {
    const world = worldFor(ALICE)
    noteLocalRemoval(world, 'zeta', [1])
    noteLocalRemoval(world, 'alpha', [1])
    noteLocalSegments(world, 'mid', [1])
    expect(damagedNodes(world)).toEqual(['alpha', 'mid', 'zeta'])
  })
})

// ── The epoch: the restore path ─────────────────────────────────────────────

describe('epoch resets', () => {
  test('a local reset clears the generation, including our own holes', () => {
    const world = worldFor(ALICE)
    noteLocalRemoval(world, WALL, [1, 2])
    noteLocalSegments(world, WALL, [4])
    noteLocalKill(world, WALL)
    expect(noteLocalReset(world, WALL)).toBe(1)
    expect(removedCells(world, WALL)).toEqual([])
    expect(brokenSegments(world, WALL)).toEqual([])
    expect(localWork(world).cells.size).toBe(0)
    expect(localWork(world).killed).toEqual([])
  })

  test('damage from a stale generation is discarded', () => {
    const world = worldFor(ALICE)
    noteLocalReset(world, WALL) // epoch 1
    const fx = mergeDelta(
      world,
      deltaWith(BOB, { nodes: [nodeDelta({ nodeId: WALL, epoch: 0, removed: [1, 2] })] }),
      BOB,
    )
    expect(removedCells(world, WALL)).toEqual([])
    expect(fx.removedCells.size).toBe(0)
  })

  test('a remote reset wins outright and is reported as an effect', () => {
    const world = worldFor(ALICE)
    noteLocalRemoval(world, WALL, [1, 2])
    const fx = mergeDelta(
      world,
      deltaWith(BOB, {
        nodes: [nodeDelta({ nodeId: WALL, epoch: 3, reset: true, removed: [9] })],
      }),
      BOB,
    )
    expect(fx.resetNodes).toEqual([WALL])
    expect(removedCells(world, WALL)).toEqual([9])
    expect(fx.removedCells.get(WALL)).toEqual([9])
  })

  test('a reset later in the same frame supersedes cells earlier in it', () => {
    const world = worldFor(ALICE)
    const fx = mergeDelta(
      world,
      deltaWith(BOB, {
        nodes: [
          nodeDelta({ nodeId: WALL, epoch: 0, removed: [1, 2], killed: true }),
          nodeDelta({ nodeId: WALL, epoch: 1, reset: true }),
        ],
      }),
      BOB,
    )
    expect(fx.removedCells.has(WALL)).toBe(false)
    expect(fx.killedNodes).toEqual([])
    expect(fx.resetNodes).toEqual([WALL])
    expect(removedCells(world, WALL)).toEqual([])
  })
})

// ── Lanes and authorship ────────────────────────────────────────────────────

describe('record lanes', () => {
  test('adds are visible, tombstones hide them, and the order is canonical', () => {
    const world = worldFor(ALICE)
    const a = addLocalPiece(world, {
      kind: 'wall',
      slot: 'Wx:1,0,0',
      mask: 511,
      yaw: 0,
      height: 2.7,
      corners: null,
    })
    const b = addLocalPiece(world, {
      kind: 'floor',
      slot: 'F:0,0,0',
      mask: 511,
      yaw: 0,
      height: 0,
      corners: [0, 0, 0, 0],
    })
    expect(liveRecords(world.pieces).map((r) => r.id)).toEqual([idOf(a), idOf(b)].sort())
    expect(killRecord(world, 'pieces', idOf(a))).toBe(true)
    expect(killRecord(world, 'pieces', idOf(a))).toBe(false)
    expect(liveRecords(world.pieces).map((r) => r.id)).toEqual([idOf(b)])
  })

  test('a peer cannot add a record under another peer id', () => {
    const world = worldFor(ALICE)
    const fx = mergeDelta(world, deltaWith(BOB, { pieces: [piece('alice#1')] }), BOB)
    expect(liveRecords(world.pieces)).toEqual([])
    expect(fx.dropped).toBeGreaterThan(0)
  })

  test('a peer CAN tombstone another peer record — destruction is the game', () => {
    const world = worldFor(ALICE)
    const mine = addLocalPiece(world, {
      kind: 'wall',
      slot: 'Wx:1,0,0',
      mask: 511,
      yaw: 0,
      height: 2.7,
      corners: null,
    })
    const fx = mergeDelta(world, deltaWith(BOB, { deadPieces: [idOf(mine)] }), BOB)
    expect(fx.deadPieces).toEqual([idOf(mine)])
    expect(liveRecords(world.pieces)).toEqual([])
  })

  test('a record added and killed inside one frame never reaches the game', () => {
    const world = worldFor(ALICE)
    const fx = mergeDelta(
      world,
      deltaWith(BOB, { pieces: [piece('bob#1')], deadPieces: ['bob#1'] }),
      BOB,
    )
    expect(fx.addedPieces).toEqual([])
    expect(fx.deadPieces).toEqual(['bob#1'])
    expect(liveRecords(world.pieces)).toEqual([])
  })

  test('two versions of one id settle on the same winner either way', () => {
    const lo = piece('bob#1', { lamport: 4, mask: 1 })
    const hi = piece('bob#1', { lamport: 9, mask: 7 })
    const a = worldFor(ALICE)
    const b = worldFor(ALICE)
    mergeDelta(a, deltaWith(BOB, { pieces: [lo] }), BOB)
    mergeDelta(a, deltaWith(BOB, { pieces: [hi] }), BOB)
    mergeDelta(b, deltaWith(BOB, { pieces: [hi] }), BOB)
    mergeDelta(b, deltaWith(BOB, { pieces: [lo] }), BOB)
    expect(liveRecords(a.pieces)[0]?.mask).toBe(7)
    expect(liveRecords(b.pieces)[0]?.mask).toBe(7)
  })
})

// ── The grid gate ───────────────────────────────────────────────────────────

describe('grid fingerprint gate', () => {
  test('a mismatched stamp refuses slot-addressed pieces and keeps the rest', () => {
    const world = worldFor(ALICE, 7)
    const fx = mergeDelta(
      world,
      deltaWith(
        BOB,
        {
          pieces: [piece('bob#1')],
          items: [{ id: 'bob#2', lamport: 2, catalogId: 'sofa', x: 1, y: 0, z: 1, yaw: 0 }],
          nodes: [nodeDelta({ nodeId: WALL, removed: [3] })],
        },
        999,
      ),
      BOB,
    )
    expect(fx.refusedGrid).toBe(true)
    expect(liveRecords(world.pieces)).toEqual([])
    expect(liveRecords(world.items).length).toBe(1)
    expect(removedCells(world, WALL)).toEqual([3])
  })

  test('an unknown (0) stamp also refuses', () => {
    const world = worldFor(ALICE, 7)
    mergeDelta(world, deltaWith(BOB, { pieces: [piece('bob#1')] }, 0), BOB)
    expect(liveRecords(world.pieces)).toEqual([])
  })

  test('tombstones cross a grid mismatch — a piece can always be destroyed', () => {
    const world = worldFor(ALICE, 7)
    mergeDelta(world, deltaWith(BOB, { pieces: [piece('bob#1')] }, 7), BOB)
    mergeDelta(world, deltaWith(BOB, { deadPieces: ['bob#1'] }, 999), BOB)
    expect(liveRecords(world.pieces)).toEqual([])
  })

  test('a locally-replayed delta (sender null) skips both gates', () => {
    const world = worldFor(ALICE, 7)
    mergeDelta(world, deltaWith(BOB, { pieces: [piece('bob#1')] }, 0), null)
    expect(liveRecords(world.pieces).length).toBe(1)
  })
})

// ── Hostile input ───────────────────────────────────────────────────────────

describe('hostile input', () => {
  test('a wrong version merges nothing', () => {
    const world = worldFor(ALICE)
    const bad = { ...deltaWith(BOB, { nodes: [nodeDelta({ nodeId: WALL, removed: [1] })] }), v: 2 }
    const fx = mergeDelta(world, bad as unknown as SharedDelta, BOB)
    expect(world.nodes.size).toBe(0)
    expect(fx.dropped).toBe(1)
  })

  test('an unnameable sender merges nothing', () => {
    const world = worldFor(ALICE)
    const fx = mergeDelta(
      world,
      deltaWith('x', { nodes: [nodeDelta({ nodeId: WALL, removed: [1] })] }),
      'evil#peer',
    )
    expect(world.nodes.size).toBe(0)
    expect(fx.dropped).toBe(1)
  })

  test('missing arrays and wrong types are survived, not thrown', () => {
    const world = worldFor(ALICE)
    const junk = {
      v: 1,
      kind: 'delta',
      from: BOB,
      lamport: 3,
      gridStamp: 7,
      nodes: 'nope',
      pieces: null,
      items: undefined,
      apertures: 5,
      strokes: {},
      deadPieces: 'x',
      deadItems: null,
      deadApertures: 1,
      deadStrokes: false,
    }
    expect(() => mergeDelta(world, junk as unknown as SharedDelta, BOB)).not.toThrow()
    expect(effectsAreEmpty(mergeDelta(world, junk as unknown as SharedDelta, BOB))).toBe(true)
  })

  test('absurd node counts are capped, and the model node ceiling holds', () => {
    const world = worldFor(ALICE)
    const nodes = Array.from({ length: MAX_NODES_PER_FRAME + 50 }, (_, i) =>
      nodeDelta({ nodeId: `n${i}`, removed: [1] }),
    )
    const fx = mergeDelta(world, deltaWith(BOB, { nodes }), BOB)
    expect(world.nodes.size).toBeLessThanOrEqual(MAX_NODES_PER_FRAME)
    expect(fx.dropped).toBeGreaterThan(0)
    expect(world.nodes.size).toBeLessThanOrEqual(MAX_MODEL_NODES)
  })

  test('an unbounded id or string is refused', () => {
    const world = worldFor(ALICE)
    const fx = mergeDelta(
      world,
      deltaWith(BOB, {
        nodes: [nodeDelta({ nodeId: 'n'.repeat(4000), removed: [1] })],
        items: [
          {
            id: 'bob#1',
            lamport: 1,
            catalogId: 'c'.repeat(4000),
            x: 0,
            y: 0,
            z: 0,
            yaw: 0,
          },
        ],
      }),
      BOB,
    )
    expect(world.nodes.size).toBe(0)
    expect(liveRecords(world.items)).toEqual([])
    expect(fx.dropped).toBeGreaterThan(1)
  })

  test('a peer cannot shove the lamport clock past reach', () => {
    const world = worldFor(ALICE)
    mergeDelta(world, deltaWith(BOB, { lamport: Number.MAX_SAFE_INTEGER }), BOB)
    expect(world.clock).toBeLessThanOrEqual(1 << 20)
    // ...and a local op still produces a usable stamp afterwards.
    const rec = addLocalItem(world, { catalogId: 'sofa', x: 0, y: 0, z: 0, yaw: 0 })
    expect(rec?.lamport).toBeGreaterThan(0)
  })

  test('out-of-world item coordinates are refused', () => {
    const world = worldFor(ALICE)
    mergeDelta(
      world,
      deltaWith(BOB, {
        items: [{ id: 'bob#1', lamport: 1, catalogId: 'sofa', x: 1e9, y: 0, z: 0, yaw: 0 }],
      }),
      BOB,
    )
    expect(liveRecords(world.items)).toEqual([])
  })
})

// ── Snapshots ───────────────────────────────────────────────────────────────

describe('snapshots', () => {
  test('a snapshot of a live world reconstructs it on a fresh peer', () => {
    const source = worldFor(ALICE)
    noteLocalRemoval(source, WALL, [cellKey(1, 2, 3), cellKey(1, 2, 4)])
    noteLocalSegments(source, WALL, [2, 5])
    noteLocalKill(source, 'other-node')
    addLocalPiece(source, {
      kind: 'wall',
      slot: 'Wx:1,0,0',
      mask: 3,
      yaw: 1,
      height: 2.7,
      corners: null,
    })
    addLocalStroke(source, { node: WALL, color: 2, x: 1, y: 2, z: 3, radius: 0.2 })

    const target = worldFor(BOB)
    mergeDelta(target, snapshotOf(source), ALICE)
    expect(damagedNodes(target)).toEqual(damagedNodes(source))
    expect(removedCells(target, WALL)).toEqual(removedCells(source, WALL))
    expect(brokenSegments(target, WALL)).toEqual([2, 5])
    expect(liveRecords(target.pieces).length).toBe(1)
    expect(liveRecords(target.strokes).length).toBe(1)
  })

  test('two peers holding the same state emit identical snapshots', () => {
    const build = (self: string) => {
      const w = worldFor(self)
      mergeDelta(
        w,
        deltaWith(ALICE, {
          nodes: [nodeDelta({ nodeId: 'b', removed: [9, 1] }), nodeDelta({ nodeId: 'a', killed: true })],
          pieces: [piece('alice#2', { lamport: 5 }), piece('alice#1')],
        }),
        ALICE,
      )
      return w
    }
    const one = snapshotOf(build('p1'))
    const two = snapshotOf(build('p2'))
    expect({ ...one, from: '' }).toEqual({ ...two, from: '' })
  })

  test('a snapshot is idempotent against a world that already has it', () => {
    const source = worldFor(ALICE)
    noteLocalRemoval(source, WALL, [1, 2, 3])
    const snap = snapshotOf(source)
    const target = worldFor(BOB)
    mergeDelta(target, snap, ALICE)
    const fx = mergeDelta(target, snap, ALICE)
    expect(effectsAreEmpty(fx)).toBe(true)
  })

  test('effects accumulate into a caller-supplied bag', () => {
    const world = worldFor(ALICE)
    const fx = emptyEffects()
    mergeDelta(world, deltaWith(BOB, { nodes: [nodeDelta({ nodeId: 'a', removed: [1] })] }), BOB, fx)
    mergeDelta(world, deltaWith(BOB, { nodes: [nodeDelta({ nodeId: 'b', removed: [2] })] }), BOB, fx)
    expect([...fx.removedCells.keys()].sort()).toEqual(['a', 'b'])
  })
})

// ── The Save-bridge fence ───────────────────────────────────────────────────

describe('localWork is the only projection the Save bridges may see', () => {
  test('remote damage and remote records are excluded', () => {
    const world = worldFor(ALICE)
    noteLocalRemoval(world, WALL, [1, 2])
    noteLocalSegments(world, WALL, [3])
    noteLocalKill(world, 'mine-only')
    const mine = addLocalPiece(world, {
      kind: 'wall',
      slot: 'Wx:1,0,0',
      mask: 511,
      yaw: 0,
      height: 2.7,
      corners: null,
    })

    mergeDelta(
      world,
      deltaWith(BOB, {
        nodes: [
          nodeDelta({ nodeId: WALL, removed: [40, 41] }),
          nodeDelta({ nodeId: 'theirs', removed: [7], segments: [8], killed: true }),
        ],
        pieces: [piece('bob#1', { slot: 'Wx:9,0,0' })],
        items: [{ id: 'bob#2', lamport: 2, catalogId: 'sofa', x: 1, y: 0, z: 1, yaw: 0 }],
        strokes: [{ id: 'bob#3', lamport: 3, node: WALL, color: 1, x: 0, y: 0, z: 0, radius: 0.2 }],
      }),
      BOB,
    )

    // The shared model sees everything...
    expect(removedCells(world, WALL)).toEqual([1, 2, 40, 41])
    expect(liveRecords(world.pieces).length).toBe(2)

    // ...but the Save projection sees only this player's work.
    const work = localWork(world)
    expect(work.cells.get(WALL)).toEqual([1, 2])
    expect(work.cells.has('theirs')).toBe(false)
    expect(work.segments.get(WALL)).toEqual([3])
    expect(work.killed).toEqual(['mine-only'])
    expect(work.pieces.map((r) => r.id)).toEqual([idOf(mine)])
    expect(work.items).toEqual([])
    expect(work.strokes).toEqual([])
  })

  test('a record of ours that a peer destroyed is no longer ours to save', () => {
    const world = worldFor(ALICE)
    const mine = addLocalItem(world, { catalogId: 'sofa', x: 1, y: 0, z: 1, yaw: 0 })
    mergeDelta(world, deltaWith(BOB, { deadItems: [idOf(mine)] }), BOB)
    expect(localWork(world).items).toEqual([])
  })

  test('a peer cannot make us save its work by claiming our id prefix', () => {
    const world = worldFor(ALICE)
    mergeDelta(
      world,
      deltaWith(BOB, {
        pieces: [piece(`${ALICE}#99`)],
        nodes: [nodeDelta({ nodeId: WALL, removed: [5] })],
      }),
      BOB,
    )
    const work = localWork(world)
    expect(work.pieces).toEqual([])
    // Remote cells have no author on the wire, and `mine` is written only by
    // the local op — so a remote frame can never enter the Save set at all.
    expect(work.cells.size).toBe(0)
  })
})

// ── Housekeeping ────────────────────────────────────────────────────────────

describe('housekeeping', () => {
  test('reset forgets the world but not the serial', () => {
    const world = worldFor(ALICE)
    const first = addLocalItem(world, { catalogId: 'sofa', x: 0, y: 0, z: 0, yaw: 0 })
    noteLocalRemoval(world, WALL, [1])
    resetSharedWorld(world)
    expect(world.nodes.size).toBe(0)
    expect(liveRecords(world.items)).toEqual([])
    const second = addLocalItem(world, { catalogId: 'sofa', x: 0, y: 0, z: 0, yaw: 0 })
    expect(second?.id).not.toBe(first?.id)
  })

  test('the debug dump counts what it says it counts', () => {
    const world = worldFor(ALICE)
    noteLocalRemoval(world, WALL, [1, 2, 3])
    noteLocalSegments(world, WALL, [1])
    noteLocalKill(world, 'gone')
    const dump = sharedWorldDebug(world)
    expect(dump.self).toBe(ALICE)
    expect(dump.cells).toBe(3)
    expect(dump.segments).toBe(1)
    expect(dump.killed).toBe(1)
    expect(dump.nodes).toBe(2)
  })

  test('an aperture is host-relative, so it survives a grid it did not choose', () => {
    const world = worldFor(ALICE)
    const ap = addLocalAperture(world, {
      catalogId: 'door-single',
      host: WALL,
      u: 1.2345678,
      v: 0,
      width: 0.9,
      height: 2.1,
    })
    expect(ap?.host).toBe(WALL)
    expect(ap?.u).toBe(1.235)
  })
})
