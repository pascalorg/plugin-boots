import { Vector3 } from 'three'
import { EYE_HEIGHT } from './collision'
import { localSessionId, type NetMessage, onFrame, publishFrame, registerFrameKind } from './net'
import { damagePlayer, playerRig } from './player'
import { getRemotes } from './presence'
import { createSampledPose, INTERP_DELAY_MS, sampleAt, type SampledPose } from './presence-interp'
import { type PlayerRayHit, registerPvpRoutes } from './shooting'

/**
 * PLAYER-VS-PLAYER HIT DAMAGE — you can tag another player with your gun, and
 * it hurts them exactly the way a zombie does: a red edge-flash, a shove, and
 * the walk-lock stagger if you tag them enough. It NEVER kills (owner: "not
 * killed for now") — and it can't, because `damagePlayer` has no death path
 * (health floors into a 2.5 s stagger, never below).
 *
 * SHOOTER-AUTHORITATIVE. The shooter already owns the hitscan, the aim, and the
 * weapon damage, and tests each peer's capsule at the point its avatar is
 * DRAWN this frame (remote-players.tsx publishes it on the RemotePlayer after
 * the adaptive delay and the residual smoother) — so "what you shoot is what
 * you hit", whatever delay that peer has earned. On a hit it bumps a per-victim counter
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
 * for forgiving PvP hit-reg against a target drawn 150-320 ms in the past. */
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
const _sample: SampledPose = createSampledPose()

/**
 * A drawn position older than this (ms) is not a picture anyone is looking at:
 * the renderer writes drawnAt every frame it draws the peer, so a stale stamp
 * means the avatar is unmounted, culled, or this page has no scene. ~3 frames
 * at 12 fps — a hitching renderer keeps its drawn body; a dead one is ignored.
 */
export const DRAWN_FRESH_MS = 250

/** What the raycast needs from a RemotePlayer (structural, so tests can hand
 * in plain objects): the ring and clock for the fallback, the drawn eye. */
export type HittablePeer = {
  ring: Parameters<typeof sampleAt>[0]
  clockOffset: number
  drawnX: number
  drawnY: number
  drawnZ: number
  drawnAt: number
}

/**
 * Where this peer's capsule IS right now, into `_sample` (only x/y/z are
 * meaningful to the callers here). The DRAWN eye when the renderer stamped it
 * within DRAWN_FRESH_MS — the one position that agrees with what the shooter
 * sees, whatever adaptive delay (150-320 ms) and residual glide that peer is
 * being drawn with. Otherwise (spectator page without a scene, a peer culled
 * from the renderer, never drawn yet) the ring sampled at the floor delay, so
 * a hit is still possible. False only when there is nothing to sample.
 */
function sampleRemoteNow(remote: HittablePeer, now = Date.now()): boolean {
  if (remote.drawnAt > 0 && now - remote.drawnAt < DRAWN_FRESH_MS) {
    _sample.x = remote.drawnX
    _sample.y = remote.drawnY
    _sample.z = remote.drawnZ
    return true
  }
  const offset = Number.isNaN(remote.clockOffset) ? 0 : remote.clockOffset
  return sampleAt(remote.ring, now - offset - INTERP_DELAY_MS, _sample)
}

/**
 * Ray vs the LIVE remote roster. Each GAME-PHASE peer is tested exactly where
 * its avatar is drawn (sampleRemoteNow), as a vertical capsule from feet
 * (eye − EYE_HEIGHT) to eye. Nearest within maxDist wins. Spectators (ph
 * 'editor') are skipped — they have no avatar and cannot be shot.
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
type PvpFrame = {
  hits: Record<string, number>
  /** Cumulative vehicle impacts, kept separate so a ram can add vertical
   * launch without making a coalesced minigun burst throw somebody skyward. */
  rams?: Record<string, number>
  /** Cumulative bot damage dealt by the elected horde simulator. The latest
   * source point keeps the victim's red flash and shove directional. */
  enemy?: Record<string, { n: number; x: number; z: number }>
}

/** Per-victim cumulative tags WE have landed (rebuilt into every frame so the
 * latest coalesced frame is self-sufficient). */
const outgoing = new Map<string, number>()
const outgoingRams = new Map<string, number>()
const outgoingEnemy = new Map<string, { n: number; x: number; z: number }>()
/** Per-shooter last counter we have already applied. */
const seen = new Map<string, number>()
const seenRams = new Map<string, number>()
const seenEnemy = new Map<string, number>()
/** Driver-side debounce: overlap lasts several frames but is one impact. */
const rammedAt = new Map<string, number>()
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
  const rawRams = (data as { rams?: unknown }).rams
  const rams: Record<string, number> = {}
  if (rawRams && typeof rawRams === 'object') {
    for (const [k, v] of Object.entries(rawRams as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) rams[k] = v
    }
  }
  const rawEnemy = (data as { enemy?: unknown }).enemy
  const enemy: Record<string, { n: number; x: number; z: number }> = {}
  if (rawEnemy && typeof rawEnemy === 'object') {
    for (const [k, value] of Object.entries(rawEnemy as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const rec = value as Record<string, unknown>
      if (
        typeof rec.n === 'number' && Number.isFinite(rec.n) && rec.n >= 0 && rec.n <= 1_000_000 &&
        typeof rec.x === 'number' && Number.isFinite(rec.x) && Math.abs(rec.x) <= 100_000 &&
        typeof rec.z === 'number' && Number.isFinite(rec.z) && Math.abs(rec.z) <= 100_000
      ) enemy[k] = { n: rec.n, x: rec.x, z: rec.z }
    }
  }
  return {
    hits,
    ...(Object.keys(rams).length > 0 ? { rams } : {}),
    ...(Object.keys(enemy).length > 0 ? { enemy } : {}),
  }
}

function publishPvpCounters(): void {
  const hits: Record<string, number> = {}
  const rams: Record<string, number> = {}
  const enemy: Record<string, { n: number; x: number; z: number }> = {}
  for (const [k, n] of outgoing) hits[k] = n
  for (const [k, n] of outgoingRams) rams[k] = n
  for (const [k, rec] of outgoingEnemy) enemy[k] = { ...rec }
  publishFrame(PVP_KIND, {
    hits,
    ...(outgoingRams.size > 0 ? { rams } : {}),
    ...(outgoingEnemy.size > 0 ? { enemy } : {}),
  })
}

/** Shooter side (called from shooting.ts on a player hit): count the tag and
 * broadcast the cumulative per-victim counter. */
function recordPvpHit(sessionId: string): void {
  if (!active) return
  outgoing.set(sessionId, (outgoing.get(sessionId) ?? 0) + 1)
  publishPvpCounters()
}

/** Driver-authoritative overlap against the same live/drawn remote poses used
 * by hitscan. One overlap per player per second becomes one heavy red damage
 * pulse plus a grenade-like loft on the victim's own client. */
export function ramRemotePlayersAt(x: number, z: number, radius: number, now = Date.now()): number {
  if (!active) return 0
  let hit = 0
  const radiusSq = radius * radius
  for (const remote of getRemotes().values()) {
    if (remote.ph !== 'game' || !sampleRemoteNow(remote, now)) continue
    const dx = _sample.x - x
    const dz = _sample.z - z
    if (dx * dx + dz * dz > radiusSq) continue
    if (now - (rammedAt.get(remote.sessionId) ?? -Infinity) < 1_000) continue
    rammedAt.set(remote.sessionId, now)
    outgoingRams.set(remote.sessionId, (outgoingRams.get(remote.sessionId) ?? 0) + 1)
    hit++
  }
  if (hit > 0) publishPvpCounters()
  return hit
}

/** Horde-authority side: address damage to the player the shared bot chose. */
export function recordEnemyHit(sessionId: string, damage: number, x: number, z: number): void {
  if (!active || !(damage > 0)) return
  const prior = outgoingEnemy.get(sessionId)
  outgoingEnemy.set(sessionId, {
    n: (prior?.n ?? 0) + damage,
    x,
    z,
  })
  publishPvpCounters()
}

const _fromDir = { x: 0, z: 0 }

/** Victim side: apply any NEW tags addressed to us, hurt direction derived from
 * the shooter's live position so the flash + shove point correctly. */
function onPvpFrame(msg: NetMessage<PvpFrame>): void {
  const mine = localSessionId()
  if (!mine) return
  const burst = consumeHits(msg.sessionId, msg.data.hits[mine], seen, MAX_BURST)
  const rams = consumeHits(msg.sessionId, msg.data.rams?.[mine], seenRams, 1)
  const enemyRec = msg.data.enemy?.[mine]
  const enemyKey = `${msg.sessionId}:${mine}`
  const enemyPrior = seenEnemy.get(enemyKey) ?? 0
  const enemyDamage = enemyRec && enemyRec.n > enemyPrior
    ? Math.min(60, enemyRec.n - enemyPrior)
    : 0
  if (enemyRec && enemyRec.n > enemyPrior) seenEnemy.set(enemyKey, enemyRec.n)
  if (burst <= 0 && rams <= 0 && enemyDamage <= 0) return
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
  if (rams > 0) {
    damagePlayer(38, hasDir ? _fromDir : undefined)
    playerRig.launch(5.8)
    playerRig.shake(3.2)
  }
  if (enemyDamage > 0 && enemyRec) {
    const dx = playerRig.position.x - enemyRec.x
    const dz = playerRig.position.z - enemyRec.z
    const len = Math.hypot(dx, dz)
    damagePlayer(
      enemyDamage,
      len > 1e-4 ? { x: dx / len, z: dz / len } : undefined,
    )
  }
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
  outgoingRams.clear()
  outgoingEnemy.clear()
  seen.clear()
  seenRams.clear()
  seenEnemy.clear()
  rammedAt.clear()
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
  outgoingRams.clear()
  outgoingEnemy.clear()
  seen.clear()
  seenRams.clear()
  seenEnemy.clear()
  rammedAt.clear()
}

/** Test-only reset of the module singletons. */
export function resetPvpForTests(): void {
  active = false
  offFrame = null
  outgoing.clear()
  outgoingRams.clear()
  outgoingEnemy.clear()
  seen.clear()
  seenRams.clear()
  seenEnemy.clear()
  rammedAt.clear()
}
