import {
  type CollabParticipant,
  forgetSender,
  type NetMessage,
  netAvailable,
  onFrame,
  onParticipants,
  participantName as netParticipantName,
  publishFrame,
  registerFrameKind,
  startNet,
  stopNet,
} from './net'
import {
  createRing,
  isStale,
  latestSnapshot,
  angleDist,
  type PresenceFrame,
  type PresencePhase,
  pushSnapshot,
  type SnapshotRing,
  validateFrame,
} from './presence-interp'

/**
 * Co-presence — the AVATAR layer. One frame kind ('pose') on the generic
 * Boots transport (net.ts, which owns the host bus, the envelope, sequence
 * numbers and the late-join hook). Nothing here knows about the wire; net.ts
 * knows nothing about poses.
 *
 * FEATURE-DETECTED through net.ts: with no bus (solo app, older hosts,
 * :3002, or the host's NEXT_PUBLIC_PLUGIN_COLLAB off) every function no-ops
 * and the game is byte-for-byte unaffected.
 *
 * What flows over the wire HERE is presence only — pose frames (protocol v1,
 * presence-interp.ts). No game state, no destruction, no scene writes: this
 * module imports neither the scene store nor any Save bridge, and a test
 * pins that (presence-hostile.test.ts). Destruction and build sync are
 * separate kinds owned elsewhere on the same bus.
 *
 * Publish policy (pure, test-pinned):
 * - 12 Hz base; 10 Hz once MORE THAN 4 remotes are live (crowd back-off).
 * - Idle skip: an unchanged pose (beyond epsilons) is not re-sent — but
 *   never stay silent longer than 500 ms (the keep-alive that feeds the
 *   peers' staleness clocks).
 * - A 'deferred' publish result is a SKIP, not a queue: the frame is
 *   dropped and the next tick builds a fresh one (stale poses are worse
 *   than missing ones).
 *
 * Remote registry: Map<sessionId, RemotePlayer> fed by the bus
 * subscription. Join = first 'game'-phase frame from a session; leave =
 * explicit 'editor'-phase frame (instant — the peer pressed Esc),
 * staleness (>3 s silent), or a roster drop from onParticipants. Leave
 * removes the entry; remote-players.tsx re-renders off rosterVersion.
 *
 * Crowd ceiling: the registry is HARD-CAPPED at MAX_REMOTE_AVATARS. A
 * public lobby is unbounded — a hostile or merely popular one must cost a
 * bounded amount, so past the cap the FARTHEST peers lose their slot
 * instead of everyone losing frame rate (admitRemote, pure).
 */

/** Our frame kind on the Boots transport. */
export const POSE_KIND = 'pose' as const

// ── Publish policy (pure) ───────────────────────────────────────────────────

export const PUBLISH_HZ_BASE = 12
export const PUBLISH_HZ_CROWDED = 10
/** More remotes than this switches the publisher to the crowded rate. */
export const CROWDED_REMOTES = 4
/** Never stay silent longer than this even when perfectly idle (ms). */
export const IDLE_MAX_SILENCE_MS = 500
/** Position change epsilon (m) — just above the 2-decimal wire resolution. */
export const POS_EPSILON = 0.015
/** Angle change epsilon (rad) — just above the 3-decimal wire resolution. */
export const ANGLE_EPSILON = 0.0015
/** Speed change epsilon (normalized 0..1). */
export const SPEED_EPSILON = 0.02
/** Adapter tick — policy gating makes the actual publish rate 12/10 Hz. */
const TICK_MS = 25

export function publishIntervalMs(remoteCount: number): number {
  return 1000 / (remoteCount > CROWDED_REMOTES ? PUBLISH_HZ_CROWDED : PUBLISH_HZ_BASE)
}

/** Change gate between the last SENT frame and the next candidate. */
export function framesEqual(a: PresenceFrame, b: PresenceFrame): boolean {
  return (
    a.ph === b.ph &&
    a.w === b.w &&
    a.g === b.g &&
    a.st === b.st &&
    Math.abs(a.p[0] - b.p[0]) <= POS_EPSILON &&
    Math.abs(a.p[1] - b.p[1]) <= POS_EPSILON &&
    Math.abs(a.p[2] - b.p[2]) <= POS_EPSILON &&
    angleDist(a.yaw, b.yaw) <= ANGLE_EPSILON &&
    angleDist(a.pitch, b.pitch) <= ANGLE_EPSILON &&
    Math.abs(a.s - b.s) <= SPEED_EPSILON
  )
}

/**
 * THE publish decision (pure — the whole cadence is pinned by tests):
 * rate-gate first (12/10 Hz off `lastPublishAt`), then the idle gate
 * (unchanged frames only ride the 500 ms keep-alive).
 */
export function shouldPublish(args: {
  now: number
  lastPublishAt: number
  remoteCount: number
  changed: boolean
}): boolean {
  const since = args.now - args.lastPublishAt
  if (since < publishIntervalMs(args.remoteCount)) return false
  if (!args.changed && since < IDLE_MAX_SILENCE_MS) return false
  return true
}

// ── Local pose → wire frame ─────────────────────────────────────────────────

/** What the game hands the publisher every tick (game-root's sampler reads
 * playerRig + the boots store; positions are EYE positions — the renderer
 * drops them by EYE_HEIGHT to plant remote feet). */
export type LocalPose = {
  ph: PresencePhase
  x: number
  y: number
  z: number
  yaw: number
  pitch: number
  w: string
  s: number
  g: boolean
  st: boolean
}

const round2 = (v: number): number => Math.round(v * 100) / 100
const round3 = (v: number): number => Math.round(v * 1000) / 1000

/** Wrap into (-π, π] — playerRig.yaw grows unbounded; the wire stays small. */
export function wrapAngle(a: number): number {
  let w = a % (Math.PI * 2)
  if (w > Math.PI) w -= Math.PI * 2
  else if (w <= -Math.PI) w += Math.PI * 2
  return w
}

/** Quantize a local pose into the caller-owned wire frame (~150 B): 2
 * decimals of position (cm), 3 decimals of angle (~0.06°), s clamped. */
export function buildFrame(local: LocalPose, out: PresenceFrame): PresenceFrame {
  out.v = 1
  out.ph = local.ph
  out.p[0] = round2(local.x)
  out.p[1] = round2(local.y)
  out.p[2] = round2(local.z)
  out.yaw = round3(wrapAngle(local.yaw))
  out.pitch = round3(wrapAngle(local.pitch))
  out.w = local.w
  out.s = round2(local.s < 0 ? 0 : local.s > 1 ? 1 : local.s)
  out.g = local.g
  out.st = local.st
  return out
}

// ── Crowd ceiling (pure) ─────────────────────────────────────────────────────

/**
 * HARD maximum simultaneously rendered remote avatars. The open lobby has no
 * roster limit of its own, so this is the plugin's own bound: 12 rigs ≈ 130
 * primitives + 12 name-tag textures, which measured flat against solo. Past
 * it the farthest peers are culled — a packed lobby costs what a full one
 * costs, and nobody's frame rate pays for the twentieth stranger.
 */
export const MAX_REMOTE_AVATARS = 12

/**
 * A newcomer must be at least this much closer (m) than the farthest
 * rendered peer to take its slot. Hysteresis: two strangers at similar range
 * would otherwise trade the last slot every frame, and each swap is a
 * roster bump (React re-render + rig mount).
 */
export const CROWD_SWAP_MARGIN_M = 2

/** One rendered remote as the cap policy sees it. */
export type CrowdSlot = {
  sessionId: string
  /** Squared distance to the local player; Infinity when unknown. */
  distSq: number
  /** Local clock of the last accepted frame (tie-break). */
  lastReceivedAt: number
}

/**
 * Admission decision for a would-be newcomer at the ceiling (pure, so the
 * whole policy is pinned by tests):
 * - under the cap → admit, evict nothing;
 * - at the cap → the newcomer must be CROWD_SWAP_MARGIN_M closer than the
 *   farthest slot to displace it, otherwise it is culled (never entered in
 *   the registry at all, so a rejected peer costs one comparison and never
 *   churns the roster);
 * - unknown distance (no local pose yet, or an unpositioned slot) ranks as
 *   farthest, with the oldest-heard slot losing ties; when NOTHING has a
 *   distance the fallback is pure recency, so the cap still holds.
 */
export function admitRemote(
  slots: CrowdSlot[],
  incoming: { distSq: number },
  max = MAX_REMOTE_AVATARS,
): { admit: boolean; evict: string | null } {
  if (slots.length < max) return { admit: true, evict: null }
  if (slots.length === 0) return { admit: false, evict: null } // max <= 0
  let worst = slots[0]!
  for (const slot of slots) {
    if (
      slot.distSq > worst.distSq ||
      (slot.distSq === worst.distSq && slot.lastReceivedAt < worst.lastReceivedAt)
    ) {
      worst = slot
    }
  }
  // No reference point anywhere: fall back to recency (the oldest goes) so a
  // pre-sampler burst of joins cannot blow past the ceiling.
  if (!Number.isFinite(worst.distSq) && !Number.isFinite(incoming.distSq)) {
    return { admit: true, evict: worst.sessionId }
  }
  if (Math.sqrt(incoming.distSq) < Math.sqrt(worst.distSq) - CROWD_SWAP_MARGIN_M) {
    return { admit: true, evict: worst.sessionId }
  }
  return { admit: false, evict: null }
}

// ── Remote registry ──────────────────────────────────────────────────────────

export type RemotePlayer = {
  sessionId: string
  clientId: string
  userId: string
  ring: SnapshotRing
  /** Local clock of the last accepted frame (staleness). */
  lastReceivedAt: number
  /** EMA of (local now − bus sentAt): maps local render time into the
   * sender's sentAt clock for sampleAt. NaN until the first frame. */
  clockOffset: number
  ph: PresencePhase
  /** Last weapon seen (registry-level convenience for the QA dump). */
  w: string
  /** Local clock when this session entered 'game' (drives the scale-in). */
  joinedAt: number
}

export type PresenceEvent = {
  type: 'join' | 'leave'
  sessionId: string
  userId: string
  name: string
}

type PresenceState = {
  active: boolean
  getLocal: (() => LocalPose) | null
  unsubscribe: (() => void) | null
  offParticipants: (() => void) | null
  timer: ReturnType<typeof setInterval> | null
  remotes: Map<string, RemotePlayer>
  /** Bumped on every join/leave — remote-players.tsx re-renders off it. */
  rosterVersion: number
  lastPublishAt: number
  /** Last frame the bus ACCEPTED ('sent') — the idle change gate's basis. */
  lastSentFrame: PresenceFrame | null
  published: number
  received: number
  /** Valid frames refused by the crowd ceiling (QA observability). */
  culled: number
}

const emptyFrame = (): PresenceFrame => ({
  v: 1,
  ph: 'editor',
  p: [0, 0, 0],
  yaw: 0,
  pitch: 0,
  w: 'knife',
  s: 0,
  g: true,
  st: false,
})

const state: PresenceState = {
  active: false,
  getLocal: null,
  unsubscribe: null,
  offParticipants: null,
  timer: null,
  remotes: new Map(),
  rosterVersion: 0,
  lastPublishAt: 0,
  lastSentFrame: null,
  published: 0,
  received: 0,
  culled: 0,
}

/** Reused publish scratch — the tick never allocates while idle. */
const scratchFrame = emptyFrame()

const eventHandlers = new Set<(e: PresenceEvent) => void>()

/** Join/leave notifications (HUD toasts). Returns the unsubscribe. */
export function onPresenceEvent(handler: (e: PresenceEvent) => void): () => void {
  eventHandlers.add(handler)
  return () => eventHandlers.delete(handler)
}

function emit(type: 'join' | 'leave', remote: RemotePlayer): void {
  const event: PresenceEvent = {
    type,
    sessionId: remote.sessionId,
    userId: remote.userId,
    name: participantName(remote.userId),
  }
  for (const handler of eventHandlers) handler(event)
}

/** Display name for a userId off the live roster; 'builder' when unknown. */
export function participantName(userId: string): string {
  return netParticipantName(userId) ?? 'builder'
}

/** LIVE internal map — remote-players.tsx's render feed. Everything handed
 * to `__boots` goes through presenceDebug() (plain copies) instead. */
export function getRemotes(): ReadonlyMap<string, RemotePlayer> {
  return state.remotes
}

export function getRosterVersion(): number {
  return state.rosterVersion
}

export function presenceCounters(): { published: number; received: number; culled: number } {
  return { published: state.published, received: state.received, culled: state.culled }
}

function dropRemote(remote: RemotePlayer, announce: boolean): void {
  state.remotes.delete(remote.sessionId)
  state.rosterVersion++
  // Release the transport's per-sender sequence tracker with the avatar, so a
  // long lobby session never accumulates dead senders.
  forgetSender(remote.sessionId)
  if (announce && remote.ph === 'game') emit('leave', remote)
}

/**
 * Pose-frame ingestion (exported for tests; net.ts's dispatcher calls it with
 * Date.now()). The envelope, self-echo, sequence ordering and payload
 * validation are ALREADY done by net.ts — `msg.data` is a normalized
 * PresenceFrame. This function owns only the avatar semantics: the crowd
 * ceiling, the interpolation ring, and the join/leave edges.
 */
export function ingestPoseFrame(msg: NetMessage<PresenceFrame>, now: number): void {
  if (!state.active) return
  const frame = msg.data
  state.received++

  let remote = state.remotes.get(msg.sessionId)
  if (frame.ph === 'editor') {
    // Explicit exit — instant despawn (the peer left the game or the
    // session; stopPresence publishes exactly this as its last word).
    if (remote) dropRemote(remote, true)
    return
  }

  if (!remote) {
    // Crowd ceiling FIRST: a culled newcomer is never entered in the
    // registry, so it costs one comparison and never bumps the roster.
    const decision = admitRemote(crowdSlots(), { distSq: distSqToLocal(frame) })
    if (!decision.admit) {
      state.culled++
      return
    }
    if (decision.evict) {
      const evicted = state.remotes.get(decision.evict)
      // announce:false — a culled peer did NOT leave (it is still in the
      // project); claiming "X left" in the HUD would be a lie.
      if (evicted) dropRemote(evicted, false)
    }
    remote = {
      sessionId: msg.sessionId,
      clientId: msg.clientId,
      userId: msg.userId,
      ring: createRing(),
      lastReceivedAt: now,
      clockOffset: Number.NaN,
      ph: 'editor',
      w: frame.w,
      joinedAt: now,
    }
    state.remotes.set(msg.sessionId, remote)
  }
  remote.lastReceivedAt = now
  remote.w = frame.w
  const offset = now - msg.sentAt
  remote.clockOffset = Number.isFinite(remote.clockOffset)
    ? remote.clockOffset + (offset - remote.clockOffset) * 0.1
    : offset
  const wasInGame = remote.ph === 'game'
  remote.ph = 'game'
  if (!wasInGame) {
    remote.joinedAt = now
    state.rosterVersion++
    emit('join', remote)
  }
  pushSnapshot(remote.ring, msg.sentAt, frame)
}

/** Squared distance from a wire frame to the local eye; Infinity with no
 * local pose sampler yet (pre-first-frame joins). */
function distSqToLocal(frame: PresenceFrame): number {
  const local = state.getLocal?.()
  if (!local) return Number.POSITIVE_INFINITY
  const dx = frame.p[0] - local.x
  const dy = frame.p[1] - local.y
  const dz = frame.p[2] - local.z
  return dx * dx + dy * dy + dz * dz
}

/** Snapshot the rendered crowd for the cap policy. Reuses one scratch array
 * so a flood of rejected joins allocates nothing per frame. */
const crowdScratch: CrowdSlot[] = []
function crowdSlots(): CrowdSlot[] {
  crowdScratch.length = 0
  const local = state.getLocal?.()
  for (const remote of state.remotes.values()) {
    const snap = latestSnapshot(remote.ring)
    let distSq = Number.POSITIVE_INFINITY
    if (local && snap) {
      const dx = snap.x - local.x
      const dy = snap.y - local.y
      const dz = snap.z - local.z
      distSq = dx * dx + dy * dy + dz * dz
    }
    crowdScratch.push({
      sessionId: remote.sessionId,
      distSq,
      lastReceivedAt: remote.lastReceivedAt,
    })
  }
  return crowdScratch
}

/** Roster reconciliation (exported for tests): a remote whose sessionId no
 * longer appears in the participant list dropped without a goodbye frame. */
export function reconcileRoster(participants: CollabParticipant[]): void {
  if (state.remotes.size === 0) return
  const live = new Set<string>()
  for (const participant of participants) {
    for (const session of participant.sessions) live.add(session.sessionId)
  }
  for (const remote of [...state.remotes.values()]) {
    if (!live.has(remote.sessionId)) dropRemote(remote, true)
  }
}

/**
 * One adapter tick (exported for tests; the interval calls it with
 * Date.now()): staleness sweep, then the policy-gated publish.
 */
export function presenceTick(now: number): void {
  if (!state.active) return

  // Staleness: a peer silent >3s despawns (crash, tab close, network gone).
  for (const remote of state.remotes.values()) {
    if (isStale(remote.lastReceivedAt, now)) dropRemote(remote, true)
  }

  const getLocal = state.getLocal
  if (!getLocal) return
  buildFrame(getLocal(), scratchFrame)
  const changed = state.lastSentFrame === null || !framesEqual(state.lastSentFrame, scratchFrame)
  if (
    !shouldPublish({
      now,
      lastPublishAt: state.lastPublishAt,
      remoteCount: state.remotes.size,
      changed,
    })
  ) {
    return
  }
  // A fresh plain object per accepted attempt — the transport may serialize
  // asynchronously, so it never gets a live reference to the scratch.
  const result = publishFrame(POSE_KIND, wireCopy(scratchFrame))
  state.lastPublishAt = now // 'deferred'/'suppressed' → skip, not queue
  if (result === 'sent') {
    state.published++
    state.lastSentFrame = state.lastSentFrame ?? emptyFrame()
    copyFrame(scratchFrame, state.lastSentFrame)
  }
}

function wireCopy(frame: PresenceFrame): PresenceFrame {
  return {
    v: 1,
    ph: frame.ph,
    p: [frame.p[0], frame.p[1], frame.p[2]],
    yaw: frame.yaw,
    pitch: frame.pitch,
    w: frame.w,
    s: frame.s,
    g: frame.g,
    st: frame.st,
  }
}

function copyFrame(from: PresenceFrame, to: PresenceFrame): void {
  to.v = 1
  to.ph = from.ph
  to.p[0] = from.p[0]
  to.p[1] = from.p[1]
  to.p[2] = from.p[2]
  to.yaw = from.yaw
  to.pitch = from.pitch
  to.w = from.w
  to.s = from.s
  to.g = from.g
  to.st = from.st
}

/**
 * Start the adapter for the current game session. Feature-detected: no bus
 * (or wrong protocol) → false, and the whole co-presence feature is inert.
 * Idempotent — a dev-time ActiveGame remount just swaps the pose sampler
 * (never despawns the live registry or re-announces the local player).
 */
export function startPresence(getLocal: () => LocalPose): boolean {
  // The transport decides whether co-presence exists at all (no bus = the
  // host flag is off) — nothing below runs when it says no.
  if (!startNet()) return false
  if (state.active) {
    state.getLocal = getLocal
    return true
  }
  state.active = true
  state.getLocal = getLocal
  state.lastPublishAt = 0
  state.lastSentFrame = null
  state.published = 0
  state.received = 0
  state.culled = 0
  // Our payload validator IS the pose trust boundary (presence-interp).
  registerFrameKind(POSE_KIND, validateFrame)
  state.unsubscribe = onFrame<PresenceFrame>(POSE_KIND, (msg) => ingestPoseFrame(msg, Date.now()))
  state.offParticipants = onParticipants((participants) => reconcileRoster(participants))
  state.timer = setInterval(() => presenceTick(Date.now()), TICK_MS)
  return true
}

/**
 * Stop the adapter: publish ONE final explicit `ph:'editor'` frame (peers
 * despawn our avatar instantly instead of waiting out the 3 s staleness
 * clock), then unsubscribe, kill the timer and clear the registry. Safe to
 * call twice — session.exitGame fires it before teardown AND the ActiveGame
 * unmount path may follow (idempotent no-op the second time).
 */
export function stopPresence(): void {
  if (!state.active) return
  if (netAvailable()) {
    const local = state.getLocal?.()
    if (local) buildFrame(local, scratchFrame)
    else copyFrame(emptyFrame(), scratchFrame)
    scratchFrame.ph = 'editor' // the goodbye — regardless of the store phase
    scratchFrame.s = 0
    // publishFrame never throws (a tearing-down bus reads as 'unavailable').
    publishFrame(POSE_KIND, wireCopy(scratchFrame))
  }
  if (state.timer) clearInterval(state.timer)
  state.timer = null
  state.unsubscribe?.()
  state.unsubscribe = null
  state.offParticipants?.()
  state.offParticipants = null
  state.remotes.clear()
  state.rosterVersion++
  state.active = false
  state.getLocal = null
  state.lastSentFrame = null
  // Close the transport last: presence is currently its only user, and a
  // session that ended should leave no subscription behind. When destruction
  // and build kinds land, this becomes the session owner's call instead.
  stopNet()
}

/** Plain-data QA dump for `__boots.presence()` — copies, never live refs. */
export function presenceDebug(): {
  remotes: Array<{ sessionId: string; name: string; p: [number, number, number]; w: string; ageMs: number }>
  published: number
  received: number
  culled: number
  cap: number
} {
  const now = Date.now()
  const remotes: Array<{
    sessionId: string
    name: string
    p: [number, number, number]
    w: string
    ageMs: number
  }> = []
  for (const remote of state.remotes.values()) {
    const snap = latestSnapshot(remote.ring)
    remotes.push({
      sessionId: remote.sessionId,
      name: participantName(remote.userId),
      p: snap ? [snap.x, snap.y, snap.z] : [0, 0, 0],
      w: remote.w,
      ageMs: now - remote.lastReceivedAt,
    })
  }
  return {
    remotes,
    published: state.published,
    received: state.received,
    culled: state.culled,
    cap: MAX_REMOTE_AVATARS,
  }
}
