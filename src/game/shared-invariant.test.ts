/**
 * THE NON-DESTRUCTIVE INVARIANT, applied to the shared world.
 *
 * Boots never writes the document while you play. The four Save bridges
 * (keep.ts, save-demolition.ts, paint-keep.ts, item-keep.ts) are the only
 * scene writers in the plugin and they run from the sidebar after Esc.
 * Multiplayer makes that promise harder in one specific way: a stranger's
 * holes, pieces, items and paint now live in this process. They must be
 * visible, shootable and shared — and they must never reach a scene write,
 * because saving someone else's demolition on their behalf would break the
 * invariant for them, in their document, without their consent.
 *
 * Three fences, tested here:
 *
 *  1. STRUCTURAL — the shared modules import nothing that can write a scene.
 *     No host store, no bridge, not even indirectly. Source-scanned so a
 *     future edit cannot quietly add one.
 *  2. PROJECTION — localWork() is the ONLY door from the shared model to a
 *     bridge, and it yields this client's own work exclusively. A peer that
 *     forges our peer id cannot get through it either.
 *  3. LIVE — a full hostile-and-legitimate merge storm, run with the scene
 *     write sentinel ARMED during play, leaves the scene store
 *     object-identical and the sentinel silent.
 *
 * Fence 1 is the one that keeps the other two honest: the shared model has no
 * store handle at all, and this file is what makes that a rule instead of a
 * habit.
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { useScene } from '@pascal-app/core'
import { useBoots } from '../store'
import { armSceneWriteSentinel } from './session'
import { mulberry32 } from './shared-derive'
import { decodeDelta, encodeDelta, MAX_TEXT_CHARS, MAX_WIRE_PARTS } from './shared-wire'
import {
  addLocalItem,
  addLocalPiece,
  addLocalStroke,
  cellKey,
  createSharedWorld,
  emptyDelta,
  emptyEffects,
  killRecord,
  liveRecords,
  localWork,
  mergeDelta,
  noteLocalKill,
  noteLocalRemoval,
  noteLocalSegments,
  setGridStamp,
  snapshotOf,
  type SharedDelta,
  type SharedWorld,
} from './shared-world'

const STAMP = 0xbeef

/** The three modules that make up the shared world. Nothing else may join. */
const SHARED_MODULES = ['./shared-world.ts', './shared-wire.ts', './shared-derive.ts'] as const

/** The only scene writers in the plugin. */
const BRIDGES = ['./keep.ts', './save-demolition.ts', './paint-keep.ts', './item-keep.ts'] as const

const read = (module: string): Promise<string> =>
  Bun.file(new URL(module, import.meta.url).pathname).text()

/**
 * Source with comments removed. The shared modules discuss Math.random() and
 * performance.now() at length in their headers — that prose is the whole point
 * of the design — so the scans below must look at code, not at the essay
 * explaining why the code avoids them.
 */
const codeOf = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

// ── Fence 1: structural ─────────────────────────────────────────────────────

describe('the shared model cannot write a scene', () => {
  test('it holds no host store and no Save-bridge handle', async () => {
    for (const module of SHARED_MODULES) {
      const source = await read(module)
      expect(source, module).not.toContain('@pascal-app')
      expect(source, module).not.toContain('useScene')
      expect(source, module).not.toContain('useEditor')
      expect(source, module).not.toContain('useBoots')
      for (const bridge of ['keep', 'save-demolition', 'paint-keep', 'item-keep']) {
        expect(codeOf(source), `${module} must not import ${bridge}`).not.toContain(`'./${bridge}'`)
      }
    }
  })

  test('its only imports are each other — a closed, pure trio', async () => {
    const allowed = new Set(['./shared-world', './shared-wire', './shared-derive'])
    for (const module of SHARED_MODULES) {
      const code = codeOf(await read(module))
      const specifiers = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] as string)
      for (const spec of specifiers) {
        expect(allowed.has(spec), `${module} imports ${spec}`).toBe(true)
      }
      // No dynamic escape hatch either.
      expect(code, module).not.toContain('require(')
      expect(code, module).not.toContain('import(')
    }
  })

  test('it reads no clock, no frame budget and no unseeded randomness', async () => {
    // Determinism is the product requirement: two clients holding the same
    // replicated inputs must derive the same world. Anything below would make
    // the answer depend on when the code ran or which machine ran it.
    const banned = [
      'Math.random(',
      'Date.now(',
      'performance.now(',
      'new Date(',
      'requestAnimationFrame',
      'setTimeout(',
      'setInterval(',
      'crypto.',
      'globalThis',
      'process.',
    ]
    for (const module of SHARED_MODULES) {
      const code = codeOf(await read(module))
      for (const needle of banned) {
        expect(code, `${module} uses ${needle}`).not.toContain(needle)
      }
    }
  })

  test('the frame budget is the transport, arithmetic checked not imported', async () => {
    // shared-wire may not import net.ts — a pure codec that reaches for the bus
    // is not pure any more — so the two numbers are related by a comment and
    // could drift. This is the thing that notices. 8000 serialized characters
    // per frame, 120 reserved for the envelope, two for the JSON quotes around
    // a bare base64 string.
    const net = codeOf(await read('./net.ts'))
    const frame = Number(/MAX_FRAME_SERIALIZED\s*=\s*(\d+)/.exec(net)?.[1])
    const envelope = Number(/MAX_PAYLOAD_SERIALIZED\s*=\s*MAX_FRAME_SERIALIZED\s*-\s*(\d+)/.exec(net)?.[1])
    expect(frame).toBe(8000)
    expect(envelope).toBe(120)
    expect(MAX_TEXT_CHARS).toBe(frame - envelope - 2)
    // And the host refuses an envelope claiming more parts than this.
    expect(net).toContain('f.parts > 1024')
    expect(MAX_WIRE_PARTS).toBe(1024)
  })

  test('nothing in the plugin vouches for a stranger', async () => {
    // mergeDelta's third argument is the AUTHORSHIP GATE'S INPUT. null means
    // "this came out of our own model, skip the gate", and the bus never
    // produces it: every inbound frame is stamped with the sender's session id
    // by the host. A caller passing a literal null would hand any peer the
    // right to author records as anyone — including as us.
    const glob = new Bun.Glob('*.{ts,tsx}')
    const dir = new URL('.', import.meta.url).pathname
    let callers = 0
    for await (const file of glob.scan({ cwd: dir })) {
      if (file.includes('.test.')) continue
      const code = codeOf(await Bun.file(`${dir}${file}`).text())
      for (const match of code.matchAll(/mergeDelta\(([^)]*)\)/g)) {
        const args = (match[1] as string).split(',')
        if (args.length < 3) continue
        callers++
        expect((args[2] as string).trim(), `${file} passes it as the sender`).not.toBe('null')
      }
    }
    // The fence is worthless if it scanned nothing.
    expect(callers).toBeGreaterThan(0)
  })

  test('a Save bridge may consume localWork and nothing else from it', async () => {
    // The design allows a bridge to save the LOCAL player's work through
    // localWork(). It allows nothing else: a bridge reaching for world.nodes,
    // liveRecords or a snapshot would be reaching for peers' work.
    for (const bridge of BRIDGES) {
      const code = codeOf(await read(bridge))
      const imports = [...code.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)]
      for (const [, names, from] of imports) {
        if (!(from as string).startsWith('./shared-')) continue
        const wanted = (names as string)
          .split(',')
          .map((n) => n.replace(/^\s*type\s+/, '').trim())
          .filter(Boolean)
        for (const name of wanted) {
          expect(['localWork', 'LocalWork'].includes(name), `${bridge} imports ${name}`).toBe(true)
        }
      }
    }
  })

  test('and it cannot reach peers work through a re-export either', async () => {
    // The Save gate PULLS now: save-demolition asks destruction.ts, which asks
    // shared-damage. That is a better shape than being handed a world — the
    // bridge holds no SharedWorld handle and there is no module cycle — but it
    // routes the projection through a module the import check above does not
    // scan. So scan for the READERS themselves, by name, wherever they came
    // from. Every one of these answers about the whole room.
    const peerWide = [
      'mergeDelta',
      'snapshotOf',
      'takePending',
      'restorePending',
      'liveRecords',
      'damagedNodes',
      'removedCells',
      'brokenSegments',
      'sharedWorldDebug',
      'createSharedWorld',
      'SharedWorld',
    ]
    for (const bridge of BRIDGES) {
      const code = codeOf(await read(bridge))
      for (const name of peerWide) {
        expect(code, `${bridge} reads ${name}`).not.toContain(name)
      }
    }

    // And the window a re-exporter opens must stay the projection's shape. Any
    // function that hands sharedLocalWork()'s answer onwards has to say
    // LocalWork in its signature; a wider return type is a wider window, and
    // whoever writes one has to come back here and argue for it.
    const gate = codeOf(await read('./destruction.ts'))
    const exported = gate.split(/\nexport (?:async )?function /).slice(1)
    let windows = 0
    for (const block of exported) {
      if (!block.includes('sharedLocalWork()')) continue
      windows++
      const signature = block.slice(0, block.indexOf('{'))
      expect(signature, `${signature.trim()} is not LocalWork-shaped`).toContain('LocalWork')
    }
    expect(windows).toBe(1)
  })
})

// ── Fence 2: the projection ─────────────────────────────────────────────────

/** A world with our own work in it, plus a stranger's, merged for real. */
function mixedWorld(): { world: SharedWorld; peer: string } {
  const world = createSharedWorld('me')
  setGridStamp(world, STAMP)
  const peer = 'stranger'

  noteLocalRemoval(world, 'wall-a', [cellKey(1, 1, 0), cellKey(2, 1, 0)])
  noteLocalSegments(world, 'wall-a', [3])
  noteLocalKill(world, 'shed-a')
  addLocalPiece(world, {
    kind: 'wall',
    slot: 'Wx:0,0,0',
    mask: 511,
    yaw: 0,
    height: 2.7,
    corners: null,
  })
  addLocalItem(world, { catalogId: 'sofa', x: 1, y: 0, z: 1, yaw: 0 })
  addLocalStroke(world, { node: 'wall-a', color: 3, x: 0, y: 1, z: 0, radius: 0.2 })

  const theirs = emptyDelta(peer)
  theirs.gridStamp = STAMP
  theirs.lamport = 40
  theirs.nodes.push({
    nodeId: 'wall-b',
    epoch: 0,
    removed: [cellKey(4, 4, 0), cellKey(5, 4, 0)],
    segments: [7],
    killed: false,
    reset: false,
  })
  theirs.nodes.push({
    nodeId: 'wall-a',
    epoch: 0,
    removed: [cellKey(9, 9, 1)],
    segments: [11],
    killed: false,
    reset: false,
  })
  theirs.nodes.push({
    nodeId: 'barn-b',
    epoch: 0,
    removed: [],
    segments: [],
    killed: true,
    reset: false,
  })
  theirs.pieces.push({
    id: `${peer}#1`,
    lamport: 41,
    kind: 'floor',
    slot: 'F:1,0,0',
    mask: 511,
    yaw: 0,
    height: 2.7,
    corners: null,
  })
  theirs.items.push({
    id: `${peer}#2`,
    lamport: 42,
    catalogId: 'lamp',
    x: 3,
    y: 0,
    z: 3,
    yaw: 0,
  })
  theirs.strokes.push({
    id: `${peer}#3`,
    lamport: 43,
    node: 'wall-b',
    color: 5,
    x: 2,
    y: 1,
    z: 2,
    radius: 0.2,
  })
  mergeDelta(world, theirs, peer)
  return { world, peer }
}

describe('localWork is the only door, and it opens on our work alone', () => {
  test('a stranger cells, sticks, kills and records are all absent', () => {
    const { world, peer } = mixedWorld()
    const work = localWork(world)

    // Present in the shared world...
    expect(world.nodes.has('wall-b')).toBe(true)
    expect(world.nodes.get('barn-b')?.killed).toBe(true)
    expect(liveRecords(world.pieces).length).toBe(2)
    // ...absent from what a bridge may save.
    expect([...work.cells.keys()]).toEqual(['wall-a'])
    expect(work.cells.get('wall-a')).toEqual([cellKey(1, 1, 0), cellKey(2, 1, 0)])
    expect(work.segments.get('wall-a')).toEqual([3])
    expect(work.killed).toEqual(['shed-a'])
    for (const rec of [...work.pieces, ...work.items, ...work.apertures, ...work.strokes]) {
      expect(rec.id.startsWith('me#'), `${rec.id} is not ours`).toBe(true)
      expect(rec.id.startsWith(peer)).toBe(false)
    }
  })

  test('a peer who forges our id still cannot get into our Save path', () => {
    // The authorship gate refuses the record outright, so there is nothing to
    // filter later. Peer identity comes from the bus envelope, never from the
    // frame body — a peer cannot claim to be us.
    const world = createSharedWorld('me')
    setGridStamp(world, STAMP)
    const forged = emptyDelta('thief')
    forged.gridStamp = STAMP
    forged.items.push({ id: 'me#1', lamport: 9, catalogId: 'sofa', x: 0, y: 0, z: 0, yaw: 0 })
    forged.pieces.push({
      id: 'me#2',
      lamport: 9,
      kind: 'wall',
      slot: 'Wx:9,0,0',
      mask: 511,
      yaw: 0,
      height: 2.7,
      corners: null,
    })
    mergeDelta(world, forged, 'thief')

    expect(liveRecords(world.items)).toEqual([])
    expect(liveRecords(world.pieces)).toEqual([])
    const work = localWork(world)
    expect(work.items).toEqual([])
    expect(work.pieces).toEqual([])
  })

  test('a world built purely from remote frames yields nothing to save', () => {
    const { world } = mixedWorld()
    const observer = createSharedWorld('observer')
    setGridStamp(observer, STAMP)
    // Ingested the way the transport actually delivers it: the bus does NOT
    // vouch for anyone. Every inbound frame carries a host-stamped sender, so a
    // joiner learns the room from EACH peer's own snapshot — one frame per
    // author, each gated against that author. There is no relay frame and no
    // sender = null on the wire; null means "replayed from our own model".
    const snapshot = snapshotOf(world)
    mergeDelta(observer, snapshot, 'me')
    mergeDelta(observer, snapshot, 'stranger')

    // The observer sees everything...
    expect(observer.nodes.size).toBe(world.nodes.size)
    expect(liveRecords(observer.pieces).length).toBe(liveRecords(world.pieces).length)
    // ...and owns none of it.
    const work = localWork(observer)
    expect(work.cells.size).toBe(0)
    expect(work.segments.size).toBe(0)
    expect(work.killed).toEqual([])
    expect(work.pieces).toEqual([])
    expect(work.items).toEqual([])
    expect(work.apertures).toEqual([])
    expect(work.strokes).toEqual([])
  })

  test('a remote frame cannot revive a record we tombstoned, into our own lane', () => {
    // Ownership is not authority over deletion: anyone may destroy anyone's
    // piece, and the tombstone wins forever. What must not happen is a peer
    // re-adding a dead record and it reappearing as OUR work to save.
    const world = createSharedWorld('me')
    setGridStamp(world, STAMP)
    const mine = addLocalPiece(world, {
      kind: 'wall',
      slot: 'Wx:0,0,0',
      mask: 511,
      yaw: 0,
      height: 2.7,
      corners: null,
    })
    if (!mine) throw new Error('the model refused a legal piece')
    killRecord(world, 'pieces', mine.id)
    expect(localWork(world).pieces).toEqual([])

    const replay = emptyDelta('stranger')
    replay.gridStamp = STAMP
    replay.pieces.push(mine)
    mergeDelta(world, replay, 'stranger')
    expect(localWork(world).pieces).toEqual([])
  })

  test('merge reports only plain data, so nothing live can leak to the wiring', () => {
    // The wiring layer receives SharedEffects and acts on it. If effects could
    // carry a function or a store handle, the fence would be decorative.
    const { world } = mixedWorld()
    const fx = emptyEffects()
    const more = emptyDelta('stranger')
    more.gridStamp = STAMP
    more.nodes.push({
      nodeId: 'wall-c',
      epoch: 0,
      removed: [cellKey(1, 2, 0)],
      segments: [],
      killed: false,
      reset: false,
    })
    mergeDelta(world, more, 'stranger', fx)
    expect(fx.removedCells.size).toBe(1)
    // structuredClone throws on a function, so it throws on a store handle, a
    // React ref, or anything else with behaviour attached.
    expect(() => structuredClone(fx)).not.toThrow()
    // ...and every value in there is a plain container or a scalar: no class
    // instance can slip through as an opaque bag of numbers.
    const plain = new Set([Object.prototype, Array.prototype, Map.prototype, Set.prototype])
    const walk = (value: unknown, path: string): void => {
      if (value === null) return
      const kind = typeof value
      expect(kind, `${path} is a ${kind}`).not.toBe('function')
      if (kind !== 'object') return
      expect(plain.has(Object.getPrototypeOf(value as object)), `${path} is not plain`).toBe(true)
      if (value instanceof Map) {
        for (const [key, child] of value) walk(child, `${path}[${String(key)}]`)
        return
      }
      if (value instanceof Set) {
        for (const child of value) walk(child, `${path}(set)`)
        return
      }
      for (const [key, child] of Object.entries(value as object)) walk(child, `${path}.${key}`)
    }
    walk(fx, 'fx')
  })
})

// ── Fence 3: live, with the sentinel armed ──────────────────────────────────

type SceneStore = {
  getState: () => {
    setScene: (nodes: Record<string, unknown>, roots: string[]) => void
    setReadOnly?: (readOnly: boolean) => void
    nodes: Record<string, unknown>
  }
}
const scene = useScene as unknown as SceneStore

afterEach(() => {
  useBoots.getState().setPhase('editor')
  scene.getState().setReadOnly?.(false)
  scene.getState().setScene({}, [])
})

/** Frames a hostile peer might send. None may write anything, anywhere. */
function hostileFrames(): { why: string; delta: SharedDelta; sender: string | null }[] {
  const base = (): SharedDelta => {
    const d = emptyDelta('attacker')
    d.gridStamp = STAMP
    return d
  }
  const out: { why: string; delta: SharedDelta; sender: string | null }[] = []
  const push = (why: string, make: (d: SharedDelta) => void, sender: string | null = 'attacker') => {
    const d = base()
    make(d)
    out.push({ why, delta: d, sender })
  }

  push('a node id that does not exist here', (d) => {
    d.nodes.push({
      nodeId: '__boots-node-nowhere',
      epoch: 0,
      removed: [cellKey(1, 1, 1)],
      segments: [],
      killed: true,
      reset: false,
    })
  })
  push('cell indices past the lattice', (d) => {
    d.nodes.push({
      nodeId: 'wall-a',
      epoch: 0,
      removed: [-1, 2 ** 31, Number.NaN, Number.POSITIVE_INFINITY, 1.5] as number[],
      segments: [-4, 1e9],
      killed: false,
      reset: false,
    })
  })
  push('an absurd cell count', (d) => {
    d.nodes.push({
      nodeId: 'wall-a',
      epoch: 0,
      removed: Array.from({ length: 200_000 }, (_, i) => i),
      segments: [],
      killed: false,
      reset: false,
    })
  })
  push('an unbounded catalog id', (d) => {
    d.items.push({
      id: 'attacker#1',
      lamport: 1,
      catalogId: 'x'.repeat(500_000),
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
    })
  })
  push('coordinates off the planet', (d) => {
    d.items.push({
      id: 'attacker#2',
      lamport: 1,
      catalogId: 'lamp',
      x: 1e12,
      y: Number.NaN,
      z: -1e12,
      yaw: Number.POSITIVE_INFINITY,
    })
  })
  push('a prototype-pollution attempt', (d) => {
    d.items.push({
      id: '__proto__',
      lamport: 1,
      catalogId: 'lamp',
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
    })
    ;(d as unknown as Record<string, unknown>).__proto__ = { polluted: true }
    d.deadItems.push('constructor', '__proto__', 'polluted')
  })
  push('a lamport shove to the end of time', (d) => {
    d.lamport = Number.MAX_VALUE
    d.nodes.push({
      nodeId: 'wall-a',
      epoch: 2 ** 40,
      removed: [],
      segments: [],
      killed: false,
      reset: true,
    })
  })
  push('junk in every field', () => {}, 'attacker')
  out.push({
    why: 'a frame that is not a frame',
    delta: { v: 1, kind: 'delta' } as unknown as SharedDelta,
    sender: 'attacker',
  })
  out.push({
    why: 'a nameless sender',
    delta: base(),
    sender: 'not#a#peer',
  })
  out.push({
    why: 'null pretending to be a frame',
    delta: null as unknown as SharedDelta,
    sender: 'attacker',
  })
  return out
}

describe('the live invariant', () => {
  test('a full merge storm leaves the scene store untouched, sentinel silent', () => {
    const error = spyOn(console, 'error').mockImplementation(() => {})
    const info = spyOn(console, 'info').mockImplementation(() => {})

    // A lot worth destroying, then play begins and the sentinel arms. Only
    // types the host stores verbatim: a 'roof' container makes core's
    // setScene mint a child roof-segment of its own, which would muddy the
    // key-for-key comparison below with a write that is not ours.
    const seeded = {
      'wall-1': { id: 'wall-1', type: 'wall', name: 'south wall' },
      'wall-2': { id: 'wall-2', type: 'wall', name: 'north wall' },
      'slab-1': { id: 'slab-1', type: 'slab', name: 'floor' },
    }
    scene.getState().setScene(seeded, ['wall-1', 'wall-2', 'slab-1'])
    useBoots.getState().setPhase('game')
    const teardown: Array<() => void> = []
    armSceneWriteSentinel(teardown)

    const before = scene.getState().nodes
    const beforeJson = JSON.stringify(before)

    const world = createSharedWorld('me')
    setGridStamp(world, STAMP)
    const rand = mulberry32(90210)

    // Our own work first — the local half must not write the scene either.
    for (let i = 0; i < 40; i++) {
      noteLocalRemoval(world, `wall-${i % 4}`, [cellKey(i % 20, i % 30, i % 2)])
      noteLocalSegments(world, `wall-${i % 4}`, [i % 12])
      addLocalStroke(world, {
        node: `wall-${i % 4}`,
        color: i % 8,
        x: rand() * 4,
        y: rand() * 2.7,
        z: rand() * 4,
        radius: 0.18,
      })
    }
    noteLocalKill(world, 'wall-1')

    // Then the strangers: hostile frames, then legitimate traffic, then the
    // same traffic again through the codec, in a shuffled order.
    for (const { why, delta, sender } of hostileFrames()) {
      expect(() => mergeDelta(world, delta, sender), why).not.toThrow()
    }
    for (let i = 0; i < 60; i++) {
      const d = emptyDelta(`peer-${i % 5}`)
      d.gridStamp = STAMP
      d.lamport = 100 + i
      d.nodes.push({
        nodeId: `wall-${i % 4}`,
        epoch: 0,
        removed: [cellKey(i % 30, i % 40, i % 2)],
        segments: [i % 14],
        killed: i % 17 === 0,
        reset: false,
      })
      d.items.push({
        id: `peer-${i % 5}#${i}`,
        lamport: 100 + i,
        catalogId: 'crate-small',
        x: rand() * 10,
        y: 0,
        z: rand() * 10,
        yaw: rand() * 6,
      })
      const bytes = encodeDelta(d)
      const back = decodeDelta(bytes)
      mergeDelta(world, d, `peer-${i % 5}`)
      if (back) mergeDelta(world, back, `peer-${i % 5}`)
    }

    // And the wiring layer's reads: the projection, a snapshot for a joiner.
    const work = localWork(world)
    expect(work.cells.size).toBeGreaterThan(0)
    const snapshot = snapshotOf(world)
    expect(decodeDelta(encodeDelta(snapshot))).not.toBeNull()

    const after = scene.getState().nodes
    // Object identity: not even a defensive re-spread of the nodes map.
    expect(after).toBe(before)
    expect(JSON.stringify(after)).toBe(beforeJson)
    expect(after['wall-1']).toBe(seeded['wall-1'])
    expect(Object.keys(after).sort()).toEqual(['slab-1', 'wall-1', 'wall-2'])
    // A killed node in the shared world is a killed node on OUR screen only.
    expect(world.nodes.get('wall-1')?.killed).toBe(true)
    expect(after['wall-1']).toBeDefined()
    // The sentinel is the product's alarm: one line here is an automatic FAIL.
    expect(error).not.toHaveBeenCalled()

    for (const fn of teardown.splice(0)) fn()
    error.mockRestore()
    info.mockRestore()
  })

  test('the hostile battery pollutes no prototype', () => {
    const world = createSharedWorld('me')
    setGridStamp(world, STAMP)
    for (const { delta, sender } of hostileFrames()) mergeDelta(world, delta, sender)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined()
    expect(world.nodes.has('__proto__')).toBe(false)
    expect(liveRecords(world.items).some((r) => r.id === '__proto__')).toBe(false)
  })

  test('a rejected frame is counted, not silently swallowed', () => {
    // Operational honesty: if a peer is being refused, QA can see it in the
    // debug handle instead of guessing why a wall looks different.
    const world = createSharedWorld('me')
    setGridStamp(world, STAMP)
    for (const { delta, sender } of hostileFrames()) mergeDelta(world, delta, sender)
    expect(world.dropped).toBeGreaterThan(0)
  })
})
