import { describe, expect, test } from 'bun:test'
import { Vector3 } from 'three'
import {
  BUILD_TABLE_SIZE,
  buildTablePosition,
  GRAB_RANGE,
  minigunTablePosition,
  TABLE_SIZE,
  tablePosition,
} from './guntable'
import type { GameWorld } from './world'

/**
 * Pure layout math for the three spawn tables. The contract under test:
 * the BUILD table is the nearest thing the player sees (its prompt is up
 * at spawn, and ONLY its prompt — the gear table stays out of grab range),
 * and its footprint never touches the gear table's, at any spawn yaw.
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

describe('spawn table layout', () => {
  test('build table is nearest, inside grab range at spawn — alone', () => {
    for (const yaw of YAWS) {
      const world = fakeWorld(new Vector3(3, 0, -2), yaw)
      const spawn = world.spawn
      const dBuild = buildTablePosition(world).distanceTo(spawn)
      const dFront = tablePosition(world).distanceTo(spawn)
      const dRear = minigunTablePosition(world).distanceTo(spawn)
      expect(dBuild).toBeLessThan(dFront)
      expect(dBuild).toBeLessThan(dRear)
      // The build prompt shows the moment the player spawns…
      expect(dBuild).toBeLessThan(GRAB_RANGE)
      // …and neither weapon table's prompt competes with it there.
      expect(dFront).toBeGreaterThan(GRAB_RANGE)
      expect(dRear).toBeGreaterThan(GRAB_RANGE)
    }
  })

  test('build table sits ahead of spawn, opposite side of the gear table', () => {
    for (const yaw of YAWS) {
      const world = fakeWorld(new Vector3(-7, 0, 11), yaw)
      const [buildLat, buildFwd] = spawnFrame(world, buildTablePosition(world))
      const [gearLat, gearFwd] = spawnFrame(world, tablePosition(world))
      expect(buildFwd).toBeGreaterThan(0)
      expect(gearFwd).toBeGreaterThan(0)
      expect(buildLat * gearLat).toBeLessThan(0)
    }
  })

  test('build and gear footprints never overlap', () => {
    for (const yaw of YAWS) {
      const world = fakeWorld(new Vector3(0.5, 0, 4), yaw)
      // Both tables rotate by spawnYaw, so in the spawn frame the tops are
      // axis-aligned rectangles: lateral ±w/2, forward ±d/2 around center.
      const [buildLat, buildFwd] = spawnFrame(world, buildTablePosition(world))
      const [gearLat, gearFwd] = spawnFrame(world, tablePosition(world))
      const latGap =
        Math.abs(buildLat - gearLat) - (BUILD_TABLE_SIZE[0] + TABLE_SIZE[0]) / 2
      const fwdGap =
        Math.abs(buildFwd - gearFwd) - (BUILD_TABLE_SIZE[2] + TABLE_SIZE[2]) / 2
      expect(Math.max(latGap, fwdGap)).toBeGreaterThan(0.05)
    }
  })
})
