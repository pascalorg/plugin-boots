import { Color, Vector3 } from 'three'
import { sfx } from './audio'
import { spawnDebris } from './debris'

/**
 * The horde, as data: humanoid droids that march, robot dogs that lope,
 * FPV drones that buzz overhead and dive. Beeline pursuit — the classic
 * horde grammar: they come straight at you, in numbers, and you kite them.
 * The React component integrates; this module owns state + damage so the
 * shooting path needs no React.
 *
 * PACING (owned here + enemies.tsx):
 * - GRACE: while `waveState.alerted` is false the lot is peaceful — no
 *   spawns, no wave text. Walking, building, breaking walls never wake the
 *   horde; only picking up a gun (pistol/rifle in useBoots.owned) does.
 * - ALERT: the first gun pickup starts a one-shot ALERT_SECONDS countdown
 *   ("They heard you — 5"); at 0 the wave director takes over (WAVE 1).
 * - MERCY: while the player is staggered bots never attack — ground bots
 *   hold a 4–6 m ring, drones climb +1 m and hover (see enemies.tsx).
 */

export type BotKind = 'droid' | 'dog' | 'drone'

export type Bot = {
  id: number
  kind: BotKind
  position: Vector3
  yaw: number
  health: number
  state: 'alive' | 'dying'
  /** Seconds since death started (tumble + fade). */
  deadT: number
  attackCooldown: number
  /** Per-bot animation phase. */
  phase: number
  /** Drone hover seed. */
  seed: number
}

export const BOT_STATS: Record<
  BotKind,
  { health: number; speed: number; damage: number; reach: number; bodyY: number; radius: number }
> = {
  droid: { health: 65, speed: 2.4, damage: 12, reach: 1.6, bodyY: 1.0, radius: 0.45 },
  dog: { health: 40, speed: 4.6, damage: 9, reach: 1.3, bodyY: 0.45, radius: 0.42 },
  drone: { health: 18, speed: 3.4, damage: 14, reach: 1.1, bodyY: 0, radius: 0.34 },
}

export const bots: Bot[] = []
let botId = 1

/** Length of the "they heard you" countdown after the first gun pickup. */
export const ALERT_SECONDS = 5

export const waveState = {
  wave: 0,
  /** Countdown to next wave while no bots are alive. */
  intermission: 4,
  /** Flips true on the first gun pickup — the lot stays peaceful before. */
  alerted: false,
  /** Seconds left on the one-shot "they heard you" countdown once alerted. */
  countdown: ALERT_SECONDS,
}

export function resetBots(): void {
  bots.length = 0
  waveState.wave = 0
  waveState.intermission = 4
  waveState.alerted = false
  waveState.countdown = ALERT_SECONDS
}

export function spawnBot(kind: BotKind, x: number, z: number): void {
  const y = kind === 'drone' ? 2.4 + Math.random() * 1.2 : 0
  bots.push({
    id: botId++,
    kind,
    position: new Vector3(x, y, z),
    yaw: 0,
    health: BOT_STATS[kind].health,
    state: 'alive',
    deadT: 0,
    attackCooldown: 1,
    phase: Math.random() * Math.PI * 2,
    seed: Math.random() * 1000,
  })
}

export type BotRayHit = { bot: Bot; distance: number; point: Vector3 }

const _toCenter = new Vector3()
const _closest = new Vector3()

/** Analytic ray-vs-sphere per bot body. Cheap at horde sizes. */
export function raycastBots(origin: Vector3, direction: Vector3, maxDist: number): BotRayHit | null {
  let best: BotRayHit | null = null
  for (const bot of bots) {
    if (bot.state !== 'alive') continue
    const stats = BOT_STATS[bot.kind]
    _toCenter.copy(bot.position)
    _toCenter.y += stats.bodyY
    _toCenter.sub(origin)
    const t = _toCenter.dot(direction)
    if (t < 0 || t > maxDist) continue
    _closest.copy(origin).addScaledVector(direction, t)
    _closest.sub(_toCenter.add(origin))
    if (_closest.length() > stats.radius) continue
    if (!best || t < best.distance) {
      best = { bot, distance: t, point: origin.clone().addScaledVector(direction, t) }
    }
  }
  return best
}

const SPARK = new Color('#ffb35c')
const SCRAP = new Color('#8a9099')

export function damageBot(bot: Bot, damage: number): void {
  if (bot.state !== 'alive') return
  bot.health -= damage
  sfx.botHit()
  const stats = BOT_STATS[bot.kind]
  for (let i = 0; i < 3; i++) {
    spawnDebris(
      bot.position.x,
      bot.position.y + stats.bodyY,
      bot.position.z,
      0.05,
      SPARK,
      2.2,
      0.7,
    )
  }
  if (bot.health <= 0) {
    bot.state = 'dying'
    bot.deadT = 0
    if (bot.kind === 'drone') {
      sfx.explosion()
      for (let i = 0; i < 10; i++) {
        spawnDebris(bot.position.x, bot.position.y, bot.position.z, 0.07, i % 2 ? SPARK : SCRAP, 3.4, 1.4)
      }
    } else {
      sfx.botDie()
      for (let i = 0; i < 6; i++) {
        spawnDebris(
          bot.position.x,
          bot.position.y + stats.bodyY,
          bot.position.z,
          0.08,
          SCRAP,
          2.2,
          1.6,
        )
      }
    }
  }
}
