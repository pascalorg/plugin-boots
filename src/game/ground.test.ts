import { afterEach, describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, Color, Matrix4, Mesh, Object3D, Vector3 } from 'three'
import { collideCapsule, PLAYER_CAPSULE } from './collision'
import {
  buildCraterGeometry,
  CRATER_BASE_Y,
  CRATER_TERRAIN_LIFT,
  craterBaseYAt,
  craterDrapeFor,
  craterEligible,
  resetCraters,
  spawnFloorBreach,
} from './craters'
import { clearDebris, debrisDump, spawnDebris } from './debris'
import { probeLandingY, resetDestruction } from './destruction'
import {
  type Bot,
  type BotKind,
  BOT_PROBE_BUDGET,
  botVisualParams,
  resetBotProbeBudget,
  resetBots,
  settleGroundBot,
  spawnBot,
  bots as liveBots,
} from './enemies-state'
import {
  FLAT_LOT_Y,
  groundSurfaceY,
  hasGroundSurfaceProbe,
  lotFloorY,
  resetGround,
  setGroundSurfaceProbe,
  setLotFloorY,
} from './ground'
import {
  bvhFor,
  type ColliderEntry,
  type GameWorld,
  installGroundProbes,
  spawnGroundY,
  terrainSurfaceYAt,
} from './world'

/**
 * SCULPTED GROUND — the y = 0 sweep (owner: "my projects sit on terrain, the
 * game acts like the world is a table"). Every case here is a bug that
 * shipped: bots hovering over an excavation or grinding into a hill, debris
 * and dust resting on an invisible plane at zero, craters refusing to scar
 * anything but the lot plane, the spawn five metres up, and the below-grade
 * half of the lot sealed off by collision.ts's infinite floor.
 *
 * The terrain is a SYNTHETIC field (rampTerrain) rather than a host
 * heightfield: ground.ts takes a plain (x, z) => y closure, which is exactly
 * what the host's analytic field is reduced to, so the whole chain
 * (collision backstop, landing probe, bot settle, craters, debris) is
 * testable with no host, no BVH and no renderer.
 *
 * Every test that leaves the ground authority installed MUST reset it — a
 * leaked probe would make every later suite in the process think it is on a
 * hill (afterEach below).
 */

/**
 * The synthetic lot, in section (all heights in m):
 *
 *   +2 ┤ ▔▔▔▔▔╲                        bench (x ≤ −2)
 *    0 ┤       ╲                       45° ramp (−2 … +2)
 *   −2 ┤        ╲▁▁▁▁▁▁▁▁▁▁            basin (x ≥ +2)
 *   −5 ┤                    ▁▁▁▁▁      excavation shelf (z > 10)
 *
 * A 45° ramp is deliberately steeper than anything gentle: a stale landing
 * plane shows up as metres, not millimetres.
 */
const SOIL = new Color(0.42, 0.3, 0.19)

function rampTerrain(x: number, z: number): number {
  if (z > 10) return -5
  if (x <= -2) return 2
  if (x >= 2) return -2
  return -x
}

/** Install the synthetic lot as the session's ground. */
function useRampTerrain(): void {
  setGroundSurfaceProbe(rampTerrain)
  setLotFloorY(-5.6)
}

function boxCollider(
  nodeId: string,
  nodeType: string,
  size: [number, number, number],
  center: [number, number, number],
): ColliderEntry {
  const mesh = new Mesh(new BoxGeometry(size[0], size[1], size[2]))
  mesh.position.set(center[0], center[1], center[2])
  mesh.updateMatrixWorld(true)
  mesh.geometry.computeBoundingBox()
  const worldBox = mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld)
  return {
    mesh,
    bvh: bvhFor(mesh),
    inverse: new Matrix4().copy(mesh.matrixWorld).invert(),
    worldBox,
    root: mesh,
    nodeId,
    nodeType,
  }
}

function makeWorld(colliders: ColliderEntry[]): GameWorld {
  const buildingAabb = new Box3()
  for (const c of colliders) {
    if (c.nodeType !== 'site') buildingAabb.union(c.worldBox)
  }
  return {
    colliders,
    walls: new Map(),
    glass: [],
    doors: [],
    overlayRoots: [],
    buildingAabb,
    spawn: new Vector3(6, 0, 6),
    spawnYaw: 0,
    levelId: null,
  }
}

/** Deterministic ground bot — groundT 0 forces a probe on the first settle. */
function makeBot(kind: BotKind, x: number, y: number, z: number): Bot {
  return {
    id: 1,
    kind,
    position: new Vector3(x, y, z),
    yaw: 0,
    health: 65,
    state: 'alive',
    deadT: 0,
    attackCooldown: 1,
    phase: 0,
    seed: 0,
    blockedT: 0,
    followT: 0,
    followSign: 1,
    climb: 0,
    groundY: y,
    groundX: x,
    groundZ: z,
    groundT: 0,
    stuckT: 0,
    doorScanT: 0,
    doorId: null,
    doorX: 0,
    doorZ: 0,
    doorFumbleT: 0,
    doorT: 0,
    visual: botVisualParams(1, kind, 1),
  }
}

afterEach(() => {
  resetGround()
  resetCraters()
  clearDebris()
  resetDestruction()
  resetBots()
  resetBotProbeBudget()
})

// ---------------------------------------------------------------------------

describe('the ground authority', () => {
  test('a scene with no terrain is the flat lot, exactly as before', () => {
    expect(hasGroundSurfaceProbe()).toBe(false)
    expect(groundSurfaceY(0, 0)).toBe(FLAT_LOT_Y)
    expect(groundSurfaceY(-40, 91.5)).toBe(FLAT_LOT_Y)
    expect(lotFloorY()).toBe(FLAT_LOT_Y)
  })

  test('an installed field answers heights, and reset puts the lot back flat', () => {
    useRampTerrain()
    expect(hasGroundSurfaceProbe()).toBe(true)
    expect(groundSurfaceY(-5, 0)).toBe(2)
    expect(groundSurfaceY(0, 0)).toBeCloseTo(0, 6)
    expect(groundSurfaceY(1, 0)).toBe(-1)
    expect(groundSurfaceY(9, 20)).toBe(-5)
    resetGround()
    expect(groundSurfaceY(-5, 0)).toBe(FLAT_LOT_Y)
    expect(lotFloorY()).toBe(FLAT_LOT_Y)
  })

  test('a host helper answering garbage degrades to flat, never NaN', () => {
    // A NaN would poison a bot position or a debris slot for the session.
    setGroundSurfaceProbe(() => Number.NaN)
    expect(groundSurfaceY(3, 3)).toBe(FLAT_LOT_Y)
    setGroundSurfaceProbe(() => Number.POSITIVE_INFINITY)
    expect(groundSurfaceY(3, 3)).toBe(FLAT_LOT_Y)
  })

  test('the lot floor only ever moves DOWN from the plane', () => {
    setLotFloorY(5)
    expect(lotFloorY()).toBe(FLAT_LOT_Y)
    setLotFloorY(-3.25)
    expect(lotFloorY()).toBe(-3.25)
    setLotFloorY(Number.NaN)
    expect(lotFloorY()).toBe(FLAT_LOT_Y)
  })
})

describe('installGroundProbes (world.ts)', () => {
  const site = (hasTerrain: boolean, surfaceHeightAt: ((x: number, z: number) => number) | null) => ({
    nodeId: 'site-1',
    root: new Object3D(),
    polygon: [] as Array<[number, number]>,
    hasTerrain,
    surfaceHeightAt,
  })

  test('a flat site (no heightfield) installs NOTHING — flat scenes unchanged', () => {
    const dirt = boxCollider('site-1', 'site', [40, 0.2, 40], [0, -0.1, 0])
    expect(installGroundProbes({ colliders: [dirt], site: site(false, null) })).toBe(false)
    expect(hasGroundSurfaceProbe()).toBe(false)
    // A decorative ground fill at y = −0.05 must NOT pull the whole game down.
    expect(lotFloorY()).toBe(FLAT_LOT_Y)
  })

  test('sculpted terrain installs the analytic field and a floor under the site', () => {
    // Terrain mesh from +2 down to −5, skirt reaching −6.
    const terrain = boxCollider('site-1', 'site', [40, 8, 40], [0, -2, 0])
    expect(installGroundProbes({ colliders: [terrain], site: site(true, rampTerrain) })).toBe(true)
    expect(groundSurfaceY(-5, 0)).toBe(2)
    // Floor = the site's own underside (−6) minus the margin, never guessed.
    expect(lotFloorY()).toBeCloseTo(-6.5, 6)
  })

  test('terrainSurfaceYAt prefers the analytic field over a BVH probe', () => {
    const world = { colliders: [], site: site(true, rampTerrain) }
    expect(terrainSurfaceYAt(world, 1, 0)).toBe(-1)
    // No site at all: null, so callers can keep their flat path.
    expect(terrainSurfaceYAt({ colliders: [], site: null }, 1, 0)).toBe(null)
  })
})

describe('collision backstop: the excavation is walkable', () => {
  test('a flat lot still clamps to y = 0 and reports grounded', () => {
    const pos = new Vector3(0, -3, 0)
    const vel = new Vector3(0, -9, 0)
    const grounded = collideCapsule(pos, vel, [], PLAYER_CAPSULE)
    expect(pos.y).toBe(0)
    expect(vel.y).toBe(0)
    expect(grounded).toBe(true)
  })

  test('on terrain, a body below y = 0 is NOT yanked back up to it', () => {
    // The bug: an infinite plane at zero sealed the owner's −5.1 m yard —
    // the terrain BVH pushed the capsule onto the real surface and this
    // clamp pulled it straight back to 0, "walking on air" over the pit.
    useRampTerrain()
    const pos = new Vector3(9, -3, 20)
    const vel = new Vector3(0, -9, 0)
    const grounded = collideCapsule(pos, vel, [], PLAYER_CAPSULE)
    expect(pos.y).toBe(-3)
    expect(vel.y).toBe(-9)
    expect(grounded).toBe(false)
  })

  test('…but the lot floor still catches anything falling past the site', () => {
    useRampTerrain()
    const pos = new Vector3(9, -40, 20)
    const vel = new Vector3(0, -30, 0)
    expect(collideCapsule(pos, vel, [], PLAYER_CAPSULE)).toBe(true)
    expect(pos.y).toBe(lotFloorY())
    expect(vel.y).toBe(0)
  })
})

describe('probeLandingY: things land on the ground, not on zero', () => {
  test('flat lot: bare ground resolves to 0 (unchanged)', () => {
    const world = makeWorld([])
    expect(probeLandingY(world, 0, 3, 0)).toBe(0)
  })

  test('a piece falling onto the bench rests at +2, not buried at 0', () => {
    useRampTerrain()
    const world = makeWorld([])
    expect(probeLandingY(world, -5, 6, 0)).toBe(2)
  })

  test('a piece falling into the basin rests at −2, not hovering at 0', () => {
    useRampTerrain()
    const world = makeWorld([])
    expect(probeLandingY(world, 6, 6, 0)).toBe(-2)
  })

  test("the site collider's AABB can no longer flatten the whole lot", () => {
    // The root cause: a 'site' entry contributes ONE number — its box top
    // (+2 here) — so every probe either snapped to the summit or, being
    // above the probe point, was skipped and fell through to 0.
    useRampTerrain()
    const terrain = boxCollider('site-1', 'site', [40, 8, 40], [0, -2, 0])
    const world = makeWorld([terrain])
    expect(probeLandingY(world, 1, 4, 0)).toBe(-1)
  })

  test('a room dug into the hillside keeps its own floor', () => {
    // Terrain at x = −5 is +2; the room's slab top is −0.5. A piece inside
    // must land on the slab, never on the hill outside the wall.
    useRampTerrain()
    const slab = boxCollider('floor-1', 'slab', [6, 0.3, 6], [-5, -0.65, 0])
    const world = makeWorld([slab])
    expect(probeLandingY(world, -5, 0.4, 0)).toBeCloseTo(-0.5, 6)
  })

  test('a body INSIDE the ground reports its own height, so nothing drags it deeper', () => {
    // Reporting 0 here is what tore hillside bots down through the hill:
    // the settle saw a plane far below and pulled while the capsule pushed.
    useRampTerrain()
    const world = makeWorld([])
    expect(probeLandingY(world, -5, 0.5, 0)).toBe(0.5)
  })
})

describe('spawnGroundY: the spawn is no longer clamped to the lot plane', () => {
  test('no collider coverage falls back to the terrain, not to 0', () => {
    useRampTerrain()
    expect(spawnGroundY([], 9, 20)).toBe(-5)
    expect(spawnGroundY([], -5, 0)).toBe(2)
  })

  test('flat lot: no coverage is still exactly 0', () => {
    expect(spawnGroundY([], 9, 20)).toBe(0)
  })
})

describe('craters follow the dirt', () => {
  test('a ground blast in the excavation is eligible; one 2 m over it is not', () => {
    useRampTerrain()
    const world = makeWorld([])
    // Ground here is −5: a detonation at the dirt scars it…
    expect(craterEligible(world, 9, -4.9, 20)).toBe(true)
    // …and one at the old "terrain height" (0) is two storeys up in the air.
    expect(craterEligible(world, 9, 0, 20)).toBe(false)
  })

  test('flat lot: the eligibility band around zero is unchanged', () => {
    const world = makeWorld([])
    expect(craterEligible(world, 9, 0, 20)).toBe(true)
    expect(craterEligible(world, 9, 1.2, 20)).toBe(false)
  })

  test('the patch base rides the ground (and is bit-identical when flat)', () => {
    expect(craterBaseYAt(9, 20)).toBe(CRATER_BASE_Y)
    useRampTerrain()
    expect(craterBaseYAt(9, 20)).toBeCloseTo(-5 + CRATER_TERRAIN_LIFT, 6)
    expect(craterBaseYAt(-5, 0)).toBeCloseTo(2 + CRATER_TERRAIN_LIFT, 6)
  })

  test('the patch is DRAPED on a slope instead of hovering as a level disc', () => {
    expect(craterDrapeFor(0, 0)).toBeUndefined()
    useRampTerrain()
    const drape = craterDrapeFor(0, 0)
    expect(drape).toBeDefined()
    // On the 45° ramp, one metre uphill is one metre higher.
    expect(drape!(-1, 0)).toBeCloseTo(1, 6)
    expect(drape!(1, 0)).toBeCloseTo(-1, 6)
    expect(drape!(0, 0)).toBeCloseTo(0, 6)
    // …and the geometry actually carries it: the rim is no longer planar.
    const flat = buildCraterGeometry(1, 7)
    const draped = buildCraterGeometry(1, 7, false, drape)
    const fy = flat.getAttribute('position').array as Float32Array
    const dy = draped.getAttribute('position').array as Float32Array
    let moved = 0
    for (let i = 0; i < fy.length; i += 3) {
      // Δy must equal the ramp's Δ at that vertex's local x.
      expect(dy[i + 1]! - fy[i + 1]!).toBeCloseTo(-fy[i]!, 5)
      if (Math.abs(dy[i + 1]! - fy[i + 1]!) > 1e-4) moved++
    }
    expect(moved).toBeGreaterThan(50)
  })

  test('a floor breach on high ground stamps, and lands on the slab not at 0.06', () => {
    useRampTerrain()
    // A ground slab on the +2 bench. The old absolute gate read +2.1 as an
    // upper storey and refused to stamp at all.
    expect(spawnFloorBreach(-5, 0, 2.1, 0.7)).toBe(true)
    expect(spawnFloorBreach(9, 20, -4.9, 0.7)).toBe(true)
  })

  test('flat lot: the breach gate and base height are unchanged', () => {
    expect(spawnFloorBreach(0, 0, 0.5, 0.7)).toBe(false)
    expect(spawnFloorBreach(0, 0, 0.2, 0.7)).toBe(true)
  })
})

describe('debris rests on the ground before its probe lands', () => {
  test('a chunk thrown over the excavation does not stop at y = 0.05', () => {
    useRampTerrain()
    spawnDebris(9, -3, 20, 0.2, SOIL, 3, 1.5)
    const piece = debrisDump()[0]!
    // rest is a fraction of the piece size; the GROUND is the −5 shelf.
    expect(piece.ground).toBeLessThan(-4.8)
    expect(piece.ground).toBeGreaterThan(-5.01)
  })

  test('flat lot: the pre-probe rest height is unchanged', () => {
    spawnDebris(9, 3, 20, 0.2, SOIL, 3, 1.5)
    const piece = debrisDump()[0]!
    expect(piece.ground).toBeGreaterThan(0)
    expect(piece.ground).toBeLessThan(0.3)
  })
})

describe('bots walk the terrain', () => {
  test('spawnBot with no probed height lands on the ground, not at y = 0', () => {
    useRampTerrain()
    spawnBot('droid', -5, 0)
    expect(liveBots[0]!.position.y).toBe(2)
    resetBots()
    spawnBot('droid', 9, 20)
    expect(liveBots[0]!.position.y).toBe(-5)
  })

  test('walking downhill re-probes on DISPLACEMENT, inside the cadence window', () => {
    // The bug: the plane was cached for 0.2 s of TIME only, so a bot running
    // down a bank hovered on the plane it left — metres of air on this ramp.
    useRampTerrain()
    const world = makeWorld([])
    const bot = makeBot('droid', -1, 1, 0)
    settleGroundBot(world, bot, 1 / 60) // first probe: plane at +1
    expect(bot.groundY).toBeCloseTo(1, 6)
    // One step downhill, well inside the 0.2 s cadence.
    bot.position.x += 0.5
    settleGroundBot(world, bot, 1 / 60)
    expect(bot.groundY).toBeCloseTo(0.5, 6)
    expect(bot.groundX).toBeCloseTo(-0.5, 6)
    // …and the feet are actually pulled toward it (never lifted).
    expect(bot.position.y).toBeLessThan(1)
  })

  test('a small step keeps the cached plane — no probe per frame', () => {
    useRampTerrain()
    const world = makeWorld([])
    const bot = makeBot('droid', -1, 1, 0)
    settleGroundBot(world, bot, 1 / 60)
    const before = bot.groundY
    bot.position.x += 0.05
    settleGroundBot(world, bot, 1 / 60)
    expect(bot.groundY).toBe(before)
    expect(bot.groundX).toBeCloseTo(-1, 6)
  })

  test('the horde-wide budget caps displacement probes per frame', () => {
    // Perf over perfection: a 40-bot wave must not pay 40 scene probes in a
    // frame. Over budget, a bot keeps its plane until its cadence tick.
    useRampTerrain()
    const world = makeWorld([])
    const herd = Array.from({ length: BOT_PROBE_BUDGET + 4 }, () => makeBot('droid', -1, 1, 0))
    // Everyone's first (cadence) probe — those are never budgeted.
    resetBotProbeBudget()
    for (const bot of herd) settleGroundBot(world, bot, 1 / 60)
    for (const bot of herd) expect(bot.groundY).toBeCloseTo(1, 6)
    // Now everyone takes a big step in the same frame.
    resetBotProbeBudget()
    for (const bot of herd) {
      bot.position.x += 0.5
      settleGroundBot(world, bot, 1 / 60)
    }
    const reprobed = herd.filter((bot) => bot.groundY !== 1).length
    expect(reprobed).toBe(BOT_PROBE_BUDGET)
    // The starved ones are at most one cadence tick behind, not stuck.
    const starved = herd[herd.length - 1]!
    settleGroundBot(world, starved, 0.25)
    expect(starved.groundY).toBeCloseTo(0.5, 6)
  })
})
