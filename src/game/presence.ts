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
 * Co-presence bus adapter — the ONLY module that talks to the host's
 * collaboration bus (`globalThis.__pascalCollabBus`). Everything is
 * FEATURE-DETECTED: with no bus (solo app, older hosts, :3002) every
 * function no-ops and the game is byte-for-byte unaffected.
 *
 * What flows over the wire is PRESENCE ONLY — pose frames (protocol v1,
 * presence-interp.ts). No game state, no destruction, no scene writes:
 * each peer's world snapshot stays frozen and local (the non-destructive
 * invariant is per-client; see docs/MULTIPLAYER.md).
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
 */

// ── Host bus interface (shipped by the host separately) ─────────────────────

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
export const PLAYER_EVENT = 'player'

/** Feature detection — protocol v1 only; anything else reads as "no bus". */
export function getCollabBus(): CollabBus | null {
  const bus = (globalThis as { __pascalCollabBus?: CollabBus }).__pascalCollabBus
  return bus && bus.version === 1 ? bus : null
}

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
  bus: CollabBus | null
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
  bus: null,
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
  const participants = state.bus?.getParticipants()
  if (participants) {
    for (const participant of participants) {
      if (participant.userId === userId && participant.name) return participant.name
    }
  }
  return 'builder'
}

/** LIVE internal map — remote-players.tsx's render feed. Everything handed
 * to `__boots` goes through presenceDebug() (plain copies) instead. */
export function getRemotes(): ReadonlyMap<string, RemotePlayer> {
  return state.remotes
}

export function getRosterVersion(): number {
  return state.rosterVersion
}

export function presenceCounters(): { published: number; received: number } {
  return { published: state.published, received: state.received }
}

function dropRemote(remote: RemotePlayer, announce: boolean): void {
  state.remotes.delete(remote.sessionId)
  state.rosterVersion++
  if (announce && remote.ph === 'game') emit('leave', remote)
}

/**
 * Bus-message ingestion (exported for tests; the subscription calls it with
 * Date.now()). Validates, drops self-echo, feeds the ring, and runs the
 * join/leave edge detection.
 */
export function ingestBusMessage(msg: CollabBusMessage, now: number): void {
  if (!state.active || !state.bus) return
  if (msg.event !== PLAYER_EVENT) return
  if (msg.sessionId === state.bus.sessionId) return // self-echo
  if (typeof msg.sentAt !== 'number' || !Number.isFinite(msg.sentAt)) return
  const frame = validateFrame(msg.data)
  if (!frame) return
  state.received++

  let remote = state.remotes.get(msg.sessionId)
  if (frame.ph === 'editor') {
    // Explicit exit — instant despawn (the peer left the game or the
    // session; stopPresence publishes exactly this as its last word).
    if (remote) dropRemote(remote, true)
    return
  }

  if (!remote) {
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
  if (!state.active || !state.bus) return

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
  // A fresh plain object per accepted attempt — the bus may serialize
  // asynchronously, so it never gets a live reference to the scratch.
  const result = state.bus.publish(PLUGIN_ID, PLAYER_EVENT, wireCopy(scratchFrame))
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
  const bus = getCollabBus()
  if (!bus) return false
  if (state.active) {
    state.getLocal = getLocal
    return true
  }
  state.active = true
  state.bus = bus
  state.getLocal = getLocal
  state.lastPublishAt = 0
  state.lastSentFrame = null
  state.published = 0
  state.received = 0
  state.unsubscribe = bus.subscribe(PLUGIN_ID, (msg) => ingestBusMessage(msg, Date.now()))
  state.offParticipants = bus.onParticipants((participants) => reconcileRoster(participants))
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
  const bus = state.bus
  if (bus) {
    const local = state.getLocal?.()
    if (local) buildFrame(local, scratchFrame)
    else copyFrame(emptyFrame(), scratchFrame)
    scratchFrame.ph = 'editor' // the goodbye — regardless of the store phase
    scratchFrame.s = 0
    try {
      bus.publish(PLUGIN_ID, PLAYER_EVENT, wireCopy(scratchFrame))
    } catch {
      // A tearing-down bus must never break session exit.
    }
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
  state.bus = null
  state.getLocal = null
  state.lastSentFrame = null
}

/** Plain-data QA dump for `__boots.presence()` — copies, never live refs. */
export function presenceDebug(): {
  remotes: Array<{ sessionId: string; name: string; p: [number, number, number]; w: string; ageMs: number }>
  published: number
  received: number
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
  return { remotes, published: state.published, received: state.received }
}
