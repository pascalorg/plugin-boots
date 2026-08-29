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
 *     g: grounded, st: staggered }
 *
 * Sampling model (the classic snapshot-interpolation setup):
 * - Snapshots land in a ring (cap 24 ≈ 2 s at 12 Hz); out-of-order frames
 *   (by sentAt) are dropped — the bus gives no ordering guarantee.
 * - sampleAt(renderTime) renders REMOTES IN THE PAST: the caller passes
 *   now − INTERP_DELAY_MS (150 ms — ~2 network frames of cushion), so a
 *   bracketing snapshot pair almost always exists and motion is a lerp,
 *   never a guess. Yaw/pitch take the shortest arc.
 * - Past the newest snapshot the pose extrapolates along the last pair's
 *   velocity for at most EXTRAPOLATE_MAX_MS (200 ms), then FREEZES — a
 *   stalled peer stands still instead of sliding into the sunset.
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
}

/** Ring capacity — 24 snapshots ≈ 2 s of history at the 12 Hz base rate. */
export const RING_CAP = 24
/** Render remotes this far in the past (ms) — the interpolation cushion. */
export const INTERP_DELAY_MS = 150
/** Extrapolate at most this far past the newest snapshot, then freeze. */
export const EXTRAPOLATE_MAX_MS = 200
/** Consecutive snapshots farther apart than this (m) snap, never lerp. */
export const TELEPORT_SNAP_M = 3
/** A remote silent longer than this (ms) is despawned by presence.ts. */
export const STALE_MS = 3000
/** Coordinate sanity bound — anything beyond is a hostile/corrupt frame. */
export const POS_LIMIT = 1e5
/** Weapon-id length bound (oversize guard — ids are short slugs). */
export const WEAPON_ID_MAX = 24

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
  /** True once extrapolation hit its 200 ms cap — the pose is frozen. */
  frozen: boolean
}

export function createSampledPose(): SampledPose {
  return { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, w: 'knife', s: 0, g: true, st: false, frozen: false }
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
  out.frozen = false
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
      if (dtPair > 0 && dist <= TELEPORT_SNAP_M) {
        const k = Math.min(ahead, EXTRAPOLATE_MAX_MS) / dtPair
        out.x += dx * k
        out.y += dy * k
        out.z += dz * k
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
      const alpha = (renderTime - a.sentAt) / (b.sentAt - a.sentAt)
      out.x = a.x + dx * alpha
      out.y = a.y + dy * alpha
      out.z = a.z + dz * alpha
      out.yaw = lerpAngle(a.yaw, b.yaw, alpha)
      out.pitch = lerpAngle(a.pitch, b.pitch, alpha)
      out.s = a.s + (b.s - a.s) * alpha
      // Discrete fields ride the newer snapshot of the bracket.
      out.w = b.w
      out.g = b.g
      out.st = b.st
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

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * Wire-frame validation — the trust boundary for everything a peer sends.
 * Rejects (returns null): non-objects, wrong protocol version, unknown
 * phase, malformed/NaN/oversize positions or angles, non-boolean flags,
 * oversize weapon ids. Clamps `s` into [0,1] (a soft field — never worth
 * dropping a frame over). Returns a NORMALIZED copy, never the input.
 */
export function validateFrame(data: unknown): PresenceFrame | null {
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
  }
}
