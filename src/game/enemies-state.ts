import { Box3, Color, Vector3 } from 'three'
import { sfx } from './audio'
import { spawnDebris } from './debris'
import { probeLandingY } from './destruction'
import type { DoorEntry, GameWorld } from './world'

/**
 * The horde, as data: humanoid droids that march, robot dogs that lope,
 * FPV drones that buzz overhead and dive. Beeline pursuit — the classic
 * horde grammar: they come straight at you, in numbers, and you kite them.
 * The React component integrates; this module owns state + damage so the
 * shooting path needs no React.
 *
 * PACING (owned here + enemies.tsx):
 * - GRACE: while `waveState.alerted` is false the lot is peaceful — no
 *   spawns, no wave text. Walking, building, breaking walls, and CRUCIALLY
 *   gearing up never wake the horde — combat is strictly OPT-IN. The ONLY
 *   trigger is the industrial breaker switch on the wall stub by the spawn
 *   tables (guntable.tsx → armWaves()).
 * - ALERT: throwing the switch starts a one-shot ALERT_SECONDS countdown
 *   ("⚠ AI robot zombies incoming — 5") over a rising machine spin-up, a
 *   clack per tick; at 0 the line flashes HERE THEY COME and the wave
 *   director takes over (WAVE 1). `waveState.countdownActive` is true for
 *   exactly that window — the switch-wall siren beacon spins off it.
 *   resetBots() re-arms the whole grace→alert cycle (and resets the switch
 *   handle back UP — it mirrors `waveState.armed`).
 * - MERCY: while the player is staggered bots never attack — ground bots
 *   hold a 4–6 m ring, drones climb +1 m and hover (see enemies.tsx).
 * - DOORWAYS: ground bots stuck against a facade hunt the nearest closed
 *   door and fumble it open (pure clocks + candidate pick down below; the
 *   walk/pause/toggle state machine is in enemies.tsx). Drones never do.
 *
 * DEV/E2E: `debugFlags.botsFrozen` — while true the enemies frame loop
 * skips ALL bot steering and attacks (pursuit, mercy-ring standoff, drone
 * hover-tracking, melee); bots keep animating in place and dying bots still
 * finish their tumble. Toggled via the `__boots.setBotsFrozen(v)` dev handle
 * (game-root.tsx); resetBots() clears it so it never leaks across sessions.
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
  /** Ground bots: seconds of near-zero progress vs intent (wall contact). */
  blockedT: number
  /** Ground bots: remaining wall-follow seconds (0 = normal pursuit). */
  followT: number
  /** Ground bots: wall-follow tangent side, +1 or -1. */
  followSign: number
  /** Drones: extra altitude (m) gained to clear obstacles under the path. */
  climb: number
  /** Ground bots: cached landing plane under the feet (settleGroundBot). */
  groundY: number
  /** Ground bots: seconds until the landing plane re-probes. */
  groundT: number
  /** Ground bots: seconds spent hindered (blocked OR wall-following) — the
   * doorway-hunt clock. Unlike blockedT it survives wall-follow stints, so
   * a bot grinding the same facade keeps accruing (accrueDoorStuck). */
  stuckT: number
  /** Ground bots: seconds until the next door-candidate scan while stuck
   * (doorScanDue — the ≤1-check-per-0.5s budget). */
  doorScanT: number
  /** Ground bots: nodeId of the door being approached/fumbled (null = none). */
  doorId: string | null
  /** Ground bots: door approach point, world XZ (setDoorApproach). */
  doorX: number
  doorZ: number
  /** Ground bots: remaining fumble pause at the leaf before the toggle
   * (0 = not fumbling yet). */
  doorFumbleT: number
  /** Ground bots: seconds on the current door mission (TTL abort). */
  doorT: number
}

/** Ground-bot (droid/dog) capsule for wall push-out — see BOT WALL RULE in
 * enemies.tsx. y is feet, like the player capsule. */
export const GROUND_BOT_CAPSULE = { radius: 0.35, height: 1.2 }

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

/** Dev/E2E toggles — see header. Not used by any gameplay path directly. */
export const debugFlags = { botsFrozen: false }

/** Length of the "robot zombies incoming" countdown after the switch throw. */
export const ALERT_SECONDS = 5

export const waveState = {
  wave: 0,
  /** Countdown to next wave while no bots are alive. */
  intermission: 4,
  /**
   * The industrial breaker switch (guntable.tsx) — true from the throw until
   * resetBots(). Combat is strictly OPT-IN: this flag is the ONLY thing the
   * wave director reads to leave grace. Gun pickups never touch it — you can
   * carry the whole arsenal for an hour and the lot stays peaceful. The
   * switch handle mirrors it every frame (down while armed, back UP on reset).
   */
  armed: false,
  /** Flips true when the armed director starts the alert — peaceful before. */
  alerted: false,
  /** Seconds left on the one-shot alert countdown once alerted. */
  countdown: ALERT_SECONDS,
  /**
   * COUNTDOWN THEATRE FLAG — true for exactly the post-throw alert window
   * (switch thrown → countdown hits 0), false before, after, and on reset.
   * Owned by the director tick below; the switch-wall siren beacon reads it
   * every frame to spin its red head + run sfx.sirenLoop while the HUD line
   * ticks "⚠ AI robot zombies incoming — N". Poll it — no events fire.
   */
  countdownActive: false,
}

/**
 * Throw the breaker: arm the wave director. Idempotent — a second E on the
 * thrown switch (or during the assault) changes nothing. The alert theatre
 * itself starts on the next director tick (tickWaveDirector), so the switch
 * stays a dumb lever: it writes one flag and the director owns the rest.
 */
export function armWaves(): void {
  waveState.armed = true
}

/** What one director tick decided — the theatre layer (enemies.tsx) turns
 * these into sfx/labels/spawns; state transitions all happen here. */
export type DirectorStep = {
  /** The switch throw registered — start the countdown theatre (spin-up). */
  alertStarted: boolean
  /** The countdown just hit zero — HERE THEY COME (spawn WAVE 1). */
  assaultStarted: boolean
  /** An intermission expired with the lot clear — spawn the next wave. */
  waveDue: boolean
}

const _step: DirectorStep = { alertStarted: false, assaultStarted: false, waveDue: false }

/**
 * The wave director's state machine, one frame: grace → (switch armed) →
 * alert countdown → assault waves with intermissions. Pure over waveState +
 * its inputs — NO store reads: weapon ownership is deliberately not an input,
 * so bots can never spawn off a pickup (the opt-in invariant, pinned by
 * enemies-waves.test.ts). Returns a shared step record (allocation-free hot
 * loop) — consume it before the next tick.
 */
export function tickWaveDirector(dt: number, botsAlive: number): DirectorStep {
  _step.alertStarted = false
  _step.assaultStarted = false
  _step.waveDue = false
  if (!waveState.alerted) {
    if (waveState.armed) {
      waveState.alerted = true
      waveState.countdown = ALERT_SECONDS
      waveState.countdownActive = true
      _step.alertStarted = true
    }
  } else if (waveState.countdown > 0) {
    waveState.countdown -= dt
    if (waveState.countdown <= 0) {
      waveState.countdownActive = false
      _step.assaultStarted = true
    }
  } else if (botsAlive === 0) {
    waveState.intermission -= dt
    if (waveState.intermission <= 0) _step.waveDue = true
  }
  return _step
}

export function resetBots(): void {
  bots.length = 0
  waveState.wave = 0
  waveState.intermission = 4
  waveState.armed = false
  waveState.alerted = false
  waveState.countdown = ALERT_SECONDS
  waveState.countdownActive = false
  debugFlags.botsFrozen = false
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
    blockedT: 0,
    followT: 0,
    followSign: 1,
    climb: 0,
    groundY: 0,
    // Stagger the probe cadence so a whole wave never re-probes on the
    // same frame (settleGroundBot probes as soon as this hits 0).
    groundT: Math.random() * GROUND_PROBE_PERIOD,
    stuckT: 0,
    doorScanT: 0,
    doorId: null,
    doorX: 0,
    doorZ: 0,
    doorFumbleT: 0,
    doorT: 0,
  })
}

// --- BOTS LEARN DOORWAYS: pure bookkeeping + candidate selection ------------
// Ground bots (droid/dog) that keep grinding a facade hunt for a nearby door
// and fumble it open through the E-interact system's own toggle. Drones never
// touch any of this — they climb. enemies.tsx owns the walk/pause/toggle
// state machine; the clocks and the door pick live here so they unit-test
// without React.

/** Hindered this long (blocked or wall-following) before the door hunt starts (s). */
export const DOOR_STUCK_TIME = 1.2
/** Door-candidate scan cadence while stuck (s) — the per-bot budget. */
export const DOOR_SCAN_PERIOD = 0.5
/** A door only counts as a way in when it sits within this range (m). */
export const DOOR_SCAN_RANGE = 3
/** The fumble tell: seconds paused at the leaf before the toggle. */
export const DOOR_FUMBLE_SECONDS = 0.6
/** "At the door": XZ distance to the approach point that starts the fumble (m). */
export const DOOR_FUMBLE_RANGE = 0.8
/** Approach point offset from the door center toward the bot (m) — keeps the
 * capsule off the leaf plane so the walk-up settles instead of grinding. */
export const DOOR_APPROACH_OFFSET = 0.55
/** A mission the capsule can't finish (furniture, bot pile-up) aborts (s). */
export const DOOR_MISSION_TTL = 5

/** Doorway-hunt clock: accrues while the bot is hindered (blocked against a
 * solid or mid wall-follow — wall-follow itself means pursuit failed), resets
 * the moment normal seek makes real progress. */
export function accrueDoorStuck(bot: Bot, hindered: boolean, dt: number): void {
  if (hindered) bot.stuckT += dt
  else bot.stuckT = 0
}

/** The scan-budget gate: true at most once per DOOR_SCAN_PERIOD, and only
 * while the bot has been stuck past DOOR_STUCK_TIME with no active mission. */
export function doorScanDue(bot: Bot, dt: number): boolean {
  if (bot.doorId !== null || bot.stuckT < DOOR_STUCK_TIME) return false
  bot.doorScanT -= dt
  if (bot.doorScanT > 0) return false
  bot.doorScanT = DOOR_SCAN_PERIOD
  return true
}

/** The slice of GameWorld the door hunt reads — structural so tests stub it
 * with plain boxes (no meshes/BVHs needed). */
export type DoorScanWorld = {
  doors: readonly Pick<DoorEntry, 'nodeId' | 'colliderIndices' | 'node'>[]
  colliders: readonly { worldBox: Box3; disabled?: boolean }[]
}

const _doorBounds = new Box3()

/**
 * Nearest fumble-worthy door within maxDist of (x, z): skips pure openings
 * (openingKind 'opening' — no leaf to swing) and doors with no ENABLED
 * collider left (already open and passable, or voxelized — destruction owns
 * those and bots use the breach). Returns the winner's nodeId and writes its
 * solid-collider bounds center into outCenter (y = 0). Pure, allocation-free.
 */
export function pickDoorCandidate(
  world: DoorScanWorld,
  x: number,
  z: number,
  maxDist: number,
  outCenter: Vector3,
): string | null {
  let bestId: string | null = null
  let bestSq = maxDist * maxDist
  for (const door of world.doors) {
    if (door.node?.openingKind === 'opening') continue
    _doorBounds.makeEmpty()
    for (const index of door.colliderIndices) {
      const collider = world.colliders[index]
      if (!collider || collider.disabled) continue
      _doorBounds.union(collider.worldBox)
    }
    if (_doorBounds.isEmpty()) continue
    const cx = (_doorBounds.min.x + _doorBounds.max.x) / 2
    const cz = (_doorBounds.min.z + _doorBounds.max.z) / 2
    const dSq = (cx - x) * (cx - x) + (cz - z) * (cz - z)
    if (dSq < bestSq) {
      bestSq = dSq
      bestId = door.nodeId
      outCenter.set(cx, 0, cz)
    }
  }
  return bestId
}

/** Does this door still block (any enabled collider)? The fumble re-checks
 * right before toggling so a door the player opened mid-fumble isn't slammed
 * shut in their face. False for unknown ids. */
export function doorIsClosed(world: DoorScanWorld, nodeId: string): boolean {
  for (const door of world.doors) {
    if (door.nodeId !== nodeId) continue
    for (const index of door.colliderIndices) {
      const collider = world.colliders[index]
      if (collider && !collider.disabled) return true
    }
    return false
  }
  return false
}

/** Arm a door mission: target the approach point (door center pushed
 * DOOR_APPROACH_OFFSET toward the bot — orientation-agnostic, works from
 * either side) and reset the mission clocks. */
export function setDoorApproach(bot: Bot, nodeId: string, centerX: number, centerZ: number): void {
  bot.doorId = nodeId
  bot.doorT = 0
  bot.doorFumbleT = 0
  const dx = bot.position.x - centerX
  const dz = bot.position.z - centerZ
  const d = Math.hypot(dx, dz)
  if (d > 1e-4) {
    bot.doorX = centerX + (dx / d) * DOOR_APPROACH_OFFSET
    bot.doorZ = centerZ + (dz / d) * DOOR_APPROACH_OFFSET
  } else {
    bot.doorX = centerX
    bot.doorZ = centerZ
  }
}

// --- BOTS ON FLOORS: ground settle (droid/dog only, drones never call this) --
/** Near-support settle — the gentle pull that releases capsule step-ups
 * (slabs, stoops), same rate the lane always had (m/s). */
export const BOT_SETTLE_RATE = 3
/** Unsupported settle — a carved hole underfoot drops the bot to the storey
 * below fast enough to read as a fall (m/s). */
export const BOT_FALL_RATE = 6
/** Gap beyond which the settle reads as a fall (m): bigger than any slab
 * step-up, far smaller than a storey. */
const FALL_GAP = 0.6
/** Landing-plane probe cadence (s) — cached per bot, never per frame. */
const GROUND_PROBE_PERIOD = 0.2
/** Probe from just above the feet so a surface exactly at foot level
 * registers (probeLandingY rejects voxel hits < 0.02 from its start). */
const GROUND_PROBE_LIFT = 0.1

/**
 * Pull a ground bot's feet toward the live landing plane under them —
 * destruction.probeLandingY over collider tops + live voxel cells + the
 * terrain plane. Standing on slabs/floors holds; walking over a carved
 * hole drops to the next support below (near-support settle 3 m/s, real
 * falls 6 m/s). The probe result is cached per bot for ~0.2 s; only the
 * pull runs per frame. Never lifts — capsule step-up owns upward motion.
 */
export function settleGroundBot(world: GameWorld, bot: Bot, dt: number): void {
  bot.groundT -= dt
  if (bot.groundT <= 0) {
    bot.groundT = GROUND_PROBE_PERIOD
    bot.groundY = probeLandingY(
      world,
      bot.position.x,
      bot.position.y + GROUND_PROBE_LIFT,
      bot.position.z,
    )
  }
  if (bot.position.y > bot.groundY) {
    const rate = bot.position.y - bot.groundY > FALL_GAP ? BOT_FALL_RATE : BOT_SETTLE_RATE
    bot.position.y = Math.max(bot.groundY, bot.position.y - rate * dt)
  }
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
