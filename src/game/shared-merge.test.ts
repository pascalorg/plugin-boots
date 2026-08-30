/**
 * The merge law, property-tested.
 *
 * The whole design rests on one claim: mergeDelta is a lattice join, so the
 * order frames arrive in, how often they are repeated, and how many are lost
 * cannot change where two clients end up. This file tries to break that with
 * randomised op logs — permuted, duplicated, truncated — from several peers at
 * once, and compares the DIGEST of the resulting models rather than object
 * identity.
 *
 * Randomness here comes from mulberry32 seeded with fixed constants: the same
 * cases run on every machine and in every CI job, and a failure is a
 * reproducible seed rather than a story about a flake.
 */

import { describe, expect, test } from 'bun:test'
import { mulberry32 } from './shared-derive'
import {
  addLocalAperture,
  addLocalItem,
  addLocalPiece,
  addLocalStroke,
  brokenSegments,
  cellKey,
  createSharedWorld,
  damagedNodes,
  emptyDelta,
  killRecord,
  liveRecords,
  mergeDelta,
  noteLocalKill,
  noteLocalRemoval,
  noteLocalReset,
  noteLocalSegments,
  removedCells,
  setGridStamp,
  snapshotOf,
  type Lane,
  type OrSet,
  type SharedDelta,
  type SharedWorld,
  type Stamped,
} from './shared-world'

const STAMP = 4242

// ── The digest: everything that must converge, and nothing else ──────────────

/**
 * A canonical string for the REPLICATED state. Deliberately excludes `clock`,
 * `seq`, `dropped`, `applied`, `mine`/`mySegments`/`killedByMe` — the local
 * annotations are per-client by design, and the lamport clock is allowed to
 * differ (it is a bound on causality, not state).
 */
function digest(world: SharedWorld): string {
  const parts: string[] = []
  for (const nodeId of damagedNodes(world)) {
    const dmg = world.nodes.get(nodeId)
    if (!dmg) continue
    parts.push(
      `N ${nodeId} e${dmg.epoch} k${dmg.killed ? 1 : 0} c[${removedCells(world, nodeId).join(',')}] s[${brokenSegments(world, nodeId).join(',')}]`,
    )
  }
  const laneDigest = <T extends Stamped>(name: Lane, lane: OrSet<T>): void => {
    for (const rec of liveRecords(lane)) parts.push(`R ${name} ${JSON.stringify(rec)}`)
    parts.push(`T ${name} [${[...lane.dead].sort().join(',')}]`)
  }
  laneDigest('pieces', world.pieces)
  laneDigest('items', world.items)
  laneDigest('apertures', world.apertures)
  laneDigest('strokes', world.strokes)
  return parts.join('\n')
}

// ── Op log generation ───────────────────────────────────────────────────────

type Op = { delta: SharedDelta; sender: string }

const NODES = ['wall-a', 'wall-b', 'roof-a#p1', 'slab-a']
const CATALOG = ['sofa', 'lamp', 'door-single']
const SLOTS = ['Wx:0,0,0', 'Wx:1,0,0', 'F:0,0,0', 'R:2,-1,0']

/**
 * Generate an interleaved op log from `peerCount` peers. Each op is a
 * one-thing delta, exactly as the live game would publish it: the author
 * mutates its own model first and reports what genuinely changed, which is
 * what makes epochs and freshness realistic rather than synthetic.
 */
function generateLog(seed: number, ops: number, peerCount = 3): Op[] {
  const rand = mulberry32(seed)
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T
  const peers = Array.from({ length: peerCount }, (_, i) => `p${i}`)
  const worlds = new Map<string, SharedWorld>()
  for (const peer of peers) {
    const w = createSharedWorld(peer)
    setGridStamp(w, STAMP)
    worlds.set(peer, w)
  }
  const minted: { lane: Lane; id: string }[] = []
  const log: Op[] = []

  const frame = (peer: string, w: SharedWorld): SharedDelta => {
    const d = emptyDelta(peer)
    d.gridStamp = STAMP
    d.lamport = w.clock
    return d
  }

  for (let i = 0; i < ops; i++) {
    const peer = pick(peers)
    const w = worlds.get(peer) as SharedWorld
    const roll = rand()
    const d = frame(peer, w)

    if (roll < 0.34) {
      const nodeId = pick(NODES)
      const cells: number[] = []
      const cx = Math.floor(rand() * 20)
      const cy = Math.floor(rand() * 20)
      const cz = Math.floor(rand() * 20)
      const span = 1 + Math.floor(rand() * 4)
      for (let dx = 0; dx < span; dx++) {
        for (let dy = 0; dy < span; dy++) cells.push(cellKey(cx + dx, cy + dy, cz))
      }
      const fresh = noteLocalRemoval(w, nodeId, cells)
      if (fresh.length === 0) continue
      fresh.sort((a, b) => a - b)
      const dmg = w.nodes.get(nodeId)
      d.nodes.push({
        nodeId,
        epoch: dmg?.epoch ?? 0,
        removed: fresh,
        segments: [],
        killed: false,
        reset: false,
      })
    } else if (roll < 0.44) {
      const nodeId = pick(NODES)
      const fresh = noteLocalSegments(w, nodeId, [Math.floor(rand() * 24)])
      if (fresh.length === 0) continue
      d.nodes.push({
        nodeId,
        epoch: w.nodes.get(nodeId)?.epoch ?? 0,
        removed: [],
        segments: fresh,
        killed: false,
        reset: false,
      })
    } else if (roll < 0.5) {
      const nodeId = pick(NODES)
      if (!noteLocalKill(w, nodeId)) continue
      d.nodes.push({
        nodeId,
        epoch: w.nodes.get(nodeId)?.epoch ?? 0,
        removed: [],
        segments: [],
        killed: true,
        reset: false,
      })
    } else if (roll < 0.56) {
      // The restore path — the one non-monotone thing in the game.
      const nodeId = pick(NODES)
      const epoch = noteLocalReset(w, nodeId)
      d.nodes.push({ nodeId, epoch, removed: [], segments: [], killed: false, reset: true })
    } else if (roll < 0.68) {
      const rec = addLocalPiece(w, {
        kind: pick(['wall', 'floor', 'roof', 'stairs'] as const),
        slot: pick(SLOTS),
        mask: Math.floor(rand() * 512),
        yaw: rand() * 7,
        height: rand() * 3,
        corners: rand() < 0.5 ? null : [rand(), rand(), rand(), rand()],
      })
      if (!rec) continue
      minted.push({ lane: 'pieces', id: rec.id })
      d.pieces.push(rec)
    } else if (roll < 0.78) {
      const rec = addLocalItem(w, {
        catalogId: pick(CATALOG),
        x: rand() * 20 - 10,
        y: rand() * 5,
        z: rand() * 20 - 10,
        yaw: rand() * 7,
      })
      if (!rec) continue
      minted.push({ lane: 'items', id: rec.id })
      d.items.push(rec)
    } else if (roll < 0.86) {
      const rec = addLocalAperture(w, {
        catalogId: pick(CATALOG),
        host: pick(NODES),
        u: rand() * 4,
        v: rand() * 2,
        width: 0.4 + rand(),
        height: 1 + rand(),
      })
      if (!rec) continue
      minted.push({ lane: 'apertures', id: rec.id })
      d.apertures.push(rec)
    } else if (roll < 0.94) {
      const rec = addLocalStroke(w, {
        node: pick(NODES),
        color: Math.floor(rand() * 8),
        x: rand() * 10,
        y: rand() * 3,
        z: rand() * 10,
        radius: 0.1 + rand() * 0.2,
      })
      if (!rec) continue
      minted.push({ lane: 'strokes', id: rec.id })
      d.strokes.push(rec)
    } else if (minted.length > 0) {
      // Anyone may destroy anyone's record.
      const victim = pick(minted)
      if (!killRecord(w, victim.lane, victim.id)) continue
      const sink: { [L in Lane]: keyof SharedDelta } = {
        pieces: 'deadPieces',
        items: 'deadItems',
        apertures: 'deadApertures',
        strokes: 'deadStrokes',
      }
      ;(d[sink[victim.lane]] as string[]).push(victim.id)
    } else {
      continue
    }
    log.push({ delta: d, sender: peer })
  }
  return log
}

const shuffled = <T>(list: readonly T[], rand: () => number): T[] => {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const a = out[i] as T
    out[i] = out[j] as T
    out[j] = a
  }
  return out
}

const play = (ops: readonly Op[], self = 'observer'): SharedWorld => {
  const world = createSharedWorld(self)
  setGridStamp(world, STAMP)
  for (const op of ops) mergeDelta(world, op.delta, op.sender)
  return world
}

// ── The laws ────────────────────────────────────────────────────────────────

const SEEDS = [1, 2, 3, 7, 11, 1337, 90210, 0x5eed]

describe('merge is commutative', () => {
  test('any arrival order lands on the same state', () => {
    for (const seed of SEEDS) {
      const log = generateLog(seed, 220)
      expect(log.length).toBeGreaterThan(80)
      // The fixture must actually exercise resets, kills and every lane.
      expect(log.some((op) => op.delta.nodes.some((n) => n.reset))).toBe(true)
      expect(log.some((op) => op.delta.nodes.some((n) => n.killed))).toBe(true)
      expect(log.some((op) => op.delta.nodes.some((n) => n.segments.length > 0))).toBe(true)
      expect(log.some((op) => op.delta.deadPieces.length + op.delta.deadItems.length > 0)).toBe(true)
      const reference = digest(play(log))
      expect(reference.length).toBeGreaterThan(500)
      const rand = mulberry32(seed ^ 0x9e3779b9)
      for (let trial = 0; trial < 12; trial++) {
        expect(digest(play(shuffled(log, rand)))).toBe(reference)
      }
    }
  })

  test('reversal — the worst case for a grow-only set with resets', () => {
    for (const seed of SEEDS) {
      const log = generateLog(seed, 220)
      expect(digest(play([...log].reverse()))).toBe(digest(play(log)))
    }
  })
})

describe('merge is idempotent', () => {
  test('duplicating every frame changes nothing', () => {
    for (const seed of SEEDS) {
      const log = generateLog(seed, 200)
      const doubled = log.flatMap((op) => [op, op])
      expect(digest(play(doubled))).toBe(digest(play(log)))
    }
  })

  test('random duplicates interleaved with the original order change nothing', () => {
    for (const seed of SEEDS) {
      const log = generateLog(seed, 200)
      const rand = mulberry32(seed * 31 + 7)
      const noisy: Op[] = []
      for (const op of log) {
        const copies = 1 + Math.floor(rand() * 3)
        for (let i = 0; i < copies; i++) noisy.push(op)
      }
      expect(digest(play(shuffled(noisy, rand)))).toBe(digest(play(log)))
    }
  })

  test('re-merging a world own snapshot is a no-op', () => {
    for (const seed of SEEDS) {
      const world = play(generateLog(seed, 150))
      const before = digest(world)
      mergeDelta(world, snapshotOf(world), null)
      expect(digest(world)).toBe(before)
    }
  })
})

describe('merge is associative', () => {
  test('(A join B) join C equals A join (B join C)', () => {
    for (const seed of SEEDS) {
      const log = generateLog(seed, 240)
      const third = Math.floor(log.length / 3)
      const chunks = [log.slice(0, third), log.slice(third, third * 2), log.slice(third * 2)]

      // Each chunk becomes a peer-shaped model, then models are joined by
      // exchanging snapshots — the state-based CRDT form of the same law.
      const asWorld = (ops: readonly Op[]) => play(ops, 'chunk')
      const join = (into: SharedWorld, from: SharedWorld) => {
        mergeDelta(into, snapshotOf(from), null)
        return into
      }
      const left = join(join(asWorld(chunks[0] as Op[]), asWorld(chunks[1] as Op[])), asWorld(chunks[2] as Op[]))
      const rightInner = join(asWorld(chunks[1] as Op[]), asWorld(chunks[2] as Op[]))
      const right = join(asWorld(chunks[0] as Op[]), rightInner)
      expect(digest(left)).toBe(digest(right))
    }
  })
})

describe('loss heals', () => {
  test('peers that dropped random frames converge once a snapshot arrives', () => {
    for (const seed of SEEDS) {
      const log = generateLog(seed, 260)
      const rand = mulberry32(seed + 99)
      const complete = play(log, 'complete')
      let sawDivergence = false

      for (let trial = 0; trial < 5; trial++) {
        const lossy = play(
          log.filter(() => rand() > 0.25),
          'lossy',
        )
        // Dropping a quarter of the frames really does diverge...
        if (digest(lossy) !== digest(complete)) sawDivergence = true
        // ...and one snapshot from a peer that saw everything repairs it.
        mergeDelta(lossy, snapshotOf(complete), null)
        expect(digest(lossy)).toBe(digest(complete))
      }
      // Guard against a vacuous test: if loss never diverged, the fixture is
      // not exercising anything.
      expect(sawDivergence).toBe(true)
    }
  })

  test('a lost reset frame is repaired by the next snapshot', () => {
    const author = createSharedWorld('author')
    setGridStamp(author, STAMP)
    const peer = createSharedWorld('peer')
    setGridStamp(peer, STAMP)

    // Peer sees the damage but not the restore.
    const cells = noteLocalRemoval(author, 'door-1', [1, 2, 3])
    const damage = emptyDelta('author')
    damage.gridStamp = STAMP
    damage.nodes.push({
      nodeId: 'door-1',
      epoch: 0,
      removed: cells,
      segments: [],
      killed: false,
      reset: false,
    })
    mergeDelta(peer, damage, 'author')
    expect(removedCells(peer, 'door-1')).toEqual([1, 2, 3])

    noteLocalReset(author, 'door-1') // the frame announcing this is lost
    mergeDelta(peer, snapshotOf(author), 'author')
    expect(removedCells(peer, 'door-1')).toEqual([])
    expect(digest(peer)).toBe(digest(author))
  })
})

describe('a hostile peer cannot break convergence', () => {
  test('forged authorship and junk frames are dropped identically by everyone', () => {
    const log = generateLog(31337, 180)
    const forged: Op[] = [
      ...log,
      // p1 trying to publish under p0's name, twice, in different places.
      {
        sender: 'p1',
        delta: (() => {
          const d = emptyDelta('p1')
          d.gridStamp = STAMP
          d.items.push({ id: 'p0#1', lamport: 5, catalogId: 'sofa', x: 0, y: 0, z: 0, yaw: 0 })
          return d
        })(),
      },
      // ...and with a wrong grid stamp, so its slot pieces are refused.
      {
        sender: 'p2',
        delta: (() => {
          const d = emptyDelta('p2')
          d.gridStamp = 1
          d.pieces.push({
            id: 'p2#9999',
            lamport: 5,
            kind: 'wall',
            slot: 'Wx:5,0,0',
            mask: 511,
            yaw: 0,
            height: 2.7,
            corners: null,
          })
          return d
        })(),
      },
    ]
    const rand = mulberry32(4)
    const reference = digest(play(forged))
    for (let trial = 0; trial < 8; trial++) {
      expect(digest(play(shuffled(forged, rand)))).toBe(reference)
    }
    // The forgery is absent from the converged state.
    const world = play(forged)
    expect(liveRecords(world.items).some((r) => r.id === 'p0#1')).toBe(false)
    expect(liveRecords(world.pieces).some((r) => r.id === 'p2#9999')).toBe(false)
  })
})
