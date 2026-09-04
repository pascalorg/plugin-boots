import { afterEach, describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, Matrix4, Mesh, Vector3 } from 'three'
import { prevoxelizeTick, resetDestruction, useDestruction } from './destruction'
import {
  armoryStationPosition,
  breakerEngageable,
  breakerPosition,
  collectArticulatedBlockers,
  convoyImpactPoint,
  convoyCanOccupy,
  buildStationPosition,
  DEPOT_NODE_ID,
  DEPOT_NODE_TYPE,
  TRAILER_DECK_LIFT,
  DEPOT_OFFSET,
  DEPOT_SIZE,
  depotLocalToWorld,
  depotPosition,
  GRAB_RANGE,
  heavyVehicleSupportY,
  nearestGrabbable,
  speedAfterRamImpact,
  stepTrailerYaw,
  trailerCenterFromHitch,
  TRAILER_HITCH_LENGTH,
  TRAILER_MAX_ARTICULATION,
  truckYawRate,
  TRUCK_HITCH_X,
  worldToDepotLocal,
} from './guntable'
import { CYBER_TRUCK_MAX_STEER_ANGLE, CYBER_TRUCK_WHEELBASE } from './cyber-truck'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

/**
 * Pure layout math for the ARMORED SPAWN DEPOT. The contract under test is
 * the tables' contract carried to the container: the BUILD station is the
 * nearest thing the player sees (its prompt is up at spawn, and ONLY its —
 * the armory and breaker stay out of grab range), one E press serves one
 * fixture, and the container's shape invariants hold at any spawn yaw
 * (stations inside the shell, open side toward spawn, breaker on the right
 * end wall).
 */

const YAWS = [0, Math.PI / 4, Math.PI * 0.75, -Math.PI / 2, 1.234, -2.8]

function fakeWorld(spawn: Vector3, spawnYaw: number): GameWorld {
  return { spawn, spawnYaw } as unknown as GameWorld
}

/** Table-center offset from spawn in the spawn frame: [lateral, forward]. */
function spawnFrame(world: GameWorld, pos: Vector3): [number, number] {
  const fwdX = -Math.sin(world.spawnYaw)
  const fwdZ = -Math.cos(world.spawnYaw)
  const dx = pos.x - world.spawn.x
  const dz = pos.z - world.spawn.z
  return [dx * -fwdZ + dz * fwdX, dx * fwdX + dz * fwdZ]
}

/**
 * The ARMORED SPAWN DEPOT: one indestructible cargo container replaces the
 * three tables + switch stub, SET BACK BEHIND SPAWN (owner ask — the view
 * toward the building stays clear; turn around and the opening faces you).
 * The pins below are the tables' grab contracts re-expressed against the
 * container's stations in the depot-local frame, plus the container-shape
 * invariants (stations inside the shell, open side toward spawn, breaker
 * ON the +x end wall).
 */
describe('spawn depot layout', () => {
  test('the supply container rides above the trailer tyres', () => {
    const wheelTop = 0.38 + 0.38
    expect(TRAILER_DECK_LIFT).toBeGreaterThan(wheelTop)
  })

  test('the depot is set back behind spawn — nothing prompts at spawn', () => {
    for (const yaw of YAWS) {
      const world = fakeWorld(new Vector3(3, 0, -2), yaw)
      const spawn = world.spawn
      // Behind the player: the container center's forward coordinate is
      // negative (the player looks away from it at entry)…
      const [, depotFwd] = spawnFrame(world, depotPosition(world))
      expect(depotFwd).toBeLessThan(0)
      // …and every fixture is walked to on purpose: no prompt at spawn.
      expect(buildStationPosition(world).distanceTo(spawn)).toBeGreaterThan(GRAB_RANGE)
      expect(armoryStationPosition(world).distanceTo(spawn)).toBeGreaterThan(GRAB_RANGE)
      expect(breakerPosition(world).distanceTo(spawn)).toBeGreaterThan(GRAB_RANGE)
    }
  })

  test('depot-local transform round-trips (grab math ⇄ rendered group)', () => {
    for (const yaw of YAWS) {
      const world = fakeWorld(new Vector3(-7, 0, 11), yaw)
      for (const [lx, lz] of [
        [3.05, 0],
        [-1.7, 1.1],
        [0.4, -0.9],
      ] as const) {
        const p = depotLocalToWorld(world, lx, lz)
        const [rx, rz] = worldToDepotLocal(world, p.x, p.z)
        expect(rx).toBeCloseTo(lx, 10)
        expect(rz).toBeCloseTo(lz, 10)
      }
    }
  })

  test('one E press serves ONE station: nearest untaken wins the overlap', () => {
    for (const yaw of YAWS) {
      const world = fakeWorld(new Vector3(3, 0, -2), yaw)
      // In the opening between the two stations — inside BOTH grab discs
      // (regression guard carried over from the tables: a single E here
      // must never grant builder + guns together).
      const probe = depotLocalToWorld(world, -1.0, 0.9)
      const px = probe.x
      const pz = probe.z
      const at = new Vector3(px, 0, pz)
      expect(buildStationPosition(world).distanceTo(at)).toBeLessThan(GRAB_RANGE)
      expect(armoryStationPosition(world).distanceTo(at)).toBeLessThan(GRAB_RANGE)
      const stations = (builderTaken: boolean) =>
        new Map([
          ['build', { x: buildStationPosition(world).x, z: buildStationPosition(world).z, taken: builderTaken }],
          ['armory', { x: armoryStationPosition(world).x, z: armoryStationPosition(world).z, taken: false }],
          ['switch', { x: breakerPosition(world).x, z: breakerPosition(world).z, taken: false }],
        ])
      // The nearest untaken station alone answers the press…
      expect(nearestGrabbable(px, pz, stations(false))).toBe('build')
      // …and once the builder is taken the SAME spot serves the armory.
      expect(nearestGrabbable(px, pz, stations(true))).toBe('armory')
    }
  })

  test('nearestGrabbable: out of every disc → null; all taken → null', () => {
    const world = fakeWorld(new Vector3(0, 0, 0), 0)
    const stations = new Map([
      ['build', { x: buildStationPosition(world).x, z: buildStationPosition(world).z, taken: false }],
      ['armory', { x: armoryStationPosition(world).x, z: armoryStationPosition(world).z, taken: false }],
    ])
    expect(nearestGrabbable(50, 50, stations)).toBeNull()
    const taken = new Map(
      [...stations].map(([id, t]) => [id, { ...t, taken: true }] as const),
    )
    expect(nearestGrabbable(0, 0, taken)).toBeNull()
  })

  test('breaker: mounted ON the +x end wall, walked to on purpose', () => {
    for (const yaw of YAWS) {
      const world = fakeWorld(new Vector3(3, 0, -2), yaw)
      expect(breakerPosition(world).distanceTo(world.spawn)).toBeGreaterThan(GRAB_RANGE)
      // Proud of the end plane by at most 0.2 m, within the container's
      // depth — pinned in the depot-local frame the cluster renders in.
      const at = breakerPosition(world)
      const [bx, bz] = worldToDepotLocal(world, at.x, at.z)
      const endPlane = DEPOT_SIZE[0] / 2
      expect(bx).toBeGreaterThan(endPlane - 1e-6)
      expect(bx - endPlane).toBeLessThan(0.2)
      expect(Math.abs(bz)).toBeLessThan(DEPOT_SIZE[2] / 2)
    }
  })

  test('E at the breaker serves the switch alone — armed or not (toggle)', () => {
    for (const yaw of YAWS) {
      const world = fakeWorld(new Vector3(3, 0, -2), yaw)
      const at = breakerPosition(world)
      // The switch is a TOGGLE now: its arbitration entry never flips to
      // taken (a thrown handle must stay claimable for the shutdown), so
      // at the panel it wins the disc for the whole session.
      const stations = new Map([
        ['build', { x: buildStationPosition(world).x, z: buildStationPosition(world).z, taken: false }],
        ['armory', { x: armoryStationPosition(world).x, z: armoryStationPosition(world).z, taken: false }],
        ['switch', { x: at.x, z: at.z, taken: false }],
      ])
      expect(nearestGrabbable(at.x, at.z, stations)).toBe('switch')
    }
  })

  /**
   * THE OUTSIDE-AND-FACING GATE: the panel hangs on the end wall's OUTSIDE
   * face, but grab arbitration is a plain XZ disc — from INSIDE the
   * container the panel is within reach straight through the steel. With
   * the switch now toggling the war OFF too, an accidental through-wall E
   * got worse, not better; breakerEngageable is the pin that a throw takes
   * standing outside the end wall AND looking at the panel.
   */
  test('inside the container the breaker never engages — even facing it', () => {
    for (const yaw of YAWS) {
      const world = fakeWorld(new Vector3(3, 0, -2), yaw)
      const at = breakerPosition(world)
      // Against the end wall's INSIDE face, staring at the panel through it.
      const inside = depotLocalToWorld(world, DEPOT_SIZE[0] / 2 - 0.3, 0)
      expect(at.distanceTo(inside)).toBeLessThan(GRAB_RANGE) // in reach — the trap
      expect(
        breakerEngageable(world, at, inside.x, inside.z, at.x - inside.x, at.z - inside.z),
      ).toBe(false)
    }
  })

  test('outside the end wall: facing the panel engages, looking away never does', () => {
    for (const yaw of YAWS) {
      const world = fakeWorld(new Vector3(3, 0, -2), yaw)
      const at = breakerPosition(world)
      const outside = depotLocalToWorld(world, DEPOT_SIZE[0] / 2 + 1.2, 0)
      expect(at.distanceTo(outside)).toBeLessThan(GRAB_RANGE)
      const toX = at.x - outside.x
      const toZ = at.z - outside.z
      expect(breakerEngageable(world, at, outside.x, outside.z, toX, toZ)).toBe(true)
      // Back turned (or sidling past shoulder-first): no throw.
      expect(breakerEngageable(world, at, outside.x, outside.z, -toX, -toZ)).toBe(false)
      expect(breakerEngageable(world, at, outside.x, outside.z, -toZ, toX)).toBe(false)
    }
  })

  test('pickup stations sit INSIDE the container shell', () => {
    for (const yaw of YAWS) {
      const world = fakeWorld(new Vector3(-1, 0, 6), yaw)
      for (const pos of [buildStationPosition(world), armoryStationPosition(world)]) {
        const [lx, lz] = worldToDepotLocal(world, pos.x, pos.z)
        expect(Math.abs(lx)).toBeLessThan(DEPOT_SIZE[0] / 2)
        expect(Math.abs(lz)).toBeLessThan(DEPOT_SIZE[2] / 2)
      }
      // Build and armory occupy DIFFERENT bays of the opening.
      const [bx] = worldToDepotLocal(
        world,
        buildStationPosition(world).x,
        buildStationPosition(world).z,
      )
      const [ax] = worldToDepotLocal(
        world,
        armoryStationPosition(world).x,
        armoryStationPosition(world).z,
      )
      expect(bx).toBeLessThan(ax)
    }
  })

  test('the open side faces spawn, with walking room in front', () => {
    for (const yaw of YAWS) {
      const world = fakeWorld(new Vector3(0.5, 0, 4), yaw)
      // In depot-local coordinates the opening is the +z side. Spawn's
      // local z must clear the opening plane with ≥1.5 m of approach room —
      // that is "the open side faces spawn" for a set-back container: the
      // player turns around and walks straight in, never through a wall.
      const [sx, sz] = worldToDepotLocal(world, world.spawn.x, world.spawn.z)
      expect(sz).toBeGreaterThan(DEPOT_SIZE[2] / 2 + 1.5)
      // Spawn is never inside the shell laterally-trapped either: it sits
      // clear of the footprint, not wedged against an end wall.
      expect(Math.abs(sx)).toBeLessThan(DEPOT_SIZE[0]) // sanity: near the lot
      // Both stations live in the OPEN half of the container (+z bays).
      for (const pos of [buildStationPosition(world), armoryStationPosition(world)]) {
        const [, lz] = worldToDepotLocal(world, pos.x, pos.z)
        expect(lz).toBeGreaterThan(0)
      }
      // Static sanity (yaw-independent): the depot anchors BEHIND spawn.
      expect(DEPOT_OFFSET[1]).toBeLessThan(0)
    }
  })
})

describe('Cybertruck convoy collision envelope', () => {
  afterEach(() => {
    resetDestruction()
  })

  const box = (
    nodeId: string,
    nodeType: string,
    size: [number, number, number],
    center: [number, number, number],
  ): ColliderEntry => {
    const mesh = new Mesh(new BoxGeometry(...size))
    mesh.position.set(...center)
    mesh.updateMatrixWorld(true)
    mesh.geometry.computeBoundingBox()
    return {
      mesh,
      bvh: bvhFor(mesh),
      inverse: new Matrix4().copy(mesh.matrixWorld).invert(),
      worldBox: mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld),
      root: mesh,
      nodeId,
      nodeType,
    }
  }

  test('the truck cannot push its nose through a wall', () => {
    const wall = box('wall-a', 'wall', [0.2, 2.6, 4], [-9.3, 1.3, 0])
    expect(convoyCanOccupy([wall], 0, 0, 0, 0)).toBe(false)
  })

  test('ground and the convoy itself never deadlock movement', () => {
    const ground = box('site-a', 'site', [100, 0.2, 100], [0, 0, 0])
    const own = box(DEPOT_NODE_ID, DEPOT_NODE_TYPE, [6, 3, 2.5], [0, 1.5, 0])
    expect(convoyCanOccupy([ground, own], 0, 0, 0, 0)).toBe(true)
  })

  test('an already-voxelized placed wall still enters the truck ram list', () => {
    const wall = box('placed-wall', 'block', [0.2, 2.8, 3], [-2.65, 1.4, 1.02])
    wall.disabled = true
    useDestruction.setState({ targets: new Map([['placed-wall', {} as never]]) })
    const impacts: ColliderEntry[] = []

    // Disabled means its source collider no longer blocks; the live voxel
    // target must nevertheless be damaged by the same truck overlap.
    expect(
      collectArticulatedBlockers(
        [wall],
        0,
        { x: 20, z: 20, yaw: 0 },
        { x: 0, z: 0, yaw: 0 },
        impacts,
      ),
    ).toBe(false)
    expect(impacts).toEqual([wall])
  })

  test('the trailer catches and carves obstacles across its full container height', () => {
    const highWall = box('upper-wall', 'wall', [0.3, 0.5, 2], [0, 3.2, 0])
    const impacts: ColliderEntry[] = []
    const trailer = { x: 0, z: 0, yaw: 0 }
    const truck = { x: 20, z: 20, yaw: 0 }

    expect(collectArticulatedBlockers([highWall], 0, trailer, truck, impacts)).toBe(true)
    expect(impacts).toEqual([highWall])
    const impact = convoyImpactPoint(highWall, 0, trailer, truck)
    expect(impact.body).toBe('trailer')
    expect(impact.point.y).toBeGreaterThan(1.8)
  })

  test('heavy support follows road grade but rejects an upper floor or roof', () => {
    expect(heavyVehicleSupportY(0, 0.18)).toBeCloseTo(0.18)
    expect(heavyVehicleSupportY(0, 2.8)).toBe(0)
    expect(heavyVehicleSupportY(-1.2, null)).toBeCloseTo(-1.2)
  })

  test('breaking walls and trees costs momentum without reversing the truck', () => {
    expect(speedAfterRamImpact(10, 100, 0)).toBeCloseTo(7.65)
    expect(speedAfterRamImpact(-6, 0, 1)).toBeCloseTo(-4.55)
    expect(speedAfterRamImpact(1, 10_000, 0)).toBe(0)
    expect(speedAfterRamImpact(4, 0, 0)).toBe(4)
  })
})

describe('articulated trailer kinematics', () => {
  test('full steering lock gives a tight, physical turning radius', () => {
    const speed = 10
    const yawRate = truckYawRate(speed, 1)
    const radius = speed / yawRate
    expect(radius).toBeCloseTo(
      CYBER_TRUCK_WHEELBASE / Math.tan(CYBER_TRUCK_MAX_STEER_ANGLE),
      10,
    )
    expect(radius).toBeLessThan(6)
    expect(radius).toBeGreaterThan(CYBER_TRUCK_WHEELBASE)
    expect(truckYawRate(-speed, 1)).toBeCloseTo(-yawRate, 12)
    expect(truckYawRate(speed, -1)).toBeCloseTo(-yawRate, 12)
    expect(truckYawRate(0, 1)).toBe(0)
  })

  test('the truck turns first and the trailer follows instead of rotating as one block', () => {
    const trailerYaw = stepTrailerYaw(0, 0.55, 6, 1 / 30)
    expect(trailerYaw).toBeGreaterThan(0)
    expect(trailerYaw).toBeLessThan(0.55)
  })

  test('the drawbar stays attached to the truck hitch at every angle', () => {
    const truck = { x: 4, z: -2, yaw: 0.6 }
    const trailerYaw = 0.18
    const trailer = trailerCenterFromHitch(truck.x, truck.z, truck.yaw, trailerYaw)
    const truckHitch = {
      x: truck.x + TRUCK_HITCH_X * Math.cos(truck.yaw),
      z: truck.z - TRUCK_HITCH_X * Math.sin(truck.yaw),
    }
    const trailerHitch = {
      x: trailer.x - TRAILER_HITCH_LENGTH * Math.cos(trailerYaw),
      z: trailer.z + TRAILER_HITCH_LENGTH * Math.sin(trailerYaw),
    }
    expect(Math.hypot(truckHitch.x - trailerHitch.x, truckHitch.z - trailerHitch.z)).toBeLessThan(
      1e-9,
    )
  })

  test('reverse jackknife is bounded before the trailer clips through the cab', () => {
    const yaw = stepTrailerYaw(0, Math.PI, -20, 1)
    const articulation = Math.atan2(Math.sin(Math.PI - yaw), Math.cos(Math.PI - yaw))
    expect(Math.abs(articulation)).toBeLessThanOrEqual(TRAILER_MAX_ARTICULATION + 1e-9)
  })
})

/**
 * The armor itself: the depot must be mechanically indestructible AND must
 * never wedge the session's voxel machinery. Two layers, both pinned:
 * the '__boots' prefix (destruction.ts's prevoxelize guard — every
 * game-only node manages its own lifecycle) and nodeType 'fixture'
 * (outside shooting's DESTRUCTIBLE set and the grenade EXPLODABLE sets,
 * so no damage path ever routes the depot into damageTarget).
 */
describe('spawn depot armor', () => {
  afterEach(() => {
    resetDestruction()
  })

  test('depot ids ride both guards: __boots prefix + fixture node type', () => {
    expect(DEPOT_NODE_ID.startsWith('__boots')).toBe(true)
    expect(DEPOT_NODE_TYPE).toBe('fixture')
  })

  test('prevoxelize skips the depot and still completes (gate not wedged)', () => {
    // A depot shell collider next to one real wall-less item crate: the
    // sweep must voxelize the crate, NEVER the depot, and report done —
    // a target-less fixture must not wedge warmup's completeness gate.
    const box = (
      nodeId: string,
      nodeType: string,
      size: [number, number, number],
      center: [number, number, number],
    ): ColliderEntry => {
      const mesh = new Mesh(new BoxGeometry(size[0], size[1], size[2]))
      mesh.position.set(center[0], center[1], center[2])
      mesh.updateMatrixWorld(true)
      mesh.geometry.computeBoundingBox()
      return {
        mesh,
        bvh: bvhFor(mesh),
        inverse: new Matrix4().copy(mesh.matrixWorld).invert(),
        worldBox: mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld),
        root: mesh,
        nodeId,
        nodeType,
      }
    }
    const depotWall = box(DEPOT_NODE_ID, DEPOT_NODE_TYPE, [6, 2.48, 0.1], [0, 1.36, -1.2])
    const crate = box('crate-1', 'item', [1.2, 0.6, 1.2], [8, 0.3, 0])
    const world = {
      colliders: [depotWall, crate],
      walls: new Map(),
      glass: [],
      doors: [],
      overlayRoots: [],
      buildingAabb: new Box3().union(depotWall.worldBox).union(crate.worldBox),
      spawn: new Vector3(0, 0, 4),
      spawnYaw: 0,
      levelId: null,
    } as unknown as GameWorld
    let done = false
    for (let i = 0; i < 50 && !done; i++) done = prevoxelizeTick(world, 8)
    expect(done).toBe(true)
    const targets = useDestruction.getState().targets
    expect(targets.has('crate-1')).toBe(true)
    expect(targets.has(DEPOT_NODE_ID)).toBe(false)
  })
})
