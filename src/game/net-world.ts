/**
 * net-world.ts — the adapter between the generic frame bus (net.ts) and the
 * convergent shared world (shared-world.ts + its two lane bridges).
 *
 * WHY THIS FILE EXISTS
 *
 * Four modules deliberately refuse to know about each other:
 *
 *   net.ts          owns the host bus, the envelope, sequence numbers, the
 *                   payload cap and the late-join channel. It knows nothing
 *                   about what any frame MEANS.
 *   shared-world.ts is a pure lattice plus an outbound JOURNAL of what this
 *                   client still owes the room. It implements no networking.
 *   shared-wire.ts  encodes, splits and queues frames. It has no transport.
 *   shared-build.ts / shared-damage.ts bridge that lattice to the running
 *                   game, and each exposes an injection point rather than
 *                   reaching for a wire.
 *
 * This module is the one place they meet, and the only arrow from the
 * transport into the model. Nothing here touches the scene directly: the lanes
 * own every scene write, and this file only moves bytes and effects.
 *
 * THE SIX RULES IT ENFORCES
 *
 * 1. THE SENDER IS THE ENVELOPE'S, NEVER THE PAYLOAD'S. `mergeDelta` gates
 *    authorship by comparing each record's id prefix against `sender`. That
 *    defence is worth exactly as much as the sender is trustworthy, so the
 *    sender is always `msg.sessionId` — stamped by the host from the sending
 *    connection. `delta.from` travels on the wire and is therefore a claim by
 *    whoever sent the frame; it is never read here.
 *
 * 2. ONE MERGE PER FRAME, EFFECTS FANNED OUT. `mergeDelta` is the only thing
 *    that writes remote state, and the two appliers are independently gated.
 *    Routing a frame through a lane's own receive entry point instead would
 *    merge and apply inside one call: pairing that with the other lane's apply
 *    double-applies the shared effects, and paint folds additively, so a
 *    second apply is not harmless.
 *
 * 3. ONE OUTBOUND PATH: THE JOURNAL. Every local op journals itself inside
 *    shared-world, so a tick calls `takePending(world)` and gets ONE batched
 *    delta. The lanes' own sinks (`attachBuildSync`'s `sink`, `DamageSync`'s
 *    `publish`) are deliberately left unwired — they are the same records by
 *    another road, and wiring both would put every piece, item, stroke and
 *    cell on the bus twice.
 *
 * 4. ONE FRAME PER KIND PER TICK, AND LOSSES STAY VISIBLE. The host keeps only
 *    the latest value per (plugin, event) per ~66 ms and DROPS the rest of a
 *    burst, so a burst is not a queue unless someone makes it one. The outbox
 *    is that queue: requeued at the front when the publish did not happen,
 *    bounded and counted. Deltas and snapshots are two events, hence two
 *    independent slots, so a tick spends BOTH — a multi-part heal snapshot must
 *    never make the wall a player just placed wait behind it.
 *
 * 5. BOTH KINDS ARE CONVERGENT, NOT ORDERED. The merge is a lattice join, so
 *    reorder, duplicate and drop are all safe, and each part of a split delta
 *    merges independently — which is why nothing here reassembles parts. Loss
 *    is not corrected, it HEALS when a snapshot arrives.
 *
 * 6. FLAG OFF IS A NO-OP. No bus reaches the plugin as "no bus at all", so
 *    startWorldSync() returns false and attaches nothing. Not one lane is
 *    wired, no world exists, and single player is byte-identical.
 *
 * HOW LATE JOIN WORKS HERE, AND WHY IT IS NOT THE ADDRESSED CHANNEL
 *
 * net.ts offers an addressed reply (`sendStateSnapshot` -> `onStateSnapshot`),
 * but the shared world does not use it. A peer answers with THE WHOLE MAP AS IT
 * KNOWS IT, and that answer is equally useful to every peer in the room rather
 * than only to the one who asked. So a request is answered by queueing a
 * snapshot on 'boots/world-snap', which is what that kind is for. The request
 * channel still earns its keep: it turns "you will learn the world within the
 * next heal period" into "you will learn it in a few hundred ms".
 *
 * The whole map, not just our own work, is the point — see mergeDelta's RELAY
 * GATE. An authored-only answer makes each record's only courier the peer who
 * wrote it, so the moment that peer leaves, their walls stop being re-published
 * and the next visitor finds a lot that has forgotten what was built on it. Every
 * peer relaying the whole lattice is what makes the map outlive its builders,
 * and it costs nothing extra on the wire: `snapshotOf` always emitted every
 * lane in full — the receiver just used to throw the other authors away.
 *
 * Answering is jittered and rate-limited: a public lobby must not let one
 * joiner — or one attacker replaying a request — trigger a synchronized burst
 * of snapshots from every peer in the room.
 */

import {
  type BootsFrameKind,
  localSessionId,
  MAX_PAYLOAD_SERIALIZED,
  type NetMessage,
  netAvailable,
  onFrame,
  onStateRequest,
  publishFrame,
  registerFrameKind,
  requestState,
  resyncNet,
  startNet,
} from './net'
import { applySharedDamage, setDamageSync } from './shared-damage'
import {
  applyBuildEffects,
  attachBuildSync,
  detachBuildSync,
  remintSharedRecords,
} from './shared-build'
import {
  createOutbox,
  decodeDeltaText,
  outboxDepth,
  queueDelta,
  requeueWireFrame,
  takeWireFrame,
  type WireOutbox,
} from './shared-wire'
import {
  createSharedWorld,
  isSafePeerId,
  mergeDelta,
  rekeySharedWorld,
  type SharedDelta,
  type SharedWorld,
  snapshotOf,
  takePending,
} from './shared-world'

/** Deltas: incremental records. */
export const WORLD_KIND: BootsFrameKind = 'boots/world'
/** Snapshots: a peer's whole own state, the healing channel. */
export const WORLD_SNAP_KIND: BootsFrameKind = 'boots/world-snap'

/**
 * A base64 payload is a bare JSON string, so its serialized length is its
 * length plus two quote characters. base64's alphabet needs no escaping, which
 * is the other reason it is the encoding of choice. Identical to shared-wire's
 * own MAX_TEXT_CHARS; asserted equal in the tests so the two cannot drift.
 */
export const MAX_WIRE_TEXT = MAX_PAYLOAD_SERIALIZED - 2

/** The host's coalescing window. Publishing faster only loses frames. */
export const PUBLISH_TICK_MS = 66
/** How often a peer rebroadcasts its own state so lost frames heal. */
export const HEAL_PERIOD_MS = 15000
/** A peer answers at most this often, however many requests arrive. */
export const SNAP_MIN_GAP_MS = 3000
/** Spread simultaneous answers so N peers do not all publish in one window. */
export const SNAP_JITTER_MS = 400

type Counters = {
  /** Frames the host accepted. */
  sent: number
  /** Frames the host coalesced away — requeued, not lost. */
  deferred: number
  /** Frames the host refused outright — requeued. */
  lost: number
  /** Deltas that could not be split into publishable parts at all. */
  oversize: number
  /** Inbound frames that reached the merge. */
  merged: number
  /**
   * Frames whose slot-addressed pieces the grid gate refused. In a healthy room
   * this is 0 for the whole session; anything else means two peers disagree
   * about the lot, and every wall in those frames was invisible.
   */
  refusedGrid: number
  /**
   * Refusals that happened while OUR OWN stamp was still 0 — i.e. we were the
   * one who could not name the lot. This is the exact signature of the bug that
   * cost production the entire pieces lane (see shared-build's
   * `publishGridStamp`): it must stay at 0, and if it ever climbs again the
   * grid frame is not reaching the world.
   */
  blindGrid: number
  /**
   * Records accepted from a snapshot on someone else's behalf — the mechanism
   * that makes a fort outlive the peer who built it (see mergeDelta's relay
   * gate).
   */
  relayed: number
  /** Snapshots queued (join answers + heals). */
  snapshots: number
  /** Snapshot answers suppressed by the rate limit. */
  throttled: number
  /**
   * Frames a lane offered through its OWN sink and we dropped on the floor,
   * because the journal already holds those records. Not an error: the damage
   * lane auto-flushes after every op, so this climbs steadily in normal play.
   * It is the measure of exactly how many frames the journal saved us.
   */
  laneSinkIgnored: number
  /**
   * Times the host re-keyed our session id mid-game and we renamed in place.
   * Never silent: a recovery nobody can see is nearly as bad as the bug.
   */
  rekeys: number
  /**
   * Records we had minted but not yet published when a re-key landed. They name
   * an author we can no longer vouch for, so every peer refuses them: this is
   * exactly the work a rename cannot save, bounded by one tick.
   */
  staleMints: number
  /**
   * How many of those the build lane could re-mint under the new name. The
   * remainder, `staleMints - staleReminted`, is the work that genuinely never
   * reaches a peer: strokes, and records whose runtime object is gone.
   */
  staleReminted: number
  /** Re-keys to a name that could never author a record. We stop instead. */
  unsafeNames: number
  /** Times the bus disappeared entirely and the session stopped. */
  busLost: number
  /** Exceptions escaping an applier (counted, never rethrown into the host). */
  applyErrors: number
}

type Session = {
  world: SharedWorld
  outbox: WireOutbox
  offs: (() => void)[]
  tick: ReturnType<typeof setInterval> | null
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
  refusedGrid: 0,
  blindGrid: 0,
  relayed: 0,
  snapshots: 0,
  throttled: 0,
  laneSinkIgnored: 0,
  rekeys: 0,
  staleMints: 0,
  staleReminted: 0,
  unsafeNames: 0,
  busLost: 0,
  applyErrors: 0,
}

let session: Session | null = null

// ── The trust boundary ──────────────────────────────────────────────────────

/**
 * TOTAL by construction: this runs on whatever a stranger serialized, so it may
 * not throw, must reject every shape that is not a base64 delta, and must bound
 * the work it does before deciding. `decodeDeltaText` is documented total, but
 * it is wrapped anyway — a validator at a trust boundary that relies on a
 * callee's good behaviour is one refactor away from being a hole.
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

// ── Outbound: journal -> outbox -> one frame per tick ───────────────────────

/**
 * Queue this peer's whole own state: the join answer and the heal tick. A
 * snapshot supersedes anything of ours still queued (it already contains it),
 * which is what stops a stalled coalescing window becoming a backlog.
 */
function queueSnapshot(s: Session, now: number): void {
  s.lastSnapAt = now
  counters.snapshots++
  queueDelta(s.outbox, snapshotOf(s.world))
}

/**
 * OUR NAME IS NOT A CONSTANT, SO IT IS CHECKED EVERY TICK.
 *
 * `world.self` is the prefix on every record id we mint, and peers gate an
 * inbound record with `isAuthoredBy(rec.id, msg.sessionId)` — sender read from
 * the envelope, live, per frame. So the model quietly depends on our session id
 * staying put for the life of the game. The host does not promise that: the
 * collab runtime adopts a restored pending operation's session id when the
 * outbox lease comes back, and its bus scope key includes the session id, so the
 * whole bus is replaced with one carrying the new name.
 *
 * Left alone the symptom is "his holes appear, his walls don't", and it reads as
 * a build-lane bug. Damage cells are unauthored so they keep landing; every
 * piece, item, aperture and stroke is refused by every peer. Nothing looks wrong
 * locally — our own prefix stays self-consistent, so the Save panel keeps
 * telling the truth about us.
 *
 * Returns false when this session is gone and the caller must stop touching it.
 */
function identityHeld(s: Session): boolean {
  // Rebind first: comparing session ids alone cannot see this, because the id we
  // can read belongs to the stale bus and would answer with the old value.
  resyncNet()
  const now = localSessionId()
  if (!netAvailable() || now === null) {
    // The bus went away entirely. Stop rather than requeue into a dead wire.
    counters.busLost++
    stopWorldSync()
    return false
  }
  if (now === s.world.self) return true

  // A name that cannot author anything must not be adopted: rekeySharedWorld
  // refuses it by returning [], which is indistinguishable from "no stale adds",
  // so silently carrying on would leave us publishing under a name no peer will
  // ever vouch for. Stop for the same reason startWorldSync refuses to begin.
  if (!isSafePeerId(now)) {
    counters.unsafeNames++
    stopWorldSync()
    return false
  }

  counters.rekeys++
  // RENAME IN PLACE, do not start over. Tearing the world down and re-minting
  // from the runtime looks equivalent and is not: it republishes work every peer
  // already holds (items and apertures carry no slot, so nothing elects between
  // the copies — two sofas), and it throws away everything only we hold, which
  // is our own damage attribution and the ids of our published records. Renaming
  // keeps the records, the tombstones, the journal, the lamport clock and the
  // grid stamp; `formerSelves` keeps "is this mine?" answerable afterwards, so
  // Save still recognises the fort we built under the old name.
  const stale = rekeySharedWorld(s.world, now)
  // Adds still in the journal when the rename landed carry the old name, so no
  // peer has them and none will now accept them. Counted rather than swallowed.
  counters.staleMints += stale.length
  // Then give that work a name peers WILL accept: the build lane re-mints each id
  // it still has a runtime object for, through the ordinary local path, so the new
  // records land in the journal and this tick drains them like any other. It skips
  // what it cannot honestly recover — an unbound id (already resolved into the
  // document, or deleted: resurrecting those is worse than losing them) and every
  // stroke, which has no runtime object to re-read. Before queueSnapshot, so the
  // snapshot we are about to queue already contains the re-minted records.
  try {
    counters.staleReminted += remintSharedRecords(stale).length
  } catch {
    // It contains its own failures per id; this is the belt for the braces.
    counters.applyErrors++
  }
  // Say the whole of it once, so a peer that missed anything gets it promptly
  // rather than at the next heal.
  queueSnapshot(s, Date.now())
  // The session itself is intact, so this tick carries on publishing as usual.
  return true
}

/**
 * One tick: drain the journal into the outbox, then publish exactly one frame.
 *
 * A frame the host did not take goes back to the FRONT of the queue — the
 * oldest state is the state a peer is most likely missing. `'sent'` is the only
 * result that means the bytes left.
 */
function pump(): void {
  const s = session
  if (!s) return
  if (!identityHeld(s)) return

  const out = takePending(s.world)
  if (out !== null && queueDelta(s.outbox, out) === 0) {
    // Unsplittable even into MAX_WIRE_PARTS parts. Restoring it would put the
    // same too-big delta back every tick forever, so it is dropped here and
    // counted; the periodic snapshot is what carries the state instead.
    counters.oversize++
  }

  // ONE FRAME PER KIND, because the host gives one slot PER (plugin, event) and
  // there are two events. Spending only one of them per tick made a heal
  // snapshot block live increments behind it — the wall you just placed waiting
  // out twenty ticks of bytes every peer already had. The two slots are
  // independent, so a tick spends both: 'delta' first, because that is the one a
  // player is watching for.
  for (const kind of ['delta', 'snapshot'] as const) {
    const frame = takeWireFrame(s.outbox, kind)
    if (frame === null) continue
    const event = frame.kind === 'snapshot' ? WORLD_SNAP_KIND : WORLD_KIND
    const result = publishFrame(event, frame.text, { part: frame.part, parts: frame.parts })
    if (result === 'sent') {
      counters.sent++
      continue
    }
    if (result === 'deferred') counters.deferred++
    else counters.lost++
    requeueWireFrame(s.outbox, frame)
  }
}

// ── Inbound ─────────────────────────────────────────────────────────────────

/**
 * One merge, then both appliers. Each applier runs inside its own try/catch
 * because this executes inside the host's subscribe callback, which swallows
 * throws: an exception here would otherwise vanish without a trace.
 *
 * Parts of a split delta are merged as they arrive and never reassembled —
 * each part is a complete, independently mergeable delta. That is the lattice
 * paying for itself.
 */
function ingest(msg: NetMessage<SharedDelta>): void {
  const s = session
  if (!s) return
  // THE AUTHORSHIP GATE'S INPUT. Host-stamped, not payload-supplied.
  const fx = mergeDelta(s.world, msg.data, msg.sessionId)
  counters.merged++
  if (fx.refusedGrid) {
    counters.refusedGrid++
    // Whose fault it was, recorded at the only moment anyone can tell.
    if (s.world.gridStamp === 0) counters.blindGrid++
  }
  counters.relayed += fx.relayed
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
 * Wire the shared world onto the bus. Returns false — having changed nothing at
 * all — when there is no bus (the feature flag is off) or when the host cannot
 * name us with an id we could author records under.
 *
 * Idempotent: calling it twice keeps the first session.
 */
export function startWorldSync(): boolean {
  if (session) return true
  if (!startNet() || !netAvailable()) return false

  const self = localSessionId()
  // A peer that cannot be named safely could never author a record: '#' is the
  // record-id separator, so an id containing one would make 'alice#7' forgeable
  // by 'alice#7evil'. mergeDelta would refuse every frame we sent, and
  // createSharedWorld would quietly rename us 'local'. Refusing to start is the
  // honest failure.
  if (!isSafePeerId(self)) return false

  const world = createSharedWorld(self)
  const s: Session = {
    world,
    outbox: createOutbox(MAX_WIRE_TEXT),
    offs: [],
    tick: null,
    heal: null,
    answer: null,
    lastSnapAt: 0,
  }

  // ORDER MATTERS. Everything a frame needs must exist before anything can
  // deliver one: `ingest` reads `session`, and receiveBuildDelta with no world
  // attached deliberately merges nothing and returns no effects, so a frame that
  // beat this point would be silently dropped rather than buffered. Nothing
  // between here and the subscriptions awaits, so this is belt and braces — but
  // it means a future await cannot open that window by accident.
  //
  // NO SINKS: every local op journals itself, and the tick drains that journal.
  // Passing a sink as well would publish every record twice.
  attachBuildSync(world)
  // DamageSync requires a publish, so it gets one that only counts. Damage
  // journals itself through noteLocal* like everything else; letting this one
  // send would be the same cells twice. Counted rather than empty so that a
  // future rewiring shows up as a number instead of a silent doubling.
  setDamageSync({
    world,
    publish: () => {
      counters.laneSinkIgnored++
    },
  })
  session = s

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
          queueSnapshot(still, Date.now())
        },
        Math.random() * SNAP_JITTER_MS,
      )
    }),
  )

  s.tick = setInterval(pump, PUBLISH_TICK_MS)
  // The healing channel. Loss is never retransmitted; it is overwritten by the
  // next snapshot, so there must always be a next snapshot.
  s.heal = setInterval(() => {
    const live = session
    if (live) queueSnapshot(live, Date.now())
  }, HEAL_PERIOD_MS)

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
  if (s.tick) clearInterval(s.tick)
  if (s.heal) clearInterval(s.heal)
  if (s.answer) clearTimeout(s.answer)
  for (const off of s.offs) off()
  detachBuildSync()
  setDamageSync(null)
}

/** Is the shared world on the wire? */
export const worldSyncActive = (): boolean => session !== null

/** The session's world, or null. Read-only: the lanes own every mutation. */
export const worldSyncWorld = (): SharedWorld | null => session?.world ?? null

/** Run one outbound tick now (QA and tests; the interval is the normal path). */
export function pumpWorldSync(): void {
  pump()
}

/** Queue a heal broadcast now (QA and the debug HUD). */
export function publishWorldSnapshot(): void {
  if (session) queueSnapshot(session, Date.now())
}

/** Counters for QA and the debug overlay. */
export function worldSyncDebug(): Counters & {
  active: boolean
  self: string | null
  /** Frames still waiting for a tick. */
  depth: number
  /** Local ops handed back because a publish did not happen. */
  unsent: number
  /** Frames dropped because the outbox was over its cap. */
  overflow: number
  /** Queued frames thrown away because a snapshot replaced them. */
  superseded: number
  /** Frames put back at the front after a publish that did not happen. */
  requeued: number
} {
  const box = session?.outbox
  return {
    ...counters,
    active: session !== null,
    self: session?.world.self ?? null,
    depth: box ? outboxDepth(box) : 0,
    unsent: session?.world.unsent ?? 0,
    overflow: box?.overflow ?? 0,
    superseded: box?.superseded ?? 0,
    requeued: box?.requeued ?? 0,
  }
}

/** Test-only: forget the counters so a suite can assert deltas from zero. */
export function resetWorldSyncCounters(): void {
  counters.sent = 0
  counters.deferred = 0
  counters.lost = 0
  counters.oversize = 0
  counters.merged = 0
  counters.refusedGrid = 0
  counters.blindGrid = 0
  counters.relayed = 0
  counters.snapshots = 0
  counters.throttled = 0
  counters.laneSinkIgnored = 0
  counters.rekeys = 0
  counters.staleMints = 0
  counters.staleReminted = 0
  counters.unsafeNames = 0
  counters.busLost = 0
  counters.applyErrors = 0
}
