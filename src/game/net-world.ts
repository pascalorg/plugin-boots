/**
 * net-world.ts — the adapter between the generic frame bus (net.ts) and the
 * convergent shared world (shared-world.ts + its two lane bridges).
 *
 * WHY THIS FILE EXISTS
 *
 * Three modules deliberately refuse to know about each other:
 *
 *   net.ts          owns the host bus, the envelope, sequence numbers, the
 *                   payload cap and the late-join channel. It knows nothing
 *                   about what any frame MEANS.
 *   shared-world.ts is a pure lattice. It implements no networking at all and
 *                   imports nothing from the transport.
 *   shared-build.ts / shared-damage.ts bridge that lattice to the running
 *                   game, and each exposes an INJECTION POINT rather than
 *                   reaching for a wire ("the transport installs one").
 *
 * This module is the one place those three meet, and it is the only arrow from
 * the transport into the model. Nothing here touches the scene directly: the
 * lanes own every scene write, and this file only routes bytes and effects.
 *
 * THE FIVE RULES IT ENFORCES
 *
 * 1. THE SENDER IS THE ENVELOPE'S, NEVER THE PAYLOAD'S. `mergeDelta` gates
 *    authorship by comparing each record's id prefix against `sender`. That
 *    defence is worth exactly as much as the sender is trustworthy, so the
 *    sender is always `msg.sessionId` — stamped by the host from the sending
 *    connection. `delta.from` travels on the wire and is therefore a claim by
 *    an attacker; it is never read here. A malicious peer can only ever author
 *    records under its own id.
 *
 * 2. ONE MERGE PER FRAME, EFFECTS FANNED OUT. `mergeDelta` is the only thing
 *    that writes remote state, and the two appliers are independently gated
 *    (each returns immediately when its lane is not attached). Merging twice
 *    would be harmless for the lattice but would double-count the world's
 *    applied/dropped counters, and re-applying build effects would double-coat
 *    remote paint strokes. So: merge once, apply to both lanes, never route a
 *    frame through a lane's own receive entry point.
 *
 * 3. BOTH KINDS ARE CONVERGENT, NOT ORDERED. The merge is a lattice join, so
 *    reorder, duplicate and drop are all safe. Registering these kinds as
 *    ordered would make the transport discard a late frame's records for
 *    nothing. Loss is not corrected — it HEALS, when a snapshot arrives.
 *
 * 4. THE WIRE IS TEXT. The host bus is a JSON channel with a cap counted in
 *    serialized characters, so a Uint8Array cannot travel on it (it would
 *    serialize to {"0":..,"1":..} and blow the budget in a few hundred bytes).
 *    Deltas cross as base64 via encodeDeltaText / decodeDeltaText.
 *
 * 5. FLAG OFF IS A NO-OP. No bus reaches the plugin as "no bus at all", so
 *    startWorldSync() returns false and attaches nothing. Not one lane is
 *    wired, no world is created, and single player is byte-identical.
 *
 * HOW LATE JOIN WORKS HERE, AND WHY IT IS NOT THE ADDRESSED CHANNEL
 *
 * net.ts offers an addressed reply (`sendStateSnapshot` -> `onStateSnapshot`),
 * but the shared world does not use it. A peer can only ever answer with its
 * OWN records — an aggregate of other peers' records could not pass the
 * authorship gate anyway — and a snapshot of one peer's own records is equally
 * useful to EVERY peer, not just the one who asked. So a request is answered
 * by broadcasting on 'boots/world-snap', which is what that kind is for. The
 * request channel is still used, to turn "you will learn the world within the
 * next heal period" into "you will learn it in a few hundred milliseconds".
 *
 * Answering is jittered and rate-limited: a public lobby must not let one
 * joiner (or one attacker replaying a request) trigger a synchronized burst of
 * snapshots from every peer in the room.
 */

import {
  type BootsFrameKind,
  MAX_PAYLOAD_SERIALIZED,
  type NetMessage,
  netAvailable,
  onFrame,
  onStateRequest,
  publishFrame,
  registerFrameKind,
  requestState,
  startNet,
} from './net'
import { localSessionId } from './net'
import { applySharedDamage, setDamageSync } from './shared-damage'
import {
  applyBuildEffects,
  attachBuildSync,
  detachBuildSync,
  setBuildSyncSink,
} from './shared-build'
import { decodeDeltaText, encodeDeltaText } from './shared-wire'
import {
  createSharedWorld,
  isSafePeerId,
  mergeDelta,
  type SharedDelta,
  type SharedWorld,
  snapshotOf,
} from './shared-world'

/** Deltas: incremental records. */
export const WORLD_KIND: BootsFrameKind = 'boots/world'
/** Snapshots: a peer's whole own state, the healing channel. */
export const WORLD_SNAP_KIND: BootsFrameKind = 'boots/world-snap'

/**
 * A base64 payload is a bare JSON string, so its serialized length is its
 * length plus two quote characters. base64's alphabet needs no escaping, which
 * is the other reason it is the encoding of choice here.
 */
export const MAX_WIRE_TEXT = MAX_PAYLOAD_SERIALIZED - 2

/** How often a peer rebroadcasts its own state so lost frames heal. */
export const HEAL_PERIOD_MS = 15000
/** A peer answers at most this often, however many requests arrive. */
export const SNAP_MIN_GAP_MS = 3000
/** Spread simultaneous answers so N peers do not all publish in one window. */
export const SNAP_JITTER_MS = 400

type Counters = {
  /** Frames handed to the host and accepted. */
  sent: number
  /** Frames the host coalesced away — that frame is GONE, not queued. */
  deferred: number
  /** Frames the host refused outright. */
  lost: number
  /** Outbound payloads over the transport budget (never published). */
  oversize: number
  /** Inbound frames that merged. */
  merged: number
  /** Inbound frames the validator refused before the model ever saw them. */
  rejected: number
  /** Snapshots broadcast (join answers + heals). */
  snapshots: number
  /** Snapshot answers suppressed by the rate limit. */
  throttled: number
  /** Exceptions escaping an applier (counted, never rethrown into the host). */
  applyErrors: number
}

type Session = {
  world: SharedWorld
  offs: (() => void)[]
  heal: ReturnType<typeof setInterval> | null
  answer: ReturnType<typeof setTimeout> | null
  lastSnapAt: number
}

const counters: Counters = {
  sent: 0,
  deferred: 0,
  lost: 0,
  oversize: 0,
  merged: 0,
  rejected: 0,
  snapshots: 0,
  throttled: 0,
  applyErrors: 0,
}

let session: Session | null = null

// ── The trust boundary ──────────────────────────────────────────────────────

/**
 * TOTAL by construction: this runs on whatever a stranger serialized, so it
 * may not throw, must reject every shape that is not a base64 delta, and must
 * bound the work it does before deciding. `decodeDeltaText` is documented
 * total, but it is wrapped anyway — a validator at a trust boundary that
 * relies on a callee's good behaviour is one refactor away from being a hole.
 */
function readWireDelta(data: unknown): SharedDelta | null {
  if (typeof data !== 'string') return null
  if (data.length === 0 || data.length > MAX_WIRE_TEXT) return null
  try {
    return decodeDeltaText(data)
  } catch {
    return null
  }
}

// ── Outbound ────────────────────────────────────────────────────────────────

/**
 * The single publish path for both lanes' sinks. Routes by the delta's own
 * kind so a snapshot never lands on the delta event (the host keeps only the
 * latest value per event per 66 ms, and a 6 kB snapshot arriving 20 ms after a
 * delta would otherwise swallow it).
 */
function sendDelta(delta: SharedDelta): void {
  const text = encodeDeltaText(delta)
  if (text.length > MAX_WIRE_TEXT) {
    // Bigger than the transport allows. Chunking is possible — net.ts reserves
    // {part, parts} and one node per chunk is the natural split, since each
    // node's records merge independently — but a frame this large is a lobby
    // that has outgrown v1, and dropping it loudly beats truncating it
    // silently. The periodic heal is what limits the damage.
    counters.oversize++
    return
  }
  const kind = delta.kind === 'snapshot' ? WORLD_SNAP_KIND : WORLD_KIND
  const result = publishFrame(kind, text)
  if (result === 'sent') counters.sent++
  else if (result === 'deferred') counters.deferred++
  else counters.lost++
}

/** Broadcast this peer's whole own state: the join answer and the heal tick. */
function publishSnapshot(now: number): void {
  const s = session
  if (!s) return
  s.lastSnapAt = now
  counters.snapshots++
  sendDelta(snapshotOf(s.world))
}

// ── Inbound ─────────────────────────────────────────────────────────────────

/**
 * One merge, then both appliers. The appliers run inside try/catch because
 * this executes inside the host's subscribe callback, which swallows throws:
 * an exception here would otherwise vanish without a trace and take the rest
 * of the frame's handlers with it.
 */
function ingest(msg: NetMessage<SharedDelta>): void {
  const s = session
  if (!s) return
  // THE AUTHORSHIP GATE'S INPUT. Host-stamped, not payload-supplied.
  const fx = mergeDelta(s.world, msg.data, msg.sessionId)
  counters.merged++
  try {
    applyBuildEffects(fx)
  } catch {
    counters.applyErrors++
  }
  try {
    applySharedDamage(fx)
  } catch {
    counters.applyErrors++
  }
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

/**
 * Wire the shared world onto the bus. Returns false — having changed nothing
 * at all — when there is no bus (the feature flag is off) or when the host
 * cannot name us with an id we could author records under.
 *
 * Idempotent: calling it twice keeps the first session.
 */
export function startWorldSync(): boolean {
  if (session) return true
  if (!startNet() || !netAvailable()) return false

  const self = localSessionId()
  // A peer that cannot be named safely could never author a record: '#' is the
  // record-id separator, so an id containing one would make 'alice#7' forgeable
  // by 'alice#7evil'. mergeDelta would refuse every frame we sent. Refusing to
  // start is the honest failure.
  if (!isSafePeerId(self)) return false

  const world = createSharedWorld(self)
  const s: Session = { world, offs: [], heal: null, answer: null, lastSnapAt: 0 }

  // Both kinds are convergent: never discard a reordered or duplicated frame.
  registerFrameKind<SharedDelta>(WORLD_KIND, readWireDelta, { ordered: false })
  registerFrameKind<SharedDelta>(WORLD_SNAP_KIND, readWireDelta, { ordered: false })
  s.offs.push(onFrame<SharedDelta>(WORLD_KIND, ingest))
  s.offs.push(onFrame<SharedDelta>(WORLD_SNAP_KIND, ingest))

  // Answer another peer's late-join request with our OWN records, jittered and
  // rate-limited so a replayed request cannot make us shout.
  s.offs.push(
    onStateRequest((req) => {
      if (req.of !== WORLD_KIND) return
      const live = session
      if (!live || live.answer) return
      const now = Date.now()
      if (now - live.lastSnapAt < SNAP_MIN_GAP_MS) {
        counters.throttled++
        return
      }
      live.answer = setTimeout(
        () => {
          const still = session
          if (!still) return
          still.answer = null
          publishSnapshot(Date.now())
        },
        Math.random() * SNAP_JITTER_MS,
      )
    }),
  )

  // Outbound: one sink, both lanes.
  attachBuildSync(world, { sink: sendDelta })
  setDamageSync({ world, publish: sendDelta })

  // The healing channel. Loss is never retransmitted; it is overwritten by the
  // next snapshot, so there must always be a next snapshot.
  s.heal = setInterval(() => {
    const live = session
    if (!live) return
    publishSnapshot(Date.now())
  }, HEAL_PERIOD_MS)

  session = s
  // Ask the room what happened before we arrived.
  requestState(WORLD_KIND)
  return true
}

/**
 * Tear the session down. Detaching both lanes is what restores exact single
 * player behaviour mid-session — and setDamageSync(null) also unwires the
 * Save-side ownership gate, so it must be called even though the world is
 * about to be dropped.
 *
 * The transport itself is NOT stopped: the avatar layer may still be using it.
 * Whoever started the net owns stopping it.
 */
export function stopWorldSync(): void {
  const s = session
  if (!s) return
  session = null
  if (s.heal) clearInterval(s.heal)
  if (s.answer) clearTimeout(s.answer)
  for (const off of s.offs) off()
  setBuildSyncSink(null)
  detachBuildSync()
  setDamageSync(null)
}

/** Is the shared world on the wire? */
export const worldSyncActive = (): boolean => session !== null

/** The session's world, or null. Read-only: the lanes own every mutation. */
export const worldSyncWorld = (): SharedWorld | null => session?.world ?? null

/** Force a heal broadcast now (QA and the debug HUD; the interval is normal). */
export function publishWorldSnapshot(): void {
  if (session) publishSnapshot(Date.now())
}

/** Counters for QA and the debug overlay. */
export function worldSyncDebug(): Counters & { active: boolean; self: string | null } {
  return { ...counters, active: session !== null, self: session?.world.self ?? null }
}

/** Test-only: forget the counters so a suite can assert deltas from zero. */
export function resetWorldSyncCounters(): void {
  counters.sent = 0
  counters.deferred = 0
  counters.lost = 0
  counters.oversize = 0
  counters.merged = 0
  counters.rejected = 0
  counters.snapshots = 0
  counters.throttled = 0
  counters.applyErrors = 0
}
