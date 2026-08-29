import { describe, expect, test } from 'bun:test'
import { Vector3 } from 'three'
import {
  ARMORY_STATION_OFFSET,
  armoryStationPosition,
  BREAKER_OFFSET,
  breakerPosition,
  BUILD_STATION_OFFSET,
  buildStationPosition,
  DEPOT_OFFSET,
  DEPOT_SIZE,
  depotPosition,
  GRAB_RANGE,
  nearestGrabbable,
} from './guntable'
import type { GameWorld } from './world'

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
 * three tables + switch stub. Same grab semantics — the pins below are the
 * tables' contracts re-expressed against the container's stations, plus the
 * new container-shape invariants (stations inside the shell, open side
 * toward spawn, breaker ON the right end wall).
 */
describe('spawn depot layout', () => {
  test('build station is the only prompt inside grab range at spawn', () => {
    for (const yaw of YAWS) {
      const world = fakeWorld(new Vector3(3, 0, -2), yaw)
      const spawn = world.spawn
      const dBuild = buildStationPosition(world).distanceTo(spawn)
      const dArmory = armoryStationPosition(world).distanceTo(spawn)
      const dBreaker = breakerPosition(world).distanceTo(spawn)
      expect(dBuild).toBeLessThan(dArmory)
      expect(dBuild).toBeLessThan(dBreaker)
      // The build prompt is up the moment the player spawns…
      expect(dBuild).toBeLessThan(GRAB_RANGE)
      // …and neither the armory nor the breaker competes with it there.
      expect(dArmory).toBeGreaterThan(GRAB_RANGE)
      expect(dBreaker).toBeGreaterThan(GRAB_RANGE)
    }
  })

  test('stations sit ahead of spawn; build opposite the armory laterally', () => {
    for (const yaw of YAWS) {
      const world = fakeWorld(new Vector3(-7, 0, 11), yaw)
      const [buildLat, buildFwd] = spawnFrame(world, buildStationPosition(world))
      const [armoryLat, armoryFwd] = spawnFrame(world, armoryStationPosition(world))
      expect(buildFwd).toBeGreaterThan(0)
      expect(armoryFwd).toBeGreaterThan(0)
      expect(buildLat * armoryLat).toBeLessThan(0)
    }
  })

  test('one E press serves ONE station: nearest untaken wins the overlap', () => {
    for (const yaw of YAWS) {
      const world = fakeWorld(new Vector3(3, 0, -2), yaw)
      // 0.4 m forward of spawn — inside BOTH the build and armory grab
      // discs (regression guard carried over from the tables: a single E
      // here must never grant builder + guns together).
      const px = world.spawn.x - Math.sin(yaw) * 0.4
      const pz = world.spawn.z - Math.cos(yaw) * 0.4
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

  test('breaker: right end wall, gear side, walked to on purpose', () => {
    for (const yaw of YAWS) {
      const world = fakeWorld(new Vector3(3, 0, -2), yaw)
      expect(breakerPosition(world).distanceTo(world.spawn)).toBeGreaterThan(GRAB_RANGE)
      const [breakerLat, breakerFwd] = spawnFrame(world, breakerPosition(world))
      const [armoryLat] = spawnFrame(world, armoryStationPosition(world))
      expect(breakerFwd).toBeGreaterThan(0)
      // Same side of the lot as the armory (the switch stub's contract).
      expect(breakerLat * armoryLat).toBeGreaterThan(0)
      // Mounted ON the container's right end wall: proud of the end plane
      // by at most 0.2 m, within the container's depth.
      const [depotLat, depotFwd] = spawnFrame(world, depotPosition(world))
      const endPlane = depotLat + DEPOT_SIZE[0] / 2
      expect(breakerLat).toBeGreaterThan(endPlane - 1e-6)
      expect(breakerLat - endPlane).toBeLessThan(0.2)
      expect(Math.abs(breakerFwd - depotFwd)).toBeLessThan(DEPOT_SIZE[2] / 2)
    }
  })

  test('E at the breaker serves the switch alone; thrown falls through', () => {
    for (const yaw of YAWS) {
      const world = fakeWorld(new Vector3(3, 0, -2), yaw)
      const at = breakerPosition(world)
      const stations = (thrown: boolean) =>
        new Map([
          ['build', { x: buildStationPosition(world).x, z: buildStationPosition(world).z, taken: false }],
          ['armory', { x: armoryStationPosition(world).x, z: armoryStationPosition(world).z, taken: false }],
          ['switch', { x: at.x, z: at.z, taken: thrown }],
        ])
      expect(nearestGrabbable(at.x, at.z, stations(false))).toBe('switch')
      // Once thrown (taken mirrors waveState.armed) the same spot never
      // re-throws — it falls through to whatever else is in range (here:
      // nothing, the pickup stations are across the container).
      expect(nearestGrabbable(at.x, at.z, stations(true))).not.toBe('switch')
    }
  })

  test('pickup stations sit INSIDE the container shell', () => {
    for (const yaw of YAWS) {
      const world = fakeWorld(new Vector3(-1, 0, 6), yaw)
      const [depotLat, depotFwd] = spawnFrame(world, depotPosition(world))
      for (const pos of [buildStationPosition(world), armoryStationPosition(world)]) {
        const [lat, fwd] = spawnFrame(world, pos)
        expect(Math.abs(lat - depotLat)).toBeLessThan(DEPOT_SIZE[0] / 2)
        expect(Math.abs(fwd - depotFwd)).toBeLessThan(DEPOT_SIZE[2] / 2)
      }
    }
  })

  test('the open side faces spawn, with walking room in front', () => {
    for (const yaw of YAWS) {
      const world = fakeWorld(new Vector3(0.5, 0, 4), yaw)
      const [depotLat, depotFwd] = spawnFrame(world, depotPosition(world))
      const frontPlane = depotFwd - DEPOT_SIZE[2] / 2
      // The shop front sits BETWEEN spawn and the container's center —
      // that is what "the open side faces spawn" means in the spawn frame —
      // and leaves at least 1.5 m of approach room.
      expect(frontPlane).toBeGreaterThan(1.5)
      // Spawn itself is outside the footprint (never inside the shell)…
      expect(depotFwd).toBeGreaterThan(DEPOT_SIZE[2] / 2)
      // …and both stations live in the FRONT half of the container: the
      // player reaches them through the opening, not through a wall.
      for (const pos of [buildStationPosition(world), armoryStationPosition(world)]) {
        const [, fwd] = spawnFrame(world, pos)
        expect(fwd).toBeLessThan(depotFwd)
      }
      // Static sanity on the constants themselves (yaw-independent).
      expect(BUILD_STATION_OFFSET[1]).toBeLessThan(DEPOT_OFFSET[1])
      expect(ARMORY_STATION_OFFSET[1]).toBeLessThan(DEPOT_OFFSET[1])
      expect(BREAKER_OFFSET[0]).toBeGreaterThan(DEPOT_OFFSET[0])
      expect(depotLat).toBeCloseTo(DEPOT_OFFSET[0], 10)
    }
  })
})
