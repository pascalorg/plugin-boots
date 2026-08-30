/**
 * shared-wire.ts — the byte format for shared-world frames.
 *
 * WHY A BINARY CODEC AT ALL. A rifle burst carves 30-60 cells per shot, four
 * or five shots a second, per player. As JSON — `{"nodeId":"...","removed":
 * [1234567,1234568,...]}` — that is 8-9 bytes per cell before the base64 the
 * bus imposes, so a single player holding the trigger costs a few kB/s and a
 * late joiner's snapshot of one thoroughly wrecked house runs to tens of kB.
 * The numbers below are measured by shared-wire.test.ts, not estimated, and
 * the test fails if they regress.
 *
 * THE FOUR IDEAS
 *
 *  1. Varints everywhere. Small numbers cost one byte.
 *
 *  2. Cells go out as SORTED GAPS, not values. A carve is a ball, so the
 *     sorted key list is dense runs along x with an occasional row jump;
 *     gap-1 encoding turns most cells into a single byte.
 *
 *  3. Per node, the encoder also costs out a DENSE BITMASK over the bounding
 *     box of the removed set and picks whichever is smaller, writing a mode
 *     byte to say which. Light damage wins on gaps; a wall that is 60 % gone
 *     wins on the bitmask (one bit per cell, no per-cell overhead at all).
 *     Neither mode is ever wrong — they are two spellings of one set.
 *
 *  4. A word table. Node ids ("__boots-node-3f2a" and roof member ids like
 *     "<node>#p4") and catalog/slot ids repeat across a frame; record ids all
 *     share a peer prefix. Words are written once and referenced by index,
 *     and a record id is written as (peer word, serial) rather than as the
 *     string "<peer>#<serial>", which is the single biggest saving in a
 *     snapshot full of placed pieces.
 *
 * WHAT THIS MODULE IS NOT. It does no compression (the transport may deflate,
 * and Supabase broadcast does), no framing, no sequence numbers, no chunking.
 * It turns one SharedDelta into bytes and back. `encodeDelta` is total;
 * `decodeDelta` NEVER throws and NEVER trusts — every length is checked
 * against the caps in shared-world.ts before a single allocation, so a
 * hostile frame claiming four billion nodes is rejected in constant time.
 */

import {
  CELL_AXIS_MAX,
  CELL_KEY_MAX,
  cellIx,
  cellIy,
  cellIz,
  cellKey,
  emptyDelta,
  MAX_APERTURE_M,
  MAX_CELLS_PER_NODE,
  MAX_NODES_PER_FRAME,
  MAX_PAINT_COLORS,
  MAX_PEER_ID_LEN,
  MAX_PIECE_HEIGHT_M,
  MAX_PIECE_MASK,
  MAX_RECORDS_PER_FRAME,
  MAX_SEGMENT_ID,
  MAX_SEGMENTS_PER_NODE,
  MAX_STROKE_RADIUS_M,
  MAX_TOMBSTONES_PER_FRAME,
  PIECE_KINDS,
  POS_PER_M,
  WORLD_BOUND_M,
  YAW_STEPS,
  type ApertureRec,
  type CellKey,
  type ItemRec,
  type NodeDelta,
  type PeerId,
  type PieceKind,
  type PieceRec,
  type RecordId,
  type SharedDelta,
  type StrokeRec,
} from './shared-world'

// ── Format constants ────────────────────────────────────────────────────────

/** 'B' — a cheap "this is not JSON, and not someone else's binary". */
export const WIRE_MAGIC = 0x42
export const WIRE_VERSION = 1

/** Per-node cell encodings. */
export const CELLS_NONE = 0
export const CELLS_GAPS = 1
export const CELLS_MASK = 2

/** Hard ceiling on a frame we will even look at. A full snapshot of a
 * completely obliterated large lot measures well under this; anything bigger
 * is a bug or an attack. The transport should cap lower for deltas. */
export const MAX_FRAME_BYTES = 1 << 20

/** Words in the table, and the longest word we accept. */
const MAX_WORDS = 8192
const MAX_WORD_BYTES = 256

// ── Varint writer ───────────────────────────────────────────────────────────

class Writer {
  private buf: Uint8Array
  private len = 0
  constructor(capacity = 1024) {
    this.buf = new Uint8Array(capacity)
  }
  private need(n: number): void {
    if (this.len + n <= this.buf.length) return
    let cap = this.buf.length * 2
    while (cap < this.len + n) cap *= 2
    const next = new Uint8Array(cap)
    next.set(this.buf.subarray(0, this.len))
    this.buf = next
  }
  u8(v: number): void {
    this.need(1)
    this.buf[this.len++] = v & 0xff
  }
  /** LEB128, unsigned. Values must be non-negative safe integers. */
  varint(v: number): void {
    let n = v
    this.need(8)
    while (n >= 0x80) {
      this.buf[this.len++] = (n & 0x7f) | 0x80
      n = Math.floor(n / 128)
      this.need(8)
    }
    this.buf[this.len++] = n & 0x7f
  }
  /** Zigzag then varint, for values that may be negative. */
  zigzag(v: number): void {
    this.varint(v < 0 ? -2 * v - 1 : 2 * v)
  }
  bytes(src: Uint8Array): void {
    this.need(src.length)
    this.buf.set(src, this.len)
    this.len += src.length
  }
  get length(): number {
    return this.len
  }
  finish(): Uint8Array {
    return this.buf.slice(0, this.len)
  }
}

// ── Varint reader (total; never throws) ─────────────────────────────────────

class Reader {
  private at = 0
  bad = false
  constructor(private readonly buf: Uint8Array) {}
  get done(): boolean {
    return this.at >= this.buf.length
  }
  get offset(): number {
    return this.at
  }
  u8(): number {
    if (this.at >= this.buf.length) {
      this.bad = true
      return 0
    }
    return this.buf[this.at++] as number
  }
  varint(): number {
    let out = 0
    let scale = 1
    for (let i = 0; i < 8; i++) {
      if (this.at >= this.buf.length) {
        this.bad = true
        return 0
      }
      const byte = this.buf[this.at++] as number
      out += (byte & 0x7f) * scale
      if ((byte & 0x80) === 0) {
        if (!Number.isSafeInteger(out)) this.bad = true
        return out
      }
      scale *= 128
    }
    // Nine continuation bytes: a number nobody legitimately sends.
    this.bad = true
    return 0
  }
  zigzag(): number {
    const raw = this.varint()
    return raw % 2 === 0 ? raw / 2 : -(raw + 1) / 2
  }
  slice(n: number): Uint8Array {
    if (n < 0 || this.at + n > this.buf.length) {
      this.bad = true
      return new Uint8Array(0)
    }
    const out = this.buf.subarray(this.at, this.at + n)
    this.at += n
    return out
  }
}

// ── Word table ──────────────────────────────────────────────────────────────

const utf8 = new TextEncoder()
const utf8Decode = new TextDecoder('utf-8', { fatal: false })

class Words {
  readonly list: string[] = []
  private index = new Map<string, number>()
  intern(word: string): number {
    const hit = this.index.get(word)
    if (hit !== undefined) return hit
    const at = this.list.length
    this.list.push(word)
    this.index.set(word, at)
    return at
  }
}

/** Number of bytes a record id costs, so tests can reason about the format. */
const splitRecordId = (id: RecordId): { peer: PeerId; seq: number } | null => {
  const cut = id.lastIndexOf('#')
  if (cut <= 0 || cut === id.length - 1) return null
  const seq = Number(id.slice(cut + 1))
  if (!Number.isInteger(seq) || seq < 0 || seq > 0xffffffff) return null
  return { peer: id.slice(0, cut), seq }
}

// ── Quantized scalars ───────────────────────────────────────────────────────
//
// Records are already on the mm/turn lattice (quantPos/quantYaw run at mint),
// so these conversions are exact round trips, not lossy compression.

const posOut = (w: Writer, v: number): void => w.zigzag(Math.round(v * POS_PER_M))
const posIn = (r: Reader): number => r.zigzag() / POS_PER_M
const lenOut = (w: Writer, v: number): void => w.varint(Math.max(0, Math.round(v * POS_PER_M)))
const lenIn = (r: Reader): number => r.varint() / POS_PER_M
const yawOut = (w: Writer, v: number): void => {
  const turn = Math.PI * 2
  const wrapped = ((v % turn) + turn) % turn
  w.varint(Math.round((wrapped / turn) * YAW_STEPS) % YAW_STEPS)
}
const yawIn = (r: Reader): number => (r.varint() * (Math.PI * 2)) / YAW_STEPS

// ── Cell encodings ──────────────────────────────────────────────────────────

type Bbox = { x0: number; y0: number; z0: number; w: number; h: number; d: number }

const bboxOf = (cells: readonly CellKey[]): Bbox => {
  let x0 = CELL_AXIS_MAX
  let y0 = CELL_AXIS_MAX
  let z0 = CELL_AXIS_MAX
  let x1 = 0
  let y1 = 0
  let z1 = 0
  for (const key of cells) {
    const ix = cellIx(key)
    const iy = cellIy(key)
    const iz = cellIz(key)
    if (ix < x0) x0 = ix
    if (iy < y0) y0 = iy
    if (iz < z0) z0 = iz
    if (ix > x1) x1 = ix
    if (iy > y1) y1 = iy
    if (iz > z1) z1 = iz
  }
  return { x0, y0, z0, w: x1 - x0 + 1, h: y1 - y0 + 1, d: z1 - z0 + 1 }
}

const varintSize = (v: number): number => {
  let n = v
  let bytes = 1
  while (n >= 0x80) {
    n = Math.floor(n / 128)
    bytes++
  }
  return bytes
}

/** Cost of the gap encoding, without building it. Cells must be ascending. */
const gapsSize = (cells: readonly CellKey[]): number => {
  let bytes = varintSize(cells.length)
  let prev = -1
  for (const key of cells) {
    bytes += varintSize(key - prev - 1)
    prev = key
  }
  return bytes
}

/** Cost of the bitmask encoding, without building it. */
const maskSize = (box: Bbox): number => {
  const volume = box.w * box.h * box.d
  return (
    varintSize(box.x0) +
    varintSize(box.y0) +
    varintSize(box.z0) +
    varintSize(box.w) +
    varintSize(box.h) +
    varintSize(box.d) +
    Math.ceil(volume / 8)
  )
}

/**
 * Which spelling wins for this cell set, and by how much. Exported so the
 * size tests can assert the crossover rather than guess at it.
 */
export function cellModeFor(cells: readonly CellKey[]): {
  mode: number
  gaps: number
  mask: number
} {
  if (cells.length === 0) return { mode: CELLS_NONE, gaps: 0, mask: 0 }
  const sorted = [...cells].sort((a, b) => a - b)
  const box = bboxOf(sorted)
  const volume = box.w * box.h * box.d
  const gaps = gapsSize(sorted)
  const mask = maskSize(box)
  const useMask = volume <= MAX_CELLS_PER_NODE * 8 && mask < gaps
  return { mode: useMask ? CELLS_MASK : CELLS_GAPS, gaps, mask }
}

/**
 * Pick and write the cheaper of the two spellings.
 *
 * The gap encoding needs an ascending list. Everything the model produces is
 * already sorted (`removedCells` and the merge both sort), but this checks and
 * sorts a copy anyway rather than emitting a frame that decodes to a
 * DIFFERENT cell set — a bug that would show up as one client's holes landing
 * in the wrong place, which is far too expensive to leave to convention.
 */
function writeCells(w: Writer, input: readonly CellKey[]): number {
  if (input.length === 0) {
    w.u8(CELLS_NONE)
    return CELLS_NONE
  }
  let ascending = true
  for (let i = 1; i < input.length; i++) {
    if ((input[i] as number) <= (input[i - 1] as number)) {
      ascending = false
      break
    }
  }
  const cells = ascending ? input : [...new Set(input)].sort((a, b) => a - b)
  const box = bboxOf(cells)
  const volume = box.w * box.h * box.d
  const useMask = volume <= MAX_CELLS_PER_NODE * 8 && maskSize(box) < gapsSize(cells)
  if (useMask) {
    w.u8(CELLS_MASK)
    w.varint(box.x0)
    w.varint(box.y0)
    w.varint(box.z0)
    w.varint(box.w)
    w.varint(box.h)
    w.varint(box.d)
    const bits = new Uint8Array(Math.ceil(volume / 8))
    for (const key of cells) {
      const at =
        cellIx(key) - box.x0 + box.w * (cellIy(key) - box.y0 + box.h * (cellIz(key) - box.z0))
      bits[at >> 3] = (bits[at >> 3] as number) | (1 << (at & 7))
    }
    w.bytes(bits)
    return CELLS_MASK
  }
  w.u8(CELLS_GAPS)
  w.varint(cells.length)
  let prev = -1
  for (const key of cells) {
    w.varint(key - prev - 1)
    prev = key
  }
  return CELLS_GAPS
}

function readCells(r: Reader): CellKey[] | null {
  const mode = r.u8()
  if (mode === CELLS_NONE) return []
  if (mode === CELLS_GAPS) {
    const count = r.varint()
    if (r.bad || count > MAX_CELLS_PER_NODE) return null
    const out: CellKey[] = []
    let prev = -1
    for (let i = 0; i < count; i++) {
      const key = prev + 1 + r.varint()
      if (r.bad) return null
      // Ascending by construction; only the range needs checking.
      if (key > CELL_KEY_MAX) return null
      out.push(key)
      prev = key
    }
    return out
  }
  if (mode === CELLS_MASK) {
    const x0 = r.varint()
    const y0 = r.varint()
    const z0 = r.varint()
    const w = r.varint()
    const h = r.varint()
    const d = r.varint()
    if (r.bad) return null
    if (w <= 0 || h <= 0 || d <= 0) return null
    if (x0 + w > CELL_AXIS_MAX || y0 + h > CELL_AXIS_MAX || z0 + d > CELL_AXIS_MAX) return null
    const volume = w * h * d
    // Refuse the allocation BEFORE making it.
    if (volume > MAX_CELLS_PER_NODE * 8) return null
    const bits = r.slice(Math.ceil(volume / 8))
    if (r.bad) return null
    const out: CellKey[] = []
    for (let at = 0; at < volume; at++) {
      if (((bits[at >> 3] as number) & (1 << (at & 7))) === 0) continue
      if (out.length >= MAX_CELLS_PER_NODE) return null
      const ix = at % w
      const iy = Math.floor(at / w) % h
      const iz = Math.floor(at / (w * h))
      out.push(cellKey(x0 + ix, y0 + iy, z0 + iz))
    }
    out.sort((a, b) => a - b)
    return out
  }
  return null
}

// ── Encode ──────────────────────────────────────────────────────────────────

/**
 * Turn a delta (or a snapshot — same shape, same path) into bytes.
 *
 * The word table has to be built before the body can reference it, so this
 * writes the body into a scratch Writer first and prefixes the table. That
 * costs one extra copy per frame and buys the compactness.
 */
export function encodeDelta(delta: SharedDelta): Uint8Array {
  const words = new Words()
  const body = new Writer(2048)

  const word = (s: string): void => body.varint(words.intern(s))
  const recId = (id: RecordId): void => {
    const split = splitRecordId(id)
    if (!split) {
      body.varint(0)
      body.varint(words.intern(id))
      return
    }
    body.varint(1 + words.intern(split.peer))
    body.varint(split.seq)
  }

  body.varint(delta.lamport)
  body.varint(delta.gridStamp >>> 0)
  word(delta.from)

  body.varint(delta.nodes.length)
  for (const nd of delta.nodes) {
    word(nd.nodeId)
    body.varint(nd.epoch)
    body.u8((nd.killed ? 1 : 0) | (nd.reset ? 2 : 0))
    writeCells(body, nd.removed)
    body.varint(nd.segments.length)
    let prevSeg = -1
    for (const id of nd.segments) {
      body.varint(id - prevSeg - 1)
      prevSeg = id
    }
  }

  body.varint(delta.pieces.length)
  for (const p of delta.pieces) {
    recId(p.id)
    body.varint(p.lamport)
    body.u8(PIECE_KINDS.indexOf(p.kind))
    word(p.slot)
    body.varint(p.mask)
    yawOut(body, p.yaw)
    lenOut(body, p.height)
    if (p.corners) {
      body.u8(1)
      for (const c of p.corners) posOut(body, c)
    } else {
      body.u8(0)
    }
  }

  body.varint(delta.items.length)
  for (const it of delta.items) {
    recId(it.id)
    body.varint(it.lamport)
    word(it.catalogId)
    posOut(body, it.x)
    posOut(body, it.y)
    posOut(body, it.z)
    yawOut(body, it.yaw)
  }

  body.varint(delta.apertures.length)
  for (const ap of delta.apertures) {
    recId(ap.id)
    body.varint(ap.lamport)
    word(ap.catalogId)
    word(ap.host)
    posOut(body, ap.u)
    posOut(body, ap.v)
    lenOut(body, ap.width)
    lenOut(body, ap.height)
  }

  body.varint(delta.strokes.length)
  for (const st of delta.strokes) {
    recId(st.id)
    body.varint(st.lamport)
    word(st.node)
    body.varint(st.color)
    posOut(body, st.x)
    posOut(body, st.y)
    posOut(body, st.z)
    lenOut(body, st.radius)
  }

  for (const dead of [delta.deadPieces, delta.deadItems, delta.deadApertures, delta.deadStrokes]) {
    body.varint(dead.length)
    for (const id of dead) recId(id)
  }

  // Header + word table + body.
  const out = new Writer(body.length + 256)
  out.u8(WIRE_MAGIC)
  out.u8(WIRE_VERSION)
  out.u8(delta.kind === 'snapshot' ? 1 : 0)
  out.varint(words.list.length)
  for (const w of words.list) {
    const bytes = utf8.encode(w)
    out.varint(bytes.length)
    out.bytes(bytes)
  }
  out.bytes(body.finish())
  return out.finish()
}

// ── Decode ──────────────────────────────────────────────────────────────────

/**
 * Bytes back to a delta, or null if the frame is malformed, over-cap, or from
 * a version we do not speak. `from` is decoded for diagnostics only — the
 * caller must pass the BUS ENVELOPE's sender to mergeDelta, never this.
 *
 * Everything here is defensive on purpose: this function is the only code in
 * the plugin that reads bytes a stranger chose.
 */
export function decodeDelta(bytes: Uint8Array): SharedDelta | null {
  if (bytes.length < 4 || bytes.length > MAX_FRAME_BYTES) return null
  const r = new Reader(bytes)
  if (r.u8() !== WIRE_MAGIC) return null
  if (r.u8() !== WIRE_VERSION) return null
  const kindByte = r.u8()
  if (kindByte > 1) return null

  const wordCount = r.varint()
  if (r.bad || wordCount > MAX_WORDS) return null
  const words: string[] = []
  for (let i = 0; i < wordCount; i++) {
    const n = r.varint()
    if (r.bad || n > MAX_WORD_BYTES) return null
    const raw = r.slice(n)
    if (r.bad) return null
    words.push(utf8Decode.decode(raw))
  }
  const word = (): string | null => {
    const at = r.varint()
    if (r.bad || at >= words.length) return null
    return words[at] as string
  }
  const recId = (): RecordId | null => {
    const tag = r.varint()
    if (r.bad) return null
    if (tag === 0) return word()
    const peer = words[tag - 1]
    if (peer === undefined) return null
    const seq = r.varint()
    if (r.bad) return null
    return `${peer}#${seq}`
  }

  const lamport = r.varint()
  const gridStamp = r.varint()
  const from = word()
  if (r.bad || from === null || from.length > MAX_PEER_ID_LEN) return null
  if (gridStamp > 0xffffffff) return null

  const out = emptyDelta(from, kindByte === 1 ? 'snapshot' : 'delta')
  out.lamport = lamport
  out.gridStamp = gridStamp

  const nodeCount = r.varint()
  if (r.bad || nodeCount > MAX_NODES_PER_FRAME) return null
  for (let i = 0; i < nodeCount; i++) {
    const nodeId = word()
    if (nodeId === null) return null
    const epoch = r.varint()
    const flags = r.u8()
    if (r.bad || flags > 3) return null
    const removed = readCells(r)
    if (removed === null) return null
    const segCount = r.varint()
    if (r.bad || segCount > MAX_SEGMENTS_PER_NODE) return null
    const segments: number[] = []
    let prev = -1
    for (let s = 0; s < segCount; s++) {
      const id = prev + 1 + r.varint()
      if (r.bad || id > MAX_SEGMENT_ID) return null
      segments.push(id)
      prev = id
    }
    const nd: NodeDelta = {
      nodeId,
      epoch,
      removed,
      segments,
      killed: (flags & 1) !== 0,
      reset: (flags & 2) !== 0,
    }
    out.nodes.push(nd)
  }

  const pieceCount = r.varint()
  if (r.bad || pieceCount > MAX_RECORDS_PER_FRAME) return null
  for (let i = 0; i < pieceCount; i++) {
    const id = recId()
    const lam = r.varint()
    const kindAt = r.u8()
    const slot = word()
    const mask = r.varint()
    const yaw = yawIn(r)
    const height = lenIn(r)
    const hasCorners = r.u8()
    if (r.bad || id === null || slot === null) return null
    if (kindAt >= PIECE_KINDS.length) return null
    if (mask > MAX_PIECE_MASK || height > MAX_PIECE_HEIGHT_M) return null
    if (hasCorners > 1) return null
    let corners: PieceRec['corners'] = null
    if (hasCorners === 1) {
      const a = posIn(r)
      const b = posIn(r)
      const c = posIn(r)
      const d = posIn(r)
      if (r.bad) return null
      corners = [a, b, c, d]
    }
    const rec: PieceRec = {
      id,
      lamport: lam,
      kind: PIECE_KINDS[kindAt] as PieceKind,
      slot,
      mask,
      yaw,
      height,
      corners,
    }
    out.pieces.push(rec)
  }

  const itemCount = r.varint()
  if (r.bad || itemCount > MAX_RECORDS_PER_FRAME) return null
  for (let i = 0; i < itemCount; i++) {
    const id = recId()
    const lam = r.varint()
    const catalogId = word()
    const x = posIn(r)
    const y = posIn(r)
    const z = posIn(r)
    const yaw = yawIn(r)
    if (r.bad || id === null || catalogId === null) return null
    if (Math.abs(x) > WORLD_BOUND_M || Math.abs(y) > WORLD_BOUND_M || Math.abs(z) > WORLD_BOUND_M) {
      return null
    }
    const rec: ItemRec = { id, lamport: lam, catalogId, x, y, z, yaw }
    out.items.push(rec)
  }

  const apCount = r.varint()
  if (r.bad || apCount > MAX_RECORDS_PER_FRAME) return null
  for (let i = 0; i < apCount; i++) {
    const id = recId()
    const lam = r.varint()
    const catalogId = word()
    const host = word()
    const u = posIn(r)
    const v = posIn(r)
    const width = lenIn(r)
    const height = lenIn(r)
    if (r.bad || id === null || catalogId === null || host === null) return null
    if (width <= 0 || height <= 0 || width > MAX_APERTURE_M || height > MAX_APERTURE_M) return null
    const rec: ApertureRec = { id, lamport: lam, catalogId, host, u, v, width, height }
    out.apertures.push(rec)
  }

  const strokeCount = r.varint()
  if (r.bad || strokeCount > MAX_RECORDS_PER_FRAME) return null
  for (let i = 0; i < strokeCount; i++) {
    const id = recId()
    const lam = r.varint()
    const node = word()
    const color = r.varint()
    const x = posIn(r)
    const y = posIn(r)
    const z = posIn(r)
    const radius = lenIn(r)
    if (r.bad || id === null || node === null) return null
    if (color >= MAX_PAINT_COLORS) return null
    if (radius <= 0 || radius > MAX_STROKE_RADIUS_M) return null
    const rec: StrokeRec = { id, lamport: lam, node, color, x, y, z, radius }
    out.strokes.push(rec)
  }

  const lanes: RecordId[][] = [out.deadPieces, out.deadItems, out.deadApertures, out.deadStrokes]
  for (const sink of lanes) {
    const n = r.varint()
    if (r.bad || n > MAX_TOMBSTONES_PER_FRAME) return null
    for (let i = 0; i < n; i++) {
      const id = recId()
      if (id === null) return null
      sink.push(id)
    }
  }

  // Trailing garbage means the frame was not produced by this encoder.
  return r.bad || !r.done ? null : out
}

// ── Base64, for a JSON-only bus ─────────────────────────────────────────────
//
// The collab bus carries `data: unknown` through JSON, so bytes have to ride
// as text at a 4/3 penalty. Chunked because String.fromCharCode.apply on a
// 100 kB snapshot overflows the argument stack.

const B64_CHUNK = 0x8000

export function bytesToBase64(bytes: Uint8Array): string {
  let ascii = ''
  for (let at = 0; at < bytes.length; at += B64_CHUNK) {
    ascii += String.fromCharCode(...bytes.subarray(at, at + B64_CHUNK))
  }
  return btoa(ascii)
}

export function base64ToBytes(text: string): Uint8Array | null {
  if (typeof text !== 'string' || text.length > MAX_FRAME_BYTES * 2) return null
  try {
    const ascii = atob(text)
    const out = new Uint8Array(ascii.length)
    for (let i = 0; i < ascii.length; i++) out[i] = ascii.charCodeAt(i) & 0xff
    return out
  } catch {
    return null
  }
}

/** encode → base64 in one call, which is what the transport wants. */
export const encodeDeltaText = (delta: SharedDelta): string => bytesToBase64(encodeDelta(delta))

/** base64 → decode in one call. Null on anything suspicious. */
export function decodeDeltaText(text: string): SharedDelta | null {
  const bytes = base64ToBytes(text)
  return bytes ? decodeDelta(bytes) : null
}

// ── Measurement (used by the tests, and by QA in the console) ───────────────

export type WireSize = {
  bytes: number
  base64: number
  /** What the same frame would cost as JSON, for the comparison that
   * justifies this module existing. */
  json: number
  cells: number
  records: number
  /** Bytes per removed cell, the number that actually matters in a firefight. */
  bytesPerCell: number
}

export function measureDelta(delta: SharedDelta): WireSize {
  const bytes = encodeDelta(delta)
  let cells = 0
  for (const nd of delta.nodes) cells += nd.removed.length
  const records =
    delta.pieces.length + delta.items.length + delta.apertures.length + delta.strokes.length
  return {
    bytes: bytes.length,
    base64: Math.ceil(bytes.length / 3) * 4,
    json: utf8.encode(JSON.stringify(delta)).length,
    cells,
    records,
    bytesPerCell: cells > 0 ? bytes.length / cells : 0,
  }
}
