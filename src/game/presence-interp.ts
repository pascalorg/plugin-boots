/**
 * PURE co-presence interpolation — the math side of remote-player rendering.
 * No three.js, no store, no bus: presence.ts feeds validated wire frames in
 * here; remote-players.tsx samples poses out. Everything is allocation-free
 * on the hot path (ring slots are preallocated and reused; sampleAt writes
 * into a caller-owned `out`), so the render loop can sample every remote
 * every frame without GC pressure.
 *
 * Wire protocol v1 (~150 B/frame, see docs/MULTIPLAYER.md):
 *   { v:1, ph:'game'|'editor', p:[x,y,z] (2 decimals), yaw, pitch (3
 *     decimals), w: weapon id, s: 0..1 normalized horizontal speed,
 *     g: grounded, st: staggered, f: rounds fired mod 256 }
 *
 * `f` IS THE GUNFIRE LANE, and it is a counter rather than an event on purpose.
 * A shot is a thing that happened AT a pose — the muzzle is wherever the arm
 * was — so carrying it as a field of the pose means the flash, the bang and the
 * avatar that fired all arrive together and are rendered at the same instant by
 * the same interpolation. An event on its own lane would land early or late by
 * the interpolation delay, next to an avatar still standing at rest. It also
 * costs no new lane, no new trust boundary, and it self-heals: peers compare
 * against the last count they SAW, so a dropped frame is a delta of two, not a
 * lost shot. Wrapping at 256 keeps it two hex digits on the wire.
 *
 * ADDED AFTER v1 SHIPPED, so `f` is optional on the wire and defaults to 0: a
 * client pinned to the older build sends frames without it and must keep its
 * avatar (an omitted field is "no shots seen", never an invalid frame), and its
 * own reader ignores a field it does not know. Everything downstream of
 * validateFrame sees a total shape.
 *
 * Sampling model (the classic snapshot-interpolation setup):
 * - Snapshots land in a ring (cap 24 ≈ 2 s at 12 Hz); out-of-order frames
 *   (by sentAt) are dropped — the bus gives no ordering guarantee.
 * - sampleAt(renderTime) renders REMOTES IN THE PAST: the caller passes
 *   now − delay, where the delay is PER PEER and ADAPTIVE (interpDelayFor):
 *   the measured arrival spacing plus a jitter margin, clamped to
 *   [INTERP_DELAY_MIN_MS, INTERP_DELAY_MAX_MS] and slewed so it never jumps.
 *   Idle keep-alives (500 ms) and hidden-tab throttling (1 Hz) are classified
 *   as GAPS by updateTiming, never as network spacing, so a quiet peer does
 *   not inflate anyone's delay. A bracketing snapshot pair then almost always
 *   exists and motion is a lerp, never a guess. Yaw/pitch take the shortest arc.
 * - sampleAt also reports the VELOCITY it used (vx/vy/vz, m/s: the bracket
 *   slope, or the last pair's slope while extrapolating; 0 when frozen,
 *   snapped, clamped or lone) — the renderer's gait, landing detection and
 *   residual smoother read it instead of the sender's wire `s`.
 * - Past the newest snapshot the pose extrapolates along the last pair's
 *   velocity for at most EXTRAPOLATE_MAX_MS (200 ms), then FREEZES — a
 *   stalled peer stands still instead of sliding into the sunset. A peer whose
 *   newest frame says it has STOPPED (wire s ≈ 0, grounded) holds at once:
 *   the last pair is the deceleration, not where it is going. An AIRBORNE
 *   peer extrapolates under WIRE_GRAVITY and never sinks more than
 *   EXTRAP_SINK_M below its newest frame (the floor is at most a frame away).
 * - smoothPose (pure) sits between sampleAt and the drawn root: the part of a
 *   sample that the previous velocity did not predict — a late frame ending
 *   an extrapolation, a stall catching up — is absorbed into a residual that
 *   decays at SMOOTH_RATE, so corrections GLIDE instead of popping. Motion
 *   that is merely fast (a fall, a knockback, a hard start) predicts itself
 *   and passes untouched; a residual ≥ TELEPORT_SNAP_M snaps.
 * - Consecutive snapshots > TELEPORT_SNAP_M (3 m) apart read as a teleport
 *   (spawn, QA teleport, respawn): no lerp, no velocity — snap.
 * - A remote silent > STALE_MS (3 s) is despawn-ripe (isStale); presence.ts
 *   owns the actual registry removal.
 */

export type PresencePhase = 'game' | 'editor'

/** Validated wire frame (see header). `w` stays a plain string here — the
 * renderer maps unknown weapon ids to a bare-hands fallback, so a newer
 * peer's weapon never breaks an older client. */
export type PresenceFrame = {
  v: 1
  ph: PresencePhase
  p: [number, number, number]
  yaw: number
  pitch: number
  w: string
  s: number
  g: boolean
  st: boolean
  /** Aim-down-sights blend. Soft-added; older peers default to hip fire. */
  a?: number
  /** Chosen display name (soft, added after v1): the tag over this peer. */
  nm?: string
  /** Rounds fired this session, mod SHOT_COUNTER_MOD (see the header). */
  f: number
  /** Exact world-space end of the latest resolved hitscan. Added softly:
   * older peers omit it and receivers fall back to yaw/pitch. */
  t?: [number, number, number]
}

/** Ring capacity — 24 snapshots ≈ 2 s of history at the 12 Hz base rate. */
export const RING_CAP = 24
/** The SMALLEST interpolation cushion (ms) — ~2 network frames at 12 Hz. */
export const INTERP_DELAY_MIN_MS = 150
/** Kept for callers that want a fixed delay (PvP's roster raycast, tests). */
export const INTERP_DELAY_MS = INTERP_DELAY_MIN_MS
/** The LARGEST cushion a jittery peer can earn (ms) — visual latency cap. */
export const INTERP_DELAY_MAX_MS = 320
/** Delay margin per ms of measured arrival jitter (EMA of |offset deviation|). */
export const INTERP_JITTER_GAIN = 3
/** Fixed slack (ms) over the measured spacing before the clamp. */
export const INTERP_SLACK_MS = 40
/** The delay moves at most this fast (ms per second) — never a visible jump. */
export const INTERP_DELAY_SLEW_MS_PER_S = 120
/** Extrapolate at most this far past the newest snapshot, then freeze. */
export const EXTRAPOLATE_MAX_MS = 200
/** Gravity the extrapolator assumes for an airborne peer (m/s²) — MUST equal
 * movement.MOVE.gravity (pinned by a test; not imported so this module stays
 * free of the kinematics module). */
export const WIRE_GRAVITY = 16
/** An airborne peer past its newest frame never sinks more than this (m)
 * below that frame — the ground is at most one network frame away. */
export const EXTRAP_SINK_M = 0.15
/** A newest frame whose wire speed `s` is at or under this is a peer that has
 * STOPPED: past it the pose holds instead of sliding on the last pair's
 * velocity — the stop is the one moment the last pair is always wrong about. */
export const EXTRAP_STOPPED_S = 0.02
/** Consecutive snapshots farther apart than this (m) snap, never lerp. */
export const TELEPORT_SNAP_M = 3
/** A remote silent longer than this (ms) is despawned by presence.ts. */
export const STALE_MS = 3000
/** Coordinate sanity bound — anything beyond is a hostile/corrupt frame. */
export const POS_LIMIT = 1e5
/** Weapon-id length bound (oversize guard — ids are short slugs). */
export const WEAPON_ID_MAX = 24
/** Longest nickname accepted off the wire (matches nickname.NICK_MAX). */
export const NICK_WIRE_MAX = 16
/** The fire counter wraps here (two hex digits on the wire). */
export const SHOT_COUNTER_MOD = 256
/**
 * Most shots one pose frame may ever be read as. A publish tick is ~83 ms and
 * the fastest gun is 24 rounds/s, so two is the honest maximum and three is
 * slack for a dropped frame; past that the delta is a peer who was firing while
 * out of range, a reconnect, or a hostile counter, and the answer to all three
 * is the same — voice a burst, not the difference of two integers.
 */
export const MAX_SHOTS_PER_SAMPLE = 3

/**
 * How many shots a peer fired between the count we last SAW and the one we are
 * looking at now (pure, tested).
 *
 * `last < 0` means "never sampled": a peer who joins mid-magazine, or whose
 * first frame we get at shot 57, must not open with a 57-round salvo, so the
 * first sighting adopts the count silently and returns 0. Equal counts are 0.
 * The subtraction is modular (the counter wraps) and the result is capped, so a
 * garbage or hostile count costs a burst of MAX_SHOTS_PER_SAMPLE and no more.
 */
export function shotsFired(last: number, current: number): number {
  if (!Number.isFinite(current) || current < 0) return 0
  if (!Number.isFinite(last) || last < 0) return 0
  const delta = (current - last + SHOT_COUNTER_MOD) % SHOT_COUNTER_MOD
  return delta > MAX_SHOTS_PER_SAMPLE ? MAX_SHOTS_PER_SAMPLE : delta
}

/** One stored snapshot — a ring slot, mutated in place on push. */
export type Snapshot = {
  sentAt: number
  x: number
  y: number
  z: number
  yaw: number
  pitch: number
  w: string
  s: number
  g: boolean
  st: boolean
  a: number
  f: number
  tx: number
  ty: number
  tz: number
  ht: boolean
}

export type SnapshotRing = {
  cap: number
  /** Preallocated slots — never replaced, only overwritten. */
  slots: Snapshot[]
  /** Index of the NEWEST written slot (meaningless while count === 0). */
  head: number
  count: number
}

export function createRing(cap = RING_CAP): SnapshotRing {
  const slots: Snapshot[] = []
  for (let i = 0; i < cap; i++) {
    slots.push({
      sentAt: 0,
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      pitch: 0,
      w: 'knife',
      s: 0,
      g: true,
      st: false,
      a: 0,
      f: 0,
      tx: 0,
      ty: 0,
      tz: 0,
      ht: false,
    })
  }
  return { cap, slots, head: cap - 1, count: 0 }
}

/**
 * Push a validated frame stamped `sentAt` (the bus envelope's clock).
 * Returns false when the frame is out of order (sentAt ≤ newest) — dropped,
 * the ring never rewinds. The oldest slot is recycled once full.
 */
export function pushSnapshot(ring: SnapshotRing, sentAt: number, frame: PresenceFrame): boolean {
  if (ring.count > 0 && sentAt <= ring.slots[ring.head]!.sentAt) return false
  const head = (ring.head + 1) % ring.cap
  const slot = ring.slots[head]!
  slot.sentAt = sentAt
  slot.x = frame.p[0]
  slot.y = frame.p[1]
  slot.z = frame.p[2]
  slot.yaw = frame.yaw
  slot.pitch = frame.pitch
  slot.w = frame.w
  slot.s = frame.s
  slot.g = frame.g
  slot.st = frame.st
  slot.a = frame.a ?? 0
  slot.f = frame.f
  slot.ht = frame.t !== undefined
  slot.tx = frame.t?.[0] ?? 0
  slot.ty = frame.t?.[1] ?? 0
  slot.tz = frame.t?.[2] ?? 0
  ring.head = head
  if (ring.count < ring.cap) ring.count++
  return true
}

export function latestSnapshot(ring: SnapshotRing): Snapshot | null {
  return ring.count > 0 ? ring.slots[ring.head]! : null
}

/** Caller-owned sample target — reuse ONE per render loop (zero alloc). */
export type SampledPose = {
  x: number
  y: number
  z: number
  yaw: number
  pitch: number
  w: string
  s: number
  g: boolean
  st: boolean
  a: number
  /** Fire counter of the snapshot whose moment this sample has REACHED — see
   * sampleAt for why it is the older side of a bracket, not the newer. */
  f: number
  /** Exact target paired with `f`; false for older clients. */
  ht: boolean
  tx: number
  ty: number
  tz: number
  /** True once extrapolation hit its 200 ms cap — the pose is frozen. */
  frozen: boolean
  /** The velocity (m/s) this sample MOVED with: the bracket slope in the lerp
   * branch, the last pair's slope (gravity-integrated while airborne) when
   * extrapolating; 0 when frozen, on a teleport pair, clamped to the oldest
   * snapshot, or with a lone snapshot. */
  vx: number
  vy: number
  vz: number
}

export function createSampledPose(): SampledPose {
  return {
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    w: 'knife',
    s: 0,
    g: true,
    st: false,
    a: 0,
    f: 0,
    ht: false,
    tx: 0,
    ty: 0,
    tz: 0,
    frozen: false,
    vx: 0,
    vy: 0,
    vz: 0,
  }
}

/** Shortest-arc angle interpolation — a→b across the ±π seam takes the
 * short way (never the 350° scenic route). */
export function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  else if (d < -Math.PI) d += Math.PI * 2
  return a + d * t
}

/** Wrapped absolute angular distance (used by the publish change gate). */
export function angleDist(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  else if (d < -Math.PI) d += Math.PI * 2
  return Math.abs(d)
}

function copyPose(from: Snapshot, out: SampledPose): void {
  out.x = from.x
  out.y = from.y
  out.z = from.z
  out.yaw = from.yaw
  out.pitch = from.pitch
  out.w = from.w
  out.s = from.s
  out.g = from.g
  out.st = from.st
  out.a = from.a
  out.f = from.f
  out.ht = from.ht
  out.tx = from.tx
  out.ty = from.ty
  out.tz = from.tz
  out.frozen = false
  out.vx = 0
  out.vy = 0
  out.vz = 0
}

/** Logical-order slot access: index 0 = oldest, count-1 = newest. */
function slotAt(ring: SnapshotRing, i: number): Snapshot {
  return ring.slots[(ring.head - (ring.count - 1) + i + ring.cap * 2) % ring.cap]!
}

/**
 * Sample the remote pose at `renderTime` (same clock as the pushed sentAt
 * values — presence.ts maps local time through its per-remote clock offset).
 * Writes into `out`; returns false only when the ring is empty. See the
 * header for the lerp / extrapolate-then-freeze / teleport-snap model.
 */
export function sampleAt(ring: SnapshotRing, renderTime: number, out: SampledPose): boolean {
  const n = ring.count
  if (n === 0) return false
  const newest = ring.slots[ring.head]!

  // At or past the newest snapshot: extrapolate along the last pair's
  // velocity (≤ 200 ms), unless that pair was a teleport (no velocity).
  if (renderTime >= newest.sentAt) {
    copyPose(newest, out)
    const ahead = renderTime - newest.sentAt
    out.frozen = ahead > EXTRAPOLATE_MAX_MS
    if (n >= 2 && ahead > 0) {
      const prev = ring.slots[(ring.head - 1 + ring.cap) % ring.cap]!
      const dtPair = newest.sentAt - prev.sentAt
      const dx = newest.x - prev.x
      const dy = newest.y - prev.y
      const dz = newest.z - prev.z
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
      // A stopped sender (wire s ≈ 0, on the ground) holds: its last pair
      // still carries the deceleration, and sliding a peer who has planted
      // their feet — then gliding them back when the 500 ms keep-alive lands —
      // was the most visible artifact of every stop.
      const stopped = newest.g && newest.s <= EXTRAP_STOPPED_S
      if (dtPair > 0 && dist <= TELEPORT_SNAP_M && !stopped) {
        const t = Math.min(ahead, EXTRAPOLATE_MAX_MS) / 1000 // s
        const vx = (dx / dtPair) * 1000
        const vy = (dy / dtPair) * 1000
        const vz = (dz / dtPair) * 1000
        out.x += vx * t
        out.z += vz * t
        if (newest.g) {
          out.y += vy * t
          out.vy = vy
        } else {
          // Airborne: a ballistic guess, floored just under the newest frame.
          // A falling peer whose next frame is late would otherwise sink
          // through the floor (8 m/s × 200 ms = 1.6 m) before freezing.
          const y = newest.y + vy * t - 0.5 * WIRE_GRAVITY * t * t
          const floor = newest.y - EXTRAP_SINK_M
          if (y > floor) {
            out.y = y
            out.vy = vy - WIRE_GRAVITY * t
          } else {
            out.y = floor
            out.vy = 0
          }
        }
        if (!out.frozen) {
          out.vx = vx
          out.vz = vz
        } else {
          out.vx = 0
          out.vy = 0
          out.vz = 0
        }
      }
    }
    return true
  }

  // Before the oldest snapshot: clamp (a very-late joiner's first sample).
  const oldest = slotAt(ring, 0)
  if (renderTime <= oldest.sentAt) {
    copyPose(oldest, out)
    return true
  }

  // Bracketing pair a ≤ t ≤ b — walk newest-ward (t is usually near the
  // head, so scanning from the back exits in one or two steps).
  for (let i = n - 1; i >= 1; i--) {
    const b = slotAt(ring, i)
    const a = slotAt(ring, i - 1)
    if (renderTime >= a.sentAt && renderTime <= b.sentAt) {
      const dx = b.x - a.x
      const dy = b.y - a.y
      const dz = b.z - a.z
      if (Math.sqrt(dx * dx + dy * dy + dz * dz) > TELEPORT_SNAP_M) {
        // Teleport pair — snap to the far side, never tween across the map.
        copyPose(b, out)
        return true
      }
      const span = b.sentAt - a.sentAt
      const alpha = (renderTime - a.sentAt) / span
      out.x = a.x + dx * alpha
      out.y = a.y + dy * alpha
      out.z = a.z + dz * alpha
      out.vx = (dx / span) * 1000
      out.vy = (dy / span) * 1000
      out.vz = (dz / span) * 1000
      out.yaw = lerpAngle(a.yaw, b.yaw, alpha)
      out.pitch = lerpAngle(a.pitch, b.pitch, alpha)
      out.s = a.s + (b.s - a.s) * alpha
      // Discrete fields ride the newer snapshot of the bracket.
      out.w = b.w
      out.g = b.g
      out.st = b.st
      out.a = a.a + (b.a - a.a) * alpha
      // …EXCEPT the fire counter, which rides the OLDER one. Every other
      // discrete field is a state we would rather show early than late; a shot
      // is an INSTANT, and taking b's count the moment we start bracketing the
      // pair would voice it a whole frame (~83 ms) before the avatar's pose got
      // there. Reading a's means a count becomes visible exactly when render
      // time reaches the snapshot that carried it — and it stays monotone,
      // because the next bracket's older side is this bracket's newer one.
      out.f = a.f
      out.ht = a.ht
      out.tx = a.tx
      out.ty = a.ty
      out.tz = a.tz
      out.frozen = false
      return true
    }
  }
  // Unreachable with a monotonic ring, but never leave `out` stale.
  copyPose(newest, out)
  return true
}

/** Staleness reducer — presence.ts despawns remotes this predicate flags. */
export function isStale(lastReceivedAt: number, now: number): boolean {
  return now - lastReceivedAt > STALE_MS
}

// ── Arrival timing (pure) ────────────────────────────────────────────────────

/**
 * What a peer's frames actually look like when they get here. Fed by
 * presence.ingestPoseFrame with every accepted frame; read by interpDelayFor
 * and dumped through presenceDebug so a real relay can be measured from a
 * prod session before any constant is tuned.
 */
export type ArrivalTiming = {
  /** EMA of the sender-clock spacing between consecutive frames (ms). */
  spacingEma: number
  /** EMA of |arrival offset − offset EMA| (ms) — the jitter the delay must cover. */
  jitterEma: number
  /** sentAt of the last frame folded in (NaN before the first). */
  lastSentAt: number
  /** Frames that arrived after a gap > TIMING_GAP_MS (idle/hidden, not network). */
  gaps: number
  /** The most recent such gap (ms); 0 if none yet. */
  lastGapMs: number
}

/** Spacing beyond this (ms) is an idle keep-alive (500 ms) or a throttled
 * hidden tab (1 Hz), never the network — it is counted, not sampled. */
export const TIMING_GAP_MS = 250
/** EMA gain for both timing averages (~7 frames to settle). */
export const TIMING_GAIN = 0.15
/** Spacing samples are clamped into this window (ms) before averaging. */
export const TIMING_SPACING_MIN_MS = 30

export function createTiming(): ArrivalTiming {
  return { spacingEma: 84, jitterEma: 0, lastSentAt: Number.NaN, gaps: 0, lastGapMs: 0 }
}

/**
 * Fold one accepted frame in. `offsetDeviationMs` is |(now − sentAt) − the
 * peer's clock-offset EMA| as the caller measured it (0 for a first frame).
 */
export function updateTiming(t: ArrivalTiming, sentAt: number, offsetDeviationMs: number): void {
  if (Number.isFinite(t.lastSentAt)) {
    const spacing = sentAt - t.lastSentAt
    if (spacing > TIMING_GAP_MS) {
      t.gaps++
      t.lastGapMs = spacing
    } else if (spacing > 0) {
      const clamped = spacing < TIMING_SPACING_MIN_MS ? TIMING_SPACING_MIN_MS : spacing
      t.spacingEma += (clamped - t.spacingEma) * TIMING_GAIN
      const dev = offsetDeviationMs > 0 ? offsetDeviationMs : 0
      t.jitterEma += (dev - t.jitterEma) * TIMING_GAIN
    }
  }
  t.lastSentAt = sentAt
}

/** The interpolation delay (ms) a peer with this timing has earned. */
export function interpDelayFor(t: ArrivalTiming): number {
  const raw = t.spacingEma + INTERP_JITTER_GAIN * t.jitterEma + INTERP_SLACK_MS
  return raw < INTERP_DELAY_MIN_MS ? INTERP_DELAY_MIN_MS : raw > INTERP_DELAY_MAX_MS ? INTERP_DELAY_MAX_MS : raw
}

/** Move the live delay toward its target by at most the slew for this dt (s). */
export function slewDelay(current: number, target: number, dt: number): number {
  const step = INTERP_DELAY_SLEW_MS_PER_S * (dt > 0 ? dt : 0)
  const d = target - current
  if (d > step) return current + step
  if (d < -step) return current - step
  return target
}

// ── Residual smoother (pure) ─────────────────────────────────────────────────

/**
 * Between the sampled pose and the drawn root. `drawn = target + err`, where
 * `err` is whatever part of a new target the previous velocity did NOT
 * predict — beyond a small deadband — and it decays exponentially. A late
 * frame that ends an extrapolation, a stall catching up, a coalesced burst:
 * all glide. Continuous motion of any speed (a fall, a shove) predicts itself
 * exactly and is never touched, which is why this compares against the
 * ring's own velocity and not against a speed cap.
 */
export type PoseSmoother = {
  primed: boolean
  /** The residual currently added to the target (m). */
  ex: number
  ey: number
  ez: number
  /** Last target and its velocity — the prediction basis. */
  px: number
  py: number
  pz: number
  pvx: number
  pvy: number
  pvz: number
  /** Last drawn point (for maxStepM). */
  ox: number
  oy: number
  oz: number
  /** How many samples needed a correction (QA). */
  corrections: number
  /** Largest drawn step (m) since the last debug read (QA; reset by the reader). */
  maxStepM: number
}

/** Residual decay rate (1/s): a 30 cm pop is under 1 cm in ~0.3 s. */
export const SMOOTH_RATE = 12
/** Residuals up to this (m) are not corrections — wire rounding, a bracket edge. */
export const SMOOTH_DEADBAND_M = 0.03
/** The residual never exceeds this (m) — a peer is never drawn a metre off. */
export const SMOOTH_MAX_ERR_M = 1.0

export function createSmoother(): PoseSmoother {
  return {
    primed: false,
    ex: 0,
    ey: 0,
    ez: 0,
    px: 0,
    py: 0,
    pz: 0,
    pvx: 0,
    pvy: 0,
    pvz: 0,
    ox: 0,
    oy: 0,
    oz: 0,
    corrections: 0,
    maxStepM: 0,
  }
}

/**
 * One frame. `wallDt` is the REAL time since the last call (s) — the
 * prediction budget — so a 100 ms hitch is not misread as a 0.6 m pop; `dt`
 * is the game loop's clamped dt, which paces the decay like every other
 * blend. Writes the drawn point into `out`.
 */
export function smoothPose(
  sm: PoseSmoother,
  x: number,
  y: number,
  z: number,
  vx: number,
  vy: number,
  vz: number,
  wallDt: number,
  dt: number,
  out: { x: number; y: number; z: number },
): void {
  if (!sm.primed) {
    sm.primed = true
    sm.ex = 0
    sm.ey = 0
    sm.ez = 0
    out.x = x
    out.y = y
    out.z = z
  } else {
    // Yesterday's residual decays first; then whatever this sample did that
    // the last velocity did not predict is absorbed whole (beyond the
    // deadband) — so the frame OF a pop moves the drawn point by exactly
    // v·dt + deadband, and the glide starts the frame after.
    const decay = Math.exp(-SMOOTH_RATE * (dt > 0 ? dt : 0))
    sm.ex *= decay
    sm.ey *= decay
    sm.ez *= decay
    const w = wallDt > 0 ? wallDt : 0
    const rx = x - (sm.px + sm.pvx * w)
    const ry = y - (sm.py + sm.pvy * w)
    const rz = z - (sm.pz + sm.pvz * w)
    const r = Math.sqrt(rx * rx + ry * ry + rz * rz)
    if (r >= TELEPORT_SNAP_M) {
      sm.ex = 0
      sm.ey = 0
      sm.ez = 0
    } else if (r > SMOOTH_DEADBAND_M) {
      const k = 1 - SMOOTH_DEADBAND_M / r
      sm.ex -= rx * k
      sm.ey -= ry * k
      sm.ez -= rz * k
      sm.corrections++
    }
    const e = Math.sqrt(sm.ex * sm.ex + sm.ey * sm.ey + sm.ez * sm.ez)
    if (e > SMOOTH_MAX_ERR_M) {
      const c = SMOOTH_MAX_ERR_M / e
      sm.ex *= c
      sm.ey *= c
      sm.ez *= c
    }
    out.x = x + sm.ex
    out.y = y + sm.ey
    out.z = z + sm.ez
    const sx = out.x - sm.ox
    const sy = out.y - sm.oy
    const sz = out.z - sm.oz
    const step = Math.sqrt(sx * sx + sy * sy + sz * sz)
    if (step > sm.maxStepM) sm.maxStepM = step
  }
  sm.px = x
  sm.py = y
  sm.pz = z
  sm.pvx = vx
  sm.pvy = vy
  sm.pvz = vz
  sm.ox = out.x
  sm.oy = out.y
  sm.oz = out.z
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * Wire-frame validation — the trust boundary for everything a peer sends.
 * Rejects (returns null): non-objects, wrong protocol version, unknown
 * phase, malformed/NaN/oversize positions or angles, non-boolean flags,
 * oversize weapon ids. Clamps `s` into [0,1] and folds `f` into 0..255 (soft
 * fields — never worth dropping a frame over; `f` may be absent entirely on an
 * older peer's frames). Returns a NORMALIZED copy, never the input — so no
 * attacker-owned object, prototype or getter is ever retained, and only the
 * fields below can exist downstream.
 *
 * TOTAL by construction: any throw while reading the payload (a hostile
 * getter — impossible through JSON transport, but the boundary owes nothing
 * to the sender's good behaviour) reads as an invalid frame.
 */
export function validateFrame(data: unknown): PresenceFrame | null {
  try {
    return readFrame(data)
  } catch {
    return null
  }
}

function readFrame(data: unknown): PresenceFrame | null {
  if (typeof data !== 'object' || data === null) return null
  const f = data as Record<string, unknown>
  if (f.v !== 1) return null
  if (f.ph !== 'game' && f.ph !== 'editor') return null
  const p = f.p
  if (!Array.isArray(p) || p.length !== 3) return null
  if (!isFiniteNumber(p[0]) || !isFiniteNumber(p[1]) || !isFiniteNumber(p[2])) return null
  if (Math.abs(p[0]) > POS_LIMIT || Math.abs(p[1]) > POS_LIMIT || Math.abs(p[2]) > POS_LIMIT) {
    return null
  }
  if (!isFiniteNumber(f.yaw) || Math.abs(f.yaw) > Math.PI * 2) return null
  if (!isFiniteNumber(f.pitch) || Math.abs(f.pitch) > Math.PI) return null
  if (typeof f.w !== 'string' || f.w.length === 0 || f.w.length > WEAPON_ID_MAX) return null
  if (!isFiniteNumber(f.s)) return null
  if (typeof f.g !== 'boolean' || typeof f.st !== 'boolean') return null
  const target = f.t
  const normalizedTarget: [number, number, number] | undefined =
    Array.isArray(target) &&
    target.length === 3 &&
    isFiniteNumber(target[0]) &&
    isFiniteNumber(target[1]) &&
    isFiniteNumber(target[2]) &&
    Math.abs(target[0]) <= POS_LIMIT &&
    Math.abs(target[1]) <= POS_LIMIT &&
    Math.abs(target[2]) <= POS_LIMIT
      ? [target[0], target[1], target[2]]
      : undefined
  return {
    v: 1,
    ph: f.ph,
    p: [p[0], p[1], p[2]],
    yaw: f.yaw,
    pitch: f.pitch,
    w: f.w,
    s: f.s < 0 ? 0 : f.s > 1 ? 1 : f.s,
    g: f.g,
    st: f.st,
    a: isFiniteNumber(f.a) ? (f.a < 0 ? 0 : f.a > 1 ? 1 : f.a) : 0,
    // Soft field, like `s`, and for the same reason twice over: it was added
    // after v1 shipped (an older peer simply has none) and a nonsense count is
    // never worth dropping a whole pose over — the shot-delta cap upstream
    // already bounds what a bad one can cost. Normalized into 0..255 here so
    // nothing downstream has to think about it.
    f: isFiniteNumber(f.f) ? ((Math.trunc(f.f) % SHOT_COUNTER_MOD) + SHOT_COUNTER_MOD) % SHOT_COUNTER_MOD : 0,
    ...(normalizedTarget ? { t: normalizedTarget } : {}),
    // Soft, like `f`: absent on an older peer, and a hostile value is capped,
    // never a dropped pose. Control chars stripped so canvas fillText can't be
    // fooled; length bounded so the tag texture never blows up.
    nm:
      typeof f.nm === 'string'
        ? f.nm
            .replace(/[\u0000-\u001f\u007f]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, NICK_WIRE_MAX) || undefined
        : undefined,
  }
}
