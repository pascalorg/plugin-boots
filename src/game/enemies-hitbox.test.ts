import { afterEach, describe, expect, test } from 'bun:test'
import { Vector3 } from 'three'
import {
  BOT_STATS,
  type Bot,
  bots,
  dogHalfLen,
  raycastBots,
  resetBots,
  spawnBot,
} from './enemies-state'

/**
 * Shot hitboxes (enemies-state.raycastBots) — droids/drones are spheres,
 * dogs a capsule along their yaw axis. Regression lane: the dog used the
 * same fixed r = 0.42 sphere at body center, so side shots through the
 * long-body dog's visible snout (local z ≈ 0.66) or tail (≈ −0.61) — and
 * even the short dog's snout (≈ 0.57) — whiffed through the silhouette.
 */

const DOG_Y = BOT_STATS.dog.bodyY // 0.45 — capsule axis height off the feet

afterEach(() => {
  resetBots()
})

/** One dog at the origin, yaw 0 (facing +z), with a pinned body length. */
function spawnDog(bodyLen: 1 | 1.3): Bot {
  spawnBot('dog', 0, 0)
  const bot = bots[bots.length - 1]!
  bot.visual = { ...bot.visual, bodyLen }
  return bot
}

/** Level −x ray aimed at world (0, y, z) from x = 5. */
function sideShot(y: number, z: number) {
  return raycastBots(new Vector3(5, y, z), new Vector3(-1, 0, 0), 90)
}

describe('dog capsule hitbox', () => {
  test('long dog: side shots through snout, head and tail all hit', () => {
    const dog = spawnDog(1.3)
    for (const z of [0.6, 0.5, -0.55]) {
      const hit = sideShot(DOG_Y, z)
      expect(hit?.bot).toBe(dog)
    }
  })

  test('short dog: the snout is inside the capsule too', () => {
    const dog = spawnDog(1)
    expect(sideShot(DOG_Y, 0.55)?.bot).toBe(dog)
  })

  test('beyond the capsule ends and beside the body still miss', () => {
    spawnDog(1.3)
    // Axial reach = halfLen + radius ≈ 0.97; past the snout is air.
    expect(sideShot(DOG_Y, dogHalfLen(1.3) + BOT_STATS.dog.radius + 0.08)).toBeNull()
    // Straight-on shots keep the same lateral radius as the old sphere.
    const head = raycastBots(new Vector3(0.5, DOG_Y, 5), new Vector3(0, 0, -1), 90)
    expect(head).toBeNull()
  })

  test('the capsule follows the dog yaw', () => {
    const dog = spawnDog(1.3)
    dog.yaw = Math.PI / 2 // snout along world +x
    // The snout line rotated with the dog...
    const hit = raycastBots(new Vector3(0.6, DOG_Y, 5), new Vector3(0, 0, -1), 90)
    expect(hit?.bot).toBe(dog)
    // ...and the unrotated snout line is now beside the body: a miss.
    expect(sideShot(DOG_Y, 0.6)).toBeNull()
  })

  test('maxDist culls dogs like everything else', () => {
    spawnDog(1.3)
    expect(raycastBots(new Vector3(5, DOG_Y, 0), new Vector3(-1, 0, 0), 4)).toBeNull()
  })

  test('droids keep the plain body sphere', () => {
    spawnBot('droid', 0, 0)
    const r = BOT_STATS.droid.radius
    expect(sideShot(BOT_STATS.droid.bodyY, r + 0.05)).toBeNull()
    expect(sideShot(BOT_STATS.droid.bodyY, r - 0.05)).not.toBeNull()
  })
})
