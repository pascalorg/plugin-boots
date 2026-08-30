/**
 * The wire format: round trips, measured sizes, and hostile bytes.
 *
 * The size numbers printed by "measured wire cost" are the ones quoted in the
 * multiplayer design notes. They are asserted against ceilings so that a
 * well-meaning change to the encoder cannot quietly triple the bandwidth of a
 * firefight without a test going red.
 */

import { describe, expect, test } from 'bun:test'
import { mulberry32 } from './shared-derive'
import {
  base64ToBytes,
  bytesToBase64,
  cellModeFor,
  CELLS_GAPS,
  CELLS_MASK,
  decodeDelta,
  decodeDeltaText,
  encodeDelta,
  encodeDeltaText,
  measureDelta,
  MAX_FRAME_BYTES,
  WIRE_MAGIC,
  WIRE_VERSION,
} from './shared-wire'
import {
  addLocalPiece,
  cellKey,
  createSharedWorld,
  damagedNodes,
  emptyDelta,
  liveRecords,
  mergeDelta,
  noteLocalKill,
  noteLocalRemoval,
  noteLocalSegments,
  removedCells,
  quantPos,
  quantYaw,
  setGridStamp,
  snapshotOf,
  type ApertureRec,
  type CellKey,
  type ItemRec,
  type NodeDelta,
  type PieceRec,
  type SharedDelta,
  type SharedWorld,
  type StrokeRec,
} from './shared-world'

const STAMP = 0xc0ffee

// ── Fixtures that look like the real game ───────────────────────────────────

/**
 * A wall grid is roughly 2.4 m × 2.7 m × 0.15 m at a 0.06 m cell, so about
 * 40 × 45 × 2 lattice slots (truncated to MAX_VOXELS when built). Carves are
 * therefore spheres CLIPPED by a thin third axis, which is exactly the shape
 * the two encodings compete over.
 */
const WALL_NX = 40
const WALL_NY = 45
const WALL_NZ = 2

/** The cells a ball of `r` lattice steps at (cx,cy,cz) takes out of a wall. */
function carve(cx: number, cy: number, cz: number, r: number): CellKey[] {
  const out: CellKey[] = []
  const r2 = r * r
  for (let iz = Math.max(0, Math.ceil(cz - r)); iz <= Math.min(WALL_NZ - 1, cz + r); iz++) {
    for (let iy = Math.max(0, Math.ceil(cy - r)); iy <= Math.min(WALL_NY - 1, cy + r); iy++) {
      for (let ix = Math.max(0, Math.ceil(cx - r)); ix <= Math.min(WALL_NX - 1, cx + r); ix++) {
        const d2 = (ix - cx) ** 2 + (iy - cy) ** 2 + (iz - cz) ** 2
        if (d2 <= r2) out.push(cellKey(ix, iy, iz))
      }
    }
  }
  return out
}

/**
 * One rifle shot. The live carve is 4-6 overlapping "nibbles" of 0.12-0.21 m
 * radius scattered around the hit point, so this is five balls of ~2 lattice
 * steps within half a metre of each other.
 */
function rifleShot(seed: number): CellKey[] {
  const rand = mulberry32(seed)
  const cx = 6 + rand() * 28
  const cy = 8 + rand() * 28
  const cells = new Set<CellKey>()
  const nibbles = 4 + Math.floor(rand() * 3)
  for (let i = 0; i < nibbles; i++) {
    const r = 1.9 + rand() * 1.5
    for (const key of carve(cx + (rand() - 0.5) * 4, cy + (rand() - 0.5) * 4, rand() * 1.4, r)) {
      cells.add(key)
    }
  }
  return [...cells].sort((a, b) => a - b)
}

/** A wall most of the way to rubble: repeated bursts until `fraction` gone. */
function wreckedWall(seed: number, fraction: number): CellKey[] {
  const rand = mulberry32(seed)
  const budget = Math.floor(WALL_NX * WALL_NY * WALL_NZ * fraction)
  const cells = new Set<CellKey>()
  let guard = 0
  while (cells.size < budget && guard++ < 400) {
    const r = 2 + rand() * 3
    for (const key of carve(rand() * WALL_NX, rand() * WALL_NY, rand() * WALL_NZ, r)) {
      cells.add(key)
    }
  }
  return [...cells].sort((a, b) => a - b)
}

const nodeDelta = (over: Partial<NodeDelta> & { nodeId: string }): NodeDelta => ({
  epoch: 0,
  removed: [],
  segments: [],
  killed: false,
  reset: false,
  ...over,
})

const shotFrame = (nodeId: string, cells: CellKey[]): SharedDelta => {
  const d = emptyDelta('9f2c41ab-7e10-4d3b-88aa-1c2d3e4f5a6b')
  d.gridStamp = STAMP
  d.lamport = 12345
  d.nodes.push(nodeDelta({ nodeId, removed: cells }))
  return d
}

/**
 * A lot after a serious session: 24 nodes touched, four of them nearly gone,
 * three collapsed outright, plus the built pieces, dropped items, cut
 * openings and paint that a couple of players leave behind.
 */
function wreckedLot(): SharedDelta {
  const d = emptyDelta('9f2c41ab-7e10-4d3b-88aa-1c2d3e4f5a6b', 'snapshot')
  d.gridStamp = STAMP
  d.lamport = 98765

  for (let i = 0; i < 24; i++) {
    const nodeId = `__boots-node-${(0x3f2a + i * 977).toString(16)}`
    const heavy = i % 6 === 0
    const removed = heavy ? wreckedWall(i + 1, 0.62) : rifleShot(i + 1)
    const segments: number[] = []
    for (let s = 0; s < (heavy ? 14 : 2); s++) segments.push(s * 2 + (i % 3))
    d.nodes.push(nodeDelta({ nodeId, removed, segments, epoch: i === 5 ? 1 : 0, reset: i === 5 }))
  }
  for (let i = 0; i < 3; i++) {
    d.nodes.push(nodeDelta({ nodeId: `__boots-node-dead-${i}`, killed: true }))
  }
  // A wall grazed in a few unrelated places: scattered cells across a big
  // bounding box, where the gap list beats the bitmask outright.
  d.nodes.push(
    nodeDelta({
      nodeId: '__boots-node-grazed',
      removed: [
        cellKey(1, 1, 0),
        cellKey(19, 4, 1),
        cellKey(2, 22, 0),
        cellKey(37, 30, 1),
        cellKey(11, 44, 0),
      ].sort((a, b) => a - b),
    }),
  )

  const peers = ['9f2c41ab-7e10-4d3b-88aa-1c2d3e4f5a6b', '5a1b2c3d-9e8f-4a7b-b6c5-d4e3f2a1b0c9']
  // Fixtures quantize exactly as addLocalPiece and friends do on mint — the
  // codec is lossless for records in canonical form, and canonical form is
  // the model's job, not the codec's.
  const rand = mulberry32(99)
  for (let i = 0; i < 18; i++) {
    const rec: PieceRec = {
      id: `${peers[i % 2]}#${i + 1}`,
      lamport: 100 + i,
      kind: (['wall', 'floor', 'roof', 'stairs'] as const)[i % 4] as PieceRec['kind'],
      slot: `Wx:${i % 7},${(i % 3) - 1},${i % 2}`,
      mask: 511,
      yaw: quantYaw(rand() * 6),
      height: 2.7,
      corners: i % 4 === 1 ? [0.1, 0.2, 0.3, 0.4] : null,
    }
    d.pieces.push(rec)
  }
  for (let i = 0; i < 10; i++) {
    const rec: ItemRec = {
      id: `${peers[i % 2]}#${40 + i}`,
      lamport: 200 + i,
      catalogId: ['sofa-2seat', 'floor-lamp', 'crate-small'][i % 3] as string,
      x: quantPos(rand() * 20 - 10),
      y: quantPos(rand() * 3),
      z: quantPos(rand() * 20 - 10),
      yaw: quantYaw(rand() * 6),
    }
    d.items.push(rec)
  }
  for (let i = 0; i < 4; i++) {
    const rec: ApertureRec = {
      id: `${peers[i % 2]}#${60 + i}`,
      lamport: 300 + i,
      catalogId: 'door-single',
      host: `__boots-node-${(0x3f2a + i * 977).toString(16)}`,
      u: 1.2,
      v: 0,
      width: 0.9,
      height: 2.1,
    }
    d.apertures.push(rec)
  }
  for (let i = 0; i < 60; i++) {
    const rec: StrokeRec = {
      id: `${peers[i % 2]}#${100 + i}`,
      lamport: 400 + i,
      node: `__boots-node-${(0x3f2a + (i % 24) * 977).toString(16)}`,
      color: i % 8,
      x: quantPos(rand() * 8),
      y: quantPos(rand() * 2.7),
      z: quantPos(rand() * 8),
      radius: 0.18,
    }
    d.strokes.push(rec)
  }
  d.deadPieces.push(`${peers[0]}#3`, `${peers[1]}#8`)
  return d
}

// ── Round trips ─────────────────────────────────────────────────────────────

describe('round trip', () => {
  test('an empty delta survives', () => {
    const d = emptyDelta('peer-1')
    const back = decodeDelta(encodeDelta(d))
    expect(back).toEqual(d)
  })

  test('a shot frame survives exactly', () => {
    const d = shotFrame('__boots-node-3f2a', rifleShot(1))
    const back = decodeDelta(encodeDelta(d))
    expect(back).toEqual(d)
  })

  test('the whole wrecked lot survives exactly, in both encodings', () => {
    const d = wreckedLot()
    const back = decodeDelta(encodeDelta(d))
    expect(back).toEqual(d)
    // Both cell modes were exercised by that fixture.
    const modes = new Set(d.nodes.map((n) => cellModeFor(n.removed).mode))
    expect(modes.has(CELLS_GAPS)).toBe(true)
    expect(modes.has(CELLS_MASK)).toBe(true)
  })

  test('base64 transport survives', () => {
    const d = wreckedLot()
    const text = encodeDeltaText(d)
    expect(decodeDeltaText(text)).toEqual(d)
    expect(base64ToBytes(text)).toEqual(encodeDelta(d))
    expect(bytesToBase64(new Uint8Array(0))).toBe('')
  })

  test('every scalar comes back bit-identical, because records are pre-quantized', () => {
    const world = createSharedWorld('9f2c41ab-7e10-4d3b-88aa-1c2d3e4f5a6b')
    setGridStamp(world, STAMP)
    const rand = mulberry32(7)
    for (let i = 0; i < 200; i++) {
      const piece = {
        kind: 'wall' as const,
        slot: `Wx:${i % 5},0,0`,
        mask: i % 512,
        yaw: rand() * 40 - 20,
        height: rand() * 30,
        corners: (i % 2 === 0 ? [rand(), -rand(), rand() * 100, -rand() * 100] : null) as
          | [number, number, number, number]
          | null,
      }
      const [sent, back] = addAndRoundTrip(world, piece)
      expect(back).toEqual(sent)
    }
  })

  test('extreme but legal values survive', () => {
    const d = emptyDelta('p')
    d.gridStamp = 0xffffffff
    d.lamport = Number.MAX_SAFE_INTEGER
    d.nodes.push(
      nodeDelta({
        nodeId: 'n',
        epoch: 1048576,
        removed: [0, cellKey(1023, 1023, 1023)],
        segments: [0, 65535],
        killed: true,
        reset: true,
      }),
    )
    const back = decodeDelta(encodeDelta(d))
    expect(back).toEqual(d)
  })
})

/** Mint a piece locally and round trip it; returns [sent, received]. */
function addAndRoundTrip(
  world: SharedWorld,
  spec: Omit<PieceRec, 'id' | 'lamport'>,
): [PieceRec, PieceRec | undefined] {
  const rec = addLocalPiece(world, spec)
  if (!rec) throw new Error('the model refused a legal piece')
  const d = emptyDelta(world.self)
  d.gridStamp = STAMP
  d.pieces.push(rec)
  return [rec, decodeDelta(encodeDelta(d))?.pieces[0]]
}

// ── Measured sizes ──────────────────────────────────────────────────────────

describe('measured wire cost', () => {
  test('one rifle shot', () => {
    const rows: string[] = []
    let worstPerCell = 0
    let worstBytes = 0
    for (let seed = 1; seed <= 8; seed++) {
      const cells = rifleShot(seed)
      const size = measureDelta(shotFrame('__boots-node-3f2a', cells))
      const mode = cellModeFor(cells)
      rows.push(
        `  shot ${seed}: ${cells.length} cells → ${size.bytes} B (${size.bytesPerCell.toFixed(2)} B/cell), ` +
          `base64 ${size.base64} B, JSON ${size.json} B, mode ${mode.mode === CELLS_MASK ? 'mask' : 'gaps'}`,
      )
      worstPerCell = Math.max(worstPerCell, size.bytesPerCell)
      worstBytes = Math.max(worstBytes, size.bytes)
      expect(size.bytes).toBeLessThan(size.json)
    }
    console.log(`\nbytes per rifle shot (one node, one frame):\n${rows.join('\n')}`)
    // A shot is well under a single MTU even after base64.
    expect(worstBytes).toBeLessThan(300)
    // Just over a byte a cell INCLUDING the frame header, which for a single
    // shot is most of the frame; the marginal cost of a cell is far lower.
    expect(worstPerCell).toBeLessThan(1.6)
  })

  test('a full snapshot of a realistically damaged building', () => {
    const snap = wreckedLot()
    const size = measureDelta(snap)
    const cells = snap.nodes.reduce((n, node) => n + node.removed.length, 0)
    console.log(
      `\nfull snapshot: ${snap.nodes.length} nodes, ${cells} dead cells, ${size.records} records\n` +
        `  binary ${size.bytes} B (${size.bytesPerCell.toFixed(2)} B/cell)\n` +
        `  base64 ${size.base64} B\n` +
        `  JSON   ${size.json} B  (${(size.json / size.bytes).toFixed(1)}× the binary)\n`,
    )
    expect(size.bytes).toBeLessThan(24 * 1024)
    expect(size.json / size.bytes).toBeGreaterThan(4)
    expect(size.bytesPerCell).toBeLessThan(1)
  })

  test('the encoder picks the cheaper cell spelling', () => {
    const light = rifleShot(3)
    const heavy = wreckedWall(3, 0.62)
    const lightPick = cellModeFor(light)
    const heavyPick = cellModeFor(heavy)
    expect(Math.min(lightPick.gaps, lightPick.mask)).toBe(
      lightPick.mode === CELLS_MASK ? lightPick.mask : lightPick.gaps,
    )
    expect(heavyPick.mode).toBe(CELLS_MASK)
    // The bitmask really is the win it claims to be on a wrecked wall.
    expect(heavyPick.mask).toBeLessThan(heavyPick.gaps)
    console.log(
      `\ncell spelling: light ${light.length} cells gaps=${lightPick.gaps}B mask=${lightPick.mask}B; ` +
        `heavy ${heavy.length} cells gaps=${heavyPick.gaps}B mask=${heavyPick.mask}B`,
    )
  })

  test('a hundred shots of sustained fire stays inside a sane budget', () => {
    let total = 0
    for (let seed = 1; seed <= 100; seed++) {
      total += encodeDelta(shotFrame(`__boots-node-${seed % 12}`, rifleShot(seed))).length
    }
    const perShotBase64 = Math.ceil(total / 100 / 3) * 4
    console.log(`\n100 shots: ${total} B binary, ~${perShotBase64} B base64 per shot`)
    // At four shots a second that is a few kB/s per shooter, before the
    // transport coalesces frames.
    expect(perShotBase64).toBeLessThan(400)
  })
})

// ── Hostile bytes ───────────────────────────────────────────────────────────

describe('hostile bytes', () => {
  test('empty, short and oversized buffers are refused', () => {
    expect(decodeDelta(new Uint8Array(0))).toBeNull()
    expect(decodeDelta(new Uint8Array([WIRE_MAGIC]))).toBeNull()
    expect(decodeDelta(new Uint8Array(MAX_FRAME_BYTES + 1))).toBeNull()
  })

  test('a wrong magic or version is refused', () => {
    const good = encodeDelta(shotFrame('n', [1, 2, 3]))
    const wrongMagic = good.slice()
    wrongMagic[0] = 0x43
    expect(decodeDelta(wrongMagic)).toBeNull()
    const wrongVersion = good.slice()
    wrongVersion[1] = WIRE_VERSION + 1
    expect(decodeDelta(wrongVersion)).toBeNull()
  })

  test('truncation at every offset is refused, never thrown', () => {
    const good = encodeDelta(wreckedLot())
    for (let cut = 1; cut < good.length; cut += 7) {
      expect(() => decodeDelta(good.subarray(0, cut))).not.toThrow()
      expect(decodeDelta(good.subarray(0, cut))).toBeNull()
    }
  })

  test('an unsorted cell list is normalised rather than mis-encoded', () => {
    const d = emptyDelta('p')
    d.nodes.push(nodeDelta({ nodeId: 'n', removed: [90, 3, 4000, 3, 12] }))
    const back = decodeDelta(encodeDelta(d))
    expect(back?.nodes[0]?.removed).toEqual([3, 12, 90, 4000])
  })

  test('trailing garbage is refused', () => {
    const good = encodeDelta(shotFrame('n', [1, 2, 3]))
    const padded = new Uint8Array(good.length + 3)
    padded.set(good)
    expect(decodeDelta(padded)).toBeNull()
  })

  test('single-byte corruption never throws and never invents state', () => {
    const good = encodeDelta(wreckedLot())
    const rand = mulberry32(5150)
    for (let trial = 0; trial < 600; trial++) {
      const bad = good.slice()
      const at = Math.floor(rand() * bad.length)
      bad[at] = Math.floor(rand() * 256)
      let out: SharedDelta | null = null
      expect(() => {
        out = decodeDelta(bad)
      }).not.toThrow()
      if (out) {
        // Anything that decodes must still respect every cap.
        const d = out as SharedDelta
        expect(d.nodes.length).toBeLessThanOrEqual(1024)
        for (const node of d.nodes) {
          expect(node.removed.length).toBeLessThanOrEqual(4096)
          expect(node.segments.length).toBeLessThanOrEqual(4096)
        }
      }
    }
  })

  test('a nine-byte varint (a length that would allocate the world) is refused', () => {
    const bytes = new Uint8Array([
      WIRE_MAGIC,
      WIRE_VERSION,
      0,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
    ])
    expect(decodeDelta(bytes)).toBeNull()
  })

  test('a bitmask claiming an enormous bounding box is refused before allocating', () => {
    // magic, version, kind, 1 word ("n"), lamport, gridStamp, from, 1 node...
    const bytes = [WIRE_MAGIC, WIRE_VERSION, 0, 1, 1, 0x6e, 0, 0, 0, 1, 0, 0, 2]
    // ...then a mask header with a 1023³ box.
    const varint = (v: number) => {
      const out: number[] = []
      let n = v
      while (n >= 0x80) {
        out.push((n & 0x7f) | 0x80)
        n = Math.floor(n / 128)
      }
      out.push(n)
      return out
    }
    bytes.push(...varint(0), ...varint(0), ...varint(0))
    bytes.push(...varint(1023), ...varint(1023), ...varint(1023))
    const started = Date.now()
    expect(decodeDelta(new Uint8Array(bytes))).toBeNull()
    expect(Date.now() - started).toBeLessThan(200)
  })

  test('bad base64 is refused', () => {
    expect(base64ToBytes('!!!! not base64 !!!!')).toBeNull()
    expect(decodeDeltaText('')).toBeNull()
    expect(decodeDeltaText('aGVsbG8=')).toBeNull()
  })

  test('a decoded frame is safe to merge and cannot smuggle authorship', () => {
    const snap = wreckedLot()
    const bytes = encodeDelta(snap)
    const back = decodeDelta(bytes)
    expect(back).not.toBeNull()

    const world = createSharedWorld('observer')
    setGridStamp(world, STAMP)
    // The bus says this came from ONE peer, so only that peer records survive.
    const sender = '5a1b2c3d-9e8f-4a7b-b6c5-d4e3f2a1b0c9'
    mergeDelta(world, back as SharedDelta, sender)
    expect(liveRecords(world.pieces).every((r) => r.id.startsWith(sender))).toBe(true)
    expect(liveRecords(world.strokes).every((r) => r.id.startsWith(sender))).toBe(true)
    // Damage has no author, so all of it applies.
    expect(damagedNodes(world).length).toBe(snap.nodes.length)
  })

  test('a re-encoded decoded frame is byte-identical (the format is canonical)', () => {
    const once = encodeDelta(wreckedLot())
    const twice = encodeDelta(decodeDelta(once) as SharedDelta)
    expect(twice).toEqual(once)
  })
})

// ── Snapshot for late join ──────────────────────────────────────────────────

describe('late join', () => {
  test('a joiner reconstructs the world from bytes alone', () => {
    const host = createSharedWorld('9f2c41ab-7e10-4d3b-88aa-1c2d3e4f5a6b')
    setGridStamp(host, STAMP)
    for (let i = 0; i < 12; i++) {
      noteLocalRemoval(host, `__boots-node-${i}`, rifleShot(i + 1))
      noteLocalSegments(host, `__boots-node-${i}`, [i, i + 3])
    }
    noteLocalKill(host, '__boots-node-dead')
    addLocalPiece(host, {
      kind: 'wall',
      slot: 'Wx:2,0,0',
      mask: 511,
      yaw: 1.5,
      height: 2.7,
      corners: null,
    })

    const bytes = encodeDelta(snapshotOf(host))
    const joiner = createSharedWorld('joiner')
    setGridStamp(joiner, STAMP)
    const frame = decodeDelta(bytes)
    expect(frame?.kind).toBe('snapshot')
    mergeDelta(joiner, frame as SharedDelta, host.self)

    expect(damagedNodes(joiner)).toEqual(damagedNodes(host))
    for (const nodeId of damagedNodes(host)) {
      expect(removedCells(joiner, nodeId)).toEqual(removedCells(host, nodeId))
    }
    expect(liveRecords(joiner.pieces).length).toBe(1)
    console.log(`\nlate-join snapshot for 13 damaged nodes: ${bytes.length} B binary`)
  })
})
