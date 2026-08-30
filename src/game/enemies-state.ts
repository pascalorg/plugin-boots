import { Box3, Color, Vector3 } from 'three'
import { sfx } from './audio'
import { spawnDebris } from './debris'
import { probeLandingY } from './destruction'
import { groundSurfaceY } from './ground'
import { type DoorEntry, type GameWorld, lotPerimeterPoint, lotRadiusAlong } from './world'

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
  /** Ground bots: the XZ the cached plane was probed at — a bot that has
   * walked away from it needs a fresh one (sloped terrain). */
  groundX: number
  groundZ: number
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
  /** Render-only per-unit variation (botVisualParams, stamped at spawn) —
   * pathing/collision/waves logic never reads it. */
  visual: BotVisual
}

// --- PER-UNIT VISUAL VARIATION (render-only) ---------------------------------
// Every unit rolls a deterministic look off its id (mulberry32) so the horde
// stops reading as clones: droids vary in size and stride, dogs in gait and
// body length, drones in rotor layout and body shape. The accent color
// (visor slit / shoulder stripe / eye ring) is PER WAVE — a whole wave shares
// one palette entry, so "the green wave" reads at a glance. enemies.tsx is
// the only consumer; nothing here feeds steering, damage or collision.

/** Per-wave accent palette (visor slits, shoulder stripes) — 4 entries. */
export const ACCENT_PALETTE = ['#ff5c47', '#3edb84', '#4aa8ff', '#ffc23d'] as const

export type BotVisual = {
  /** Whole-body scale (droid size jitter 0.9–1.15×; dogs/drones stay 1). */
  scale: number
  /** Droid walk cycle: arm/leg swing amplitude (rad), per unit. */
  swingAmp: number
  /** Dog gait: per-leg phase offsets (rad, [0, 2π)) — FL, FR, BL, BR. */
  gait: [number, number, number, number]
  /** Dog silhouette: body length factor — short (1) or long (1.3). */
  bodyLen: number
  /** Drone rotor discs: 2 (bar frame) or 4 (cross frame). */
  rotors: 2 | 4
  /** Drone body variant: round (sphere) vs boxy (box). */
  round: boolean
  /** ACCENT_PALETTE index for the unit's wave. */
  accent: number
}

/** Tiny deterministic PRNG (same recipe as dust/nature) — a unit looks the
 * same every session and every remount. */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0
  return () => {
    t = (t + 0x6d2b79f5) | 0
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Roll a unit's look: pure over (id, kind, wave) — same inputs, same params,
 * pinned by enemies-visual.test.ts. Every field is drawn for every kind (a
 * fixed draw order keeps the stream stable); the renderer just ignores the
 * ones its kind doesn't use. Called once per spawn — never in a hot loop.
 */
export function botVisualParams(id: number, kind: BotKind, wave: number): BotVisual {
  const rand = mulberry32(Math.imul(id, 0x9e3779b1) ^ 0x85ebca6b)
  const scale = 0.9 + rand() * 0.25
  const swingAmp = 0.5 + rand() * 0.45
  const gait: [number, number, number, number] = [
    rand() * Math.PI * 2,
    rand() * Math.PI * 2,
    rand() * Math.PI * 2,
    rand() * Math.PI * 2,
  ]
  const bodyLen = rand() < 0.5 ? 1 : 1.3
  const rotors = rand() < 0.5 ? 2 : 4
  const round = rand() < 0.5
  return {
    scale: kind === 'droid' ? scale : 1,
    swingAmp,
    gait,
    bodyLen,
    rotors,
    round,
    accent: ((wave % ACCENT_PALETTE.length) + ACCENT_PALETTE.length) % ACCENT_PALETTE.length,
  }
}

/** Ground-bot (droid/dog) capsule for wall push-out — see BOT WALL RULE in
 * enemies.tsx. y is feet, like the player capsule. */
export const GROUND_BOT_CAPSULE = { radius: 0.35, height: 1.2 }

/** Drone capsule for the same wall rule (DRONE WALL RULE in enemies.tsx) —
 * sized to the rotor frame. A drone's position is its BODY CENTER (no feet),
 * so enemies.tsx offsets by half the height into the feet-based collide*
 * calls and back. MUST stay a legal capsule (height ≥ 2·radius): the old
 * radius 0.3 × height 0.5 inverted the core segment, so the narrow-phase
 * hull overhung the y..y+height broad-phase box by 0.1 m below AND above —
 * drones hovered proud of floors and bumped lintels early. 0.3 × 0.72
 * keeps the rotor width AND the old effective hull (body ± 0.36 vs the
 * inverted ± 0.35) with a REAL core segment: a degenerate point-sphere at
 * body center sits exactly midway between 0.15 m voxel rows and can thread
 * a wall's row channel (the wall-rule pin caught it). */
export const DRONE_CAPSULE = { radius: 0.3, height: 0.72 }

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

/**
 * Throw the breaker back UP: stand down. The switch is a TOGGLE — players
 * asked to be able to turn the machines off again. Mirrors resetBots' wave
 * fields (grace fully restored: a later throw starts over with the whole
 * alert countdown, then WAVE 1) and powers down every unit still on the
 * lot through the normal dying theatre — the integrator's own cleanup
 * path, so nothing snaps out of existence. Deliberately NOT damageBot:
 * a shutdown is not a kill (no hit sparks, no per-kind death voice).
 */
export function disarmWaves(): void {
  waveState.armed = false
  waveState.alerted = false
  waveState.countdown = ALERT_SECONDS
  waveState.countdownActive = false
  waveState.intermission = 4
  waveState.wave = 0
  for (const bot of bots) {
    if (bot.state === 'alive') {
      bot.state = 'dying'
      bot.deadT = 0
    }
  }
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
  // Re-arm the id counter too: botVisualParams seeds a unit's look from its
  // id alone, so a counter that survives reset re-rolls every silhouette on
  // the next session in the same page — breaking the "a unit looks the same
  // every session and every remount" contract pinned above mulberry32.
  botId = 1
  waveState.wave = 0
  waveState.intermission = 4
  waveState.armed = false
  waveState.alerted = false
  waveState.countdown = ALERT_SECONDS
  waveState.countdownActive = false
  debugFlags.botsFrozen = false
}

export function spawnBot(
  kind: BotKind,
  x: number,
  z: number,
  groundY = groundSurfaceY(x, z),
): void {
  // groundY: the probed terrain height at (x,z) — site hills lift the ring
  // point (settleGroundBot only ever probes DOWNWARD, so a bot born at 0
  // under a +1.6 m hill stayed buried until the first probe never freed it).
  // The default is the GROUND at (x, z), not the old literal 0: a caller
  // without a collider set (tests, scripted spawns) still lands on the
  // terrain instead of at the lot plane's height.
  const y = kind === 'drone' ? groundY + 2.4 + Math.random() * 1.2 : groundY
  const id = botId++
  bots.push({
    id,
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
    groundY,
    groundX: x,
    groundZ: z,
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
    visual: botVisualParams(id, kind, waveState.wave),
  })
}

// --- WAVE RING PLACEMENT: every spawn point stands on walkable ground -------

/** Ring distance from the building center (m): nearest, and the random span
 * above it. Unchanged from the original ring — the clamp below only ever
 * SHORTENS a radius, so an ample lot spawns exactly where it always did. */
export const RING_MIN = 22
export const RING_SPAN = 12

/**
 * A ring point clamped closer than this to the building center (m) is not a
 * siege any more — it is a droid materialising in the kitchen. Past this the
 * placement gives up on the bearing and walks the lot's PERIMETER instead,
 * which is both on-lot and as far out as the parcel goes.
 */
export const RING_MIN_ON_LOT = 8

/**
 * Where one wave bot stands. The ring is the design — bots converge from
 * every bearing — but a ring radius is a guess about a lot it knows nothing
 * about, and off the lot polygon there is no terrain: a bot born out there
 * fell to the session's backstop plane and walked in from under the world
 * (observed on the owner's real project at (−4.46, −35.35) and (−29.64,
 * 1.32), both metres outside the parcel).
 *
 * So the ring is CLAMPED, deterministically, in this order:
 *
 * 1. No lot polygon (void or flat scene, no site node) → the raw ring point.
 *    Byte-identical to the behaviour before this function existed.
 * 2. `lotRadiusAlong` shortens the radius along the bot's OWN bearing until
 *    the point is inside the parcel (inset by a capsule's worth of slack).
 *    The bearing is never rotated, so the wave keeps its angular spread —
 *    which is the whole point of a ring, and why "re-roll until a point
 *    lands on the lot" was rejected: it is unbounded and it biases the
 *    bearings toward whichever direction the lot happens to be long in.
 * 3. If that lands inside RING_MIN_ON_LOT (a small parcel, or a ring center
 *    off the lot on a bearing that misses it), the BOUNDED fallback walks the
 *    lot perimeter to `fraction` of the way round — evenly spread by the
 *    caller's bot index, so a cramped lot still gets a ring of attackers and
 *    never a stack of bots on one point.
 *
 * Writes into `out` ([x, z]) — pure, allocation-free, no world access, and
 * called `count` times per wave, never per frame.
 */
export function waveSpawnXZ(
  polygon: ReadonlyArray<readonly [number, number]> | undefined,
  centerX: number,
  centerZ: number,
  angle: number,
  desired: number,
  fraction: number,
  out: [number, number],
): void {
  const dirX = Math.cos(angle)
  const dirZ = Math.sin(angle)
  out[0] = centerX + dirX * desired
  out[1] = centerZ + dirZ * desired
  if (!polygon || polygon.length < 3) return

  const radius = lotRadiusAlong(polygon, centerX, centerZ, dirX, dirZ, desired)
  if (radius !== null && radius >= RING_MIN_ON_LOT) {
    out[0] = centerX + dirX * radius
    out[1] = centerZ + dirZ * radius
    return
  }
  const edge = lotPerimeterPoint(polygon, fraction)
  if (edge) {
    out[0] = edge[0]
    out[1] = edge[1]
    return
  }
  // Degenerate polygon (zero perimeter): the clamp's answer if it had one,
  // else the raw ring point. Both are the best available; neither can stack.
  if (radius !== null) {
    out[0] = centerX + dirX * radius
    out[1] = centerZ + dirZ * radius
  }
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
/** Horizontal travel (m) that invalidates a cached plane on its own, before
 * the cadence runs out. On sloped ground the plane is only true where it was
 * sampled: at a bot's ~3 m/s this fires about every 7 frames, and the worst
 * stale error is this times the slope (≈ 0.2 m on a 30° bank) — small enough
 * that the settle rate below swallows it, which is the "sample and
 * interpolate" the horde can afford. */
const GROUND_PROBE_STEP = 0.35
const GROUND_PROBE_STEP_SQ = GROUND_PROBE_STEP * GROUND_PROBE_STEP

/**
 * Per-frame ceiling on DISPLACEMENT-triggered probes across the whole horde
 * (the cadence ones always run — every bot keeps its 5 Hz floor no matter
 * what). A probe walks every collider in the scene, so on a 670-node
 * neighborhood this is the one cost that scales with horde size; capping it
 * makes the terrain follow cost O(1) per frame instead of O(bots). Worst
 * case adds 8 probes/frame ≈ 480/s on top of the cadence's 5/s per bot, and
 * a bot that loses the draw is at most one cadence tick (0.2 s) stale.
 */
export const BOT_PROBE_BUDGET = 8
let probeBudget = BOT_PROBE_BUDGET

/** Refill the displacement-probe budget — enemies.tsx calls this once per
 * frame before the bot loop. */
export function resetBotProbeBudget(): void {
  probeBudget = BOT_PROBE_BUDGET
}

/** Remaining displacement probes this frame (tests / perf introspection). */
export function botProbeBudgetLeft(): number {
  return probeBudget
}

/**
 * Pull a ground bot's feet toward the live landing plane under them —
 * destruction.probeLandingY over collider tops + live voxel cells + the
 * ground at its XZ. Standing on slabs/floors holds; walking over a carved
 * hole drops to the next support below (near-support settle 3 m/s, real
 * falls 6 m/s). Never lifts — capsule step-up owns upward motion.
 *
 * SLOPES: bots steer in XZ only, so on sculpted terrain the cached plane
 * goes stale as soon as one takes a step — downhill it hovered on the plane
 * it left, uphill the capsule shoved it out of the hill every frame while
 * this dragged it back in (visible jitter). The cache is now invalidated by
 * DISPLACEMENT as well as time, throttled by a horde-wide per-frame budget
 * (see BOT_PROBE_BUDGET) so a 40-bot wave costs a bounded number of probes.
 */
export function settleGroundBot(world: GameWorld, bot: Bot, dt: number): void {
  bot.groundT -= dt
  const dx = bot.position.x - bot.groundX
  const dz = bot.position.z - bot.groundZ
  const due = bot.groundT <= 0
  const moved = dx * dx + dz * dz >= GROUND_PROBE_STEP_SQ
  if (due || (moved && probeBudget > 0)) {
    if (!due) probeBudget--
    bot.groundT = GROUND_PROBE_PERIOD
    bot.groundX = bot.position.x
    bot.groundZ = bot.position.z
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

// --- DRONE STEERING PROBES + MELEE LOS: pure math (see enemies.tsx) ---------
// The capsule pass is TRUTH for drone placement; these probes are steering —
// they decide when a drone climbs, when it may settle, and when a melee swing
// is walled off. Pure over collider worldBoxes so they unit-test with plain
// Box3 stubs (no meshes/BVHs needed).

/** The slice of a collider the probes read. Disabled entries (voxelized
 * walls/pieces) stay INCLUDED on purpose — the box outlives the hidden mesh,
 * so drones climb over breached buildings instead of threading holes meant
 * for ground bots (the capsule pass, which honors liveness, is still truth). */
export type ProbeBox = { worldBox: Box3 }

/** Wall-top skim: extra probe this far under the path's far end (m) so a
 * wall whose top sits just below the flight line still reads solid. */
const PATH_PROBE_UNDER = 0.6
/** Descent corridor: how far below the rotors the settle probe looks (m). */
export const DRONE_DESCENT_PROBE = 1.2
/** Rotor clearance kept over anything solid in the corridor (m). */
export const DRONE_DESCENT_CLEARANCE = 0.4

const _probePoint = new Vector3()

/** Point-vs-collider worldBox — the skim-probe primitive. */
export function pointInColliderBoxes(
  colliders: readonly ProbeBox[],
  x: number,
  y: number,
  z: number,
): boolean {
  _probePoint.set(x, y, z)
  for (const collider of colliders) {
    if (collider.worldBox.containsPoint(_probePoint)) return true
  }
  return false
}

/**
 * Path-aware forward probe: an exact sweep along the intended DISPLACEMENT
 * (dx, dy, dz — vertical included, so a descent toward the player reads the
 * floor it would cut through; a segment test never straddles a thin slab
 * the way point samples can), plus one point just under the far end so wall
 * tops keep reading solid while skimming. Blocked → the drone climbs.
 */
export function dronePathBlocked(
  colliders: readonly ProbeBox[],
  x: number,
  y: number,
  z: number,
  dx: number,
  dy: number,
  dz: number,
): boolean {
  const len = Math.hypot(dx, dy, dz)
  if (len > 1e-6) {
    const inv = 1 / len
    // Axis broadphase: a box wholly outside the segment's per-axis extents
    // can't intersect it (the slab test would fail on that axis anyway) —
    // a few compares cull almost every collider of a big scene before the
    // full slab walk. Exact reject: answers are identical.
    const minX = dx < 0 ? x + dx : x
    const maxX = dx < 0 ? x : x + dx
    const minY = dy < 0 ? y + dy : y
    const maxY = dy < 0 ? y : y + dy
    const minZ = dz < 0 ? z + dz : z
    const maxZ = dz < 0 ? z : z + dz
    for (const collider of colliders) {
      const box = collider.worldBox
      if (
        box.max.x < minX ||
        box.min.x > maxX ||
        box.max.z < minZ ||
        box.min.z > maxZ ||
        box.max.y < minY ||
        box.min.y > maxY
      )
        continue
      if (segmentHitsBox(box, x, y, z, dx * inv, dy * inv, dz * inv, len)) {
        return true
      }
    }
  }
  return pointInColliderBoxes(colliders, x + dx, y + dy - PATH_PROBE_UNDER, z + dz)
}

/**
 * Descent corridor: before a drone gives altitude back (settling banked
 * climb, or following the player down a storey) the band under the rotors
 * is swept down to `drop` + clearance. Blocked → hold altitude: an elevated
 * floor/roof/wall under the drone is COVER, exactly like ground walls stop
 * ground bots.
 */
export function droneDescentBlocked(
  colliders: readonly ProbeBox[],
  x: number,
  y: number,
  z: number,
  drop: number,
): boolean {
  const reach = drop + DRONE_DESCENT_CLEARANCE
  const floor = y - reach
  for (const collider of colliders) {
    const box = collider.worldBox
    // Straight-down sweep: the XZ point + Y band reject is exact — only
    // boxes actually under the rotors reach the slab test.
    if (x < box.min.x || x > box.max.x || z < box.min.z || z > box.max.z) continue
    if (box.max.y < floor || box.min.y > y) continue
    if (segmentHitsBox(box, x, y, z, 0, -1, 0, reach)) return true
  }
  return false
}

/**
 * Segment-vs-AABB slab test — melee LOS vs non-voxelized solids (closed
 * doors, props, pristine walls). Exact where the old single midpoint probe
 * could miss a thin door leaf sitting near either end of the swing: bots
 * never damage through a closed door. Allocation-free; attack-frames only.
 */
export function segmentHitsBox(
  box: Box3,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDist: number,
): boolean {
  let tMin = 0
  let tMax = maxDist
  for (let axis = 0; axis < 3; axis++) {
    const o = axis === 0 ? ox : axis === 1 ? oy : oz
    const d = axis === 0 ? dx : axis === 1 ? dy : dz
    const min = axis === 0 ? box.min.x : axis === 1 ? box.min.y : box.min.z
    const max = axis === 0 ? box.max.x : axis === 1 ? box.max.y : box.max.z
    if (Math.abs(d) < 1e-9) {
      if (o < min || o > max) return false
      continue
    }
    const inv = 1 / d
    let t1 = (min - o) * inv
    let t2 = (max - o) * inv
    if (t1 > t2) {
      const swap = t1
      t1 = t2
      t2 = swap
    }
    if (t1 > tMin) tMin = t1
    if (t2 < tMax) tMax = t2
    if (tMin > tMax) return false
  }
  return true
}

export type BotRayHit = { bot: Bot; distance: number; point: Vector3 }

const _toCenter = new Vector3()
const _closest = new Vector3()

/**
 * Dog hitbox half-length: the axis segment of the dog's capsule, along its
 * yaw. The long-body dog (visual.bodyLen 1.3, half the spawns) puts its
 * snout at local z ≈ 0.66 and tail at ≈ −0.61 — way outside the old fixed
 * r = 0.42 sphere at body center, so side shots through the visible head or
 * tail whiffed entirely (even the short dog's snout at z ≈ 0.57 missed).
 * Segment ± this at bodyY, radius BOT_STATS.dog.radius, matches the
 * silhouette for both lengths; droids and drones keep the sphere.
 */
export function dogHalfLen(bodyLen: number): number {
  return 0.31 * bodyLen + 0.15
}

/** Analytic ray-vs-body per bot: sphere for droids/drones, capsule along
 * the yaw axis for dogs (see dogHalfLen). Cheap at horde sizes; both paths
 * use the closest-approach parameter as the hit distance. */
export function raycastBots(origin: Vector3, direction: Vector3, maxDist: number): BotRayHit | null {
  let best: BotRayHit | null = null
  for (const bot of bots) {
    if (bot.state !== 'alive') continue
    const stats = BOT_STATS[bot.kind]
    let t: number
    if (bot.kind === 'dog') {
      // Closest approach between the ray and the capsule's axis segment
      // A→B (horizontal, so the segment direction u has uy = 0).
      const hl = dogHalfLen(bot.visual.bodyLen)
      const fx = Math.sin(bot.yaw)
      const fz = Math.cos(bot.yaw)
      const ax = bot.position.x - fx * hl
      const ay = bot.position.y + stats.bodyY
      const az = bot.position.z - fz * hl
      const ux = fx * 2 * hl
      const uz = fz * 2 * hl
      const wx = ax - origin.x
      const wy = ay - origin.y
      const wz = az - origin.z
      const a = ux * ux + uz * uz
      const b = ux * direction.x + uz * direction.z
      const d0 = ux * wx + uz * wz
      const e = direction.x * wx + direction.y * wy + direction.z * wz
      const denom = a - b * b
      // denom → 0 only when the ray runs parallel to the axis; the endpoint
      // A is then as close as any segment point.
      let sSeg = denom > 1e-8 ? (b * e - d0) / denom : 0
      sSeg = sSeg < 0 ? 0 : sSeg > 1 ? 1 : sSeg
      t = e + sSeg * b
      if (t < 0 || t > maxDist) continue
      const px = ax + sSeg * ux - (origin.x + direction.x * t)
      const py = ay - (origin.y + direction.y * t)
      const pz = az + sSeg * uz - (origin.z + direction.z * t)
      if (px * px + py * py + pz * pz > stats.radius * stats.radius) continue
    } else {
      _toCenter.copy(bot.position)
      _toCenter.y += stats.bodyY
      _toCenter.sub(origin)
      t = _toCenter.dot(direction)
      if (t < 0 || t > maxDist) continue
      _closest.copy(origin).addScaledVector(direction, t)
      _closest.sub(_toCenter.add(origin))
      if (_closest.length() > stats.radius) continue
    }
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
