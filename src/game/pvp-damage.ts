import { Vector3 } from 'three'
import { EYE_HEIGHT } from './collision'
import { localSessionId, type NetMessage, onFrame, publishFrame, registerFrameKind } from './net'
import { damagePlayer, playerRig } from './player'
import { getRemotes } from './presence'
import { INTERP_DELAY_MS, sampleAt, type SampledPose } from './presence-interp'
import { type PlayerRayHit, registerPvpRoutes } from './shooting'

/**
 * PLAYER-VS-PLAYER HIT DAMAGE — you can tag another player with your gun, and
 * it hurts them exactly the way a zombie does: a red edge-flash, a shove, and
 * the walk-lock stagger if you tag them enough. It NEVER kills (owner: "not
 * killed for now") — and it can't, because `damagePlayer` has no death path
 * (health floors into a 2.5 s stagger, never below).
 *
 * SHOOTER-AUTHORITATIVE. The shooter already owns the hitscan, the aim, and the
 * weapon damage, and sees each peer at the same interpolated pose it is drawing
 * — so "what you shoot is what you hit". On a hit it bumps a per-victim counter
 * and broadcasts it; the VICTIM is the sole applier of its own hurt. Clean
 * split: shooter decides the hit, victim decides (and bounds) the effect.
 *
 * The wire is a MONOTONE COUNTER, not an event — the same trick the gunfire
 * field `f` uses. The host coalesces to the latest value per kind every ~66 ms,
 * so a naive "one frame per hit" would silently drop rapid tags (shotgun,
 * minigun). A cumulative counter means the latest surviving frame always
 * carries the full count; the victim diffs against what it last saw.
 *
 * Avatars are deliberately NOT world colliders (remote-players.tsx anti-goal),
 * so hit detection tests the ray against the live roster's interpolated poses,
 * never `world.colliders`.
 */

const PVP_KIND = 'boots/pvp-hit'

/** Damage per tag — matched to a droid bite so a few hits stagger (red +
 * walk-lock) and nothing kills. */
export const PVP_DAMAGE = 10

/** Player hit capsule radius: the movement capsule is 0.34; a touch wider here
 * for forgiving PvP hit-reg against a 150 ms-interpolated target. */
const HIT_RADIUS = 0.42

/** Never let one coalesced frame (a hitch that merged many tags) burst more
 * than this — bounds a bad frame to "annoying", never a one-frame beatdown. */
const MAX_BURST = 4

// ── Pure cores (exported for tests) ─────────────────────────────────────────

/**
 * Closest-approach ray vs a VERTICAL capsule (axis feet→feet+height). Returns
 * the ray distance `t` of the hit, or null on a miss / behind / past maxDist.
 * Direction must be unit length. Mirrors the dog-capsule test in enemies-state.
 */
export function rayHitsCapsule(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  feetX: number, feetY: number, feetZ: number,
  height: number, radius: number, maxDist: number,
): number | null {
  const wx = feetX - ox
  const wy = feetY - oy
  const wz = feetZ - oz
  const a = height * height
  const b = height * dy
  const d0 = height * wy
  const e = dx * wx + dy * wy + dz * wz
  const denom = a - b * b
  let sSeg = denom > 1e-8 ? (b * e - d0) / denom : 0
  sSeg = sSeg < 0 ? 0 : sSeg > 1 ? 1 : sSeg
  const t = e + sSeg * b
  if (t < 0 || t > maxDist) return null
  const px = feetX - (ox + dx * t)
  const py = feetY + sSeg * height - (oy + dy * t)
  const pz = feetZ - (oz + dz * t)
  return px * px + py * py + pz * pz <= radius * radius ? t : null
}

/**
 * Idempotent counter-diff for one shooter, keyed in `seen` by shooter id.
 * Returns how many NEW tags to apply (0..maxBurst), advancing `seen`. A
 * duplicate or reordered frame (counter ≤ last) returns 0 — the guard that
 * makes coalescing/dup delivery safe.
 */
export function consumeHits(
  shooterId: string,
  myCounter: number | undefined,
  seen: Map<string, number>,
  maxBurst: number,
): number {
  if (typeof myCounter !== 'number' || !Number.isFinite(myCounter)) return 0
  const last = seen.get(shooterId) ?? 0
  if (myCounter <= last) return 0
  seen.set(shooterId, myCounter)
  return Math.min(myCounter - last, maxBurst)
}

// ── Roster raycast ──────────────────────────────────────────────────────────
const _sample: SampledPose = {
  x: 0, y: 0, z: 0, yaw: 0, pitch: 0, w: 'knife', s: 0, g: true, st: false, f: 0, frozen: false,
}

function sampleRemoteNow(remote: {
  ring: Parameters<typeof sampleAt>[0]
  clockOffset: number
}): boolean {
  const offset = Number.isNaN(remote.clockOffset) ? 0 : remote.clockOffset
  return sampleAt(remote.ring, Date.now() - offset - INTERP_DELAY_MS, _sample)
}

/**
 * Ray vs the LIVE remote roster. Each GAME-PHASE peer is sampled exactly where
 * its avatar is drawn (same interpolation), tested as a vertical capsule from
 * feet (eye − EYE_HEIGHT) to eye. Nearest within maxDist wins. Spectators
 * (ph 'editor') are skipped — they have no avatar and cannot be shot.
 */
export function raycastRemotePlayers(
  origin: Vector3,
  direction: Vector3,
  maxDist: number,
): PlayerRayHit | null {
  let best: PlayerRayHit | null = null
  for (const remote of getRemotes().values()) {
    if (remote.ph !== 'game') continue
    if (!sampleRemoteNow(remote)) continue
    const t = rayHitsCapsule(
      origin.x, origin.y, origin.z,
      direction.x, direction.y, direction.z,
      _sample.x, _sample.y - EYE_HEIGHT, _sample.z,
      EYE_HEIGHT, HIT_RADIUS, maxDist,
    )
    if (t === null) continue
    if (!best || t < best.distance) {
      best = {
        sessionId: remote.sessionId,
        distance: t,
        point: new Vector3(
          origin.x + direction.x * t,
          origin.y + direction.y * t,
          origin.z + direction.z * t,
        ),
      }
    }
  }
  return best
}

// ── Wire state ──────────────────────────────────────────────────────────────
type PvpFrame = { hits: Record<string, number> }

/** Per-victim cumulative tags WE have landed (rebuilt into every frame so the
 * latest coalesced frame is self-sufficient). */
const outgoing = new Map<string, number>()
/** Per-shooter last counter we have already applied. */
const seen = new Map<string, number>()
let active = false
let offFrame: (() => void) | null = null

export function validatePvpFrame(data: unknown): PvpFrame | null {
  if (!data || typeof data !== 'object') return null
  const raw = (data as { hits?: unknown }).hits
  if (!raw || typeof raw !== 'object') return null
  const hits: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) hits[k] = v
  }
  return { hits }
}

/** Shooter side (called from shooting.ts on a player hit): count the tag and
 * broadcast the cumulative per-victim counter. */
function recordPvpHit(sessionId: string): void {
  if (!active) return
  outgoing.set(sessionId, (outgoing.get(sessionId) ?? 0) + 1)
  const hits: Record<string, number> = {}
  for (const [k, n] of outgoing) hits[k] = n
  publishFrame(PVP_KIND, { hits })
}

const _fromDir = { x: 0, z: 0 }

/** Victim side: apply any NEW tags addressed to us, hurt direction derived from
 * the shooter's live position so the flash + shove point correctly. */
function onPvpFrame(msg: NetMessage<PvpFrame>): void {
  const mine = localSessionId()
  if (!mine) return
  const burst = consumeHits(msg.sessionId, msg.data.hits[mine], seen, MAX_BURST)
  if (burst <= 0) return
  const shooter = getRemotes().get(msg.sessionId)
  let hasDir = false
  if (shooter && sampleRemoteNow(shooter)) {
    const dx = playerRig.position.x - _sample.x
    const dz = playerRig.position.z - _sample.z
    const len = Math.hypot(dx, dz)
    if (len > 1e-4) {
      _fromDir.x = dx / len
      _fromDir.z = dz / len
      hasDir = true
    }
  }
  for (let i = 0; i < burst; i++) damagePlayer(PVP_DAMAGE, hasDir ? _fromDir : undefined)
}

/**
 * Start/stop the PvP lane — called from the game-root co-presence adapter next
 * to startWorldSync/stopWorldSync (game phase only). Registering the routes is
 * what makes a shot cast against players; clearing them makes shooting.ts
 * ignore players again. Inert without a bus (publishFrame → 'unavailable', an
 * empty roster → no hits), so single-player pays only an empty roster scan.
 */
export function startPvpSync(): void {
  if (active) return
  active = true
  outgoing.clear()
  seen.clear()
  registerFrameKind<PvpFrame>(PVP_KIND, validatePvpFrame, { ordered: false })
  offFrame = onFrame<PvpFrame>(PVP_KIND, onPvpFrame)
  registerPvpRoutes({ raycast: raycastRemotePlayers, onHit: recordPvpHit })
}

export function stopPvpSync(): void {
  if (!active) return
  active = false
  registerPvpRoutes(null)
  offFrame?.()
  offFrame = null
  outgoing.clear()
  seen.clear()
}

/** Test-only reset of the module singletons. */
export function resetPvpForTests(): void {
  active = false
  offFrame = null
  outgoing.clear()
  seen.clear()
}
