import {
  type CollabBus,
  type CollabParticipant,
  forgetSender,
  getCollabBus,
  type NetMessage,
  netAvailable,
  netBus,
  netCounters,
  onFrame,
  onParticipants,
  participantName as netParticipantName,
  publishFrame,
  registerFrameKind,
  resyncNet,
  startNet,
  stopNet,
} from './net'
import {
  type ArrivalTiming,
  createRing,
  createTiming,
  SHOT_COUNTER_MOD,
  isStale,
  latestSnapshot,
  angleDist,
  type PresenceFrame,
  type PresencePhase,
  pushSnapshot,
  type SnapshotRing,
  updateTiming,
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
 * presence-interp.ts), including the fire counter `f`, because a shot is part of
 * a pose rather than a fact about the world (presence-interp's header argues
 * it). No game state, no destruction, no scene writes: this
 * module imports neither the scene store nor any Save bridge, and a test
 * pins that (presence-hostile.test.ts). Destruction and build sync are
 * separate kinds owned elsewhere on the same bus.
 *
 * Publish policy (pure, test-pinned):
 * - 12 Hz base; 10 Hz once MORE THAN 4 remotes are live (crowd back-off).
 *   The adapter ticks every TICK_MS (21 ms) and the rate gate allows half a
 *   tick of tolerance, so the 4th tick (84 ms) publishes even when the timer
 *   lands a millisecond early — a 25 ms tick with no tolerance silently
 *   quantized the 83 ms gate to 100 ms (10 Hz) for the first week.
 * - Idle skip: an unchanged pose (beyond epsilons) is not re-sent — but
 *   never stay silent longer than 500 ms (the keep-alive that feeds the
 *   peers' staleness clocks).
 * - A 'deferred' publish result is treated as NOT SENT: the host queues and
 *   later sends the latest value per event (plugin-collab-bus.ts, 66 ms
 *   slot), but this side conservatively re-offers a fresh frame at the next
 *   rate tick rather than trusting the queue. At 12 Hz against a 66 ms slot
 *   it does not occur.
 *
 * Remote registry: Map<sessionId, RemotePlayer> fed by the bus
 * subscription. Join = first 'game'-phase frame from a session; leave =
 * explicit 'editor'-phase frame (instant — the peer pressed Esc),
 * staleness (>3 s silent), or a roster drop from onParticipants that OUTLASTS
 * ROSTER_GRACE_MS (see reconcileRoster: the host's roster goes empty for a
 * beat on every channel restart, and a roster that is merely unsynced must
 * not despawn people who are still sending frames). Leave removes the entry;
 * remote-players.tsx re-renders off rosterVersion.
 *
 * The bus is not forever: the host installs one bus per awareness runtime and
 * swaps it (or removes it) on a channel restart / session re-key. Every tick
 * re-checks the installed bus by OBJECT identity (rebindTransport) and moves
 * the transport AND the roster subscription onto the new one — a spectator
 * used to go deaf after a host restart until the phase flipped. The registry
 * survives a rebind untouched (nobody re-joins, no toasts).
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
/** Adapter tick (ms) — policy gating makes the actual publish rate 12/10 Hz.
 * Four ticks = 84 ms, the first multiple that clears the 83.3 ms gate with the
 * half-tick tolerance below; 25 ms ticks could only ever hit 100 ms. */
export const TICK_MS = 21
/** The rate gate forgives this much (ms) — a timer that fires a hair early
 * on the qualifying tick must not push the publish a whole tick later.
 *
 * Half a tick, deliberately, because `since` is measured from the ACTUAL time
 * of the last publish and timers fire LATE under load (a 60 fps game loop
 * delays a 21 ms timer by 0-16 ms): a late publishing tick followed by a
 * punctual 4th tick reads 84 − δ ms, and a tolerance small enough to refuse
 * the 3rd tick at its latest (3 ms) refuses those too — simulated over 60 s
 * with ticks 0-8 / 0-16 ms late that is 11.4 / 10.9 Hz. Half a tick holds
 * 11.9 Hz across the same range, at the price of a 3rd-tick publish (73 ms)
 * in the ~2 % of cases where a tick lands ≥ 10 ms later than the one that
 * published — the host's 66 ms slot carries it, and the mean is unchanged.
 * (presence.test.ts pins the cadence under regular AND late ticks.) */
export const TICK_TOLERANCE_MS = TICK_MS / 2

/**
 * How long a peer may be MISSING FROM THE ROSTER before that alone despawns
 * it (ms). A roster drop is the fallback leave signal (tab closed, socket
 * gone — the peer had no chance to send its ph:'editor' goodbye), and the
 * host's roster is not a clean signal: every awareness channel restart pushes
 * an empty list first and a fresh bus starts with whatever the runtime had —
 * usually nothing — until the next presence sync. A frame from the peer in
 * the meantime clears the flag (host-stamped frames are the stronger
 * evidence), so the window must OUTLAST the longest gap between two frames of
 * a peer who is still there: a background tab's timers are throttled to 1 Hz,
 * which stretches the 500 ms keep-alive to ~1000-1100 ms, and one second of
 * grace expired exactly between two such keep-alives — a roster still catching
 * up after a restart would have dropped a peer who was still sending, and the
 * next frame re-joined them. Two seconds holds that with margin, is still
 * invisible next to a real crash despawn, and stays shorter than STALE_MS
 * because an explicit roster drop is still a stronger hint than plain silence.
 */
export const ROSTER_GRACE_MS = 2000
/** The slowest a LIVE peer's keep-alive gets (ms): Chrome's background-tab
 * timer throttle (1 Hz) stretching IDLE_MAX_SILENCE_MS. ROSTER_GRACE_MS must
 * clear it with margin (test-pinned). */
export const BACKGROUND_KEEPALIVE_MS = 1100

export function publishIntervalMs(remoteCount: number): number {
  return 1000 / (remoteCount > CROWDED_REMOTES ? PUBLISH_HZ_CROWDED : PUBLISH_HZ_BASE)
}

/**
 * Change gate between the last SENT frame and the next candidate.
 *
 * The fire counter is in here as an EXACT comparison, and that is the whole
 * reason a standing player's gunfire reaches anyone: a peer holding still and
 * emptying a magazine is idle by every other measure — same position, same
 * angles, same speed — so the idle skip would sit on those frames for up to
 * 500 ms and the shots would arrive in one lump, after the fact. A changed
 * count is a changed frame, published at the next rate tick.
 */
export function framesEqual(a: PresenceFrame, b: PresenceFrame): boolean {
  return (
    a.ph === b.ph &&
    a.w === b.w &&
    a.g === b.g &&
    a.st === b.st &&
    Math.abs((a.a ?? 0) - (b.a ?? 0)) <= 0.02 &&
    a.f === b.f &&
    a.nm === b.nm &&
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
  if (since + TICK_TOLERANCE_MS < publishIntervalMs(args.remoteCount)) return false
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
  /** Aim-down-sights blend; optional for old/test samplers. */
  a?: number
  /** Monotone count of rounds this session has fired (playerRig.shots) — the
   * publisher wraps it into the wire's 0..255 counter. */
  f: number
  /** Exact end of the latest resolved hitscan; optional for older samplers. */
  t?: [number, number, number]
  /** Chosen display name (nickname.localDisplayName) — the tag peers show.
   * Optional so hand-built poses in tests need not carry it. */
  nm?: string
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
  out.a = round2(Math.max(0, Math.min(1, local.a ?? 0)))
  out.f = wrapShots(local.f)
  if (local.t) {
    out.t = [round2(local.t[0]), round2(local.t[1]), round2(local.t[2])]
  } else {
    delete out.t
  }
  out.nm = local.nm || undefined
  return out
}

/** The session's shot count as the wire carries it: a whole number in
 * 0..SHOT_COUNTER_MOD-1. Total — a NaN or negative counter reads as 0 rather
 * than poisoning every frame after it. */
export function wrapShots(shots: number): number {
  if (!Number.isFinite(shots) || shots <= 0) return 0
  return Math.trunc(shots) % SHOT_COUNTER_MOD
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
  /** Last chosen display name seen on this peer's pose ('' = use the roster). */
  nick: string
  /** Local clock when this session entered 'game' (drives the scale-in). */
  joinedAt: number
  /** Measured arrival timing (spacing / jitter / idle gaps) — the adaptive
   * interpolation delay's input, and the QA dump's. */
  timing: ArrivalTiming
  /** The EYE position this peer was last DRAWN at (remote-players.tsx writes
   * it every frame after interpolation + smoothing), and the local clock of
   * that write (0 = never drawn on this page — a spectator with no scene, or
   * a peer culled from the renderer). Consumers that must agree with the
   * picture (PvP hit capsule, voice range) read these when fresh. */
  drawnX: number
  drawnY: number
  drawnZ: number
  drawnAt: number
  /** The interpolation delay (ms) the renderer currently uses for this peer. */
  delayMs: number
  /** Local clock when the host roster FIRST stopped listing this session
   * (0 = listed, or never checked). Past ROSTER_GRACE_MS the sweep drops the
   * peer; a fresh frame or a roster that lists it again resets it to 0. */
  rosterMissingSince: number
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
  /** The bus object our ROSTER subscription is bound to (identity only) —
   * compared against the installed bus every tick; null while unbound. */
  boundBus: CollabBus | null
  /** Times the tick moved us onto a different (or returned) bus. */
  rebinds: number
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
  a: 0,
  f: 0,
  t: undefined,
  nm: undefined,
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
  boundBus: null,
  rebinds: 0,
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
    name: remoteLabel(remote),
  }
  for (const handler of eventHandlers) handler(event)
}

/**
 * THE one label rule for a remote player, shared by every surface that prints
 * WHO is here (join/leave toasts, the spectator pill, the in-game roster chip,
 * the QA dump): the peer's CHOSEN nickname (rides their pose frame, `nm`)
 * wins; otherwise the host roster's display name for their userId; otherwise
 * 'builder'. Open-lobby strangers are unprofiled, so a surface built off the
 * roster name alone would read "builder is playing" — the nick is what makes
 * the copy true. roster-names.ts re-exports it.
 *
 * Known inline copies of this rule (`remote.nick || participantName(...)`)
 * still live in remote-players.tsx (the name tag's useState seed and its
 * refresh) and voice.ts (the speaking-peer label) — owned by the avatar and
 * voice lanes; behaviour is identical today, fold them onto this export when
 * those files are next touched so the three cannot drift.
 */
export function remoteLabel(remote: Pick<RemotePlayer, 'nick' | 'userId'>): string {
  return remote.nick || participantName(remote.userId)
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
      nick: frame.nm ?? '',
      joinedAt: now,
      timing: createTiming(),
      drawnX: 0,
      drawnY: 0,
      drawnZ: 0,
      drawnAt: 0,
      delayMs: 0,
      rosterMissingSince: 0,
    }
    state.remotes.set(msg.sessionId, remote)
  }
  remote.lastReceivedAt = now
  // A host-stamped frame is proof of presence: whatever the roster said, this
  // session is here. Clears a pending roster-grace countdown.
  remote.rosterMissingSince = 0
  remote.w = frame.w
  remote.nick = frame.nm ?? ''
  const wasInGame = remote.ph === 'game'
  remote.ph = 'game'
  if (!wasInGame) {
    remote.joinedAt = now
    state.rosterVersion++
    emit('join', remote)
  }
  // The ring's order guard decides whether this frame is a SAMPLE at all. A
  // reordered or duplicate frame (sentAt ≤ newest) keeps the peer alive above
  // but must feed neither the timing nor the clock offset: a rewound lastSentAt
  // would read the next accepted frame as a too-wide spacing (or a phantom
  // gap) and lift the adaptive delay for nothing, and a late frame's offset is
  // exactly the sample the offset EMA should not learn from.
  if (!pushSnapshot(remote.ring, msg.sentAt, frame)) return
  const offset = now - msg.sentAt
  // Arrival timing BEFORE the offset EMA moves: the deviation is this frame's
  // offset against the smoothed one, i.e. how early/late it landed.
  updateTiming(
    remote.timing,
    msg.sentAt,
    Number.isFinite(remote.clockOffset) ? Math.abs(offset - remote.clockOffset) : 0,
  )
  remote.clockOffset = Number.isFinite(remote.clockOffset)
    ? remote.clockOffset + (offset - remote.clockOffset) * 0.1
    : offset
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

/** Reused by reconcileRoster — a roster push allocates nothing. */
const rosterScratch = new Set<string>()

/**
 * Roster reconciliation (exported for tests; the bus's onParticipants calls it
 * with Date.now()): a remote whose sessionId no longer appears in the
 * participant list probably dropped without a goodbye frame — but NOT
 * necessarily, so it is not despawned here. It is marked missing, and the tick
 * drops it only once it has been missing for ROSTER_GRACE_MS with no frame
 * heard in between (rosterGraceExpired). A roster that lists it again clears
 * the mark.
 *
 * An EMPTY roster is ignored outright: a list that does not even contain OUR
 * session is not a statement about who left, it is the host mid-restart
 * (use-project-awareness resets to [] on every channel teardown and a fresh
 * bus is born with that same empty list). Acting on it despawned the whole
 * lobby on every reconnect.
 */
export function reconcileRoster(participants: CollabParticipant[], now: number = Date.now()): void {
  if (state.remotes.size === 0) return
  let listed = 0
  for (const participant of participants) listed += participant.sessions.length
  if (listed === 0) return
  const live = rosterScratch
  live.clear()
  for (const participant of participants) {
    for (const session of participant.sessions) live.add(session.sessionId)
  }
  for (const remote of state.remotes.values()) {
    if (live.has(remote.sessionId)) {
      remote.rosterMissingSince = 0
    } else if (remote.rosterMissingSince === 0) {
      remote.rosterMissingSince = now
    }
    // Already missing: the countdown keeps its original start; the sweep
    // (presenceTick) is the one place a peer is dropped for it.
  }
}

/** Pure: has this peer been missing from the roster past the grace window? */
export function rosterGraceExpired(
  remote: Pick<RemotePlayer, 'rosterMissingSince'>,
  now: number,
): boolean {
  return remote.rosterMissingSince > 0 && now - remote.rosterMissingSince > ROSTER_GRACE_MS
}

// ── Bus rebinding ────────────────────────────────────────────────────────────

/** (Re)subscribe the roster on the bus the transport currently holds. */
function bindRoster(): void {
  state.offParticipants?.()
  state.offParticipants = onParticipants((participants) => reconcileRoster(participants, Date.now()))
  state.boundBus = netBus()
}

/**
 * Keep the transport and the roster subscription on the bus the host has
 * INSTALLED (exported for tests; presenceTick calls it first thing). Returns
 * true when anything moved.
 *
 * Steady state is one global read and two identity compares — no allocation,
 * no host call. Three ways out of it:
 *  - the host SWAPPED the bus (session re-key, channel restart): resyncNet
 *    moves the transport (kinds and handlers survive; INBOUND trackers reset
 *    so a peer's stream is accepted from its first frame on the new wire,
 *    while our OUTBOUND counters carry on — the host keeps our sessionId
 *    across a restart, and a peer's ordered tracker would refuse a counter
 *    that restarted at 1 until its staleness sweep despawned us), then the
 *    roster is re-subscribed on the new object — our old onParticipants
 *    closure died with the old bus (the host clears its handler sets on
 *    uninstall), so without this the roster went deaf for good;
 *  - the bus is GONE (collab torn down, or the gap between uninstall and the
 *    next install): the transport closes honestly (publishFrame reads
 *    'unavailable'), the dead roster subscription is released, and the adapter
 *    stays active with its registry intact — peers age out through the normal
 *    staleness sweep if nobody comes back, and are adopted as-is if a bus
 *    returns within STALE_MS;
 *  - a bus APPEARED while we were unbound: start the transport on it and bind.
 *
 * Nothing in the registry is touched: a rebind is not a leave, so no toasts,
 * no roster bump, no avatar re-scales in.
 */
export function rebindTransport(): boolean {
  if (!state.active) return false
  const installed = getCollabBus()
  const bound = netBus()
  if (installed === bound && installed === state.boundBus) return false
  if (installed === null) {
    if (bound !== null) resyncNet() // closes the transport (no bus to rebind to)
    state.offParticipants?.()
    state.offParticipants = null
    if (state.boundBus !== null) state.rebinds++
    state.boundBus = null
    return true
  }
  if (bound !== installed) {
    // resyncNet is the swap path (net active on another object); startNet the
    // cold one (net closed by an earlier outage). Either lands on `installed`.
    if (bound !== null) resyncNet()
    else if (!startNet()) return false
  }
  bindRoster()
  state.rebinds++
  // First tick on the new wire publishes at once (rate gate permitting): a
  // re-keyed bus may carry a session id nobody has heard from yet, and the
  // 500 ms keep-alive is a long time to be invisible.
  state.lastSentFrame = null
  return true
}

/**
 * One adapter tick (exported for tests; the interval calls it with
 * Date.now()): staleness sweep, then the policy-gated publish.
 */
export function presenceTick(now: number): void {
  if (!state.active) return

  // The host may have swapped or removed the bus since the last tick: follow
  // it BEFORE sweeping, so a peer whose frames were waiting on the new bus is
  // heard on this very tick rather than aged out on it.
  rebindTransport()

  // Staleness: a peer silent >3s despawns (crash, tab close, network gone);
  // so does one the roster stopped listing ROSTER_GRACE_MS ago with no frame
  // since (reconcileRoster only marks — this is the one place it drops).
  for (const remote of state.remotes.values()) {
    if (isStale(remote.lastReceivedAt, now) || rosterGraceExpired(remote, now)) {
      dropRemote(remote, true)
    }
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
    a: frame.a,
    f: frame.f,
    ...(frame.t ? { t: [frame.t[0], frame.t[1], frame.t[2]] as [number, number, number] } : {}),
    nm: frame.nm,
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
  to.a = from.a
  to.f = from.f
  if (from.t) {
    to.t = to.t ?? [0, 0, 0]
    to.t[0] = from.t[0]
    to.t[1] = from.t[1]
    to.t[2] = from.t[2]
  } else {
    delete to.t
  }
  to.nm = from.nm
}

/**
 * Start the adapter for the current game session. Feature-detected: no bus
 * (or wrong protocol) → false, and the whole co-presence feature is inert.
 * Idempotent — a dev-time ActiveGame remount just swaps the pose sampler
 * (never despawns the live registry or re-announces the local player).
 */
export function startPresence(getLocal: () => LocalPose): boolean {
  if (state.active) {
    // ADOPT FIRST, ask about the bus second. A spectator's receive-only
    // adapter (or a remount) is already running: the game session takes it
    // over by installing the pose sampler — even during a bus outage, so the
    // moment the bus is back the tick rebinds and publishing simply starts,
    // and stopPresence's goodbye path owns the adapter from here on. The
    // return value still tells the truth ("co-presence is live"), so a caller
    // retrying on it (untilNet) keeps retrying until the transport is up.
    state.getLocal = getLocal
    rebindTransport()
    return netAvailable()
  }
  // The transport decides whether co-presence exists at all (no bus = the
  // host flag is off) — nothing below runs when it says no.
  if (!startNet()) return false
  resyncNet() // startNet is idempotent: if net still held a stale bus, move
  state.active = true
  state.getLocal = getLocal
  state.lastPublishAt = 0
  state.lastSentFrame = null
  state.published = 0
  state.received = 0
  state.culled = 0
  state.rebinds = 0
  // Our payload validator IS the pose trust boundary (presence-interp).
  registerFrameKind(POSE_KIND, validateFrame)
  state.unsubscribe = onFrame<PresenceFrame>(POSE_KIND, (msg) => ingestPoseFrame(msg, Date.now()))
  bindRoster()
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
  // A bus that came back between ticks still gets the goodbye: rebind first,
  // so peers despawn us now instead of waiting out their staleness clocks.
  rebindTransport()
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
  state.boundBus = null
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

/**
 * SPECTATE — receive live players WITHOUT being one.
 *
 * A viewer looking at the project (the read-only /play lobby, or /editor with
 * the game not entered) wants to watch the people who ARE in the game move,
 * shoot and build — but has no avatar to broadcast. This is the RECEIVE HALF
 * of `startPresence`: the same subscription and roster reconcile, the same
 * staleness sweep, but `getLocal` stays null — and `presenceTick` already
 * returns before the publish once `getLocal` is null, so we transmit nothing.
 *
 * Coexists with `startPresence` on the one shared adapter: if a game session is
 * already live, this is a no-op (the session owns the subscription); and when a
 * spectator later drops IN, `startPresence`'s idempotent branch just hands the
 * running adapter a `getLocal` and publishing turns on with no reconnect.
 */
export function startSpectating(): boolean {
  if (!startNet()) return false
  // A live game session (or an existing spectate) already owns the adapter.
  if (state.active) return true
  resyncNet() // startNet is idempotent: if net still held a stale bus, move
  state.active = true
  state.getLocal = null // receive-only: presenceTick sweeps but never publishes
  state.lastPublishAt = 0
  state.lastSentFrame = null
  state.rebinds = 0
  registerFrameKind(POSE_KIND, validateFrame)
  state.unsubscribe = onFrame<PresenceFrame>(POSE_KIND, (msg) => ingestPoseFrame(msg, Date.now()))
  bindRoster()
  state.timer = setInterval(() => presenceTick(Date.now()), TICK_MS)
  return true
}

/**
 * Stop spectating. A NO-OP once the viewer has dropped in: a game session owns
 * the adapter then (`getLocal` is set), and its own `stopPresence` — with the
 * `ph:'editor'` goodbye — is the only thing allowed to tear it down. Otherwise
 * this is the receive-only owner, so it closes the subscription and transport.
 */
export function stopSpectating(): void {
  if (!state.active || state.getLocal) return
  if (state.timer) clearInterval(state.timer)
  state.timer = null
  state.unsubscribe?.()
  state.unsubscribe = null
  state.offParticipants?.()
  state.offParticipants = null
  state.boundBus = null
  state.remotes.clear()
  state.rosterVersion++
  state.active = false
  state.lastSentFrame = null
  stopNet()
}

/**
 * Extra plain-data sources folded into presenceDebug() under `extra.<name>`.
 * The renderer (remote-players.tsx) registers its per-avatar motion stats
 * here so `__boots.presence()` carries them without game-root knowing — and
 * without this module importing the React side (which imports this one).
 */
const debugSources = new Map<string, () => unknown>()

export function registerPresenceDebugSource(name: string, source: () => unknown): () => void {
  debugSources.set(name, source)
  return () => {
    if (debugSources.get(name) === source) debugSources.delete(name)
  }
}

export type PresenceDebugRemote = {
  sessionId: string
  /** The label every surface prints (remoteLabel: nick || roster || 'builder'). */
  name: string
  /** The chosen nickname off their pose frame ('' = none). */
  nick: string
  /** The host roster's display name for their userId, or 'builder'. */
  rosterName: string
  p: [number, number, number]
  w: string
  f: number
  ageMs: number
  /** Local clock (ms epoch) of the last accepted frame — ageMs' basis. */
  lastSeenMs: number
  /** How long (ms) the host roster has NOT listed this session (0 = listed);
   * past ROSTER_GRACE_MS with no frame heard, the sweep drops the peer. */
  rosterMissingMs: number
  /** Arrival timing (ArrivalTiming) — measure the relay before tuning. */
  spacingMs: number
  jitterMs: number
  gaps: number
  lastGapMs: number
  /** The renderer's current interpolation delay for this peer (0 = not drawn). */
  delayMs: number
  /** Where this peer was last drawn (eye), or null if never drawn here. */
  drawn: [number, number, number] | null
  drawnAgeMs: number
}

/** Plain-data QA dump for `__boots.presence()` — copies, never live refs. */
export function presenceDebug(): {
  remotes: PresenceDebugRemote[]
  published: number
  received: number
  culled: number
  /** Frames the transport refused (envelope, order, validation) — net.ts. */
  netDropped: number
  cap: number
  tickMs: number
  /** Transport live right now (a bus is installed and we are bound to it). */
  bound: boolean
  /** Host bus swaps the transport followed (net.ts) / rebinds this adapter did. */
  swaps: number
  rebinds: number
  rosterGraceMs: number
  extra: Record<string, unknown>
} {
  const now = Date.now()
  const remotes: PresenceDebugRemote[] = []
  for (const remote of state.remotes.values()) {
    const snap = latestSnapshot(remote.ring)
    remotes.push({
      sessionId: remote.sessionId,
      name: remoteLabel(remote),
      nick: remote.nick,
      rosterName: participantName(remote.userId),
      p: snap ? [snap.x, snap.y, snap.z] : [0, 0, 0],
      w: remote.w,
      // Their fire counter as last received — the ONE number a two-client QA run
      // can use to prove remote gunfire crossed the wire, since a muzzle flash
      // lasts 50 ms and a report cannot be read out of a headless browser.
      f: snap ? snap.f : 0,
      ageMs: now - remote.lastReceivedAt,
      lastSeenMs: remote.lastReceivedAt,
      rosterMissingMs: remote.rosterMissingSince > 0 ? now - remote.rosterMissingSince : 0,
      spacingMs: remote.timing.spacingEma,
      jitterMs: remote.timing.jitterEma,
      gaps: remote.timing.gaps,
      lastGapMs: remote.timing.lastGapMs,
      delayMs: remote.delayMs,
      drawn: remote.drawnAt > 0 ? [remote.drawnX, remote.drawnY, remote.drawnZ] : null,
      drawnAgeMs: remote.drawnAt > 0 ? now - remote.drawnAt : -1,
    })
  }
  const extra: Record<string, unknown> = {}
  for (const [name, source] of debugSources) {
    try {
      extra[name] = source()
    } catch {
      extra[name] = null
    }
  }
  return {
    remotes,
    published: state.published,
    received: state.received,
    culled: state.culled,
    netDropped: netCounters().dropped,
    cap: MAX_REMOTE_AVATARS,
    tickMs: TICK_MS,
    bound: netAvailable() && state.boundBus !== null && state.boundBus === netBus(),
    swaps: netCounters().swaps,
    rebinds: state.rebinds,
    rosterGraceMs: ROSTER_GRACE_MS,
    extra,
  }
}
