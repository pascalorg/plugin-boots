import { FULL_MASK, type BuildPiece, type PlacedPiece } from '../store'
import type { PaintedNode } from './paint-keep'
import type { DestroyedNode } from './save-demolition'

/**
 * The pending window, written down.
 *
 * ── WHAT THIS IS FOR ──────────────────────────────────────────────────────
 * Until now the Save/Discard decision lived entirely in memory: four zustand
 * lanes filled at Esc and read by the sidebar. Close the tab, reload the
 * editor, follow a link back into the project — and a fort you spent an hour
 * on was gone with no decision ever offered. Owner call (2026-08-30): "save
 * the state of builds/textures and destruction even when people are back in
 * the editor, and offer to reset/discard anytime in the sidebar."
 *
 * So the pending window itself becomes durable. Not the scene — the scene is
 * still untouched until the button is pressed, which is the whole promise of
 * docs/SESSION-CHANGES.md. What survives a reload is the OFFER: the pieces you
 * built, the nodes you leveled, the coats you sprayed, the furniture and
 * openings you placed, all still pending, all still one click from being kept
 * or thrown away.
 *
 * ── WHERE IT LIVES ────────────────────────────────────────────────────────
 * `localStorage`, one key per project, under `boots.pending.1.<scope>`.
 * Deliberately NOT the scene, not the host draft, not a server: a pending
 * change is by definition something the document does not know about yet, and
 * a plugin has no business inventing durable state in someone's project. The
 * browser it was played in is exactly the right blast radius.
 *
 * ── THE SCOPE IS MANDATORY ────────────────────────────────────────────────
 * `pendingScopeFrom` returns null when it cannot name the project, and a null
 * scope means NO PERSISTENCE AT ALL (in-page behaviour, exactly as before).
 * There is no shared fallback key on purpose: two projects sharing one key
 * would hand a fort built in one building to another building, and offer node
 * ids from one document for deletion in the next. Losing a pending window is
 * recoverable; mixing two buildings is not.
 *
 * ── WHAT IS NOT PERSISTED ─────────────────────────────────────────────────
 *  - Per-voxel damage. A half-carved wall has no faithful representation (the
 *    demolition lane is strict: fully leveled nodes only), and it never
 *    survived a re-entry either — the destruction runtime is rebuilt from the
 *    restored scene on every Jump in.
 *  - Anything mid-session. Writes happen at Esc and at the decision, never
 *    during play, so a crash mid-firefight costs the session, as it always
 *    did. "Nothing is saved while you play" stays literally true.
 *  - Peer identity. See the identity fence in shared-world.ts: the shared
 *    model takes its name from the transport and never from storage. Nothing
 *    here is a peer id, and nothing here reaches the shared model's authorship
 *    path — restored pieces are republished under the CURRENT session's id by
 *    the ordinary reconcile, as any locally-placed piece is.
 *
 * ── ON THE DEMOLITION ALLOW-LIST ──────────────────────────────────────────
 * `mine` is the list `deleteDestroyed` re-checks before it deletes a real
 * node, and it is persisted with the rest. That is safe for the reason the
 * wire version is not: a node only ever ENTERS `mine` through the ownership
 * gate in save-demolition.ts (`fullyMine`, a count match against the grid),
 * and this file merely writes down what that gate already granted, in
 * same-origin storage, in the player's own browser. It is not a claim
 * arriving from a peer.
 *
 * Everything below is pure — snapshot in, snapshot out, storage handle passed
 * in — so the whole format is testable without a browser. The lane reads and
 * writes live in pending-lanes.ts; this file never imports a store.
 */

/** Bump when the shape changes; a snapshot from another format is dropped. */
export const PENDING_FORMAT = 1

export const PENDING_KEY_PREFIX = `boots.pending.${PENDING_FORMAT}.`

/**
 * How many projects keep a pending window. Someone who plays in a dozen
 * buildings should not accumulate a dozen forever-keys, and the oldest
 * undecided session is the one least likely to still be wanted.
 */
export const MAX_PENDING_SCOPES = 8

/**
 * Refuse to write a snapshot bigger than this. localStorage quotas are small
 * and shared with the host app, and a write that throws QuotaExceeded on the
 * way out of a session is a worse failure than a pending window that did not
 * persist. A fort of ~2000 pieces serializes well under it.
 */
export const MAX_PENDING_BYTES = 512 * 1024

/** Hard caps per lane, so a corrupt or hostile key cannot flood the runtime. */
export const MAX_PENDING_PIECES = 4000
export const MAX_PENDING_ITEMS = 1000
export const MAX_PENDING_NODES = 4000

/**
 * A placement, by catalog id — the same trick the shared lane uses (ItemRec /
 * ApertureRec): the catalog is bundled with the plugin, so storing a row's id
 * instead of the row itself keeps the key small and cannot go stale against a
 * later catalog. A row that no longer exists simply does not come back, and
 * the restore says how many it dropped.
 */
export type PersistedPlacement =
  | {
      kind: 'item'
      catalogId: string
      position: [number, number, number]
      yaw: number
    }
  | {
      kind: 'aperture'
      catalogId: string
      wallId: string
      u: number
      v: number
      width: number
      height: number
    }

/** The four lanes, ours only, as the panel's Save would write them. */
export type PendingLanes = {
  placed: readonly PlacedPiece[]
  destroyed: readonly DestroyedNode[]
  mine: readonly string[]
  painted: readonly PaintedNode[]
  items: readonly PersistedPlacement[]
}

export type PendingSnapshot = {
  format: number
  /** Epoch ms — only used to decide which scope to evict first. */
  savedAt: number
  placed: PlacedPiece[]
  destroyed: DestroyedNode[]
  mine: string[]
  painted: PaintedNode[]
  items: PersistedPlacement[]
}

/** What `parsePendingSnapshot` gives back: the good rows, and how many it
 * refused. The count is surfaced rather than swallowed — a snapshot that
 * quietly lost half a fort would read as "nothing was pending". */
export type PendingParse = {
  snapshot: PendingSnapshot
  skipped: number
}

/** The slice of `Storage` this module uses. `localStorage` satisfies it, and a
 * plain object satisfies it in tests. */
export type PendingStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  key(index: number): string | null
  readonly length: number
}

/** Project ids and scene ids, and nothing that could escape a storage key. */
const SCOPE_TOKEN = /^[A-Za-z0-9_-]{1,120}$/

/** `/editor/<id>`, `/play/<id>`, `/scene/<id>` — the three routes a Boots
 * session can run on. Query and hash are excluded, so `?boots=drop` (the
 * lobby drop link) resolves to the same scope as a plain editor visit. */
const SCOPE_PATH = /\/(?:editor|play|scene)\/([A-Za-z0-9_-]{1,120})(?:[/?#]|$)/

const PIECE_KINDS = new Set<string>(['wall', 'floor', 'stairs', 'roof'])

/**
 * Which project is this? THE ROUTE FIRST; the collaboration bus only when the
 * page has no project route at all. Null means "cannot tell" — and null
 * disables persistence entirely (see the header).
 *
 * The route used to be the fallback and the bus the authority ("it knows for
 * certain"). It does — about the project it was installed for. But the bus is
 * a page global installed asynchronously after realtime auth, and the prod
 * editor switches projects with a CLIENT-SIDE navigation: for as long as the
 * old bus lingers (or forever, if the new one never installs) a bus-first
 * scope names the project you just LEFT, and its pending fort is restored into
 * the one you opened (owner P0, 2026-09-02). The URL changes on the first
 * frame of a navigation and never lags, so it is the identity; on every Boots
 * route the two name the same project anyway.
 */
export function pendingScopeFrom(input: {
  projectId?: unknown
  path?: string | null
}): string | null {
  if (typeof input.path === 'string') {
    const match = SCOPE_PATH.exec(input.path)
    if (match) return match[1] as string
  }
  if (typeof input.projectId === 'string' && SCOPE_TOKEN.test(input.projectId)) {
    return input.projectId
  }
  return null
}

export function pendingKey(scope: string): string {
  return `${PENDING_KEY_PREFIX}${scope}`
}

/** True when there is nothing to decide — the panel's own gate, and the
 * condition under which the key is REMOVED rather than written. */
export function isEmptyPending(lanes: PendingLanes): boolean {
  return (
    lanes.placed.length === 0 &&
    lanes.destroyed.length === 0 &&
    lanes.painted.length === 0 &&
    lanes.items.length === 0
  )
}

/** Snapshot the lanes, or null when nothing is pending. */
export function buildPendingSnapshot(lanes: PendingLanes, savedAt: number): PendingSnapshot | null {
  if (isEmptyPending(lanes)) return null
  return {
    format: PENDING_FORMAT,
    savedAt,
    placed: lanes.placed.map(copyPiece),
    destroyed: lanes.destroyed.map((node) => ({ nodeId: node.nodeId, kind: node.kind })),
    // The allow-list is narrowed to what is actually pending: a grant with no
    // row left to justify it has nothing to authorize.
    mine: [...new Set(lanes.mine)].filter((nodeId) =>
      lanes.destroyed.some((node) => node.nodeId === nodeId),
    ),
    painted: lanes.painted.map((node) => ({
      nodeId: node.nodeId,
      color: node.color,
      colorName: node.colorName,
      cells: node.cells,
    })),
    items: lanes.items.map(copyPlacement),
  }
}

/**
 * Read a snapshot back, refusing anything that does not fit the shape.
 *
 * Strictness is not paranoia about hostile keys (same-origin storage is not a
 * threat surface the plugin can defend anyway) — it is about a stale or
 * half-written key reaching the RENDERER. A piece with a missing `position`
 * would throw inside the R3F tree, in the editor, on a project that has
 * nothing to do with Boots. So every field is checked and every bad row is
 * dropped and counted.
 *
 * Piece ids are deliberately NOT trusted: they are per-page-load runtime
 * counters (store.ts) that also key colliders and shared records, so the
 * hydrator re-mints them through `addPlaced`.
 */
export function parsePendingSnapshot(raw: unknown): PendingParse | null {
  if (!isRecord(raw)) return null
  if (raw.format !== PENDING_FORMAT) return null
  let skipped = 0
  const count = (kept: unknown): boolean => {
    if (kept === null) skipped++
    return kept !== null
  }

  const placed: PlacedPiece[] = []
  for (const row of takeArray(raw.placed, MAX_PENDING_PIECES)) {
    const piece = parsePiece(row)
    if (count(piece) && piece) placed.push(piece)
  }
  const destroyed: DestroyedNode[] = []
  for (const row of takeArray(raw.destroyed, MAX_PENDING_NODES)) {
    const node = parseDestroyed(row)
    if (count(node) && node) destroyed.push(node)
  }
  const painted: PaintedNode[] = []
  for (const row of takeArray(raw.painted, MAX_PENDING_NODES)) {
    const node = parsePainted(row)
    if (count(node) && node) painted.push(node)
  }
  const items: PersistedPlacement[] = []
  for (const row of takeArray(raw.items, MAX_PENDING_ITEMS)) {
    const placement = parsePlacement(row)
    if (count(placement) && placement) items.push(placement)
  }
  const mine = takeArray(raw.mine, MAX_PENDING_NODES).filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  )
  // ROWS PAST A LANE CAP ARE DROPPED, SO THEY ARE COUNTED. The caller prints
  // `skipped`; a cap that truncated in silence would read back as a smaller
  // fort with nothing to explain it, which is the one thing this module
  // promises not to do (docs/SESSION-CHANGES.md: pruning is reported, never
  // silent). `mine` counts too — an allow-list quietly cut short is a Save
  // that refuses to delete what it offered.
  skipped +=
    overflow(raw.placed, MAX_PENDING_PIECES) +
    overflow(raw.destroyed, MAX_PENDING_NODES) +
    overflow(raw.painted, MAX_PENDING_NODES) +
    overflow(raw.items, MAX_PENDING_ITEMS) +
    overflow(raw.mine, MAX_PENDING_NODES)

  return {
    skipped,
    snapshot: {
      destroyed,
      format: PENDING_FORMAT,
      items,
      mine,
      painted,
      placed,
      savedAt: typeof raw.savedAt === 'number' && Number.isFinite(raw.savedAt) ? raw.savedAt : 0,
    },
  }
}

/**
 * Drop rows whose host node is gone.
 *
 * The three node-addressed lanes (leveled, painted, and wall-hosted openings)
 * name scene nodes that were there when the session ended. Delete that wall in
 * the editor, or open an older version of the building, and the row is an
 * offer to change something that no longer exists — Save would no-op on it and
 * the sidebar would keep printing "already gone" forever.
 *
 * Pieces and furniture are addressed by POSITION, not by node, so they are
 * never stale and are never pruned.
 *
 * CALL ONLY WITH A LOADED SCENE. An empty node map means "the document has not
 * arrived yet", not "every node was deleted", and pruning against it would
 * throw away the whole pending window. The caller checks.
 */
export function prunePendingSnapshot(
  snapshot: PendingSnapshot,
  nodes: Readonly<Record<string, unknown>>,
): { snapshot: PendingSnapshot; dropped: number } {
  const alive = (nodeId: string): boolean => nodes[nodeId] !== undefined
  const destroyed = snapshot.destroyed.filter((node) => alive(node.nodeId))
  const painted = snapshot.painted.filter((node) => alive(node.nodeId))
  const items = snapshot.items.filter(
    (item) => item.kind === 'item' || alive(item.wallId),
  )
  const dropped =
    snapshot.destroyed.length -
    destroyed.length +
    (snapshot.painted.length - painted.length) +
    (snapshot.items.length - items.length)
  if (dropped === 0) return { dropped: 0, snapshot }
  const keptNodes = new Set(destroyed.map((node) => node.nodeId))
  return {
    dropped,
    snapshot: {
      ...snapshot,
      destroyed,
      items,
      mine: snapshot.mine.filter((nodeId) => keptNodes.has(nodeId)),
      painted,
    },
  }
}

export function readPendingSnapshot(storage: PendingStorage, scope: string): PendingParse | null {
  let raw: string | null
  try {
    raw = storage.getItem(pendingKey(scope))
  } catch {
    return null
  }
  if (!raw) return null
  try {
    return parsePendingSnapshot(JSON.parse(raw))
  } catch {
    // A truncated or non-JSON key is not worth keeping around.
    forgetPendingSnapshot(storage, scope)
    return null
  }
}

/**
 * Write the snapshot, or remove the key when there is nothing pending.
 * Returns what it did, so a caller can report it; never throws.
 */
export function writePendingSnapshot(
  storage: PendingStorage,
  scope: string,
  snapshot: PendingSnapshot | null,
): 'written' | 'cleared' | 'too-big' | 'failed' {
  if (snapshot === null) {
    return forgetPendingSnapshot(storage, scope) ? 'cleared' : 'failed'
  }
  let payload: string
  try {
    payload = JSON.stringify(snapshot)
  } catch {
    return 'failed'
  }
  if (payload.length > MAX_PENDING_BYTES) return 'too-big'
  try {
    storage.setItem(pendingKey(scope), payload)
  } catch {
    return 'failed'
  }
  capPendingScopes(storage, MAX_PENDING_SCOPES)
  return 'written'
}

export function forgetPendingSnapshot(storage: PendingStorage, scope: string): boolean {
  try {
    storage.removeItem(pendingKey(scope))
    return true
  } catch {
    return false
  }
}

/**
 * Keep at most `keep` pending windows, evicting the oldest by `savedAt`.
 *
 * `savedAt` is picked out with a regex rather than a parse: the whole point of
 * this pass is to avoid deserializing several hundred kilobytes of other
 * projects' forts just to compare two numbers. A key whose stamp cannot be
 * read sorts as oldest, which is the right direction — it is also the shape
 * most likely to be junk.
 */
export function capPendingScopes(storage: PendingStorage, keep: number): number {
  const found: { key: string; savedAt: number }[] = []
  try {
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index)
      if (!key?.startsWith(PENDING_KEY_PREFIX)) continue
      const stamp = /"savedAt":\s*(\d+)/.exec(storage.getItem(key) ?? '')
      found.push({ key, savedAt: stamp ? Number(stamp[1]) : 0 })
    }
  } catch {
    return 0
  }
  if (found.length <= keep) return 0
  found.sort((a, b) => b.savedAt - a.savedAt)
  let evicted = 0
  for (const stale of found.slice(keep)) {
    try {
      storage.removeItem(stale.key)
      evicted++
    } catch {
      // Nothing to do about a storage that refuses to delete.
    }
  }
  return evicted
}

/** `localStorage`, when this browser has one that works. Safari in private
 * mode and an embedded webview with storage disabled both throw on ACCESS,
 * not on use, so the probe is a real read. */
export function browserPendingStorage(): PendingStorage | null {
  try {
    const storage = (globalThis as { localStorage?: PendingStorage }).localStorage
    if (!storage) return null
    storage.getItem(`${PENDING_KEY_PREFIX}probe`)
    return storage
  } catch {
    return null
  }
}

/** The current project, from the URL if it names one, else the collab bus. */
export function currentPendingScope(): string | null {
  const bus = (globalThis as { __pascalCollabBus?: { projectId?: unknown } }).__pascalCollabBus
  const path = (globalThis as { location?: { pathname?: string } }).location?.pathname ?? null
  return pendingScopeFrom({ path, projectId: bus?.projectId })
}

// ── row-level parsing ───────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNum(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isVec3(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every(isNum)
}

function isText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

function takeArray(value: unknown, cap: number): unknown[] {
  return Array.isArray(value) ? value.slice(0, cap) : []
}

/** How many rows `takeArray` left behind. A non-array lane is not truncation —
 * it is a missing lane, which parses as empty and is not a loss to report. */
function overflow(value: unknown, cap: number): number {
  return Array.isArray(value) ? Math.max(0, value.length - cap) : 0
}

function copyPiece(piece: PlacedPiece): PlacedPiece {
  const copy: PlacedPiece = {
    id: piece.id,
    mask: piece.mask,
    piece: piece.piece,
    position: [piece.position[0], piece.position[1], piece.position[2]],
    yaw: piece.yaw,
  }
  if (piece.slotId !== undefined) copy.slotId = piece.slotId
  if (piece.corners !== undefined) copy.corners = [...piece.corners]
  if (piece.height !== undefined) copy.height = piece.height
  return copy
}

function copyPlacement(placement: PersistedPlacement): PersistedPlacement {
  return placement.kind === 'item'
    ? {
        catalogId: placement.catalogId,
        kind: 'item',
        position: [placement.position[0], placement.position[1], placement.position[2]],
        yaw: placement.yaw,
      }
    : { ...placement }
}

function parsePiece(raw: unknown): PlacedPiece | null {
  if (!isRecord(raw)) return null
  if (typeof raw.piece !== 'string' || !PIECE_KINDS.has(raw.piece)) return null
  if (!isVec3(raw.position) || !isNum(raw.yaw)) return null
  const piece: PlacedPiece = {
    // Re-minted by the hydrator; a stored runtime id means nothing here.
    id: 0,
    mask: Number.isInteger(raw.mask) ? (raw.mask as number) & FULL_MASK : FULL_MASK,
    piece: raw.piece as BuildPiece,
    position: [raw.position[0], raw.position[1], raw.position[2]],
    yaw: raw.yaw,
  }
  if (isText(raw.slotId, 64)) piece.slotId = raw.slotId
  const corners = raw.corners
  if (Array.isArray(corners) && corners.length === 4 && corners.every(isNum)) {
    const [a, b, c, d] = corners as number[]
    piece.corners = [a as number, b as number, c as number, d as number]
  }
  if (isNum(raw.height) && raw.height > 0) piece.height = raw.height
  return piece
}

function parseDestroyed(raw: unknown): DestroyedNode | null {
  if (!isRecord(raw)) return null
  if (!isText(raw.nodeId, 200)) return null
  if (raw.kind !== 'wall' && raw.kind !== 'volume') return null
  return { kind: raw.kind, nodeId: raw.nodeId }
}

function parsePainted(raw: unknown): PaintedNode | null {
  if (!isRecord(raw)) return null
  if (!isText(raw.nodeId, 200)) return null
  // A hex is what the material patch and the sidebar swatch both expect.
  if (typeof raw.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(raw.color)) return null
  if (!isText(raw.colorName, 40)) return null
  return {
    cells: isNum(raw.cells) && raw.cells >= 0 ? Math.floor(raw.cells) : 0,
    color: raw.color,
    colorName: raw.colorName,
    nodeId: raw.nodeId,
  }
}

function parsePlacement(raw: unknown): PersistedPlacement | null {
  if (!isRecord(raw)) return null
  if (!isText(raw.catalogId, 200)) return null
  if (raw.kind === 'item') {
    if (!isVec3(raw.position) || !isNum(raw.yaw)) return null
    return {
      catalogId: raw.catalogId,
      kind: 'item',
      position: [raw.position[0], raw.position[1], raw.position[2]],
      yaw: raw.yaw,
    }
  }
  if (raw.kind !== 'aperture') return null
  if (!isText(raw.wallId, 200)) return null
  if (!isNum(raw.u) || !isNum(raw.v)) return null
  if (!isNum(raw.width) || raw.width <= 0 || !isNum(raw.height) || raw.height <= 0) return null
  return {
    catalogId: raw.catalogId,
    height: raw.height,
    kind: 'aperture',
    u: raw.u,
    v: raw.v,
    wallId: raw.wallId,
    width: raw.width,
  }
}
