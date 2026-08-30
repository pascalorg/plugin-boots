/**
 * BOOTS NET — the generic plugin-to-plugin frame transport.
 *
 * This is the ONLY module that talks to the host's collaboration bus
 * (`globalThis.__pascalCollabBus`, host PR #446, gated host-side behind
 * `NEXT_PUBLIC_PLUGIN_COLLAB`). It knows nothing about poses, destruction or
 * builds: it moves bounded, validated, ordered frames of ANY registered
 * `kind` and leaves every semantic decision to that kind's owner.
 *
 *   presence.ts        → kind 'pose'              (avatar co-presence)
 *   shared-world.ts    → kind 'boots/world'       (SharedDelta, lattice join)
 *   shared-world.ts    → kind 'boots/world-snap'  (SharedDelta kind 'snapshot')
 *   any state owner    → 'state-request' / 'state-snapshot' (late join)
 *
 * FEATURE-DETECTED END TO END: with no bus (solo app, older hosts, :3002, or
 * the host flag off) every function here is a no-op and returns
 * 'unavailable'. Nothing is scheduled, nothing is allocated, no handler is
 * ever called. That is the flag-off guarantee the whole feature rests on.
 *
 * ── The envelope ────────────────────────────────────────────────────────────
 * Every Boots frame on the wire is `{ v, kind, seq, data, part?, parts? }`.
 * One host event per kind (see WHY below), so the host's own per-(pluginId,
 * event) coalescing never lets one kind eat another's frames.
 *
 * ── The sender is HOST-STAMPED, never payload-supplied ──────────────────────
 * `NetMessage.sessionId` / `.clientId` / `.userId` are copied from the host's
 * own bus envelope, which the host fills in from the connection. They are the
 * ONLY trustworthy identity on an inbound frame. A payload field claiming
 * authorship (`delta.from`, and anything like it) is attacker-controlled and
 * must be overwritten with `msg.sessionId` before use — that is what makes
 * shared-world's authorship gate mean anything.
 *
 * ── Sequence semantics ──────────────────────────────────────────────────────
 * Outbound: one monotonic counter per kind, starting at 1, per session.
 * Inbound, ORDERED kinds (the default): the newest accepted seq is remembered
 * per (senderSession, kind); anything at or below it is a duplicate/reorder
 * and is DROPPED. Register with `{ ordered: false }` for a CONVERGENT kind —
 * one whose merge is a lattice join, where a duplicate is a no-op and a
 * reordered frame still carries information that would otherwise be thrown
 * away. Either way, delivered messages carry `skipped` — how many sequence
 * numbers went missing before this frame (0 = contiguous). Poses ignore it; a
 * state-carrying kind should treat `skipped > 0` as "I lost frames, expect a
 * snapshot to heal it".
 *
 * ── Bounds (the trust boundary) ─────────────────────────────────────────────
 * The host rejects any plugin frame over PLUGIN_FRAME_MAX_SERIALIZED_LENGTH
 * (8 000 chars serialized). We refuse oversize frames BEFORE publishing
 * ('too-large') instead of letting the host drop them silently. Inbound,
 * `readEnvelope` validates the envelope and the registered per-kind
 * validator normalizes the payload; anything unexpected is dropped without a
 * handler call. A frame from a stranger can therefore only ever become a
 * value the receiving subsystem asked for.
 *
 * The host cap is 8 000 SERIALIZED CHARS, not a megabyte. The bus is a
 * JSON channel: `publish` hands `data` to the host, which measures
 * `JSON.stringify(data).length`. Binary payloads must therefore travel as
 * text (base64, ×1.333) — a Uint8Array would serialize to `{"0":…,"1":…}` and
 * blow the budget on a few hundred bytes. Anything past
 * MAX_PAYLOAD_SERIALIZED must be chunked with `{part, parts}`.
 */

// ── Host bus interface (shipped by the host separately — PR #446) ────────────

export type CollabParticipant = {
  userId: string
  name: string
  sessions: Array<{ sessionId: string; clientId: string }>
}

export type CollabBusMessage = {
  event: string
  data: unknown
  sessionId: string
  clientId: string
  userId: string
  sentAt: number
}

export type CollabBus = {
  version: number
  projectId: string
  sessionId: string
  clientId: string
  userId: string
  publish(pluginId: string, event: string, data: unknown): 'sent' | 'deferred' | 'suppressed'
  subscribe(pluginId: string, handler: (msg: CollabBusMessage) => void): () => void
  getParticipants(): CollabParticipant[]
  onParticipants(handler: (participants: CollabParticipant[]) => void): () => void
}

export const PLUGIN_ID = 'pascal:boots'

/** Feature detection — protocol v1 only; anything else reads as "no bus". */
export function getCollabBus(): CollabBus | null {
  const bus = (globalThis as { __pascalCollabBus?: CollabBus }).__pascalCollabBus
  return bus && bus.version === 1 ? bus : null
}

// ── Frame kinds ──────────────────────────────────────────────────────────────

/**
 * Every kind of frame Boots can put on the wire. ADDING A KIND is additive
 * and safe: older clients drop unknown kinds at readEnvelope, so a peer
 * running last week's pin simply ignores what it cannot understand.
 *
 * WHY one host event per kind: the host coalesces to the LATEST value per
 * (pluginId, event) every 66 ms. Sharing one event would let a 12 Hz pose
 * stream silently swallow a world frame. Per-kind events mean each stream
 * only ever coalesces against itself.
 *
 * That is also why deltas and snapshots of the SAME state get two kinds:
 * `'boots/world'` for the incremental stream and `'boots/world-snap'` for the
 * periodic/on-join full state. Sharing one event would let a 5 kB snapshot
 * coalesce away the shot that happened 20 ms later — a loss the lattice can
 * only heal on the NEXT snapshot. Two events, two independent 66 ms slots.
 */
export const FRAME_KINDS = [
  'pose',
  'boots/world',
  'boots/world-snap',
  'state-request',
  'state-snapshot',
] as const
export type BootsFrameKind = (typeof FRAME_KINDS)[number]

const KIND_SET: ReadonlySet<string> = new Set(FRAME_KINDS)

export function isFrameKind(value: unknown): value is BootsFrameKind {
  return typeof value === 'string' && KIND_SET.has(value)
}

/** Boots wire protocol version — bumped only on a BREAKING envelope change. */
export const NET_PROTOCOL = 1

/** The on-the-wire envelope. `data` is the kind owner's payload. */
export type BootsEnvelope = {
  v: typeof NET_PROTOCOL
  kind: BootsFrameKind
  seq: number
  /** Multi-part payloads (1-based). Absent = a whole frame (part 1 of 1). */
  part?: number
  parts?: number
  data: unknown
}

/** What a `kind` handler receives — payload already validated + normalized. */
export type NetMessage<P = unknown> = {
  kind: BootsFrameKind
  data: P
  seq: number
  /** Sequence numbers missing before this frame (0 = nothing lost). */
  skipped: number
  part: number
  parts: number
  sessionId: string
  clientId: string
  userId: string
  /** Sender's clock (the host envelope's stamp) — interpolation basis. */
  sentAt: number
}

/** A kind's payload validator: return a NORMALIZED copy, or null to drop.
 * This is the per-kind half of the trust boundary — own it properly. */
export type FrameValidator<P = unknown> = (data: unknown) => P | null

export type PublishResult =
  | 'sent'
  | 'deferred'
  | 'suppressed'
  /** No bus: the host flag is off or this host predates the bus. */
  | 'unavailable'
  /** Refused locally — serialized payload over the host's hard cap. */
  | 'too-large'
  /** No validator registered for this kind (a wiring bug, never silent). */
  | 'unregistered'

// ── Bounds ───────────────────────────────────────────────────────────────────

/** The host's hard per-frame cap (PLUGIN_FRAME_MAX_SERIALIZED_LENGTH). */
export const MAX_FRAME_SERIALIZED = 8000
/** Envelope overhead reserve — the budget a payload may actually use. */
export const MAX_PAYLOAD_SERIALIZED = MAX_FRAME_SERIALIZED - 120
/** Inbound (senderSession, kind) sequence trackers kept before recycling —
 * bounds memory against a flood of fabricated session ids. */
export const SEQ_TRACK_MAX = 256

/** Does this payload fit the wire? Chunk it yourself if not (see requestState
 * docs — reassembly is the state owner's job, the transport only orders). */
export function payloadFits(data: unknown): boolean {
  return serializedLength(data) <= MAX_PAYLOAD_SERIALIZED
}

export function serializedLength(data: unknown): number {
  try {
    return JSON.stringify(data)?.length ?? 0
  } catch {
    return Number.POSITIVE_INFINITY // cyclic / unserializable
  }
}

// ── Envelope validation (inbound trust boundary) ─────────────────────────────

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isSeq = (v: unknown): v is number =>
  isFiniteNumber(v) && Number.isInteger(v) && v >= 1 && v <= Number.MAX_SAFE_INTEGER

/**
 * Validate the envelope ONLY (the payload is the kind validator's problem).
 * Total: any throw while reading a hostile object reads as invalid.
 */
export function readEnvelope(data: unknown): BootsEnvelope | null {
  try {
    if (typeof data !== 'object' || data === null) return null
    const f = data as Record<string, unknown>
    if (f.v !== NET_PROTOCOL) return null
    if (!isFrameKind(f.kind)) return null
    if (!isSeq(f.seq)) return null
    let part = 1
    let parts = 1
    if (f.parts !== undefined || f.part !== undefined) {
      if (!isSeq(f.part) || !isSeq(f.parts)) return null
      if (f.part > f.parts || f.parts > 1024) return null
      part = f.part
      parts = f.parts
    }
    if (!('data' in f)) return null
    return { v: NET_PROTOCOL, kind: f.kind, seq: f.seq, part, parts, data: f.data }
  } catch {
    return null
  }
}

// ── Module state ─────────────────────────────────────────────────────────────

type KindEntry = {
  validate: FrameValidator
  handlers: Set<(msg: NetMessage) => void>
  /** false = convergent kind: duplicates and reorders are DELIVERED. */
  ordered: boolean
}

/** Per-kind delivery policy — see registerFrameKind. */
export type FrameKindOptions = {
  /**
   * Drop frames whose seq is at or below the newest already accepted from
   * that sender (default true — right for a stream of poses, where an old
   * frame is strictly worse than the one you already drew).
   *
   * Set false when the kind's merge is a LATTICE JOIN: idempotent,
   * commutative, associative. Then a duplicate costs one no-op merge and a
   * reordered frame still carries records you would otherwise have thrown
   * away, so ordering is not a service worth paying for. `skipped` is still
   * reported off the highest seq seen.
   */
  ordered?: boolean
}

type NetState = {
  active: boolean
  bus: CollabBus | null
  unsubscribe: (() => void) | null
  kinds: Map<BootsFrameKind, KindEntry>
  /** Outbound per-kind counters. */
  outSeq: Map<BootsFrameKind, number>
  /** Inbound newest-accepted seq, keyed `sessionId|kind` (insertion-ordered
   * so recycling the oldest is a Map.keys() step). */
  inSeq: Map<string, number>
  published: number
  received: number
  dropped: number
}

const state: NetState = {
  active: false,
  bus: null,
  unsubscribe: null,
  kinds: new Map(),
  outSeq: new Map(),
  inSeq: new Map(),
  published: 0,
  received: 0,
  dropped: 0,
}

// ── Registration + subscription ──────────────────────────────────────────────

/**
 * Declare a kind and how to validate its payload. Registering twice replaces
 * the validator and the policy (dev hot-reload). A kind with no validator is
 * never delivered — that is deliberate: an unvalidated payload must not exist.
 */
export function registerFrameKind<P>(
  kind: BootsFrameKind,
  validate: FrameValidator<P>,
  options?: FrameKindOptions,
): void {
  const ordered = options?.ordered ?? true
  const entry = state.kinds.get(kind)
  if (entry) {
    entry.validate = validate as FrameValidator
    entry.ordered = ordered
    return
  }
  state.kinds.set(kind, { validate: validate as FrameValidator, handlers: new Set(), ordered })
}

/** Subscribe to a kind. Returns the unsubscribe. Safe before startNet(). */
export function onFrame<P>(kind: BootsFrameKind, handler: (msg: NetMessage<P>) => void): () => void {
  let entry = state.kinds.get(kind)
  if (!entry) {
    // Handler before validator: hold the slot, stay undeliverable until a
    // validator lands (never deliver an unvalidated payload).
    entry = { validate: () => null, handlers: new Set(), ordered: true }
    state.kinds.set(kind, entry)
  }
  const typed = handler as (msg: NetMessage) => void
  entry.handlers.add(typed)
  return () => {
    entry?.handlers.delete(typed)
  }
}

// ── Publish ──────────────────────────────────────────────────────────────────

/**
 * Publish one frame of `kind`. Stamps the next per-kind sequence number.
 * Returns the host's verdict, or a local refusal:
 * - 'deferred'/'suppressed' come from the host's coalescing/rate limiting.
 *   THEY MEAN THE FRAME IS GONE. For a latest-value-correct kind (poses,
 *   cumulative grow-only sets) just send again next tick; for anything
 *   delta-shaped you MUST re-send or fall back to a snapshot.
 * - 'too-large' is refused here, never truncated.
 */
export function publishFrame(
  kind: BootsFrameKind,
  data: unknown,
  options?: { part?: number; parts?: number },
): PublishResult {
  const bus = state.active ? state.bus : null
  if (!bus) return 'unavailable'
  if (!state.kinds.has(kind)) return 'unregistered'
  if (!payloadFits(data)) return 'too-large'
  const seq = (state.outSeq.get(kind) ?? 0) + 1
  const envelope: BootsEnvelope = { v: NET_PROTOCOL, kind, seq, data }
  if (options?.parts !== undefined && options.parts > 1) {
    envelope.part = options.part ?? 1
    envelope.parts = options.parts
  }
  let result: PublishResult
  try {
    result = bus.publish(PLUGIN_ID, kind, envelope)
  } catch {
    return 'unavailable' // a tearing-down bus never breaks a caller
  }
  // The counter advances on every ATTEMPT, so a receiver's `skipped` reflects
  // real loss (coalesced frames included) instead of reading as contiguous.
  state.outSeq.set(kind, seq)
  if (result === 'sent') state.published++
  return result
}

// ── Inbound dispatch ─────────────────────────────────────────────────────────

function seqKey(sessionId: string, kind: BootsFrameKind): string {
  return `${sessionId}|${kind}`
}

/** Recycle the oldest tracker once the map is full (bounded memory). */
function trackSeq(key: string, seq: number): void {
  if (!state.inSeq.has(key) && state.inSeq.size >= SEQ_TRACK_MAX) {
    const oldest = state.inSeq.keys().next()
    if (!oldest.done) state.inSeq.delete(oldest.value)
  }
  state.inSeq.set(key, seq)
}

/**
 * Ingest one host bus message (exported for tests; the subscription calls it).
 * Drops: self-echo, unknown kinds, bad envelopes, unregistered kinds,
 * payloads their validator rejects, and — for ORDERED kinds only —
 * duplicates and reorders.
 */
export function ingestBusMessage(msg: CollabBusMessage): void {
  if (!state.active || !state.bus) return
  if (msg.sessionId === state.bus.sessionId) return // self-echo
  if (!isFiniteNumber(msg.sentAt)) return
  const envelope = readEnvelope(msg.data)
  if (!envelope) {
    state.dropped++
    return
  }
  // The host event should equal the kind; a mismatch is a spoof attempt.
  if (msg.event !== envelope.kind) {
    state.dropped++
    return
  }
  const entry = state.kinds.get(envelope.kind)
  if (!entry || entry.handlers.size === 0) return
  const payload = entry.validate(envelope.data)
  if (payload === null || payload === undefined) {
    state.dropped++
    return
  }
  const key = seqKey(msg.sessionId, envelope.kind)
  const last = state.inSeq.get(key)
  if (entry.ordered && last !== undefined && envelope.seq <= last) {
    state.dropped++ // duplicate or reorder — an ordered stream never rewinds
    return
  }
  // `skipped` is measured off the HIGHEST seq seen either way, so a convergent
  // kind still learns that frames went missing (its cue to expect a snapshot).
  const skipped = last === undefined ? 0 : Math.max(0, envelope.seq - last - 1)
  trackSeq(key, last === undefined ? envelope.seq : Math.max(last, envelope.seq))
  state.received++
  const delivered: NetMessage = {
    kind: envelope.kind,
    data: payload,
    seq: envelope.seq,
    skipped,
    part: envelope.part ?? 1,
    parts: envelope.parts ?? 1,
    sessionId: msg.sessionId,
    clientId: msg.clientId,
    userId: msg.userId,
    sentAt: msg.sentAt,
  }
  for (const handler of entry.handlers) {
    try {
      handler(delivered)
    } catch {
      // One subsystem's bug never costs another its frames.
    }
  }
}

/** Forget a departed sender's sequence trackers (call on leave). */
export function forgetSender(sessionId: string): void {
  for (const kind of FRAME_KINDS) state.inSeq.delete(seqKey(sessionId, kind))
}

// ── Late join ────────────────────────────────────────────────────────────────

/**
 * LATE-JOIN HOOK. Poses do not need it (the next tick fixes everything), but
 * accumulated state does: a visitor who walks into a lobby whose walls are
 * already half gone must be told what happened before they arrived.
 *
 * The shape, deliberately minimal and owner-driven:
 *  1. joiner calls `requestState('boots/world')`;
 *  2. every peer's `onStateRequest` fires;
 *  3. each answerer calls `sendStateSnapshot('boots/world', requester,
 *     state)`, chunking with `{part, parts}` if it exceeds
 *     MAX_PAYLOAD_SERIALIZED;
 *  4. the joiner's `onStateSnapshot('boots/world')` merges, ignoring
 *     snapshots addressed to somebody else.
 *
 * WHO ANSWERS — two strategies, and the state owner must pick deliberately:
 *
 *  - EVERY PEER ANSWERS WITH ITS OWN RECORDS. Correct whenever the receiver
 *    gates records by author, because a snapshot that aggregates several
 *    peers' records cannot pass a per-frame authorship check: only the
 *    sender's own records would survive it anyway. N answers for N peers,
 *    bounded by the roster, each independently attributable. THIS IS WHAT
 *    shared-world.ts USES — see MULTIPLAYER.md.
 *  - ONE PEER ANSWERS FOR THE ROOM (`shouldAnswerStateRequest`, below).
 *    Cheaper, but the answer is an aggregate, so it is only sound where the
 *    transport VOUCHES for the relay (a server-mediated or otherwise trusted
 *    aggregator). This bus does not vouch: the host stamps who sent a frame,
 *    which is exactly enough to attribute that peer's OWN records and not one
 *    byte more. Do not use it for authorship-gated state.
 *
 * Snapshots are BROADCAST (the host bus has no direct addressing), hence the
 * `for` field. Transport orders the chunks and reports loss via `skipped`;
 * MERGING IS THE OWNER'S JOB — only they know whether their state is a
 * lattice (idempotent, re-merge freely) or a sequence that must be applied in
 * order.
 */
export type StateRequestPayload = { of: BootsFrameKind }
export type StateSnapshotPayload = { of: BootsFrameKind; for: string; state: unknown }

function readStateRequest(data: unknown): StateRequestPayload | null {
  if (typeof data !== 'object' || data === null) return null
  const f = data as Record<string, unknown>
  return isFrameKind(f.of) ? { of: f.of } : null
}

function readStateSnapshot(data: unknown): StateSnapshotPayload | null {
  if (typeof data !== 'object' || data === null) return null
  const f = data as Record<string, unknown>
  if (!isFrameKind(f.of)) return null
  if (typeof f.for !== 'string' || f.for.length === 0 || f.for.length > 128) return null
  if (!('state' in f)) return null
  return { of: f.of, for: f.for, state: f.state }
}

/**
 * The late-join channel is owned by the TRANSPORT, not by a kind owner: its
 * two payload shapes are fixed here, so `requestState` works for a subsystem
 * that has not subscribed to anything yet (the common case — you ask for
 * state precisely because you have none). Registered at module load, and
 * restored by resetNetKinds so a test suite cannot lose them.
 */
function registerBuiltinKinds(): void {
  registerFrameKind('state-request', readStateRequest)
  registerFrameKind('state-snapshot', readStateSnapshot)
}
registerBuiltinKinds()

/** Ask the room for the current state of `of`. */
export function requestState(of: BootsFrameKind): PublishResult {
  return publishFrame('state-request', { of } satisfies StateRequestPayload)
}

/** Answer a request. `to` = the requester's sessionId (from the request msg). */
export function sendStateSnapshot(
  of: BootsFrameKind,
  to: string,
  snapshot: unknown,
  options?: { part?: number; parts?: number },
): PublishResult {
  return publishFrame(
    'state-snapshot',
    { of, for: to, state: snapshot } satisfies StateSnapshotPayload,
    options,
  )
}

/** Fires when a peer asks for state. `from` is HOST-STAMPED — it is the
 * sender's real session id, safe to use as the reply address and as the
 * authorship key. Answer with your OWN records (see "WHO ANSWERS"). */
export function onStateRequest(
  handler: (req: { of: BootsFrameKind; from: string; msg: NetMessage }) => void,
): () => void {
  return onFrame<StateRequestPayload>('state-request', (msg) => {
    handler({ of: msg.data.of, from: msg.sessionId, msg })
  })
}

/** Fires for snapshots of `of` ADDRESSED TO US (others are ignored here). */
export function onStateSnapshot(
  of: BootsFrameKind,
  handler: (snap: { state: unknown; msg: NetMessage }) => void,
): () => void {
  return onFrame<StateSnapshotPayload>('state-snapshot', (msg) => {
    if (msg.data.of !== of) return
    if (msg.data.for !== state.bus?.sessionId) return
    handler({ state: msg.data.state, msg })
  })
}

/**
 * Single-responder election (pure): the lowest sessionId among the live
 * roster answers. Deterministic, needs no coordination, and every peer
 * reaches the same verdict from the same roster. The requester never answers
 * itself.
 *
 * ONLY for state whose receiver does NOT gate records by author (see "WHO
 * ANSWERS" above). An authorship-gated receiver must let every peer answer
 * with its own records instead, because this bus stamps senders but does not
 * vouch for relays.
 */
export function shouldAnswerStateRequest(
  mySessionId: string,
  requesterSessionId: string,
  participants: CollabParticipant[],
): boolean {
  if (mySessionId === requesterSessionId) return false
  let lowest: string | null = null
  for (const participant of participants) {
    for (const session of participant.sessions) {
      if (session.sessionId === requesterSessionId) continue
      if (lowest === null || session.sessionId < lowest) lowest = session.sessionId
    }
  }
  return lowest === mySessionId
}

// ── Roster (pass-through) ────────────────────────────────────────────────────

export function getParticipants(): CollabParticipant[] {
  return state.bus?.getParticipants() ?? []
}

export function onParticipants(handler: (participants: CollabParticipant[]) => void): () => void {
  const bus = state.bus
  if (!bus) return () => {}
  return bus.onParticipants(handler)
}

/** Our own session id, or null with no bus. */
export function localSessionId(): string | null {
  return state.bus?.sessionId ?? null
}

/** Display name for a userId off the live roster (null when unknown). */
export function participantName(userId: string): string | null {
  for (const participant of getParticipants()) {
    if (participant.userId === userId && participant.name) return participant.name
  }
  return null
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

/**
 * Open the transport for this game session: ONE bus subscription for every
 * kind. Feature-detected — no bus returns false and nothing is scheduled.
 * Idempotent: a dev-time remount keeps the live subscription.
 */
export function startNet(): boolean {
  const bus = getCollabBus()
  if (!bus) return false
  if (state.active) return true
  state.active = true
  state.bus = bus
  state.outSeq.clear()
  state.inSeq.clear()
  state.published = 0
  state.received = 0
  state.dropped = 0
  state.unsubscribe = bus.subscribe(PLUGIN_ID, (msg) => ingestBusMessage(msg))
  return true
}

/** Close the transport. Registered kinds/handlers survive (they belong to
 * their modules); only the wire and the sequence state are torn down. */
export function stopNet(): void {
  if (!state.active) return
  state.unsubscribe?.()
  state.unsubscribe = null
  state.active = false
  state.bus = null
  state.outSeq.clear()
  state.inSeq.clear()
}

export function netAvailable(): boolean {
  return state.active && state.bus !== null
}

export function netCounters(): { published: number; received: number; dropped: number } {
  return { published: state.published, received: state.received, dropped: state.dropped }
}

/** Test-only: forget registered kinds so suites do not bleed into each other
 * (the transport's own built-in kinds are restored immediately). */
export function resetNetKinds(): void {
  state.kinds.clear()
  registerBuiltinKinds()
}
