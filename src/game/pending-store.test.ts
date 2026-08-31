import { describe, expect, test } from 'bun:test'
import { FULL_MASK, type PlacedPiece } from '../store'
import {
  browserPendingStorage,
  buildPendingSnapshot,
  capPendingScopes,
  currentPendingScope,
  forgetPendingSnapshot,
  isEmptyPending,
  MAX_PENDING_BYTES,
  MAX_PENDING_ITEMS,
  MAX_PENDING_PIECES,
  MAX_PENDING_SCOPES,
  parsePendingSnapshot,
  PENDING_FORMAT,
  PENDING_KEY_PREFIX,
  type PendingLanes,
  pendingKey,
  type PendingSnapshot,
  type PendingStorage,
  pendingScopeFrom,
  type PersistedPlacement,
  prunePendingSnapshot,
  readPendingSnapshot,
  writePendingSnapshot,
} from './pending-store'

/**
 * The durable pending window. Everything here is pure — snapshot in, snapshot
 * out, storage handle passed in — so the whole format is testable without a
 * browser, which is the reason the module was written that way.
 *
 * What these tests are really protecting: a player's fort. This key is the only
 * record of an undecided session, so the failure modes that matter are the
 * QUIET ones — a row silently dropped, a cap silently truncating, a stale
 * `mine` grant outliving the row it justified, one project's window offered in
 * another building.
 */

// ── Fixtures ────────────────────────────────────────────────────────────────

/** A `localStorage` stand-in with the real `key(index)`/`length` surface. */
class FakeStorage implements PendingStorage {
  readonly map = new Map<string, string>()
  /** Set to make every operation throw, like Safari private mode. */
  throws = false
  /** Set to make writes alone throw, like a full quota. */
  throwsOnWrite = false

  get length(): number {
    if (this.throws) throw new Error('storage disabled')
    return this.map.size
  }

  getItem(key: string): string | null {
    if (this.throws) throw new Error('storage disabled')
    return this.map.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    if (this.throws || this.throwsOnWrite) throw new Error('QuotaExceeded')
    this.map.set(key, value)
  }

  removeItem(key: string): void {
    if (this.throws) throw new Error('storage disabled')
    this.map.delete(key)
  }

  key(index: number): string | null {
    if (this.throws) throw new Error('storage disabled')
    return [...this.map.keys()][index] ?? null
  }
}

const wall = (over: Partial<PlacedPiece> = {}): PlacedPiece => ({
  id: 12,
  mask: FULL_MASK,
  piece: 'wall',
  position: [1, 0, 2],
  yaw: 0,
  ...over,
})

const lanes = (over: Partial<PendingLanes> = {}): PendingLanes => ({
  destroyed: [],
  items: [],
  mine: [],
  painted: [],
  placed: [],
  ...over,
})

const snapshotOf = (over: Partial<PendingSnapshot> = {}): PendingSnapshot => ({
  destroyed: [],
  format: PENDING_FORMAT,
  items: [],
  mine: [],
  painted: [],
  placed: [],
  savedAt: 1000,
  ...over,
})

const aperture = (over: Partial<Extract<PersistedPlacement, { kind: 'aperture' }>> = {}) =>
  ({
    catalogId: 'window_double',
    height: 1.2,
    kind: 'aperture',
    u: 0.5,
    v: 1,
    wallId: 'wall_1',
    width: 0.9,
    ...over,
  }) as PersistedPlacement

// ── Scope ───────────────────────────────────────────────────────────────────

describe('pendingScopeFrom (the scope is mandatory)', () => {
  test('the collaboration bus wins over the route, because it is certain', () => {
    expect(pendingScopeFrom({ path: '/editor/project_B', projectId: 'project_A' })).toBe('project_A')
  })

  test('all three Boots routes name the project', () => {
    expect(pendingScopeFrom({ path: '/editor/project_A' })).toBe('project_A')
    expect(pendingScopeFrom({ path: '/play/project_A' })).toBe('project_A')
    expect(pendingScopeFrom({ path: '/scene/projectahyvrpvr' })).toBe('projectahyvrpvr')
  })

  test('the lobby drop link resolves to the same scope as a plain visit', () => {
    // `/play/<id>?boots=drop` and `/editor/<id>` are the same building, and a
    // fort built through one link has to be offered through the other.
    expect(pendingScopeFrom({ path: '/play/project_A?boots=drop' })).toBe('project_A')
    expect(pendingScopeFrom({ path: '/editor/project_A#anchor' })).toBe('project_A')
    expect(pendingScopeFrom({ path: '/editor/project_A/settings' })).toBe('project_A')
  })

  test('null when it cannot name the project — and null means no persistence', () => {
    expect(pendingScopeFrom({ path: '/' })).toBeNull()
    expect(pendingScopeFrom({ path: '/projects' })).toBeNull()
    expect(pendingScopeFrom({ path: null })).toBeNull()
    expect(pendingScopeFrom({})).toBeNull()
    // No shared fallback key exists on purpose: mixing two buildings is worse
    // than losing a window.
    expect(pendingScopeFrom({ path: '/editor/' })).toBeNull()
  })

  test('a project id that could escape a storage key is refused, not sanitised', () => {
    // It falls through to the route, which is the trustworthy source.
    expect(pendingScopeFrom({ path: '/editor/project_A', projectId: '../other' })).toBe('project_A')
    expect(pendingScopeFrom({ projectId: 'a.b' })).toBeNull()
    expect(pendingScopeFrom({ projectId: '' })).toBeNull()
    expect(pendingScopeFrom({ projectId: 42 })).toBeNull()
    expect(pendingScopeFrom({ projectId: 'x'.repeat(121) })).toBeNull()
  })

  test('the key is namespaced by format, so a shape change cannot collide', () => {
    expect(pendingKey('project_A')).toBe(`boots.pending.${PENDING_FORMAT}.project_A`)
    expect(pendingKey('project_A').startsWith(PENDING_KEY_PREFIX)).toBe(true)
  })
})

describe('currentPendingScope (bus, else URL)', () => {
  const globals = globalThis as {
    __pascalCollabBus?: { projectId?: unknown }
    location?: { pathname?: string }
  }

  test('reads the collab bus first, then the location', () => {
    const bus = globals.__pascalCollabBus
    const location = globals.location
    try {
      globals.location = { pathname: '/editor/from_url' }
      globals.__pascalCollabBus = undefined
      expect(currentPendingScope()).toBe('from_url')
      globals.__pascalCollabBus = { projectId: 'from_bus' }
      expect(currentPendingScope()).toBe('from_bus')
    } finally {
      globals.__pascalCollabBus = bus
      globals.location = location
    }
  })
})

// ── Building a snapshot ─────────────────────────────────────────────────────

describe('buildPendingSnapshot', () => {
  test('nothing pending means no snapshot, which means the key is removed', () => {
    expect(buildPendingSnapshot(lanes(), 5)).toBeNull()
    // `mine` is an allow-list, not pending work: it cannot hold a window open
    // on its own, or an empty offer would persist forever.
    expect(isEmptyPending(lanes({ mine: ['wall_1'] }))).toBe(true)
    expect(buildPendingSnapshot(lanes({ mine: ['wall_1'] }), 5)).toBeNull()
  })

  test('each lane on its own opens a window', () => {
    expect(isEmptyPending(lanes({ placed: [wall()] }))).toBe(false)
    expect(isEmptyPending(lanes({ destroyed: [{ kind: 'wall', nodeId: 'n1' }] }))).toBe(false)
    expect(
      isEmptyPending(lanes({ painted: [{ cells: 3, color: '#3b4a63', colorName: 'NAVY', nodeId: 'n1' }] })),
    ).toBe(false)
    expect(isEmptyPending(lanes({ items: [aperture()] }))).toBe(false)
  })

  test('the demolition allow-list is narrowed to rows that still justify it', () => {
    // A grant with no destroyed row left has nothing to authorize, and it is
    // the one field that ends in a real `deleteNodes` call.
    const snapshot = buildPendingSnapshot(
      lanes({
        destroyed: [{ kind: 'wall', nodeId: 'kept' }],
        mine: ['kept', 'kept', 'orphan'],
      }),
      7,
    )
    expect(snapshot?.mine).toEqual(['kept'])
    expect(snapshot?.savedAt).toBe(7)
    expect(snapshot?.format).toBe(PENDING_FORMAT)
  })

  test('rows are copied, so a later in-game mutation cannot rewrite the offer', () => {
    const live = wall({ corners: [1, 1, 1, 1], height: 2.7, slotId: 'Wx:0,0,0' })
    const snapshot = buildPendingSnapshot(lanes({ placed: [live] }), 1)
    live.position[0] = 999
    live.corners![0] = 999
    expect(snapshot?.placed[0]?.position).toEqual([1, 0, 2])
    expect(snapshot?.placed[0]?.corners).toEqual([1, 1, 1, 1])
    expect(snapshot?.placed[0]?.slotId).toBe('Wx:0,0,0')
    expect(snapshot?.placed[0]?.height).toBe(2.7)
  })
})

// ── Reading one back ────────────────────────────────────────────────────────

describe('parsePendingSnapshot', () => {
  test('a full round trip through JSON keeps every lane', () => {
    const built = buildPendingSnapshot(
      lanes({
        destroyed: [{ kind: 'volume', nodeId: 'vol_1' }],
        items: [
          { catalogId: 'crate', kind: 'item', position: [1, 2, 3], yaw: 1.5 },
          aperture(),
        ],
        mine: ['vol_1'],
        painted: [{ cells: 9, color: '#3b4a63', colorName: 'NAVY', nodeId: 'vol_1' }],
        placed: [wall({ height: 2.7, slotId: 'Wx:0,0,0' })],
      }),
      1234,
    )
    const parsed = parsePendingSnapshot(JSON.parse(JSON.stringify(built)))
    expect(parsed?.skipped).toBe(0)
    // Ids are the one thing that does NOT survive: they are per-page-load
    // runtime counters that also key colliders, so the hydrator re-mints them.
    expect(parsed?.snapshot).toEqual({ ...built!, placed: [{ ...built!.placed[0]!, id: 0 }] })
  })

  test('another format is dropped whole, never half-read', () => {
    expect(parsePendingSnapshot({ ...snapshotOf(), format: PENDING_FORMAT + 1 })).toBeNull()
    expect(parsePendingSnapshot({ placed: [] })).toBeNull()
    expect(parsePendingSnapshot(null)).toBeNull()
    expect(parsePendingSnapshot([snapshotOf()])).toBeNull()
    expect(parsePendingSnapshot('{}')).toBeNull()
  })

  test('a bad row is dropped AND counted, because a quiet loss reads as nothing pending', () => {
    const parsed = parsePendingSnapshot({
      ...snapshotOf(),
      destroyed: [{ kind: 'wall', nodeId: 'n1' }, { kind: 'wall' }, { kind: 'ceiling', nodeId: 'n2' }],
      items: [aperture(), { catalogId: 'x', kind: 'aperture', u: 0, v: 0, wallId: 'w', width: 1 }],
      painted: [
        { cells: 1, color: '#3b4a63', colorName: 'NAVY', nodeId: 'n1' },
        { cells: 1, color: 'navy', colorName: 'NAVY', nodeId: 'n1' },
      ],
      placed: [wall(), { piece: 'moat', position: [0, 0, 0], yaw: 0 }, wall({ position: [0, 0] as never })],
    })
    expect(parsed?.snapshot.placed.length).toBe(1)
    expect(parsed?.snapshot.destroyed).toEqual([{ kind: 'wall', nodeId: 'n1' }])
    expect(parsed?.snapshot.painted.length).toBe(1)
    expect(parsed?.snapshot.items.length).toBe(1)
    expect(parsed?.skipped).toBe(6)
  })

  test('a lane cut short by its cap is counted too, not truncated in silence', () => {
    // The module's promise is that pruning is always reported. A 5000-piece key
    // that came back as 4000 with `skipped: 0` would read as a smaller fort
    // with nothing to explain it.
    const parsed = parsePendingSnapshot({
      ...snapshotOf(),
      items: Array.from({ length: MAX_PENDING_ITEMS + 5 }, () => aperture()),
      placed: Array.from({ length: MAX_PENDING_PIECES + 3 }, () => wall()),
    })
    expect(parsed?.snapshot.placed.length).toBe(MAX_PENDING_PIECES)
    expect(parsed?.snapshot.items.length).toBe(MAX_PENDING_ITEMS)
    expect(parsed?.skipped).toBe(8)
  })

  test('a missing lane is empty, not a loss to report', () => {
    const parsed = parsePendingSnapshot({ format: PENDING_FORMAT, placed: 'not an array' })
    expect(parsed?.skipped).toBe(0)
    expect(parsed?.snapshot).toEqual(snapshotOf({ savedAt: 0 }))
  })

  test('piece fields are clamped rather than trusted', () => {
    const parsed = parsePendingSnapshot({
      ...snapshotOf(),
      placed: [
        {
          corners: [1, 2, 3],
          height: -1,
          id: 77,
          mask: 0xffff,
          piece: 'roof',
          position: [1, 2, 3],
          slotId: '',
          yaw: 0,
        },
      ],
    })
    const piece = parsed?.snapshot.placed[0]
    expect(piece?.mask).toBe(FULL_MASK) // masked to nine bits
    expect(piece?.id).toBe(0) // re-minted by the hydrator
    expect(piece?.height).toBeUndefined() // a non-positive storey is no storey
    expect(piece?.corners).toBeUndefined() // a roof has four corners or none
    expect(piece?.slotId).toBeUndefined() // an empty slot id is not a slot
  })

  test('an unfinished stamp still parses, sorting oldest when scopes are capped', () => {
    expect(parsePendingSnapshot({ ...snapshotOf(), savedAt: 'yesterday' })?.snapshot.savedAt).toBe(0)
    expect(parsePendingSnapshot({ ...snapshotOf(), savedAt: Number.NaN })?.snapshot.savedAt).toBe(0)
  })
})

// ── Pruning against the document ────────────────────────────────────────────

describe('prunePendingSnapshot', () => {
  const nodes = { wall_1: {}, wall_2: {} }

  test('a row naming a node that is gone is dropped, and the grant with it', () => {
    const { snapshot, dropped } = prunePendingSnapshot(
      snapshotOf({
        destroyed: [
          { kind: 'wall', nodeId: 'wall_1' },
          { kind: 'wall', nodeId: 'deleted' },
        ],
        items: [aperture({ wallId: 'wall_2' }), aperture({ wallId: 'deleted' })],
        mine: ['wall_1', 'deleted'],
        painted: [
          { cells: 1, color: '#3b4a63', colorName: 'NAVY', nodeId: 'wall_2' },
          { cells: 1, color: '#3b4a63', colorName: 'NAVY', nodeId: 'deleted' },
        ],
      }),
      nodes,
    )
    expect(dropped).toBe(3)
    expect(snapshot.destroyed).toEqual([{ kind: 'wall', nodeId: 'wall_1' }])
    expect(snapshot.painted.map((p) => p.nodeId)).toEqual(['wall_2'])
    expect(snapshot.items.length).toBe(1)
    // The allow-list follows the rows it justifies, or Save keeps a grant for a
    // node nothing is offering to delete.
    expect(snapshot.mine).toEqual(['wall_1'])
  })

  test('pieces and furniture are addressed by POSITION, so they never go stale', () => {
    const built = snapshotOf({
      items: [{ catalogId: 'crate', kind: 'item', position: [0, 0, 0], yaw: 0 }],
      placed: [wall()],
    })
    const { snapshot, dropped } = prunePendingSnapshot(built, {})
    expect(dropped).toBe(0)
    // Same object back when nothing was dropped: no needless copy, and no
    // chance of a silent rewrite.
    expect(snapshot).toBe(built)
  })
})

// ── Storage ─────────────────────────────────────────────────────────────────

describe('readPendingSnapshot / writePendingSnapshot', () => {
  test('a written window comes back', () => {
    const storage = new FakeStorage()
    const snapshot = buildPendingSnapshot(lanes({ placed: [wall()] }), 42)
    expect(writePendingSnapshot(storage, 'project_A', snapshot)).toBe('written')
    expect(readPendingSnapshot(storage, 'project_A')?.snapshot.savedAt).toBe(42)
    expect(readPendingSnapshot(storage, 'project_B')).toBeNull()
  })

  test('a null snapshot clears the key — Save and Discard both end here', () => {
    const storage = new FakeStorage()
    storage.map.set(pendingKey('project_A'), JSON.stringify(snapshotOf()))
    expect(writePendingSnapshot(storage, 'project_A', null)).toBe('cleared')
    expect(storage.map.size).toBe(0)
    expect(forgetPendingSnapshot(storage, 'project_A')).toBe(true)
  })

  test('a truncated key is dropped rather than kept around', () => {
    const storage = new FakeStorage()
    storage.map.set(pendingKey('project_A'), '{"format":1,"placed":[{')
    expect(readPendingSnapshot(storage, 'project_A')).toBeNull()
    expect(storage.map.has(pendingKey('project_A'))).toBe(false)
  })

  test('an oversized window is refused instead of throwing on the way out', () => {
    // A QuotaExceeded at Esc is a worse failure than a window that did not
    // persist: the player is mid-exit and the offer is still on screen.
    const storage = new FakeStorage()
    const huge = snapshotOf({
      placed: Array.from({ length: 4000 }, (_, i) => wall({ position: [i, 0, i], slotId: 'W'.repeat(60) })),
    })
    expect(JSON.stringify(huge).length).toBeGreaterThan(MAX_PENDING_BYTES)
    expect(writePendingSnapshot(storage, 'project_A', huge)).toBe('too-big')
    expect(storage.map.size).toBe(0)
  })

  test('a storage that refuses is reported, never thrown through', () => {
    const storage = new FakeStorage()
    storage.throwsOnWrite = true
    expect(writePendingSnapshot(storage, 'project_A', snapshotOf())).toBe('failed')
    storage.throws = true
    expect(readPendingSnapshot(storage, 'project_A')).toBeNull()
    expect(forgetPendingSnapshot(storage, 'project_A')).toBe(false)
    expect(writePendingSnapshot(storage, 'project_A', null)).toBe('failed')
    expect(capPendingScopes(storage, 1)).toBe(0)
  })
})

describe('capPendingScopes', () => {
  const withScopes = (stamps: Record<string, number | string>): FakeStorage => {
    const storage = new FakeStorage()
    for (const [scope, savedAt] of Object.entries(stamps)) {
      storage.map.set(pendingKey(scope), JSON.stringify({ ...snapshotOf(), savedAt }))
    }
    return storage
  }

  test('the oldest undecided window is the one evicted', () => {
    const storage = withScopes({ new: 300, old: 100, older: 50 })
    expect(capPendingScopes(storage, 2)).toBe(1)
    expect([...storage.map.keys()]).toEqual([pendingKey('new'), pendingKey('old')])
  })

  test('a stamp that cannot be read sorts as oldest — it is also most likely junk', () => {
    const storage = withScopes({ junk: 'not-a-number', real: 1 })
    expect(capPendingScopes(storage, 1)).toBe(1)
    expect([...storage.map.keys()]).toEqual([pendingKey('real')])
  })

  test('other people\'s keys are none of its business', () => {
    const storage = withScopes({ a: 1 })
    storage.map.set('pascal.draft.project_A', 'x')
    storage.map.set('boots.pending.0.legacy', 'x')
    expect(capPendingScopes(storage, 0)).toBe(1)
    expect([...storage.map.keys()]).toEqual(['pascal.draft.project_A', 'boots.pending.0.legacy'])
  })

  test('under the cap it does nothing at all', () => {
    const storage = withScopes({ a: 1, b: 2 })
    expect(capPendingScopes(storage, MAX_PENDING_SCOPES)).toBe(0)
    expect(storage.map.size).toBe(2)
  })

  test('a write caps the scopes as its last act, and keeps the one it just wrote', () => {
    const storage = new FakeStorage()
    for (let i = 0; i < MAX_PENDING_SCOPES; i++) {
      storage.map.set(pendingKey(`old_${i}`), JSON.stringify({ ...snapshotOf(), savedAt: 10 + i }))
    }
    expect(writePendingSnapshot(storage, 'newest', snapshotOf({ savedAt: 9999 }))).toBe('written')
    expect(storage.map.size).toBe(MAX_PENDING_SCOPES)
    expect(storage.map.has(pendingKey('newest'))).toBe(true)
    expect(storage.map.has(pendingKey('old_0'))).toBe(false) // the oldest went
  })
})

describe('browserPendingStorage', () => {
  const globals = globalThis as { localStorage?: unknown }

  test('a browser whose storage throws on access has none, and that is not an error', () => {
    // Safari private mode and storage-disabled webviews throw on ACCESS, which
    // is why the probe is a real read rather than a truthiness check.
    const real = globals.localStorage
    try {
      Object.defineProperty(globals, 'localStorage', {
        configurable: true,
        get() {
          throw new Error('access denied')
        },
      })
      expect(browserPendingStorage()).toBeNull()
      Object.defineProperty(globals, 'localStorage', { configurable: true, value: undefined })
      expect(browserPendingStorage()).toBeNull()
      const fake = new FakeStorage()
      Object.defineProperty(globals, 'localStorage', { configurable: true, value: fake })
      expect(browserPendingStorage()).toBe(fake)
      fake.throws = true
      expect(browserPendingStorage()).toBeNull()
    } finally {
      Object.defineProperty(globals, 'localStorage', { configurable: true, value: real })
    }
  })
})
