import { describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, Matrix4, Mesh, PlaneGeometry, Vector3 } from 'three'
import { PLAYER_CAPSULE } from './collision'
import {
  bvhFor,
  capsuleOverlapsColliders,
  type ColliderEntry,
  probeSpawnSurfaceY,
  settleSpawnFeet,
  SPAWN_SETTLE_EPS,
  spawnGroundY,
  unstickSpawn,
} from './world'

/**
 * Spawn ground settle ("spawns half into the ground", owner report on a
 * LARGE real project): the old spawn Y was guessed from LEVEL elevations
 * and knew nothing about what actually stands at the spawn XZ — a raised
 * site slab / terrace under the ring spawn buried the player waist-deep,
 * and a capsule that STARTS interpenetrated is the one state the mover
 * can't fix (triangles deeper than its radius are invisible to push-out).
 * These tests pin the pure pieces: the downward surface probe
 * (probeSpawnSurfaceY / spawnGroundY), the capsule overlap test + step-lift
 * unstick (capsuleOverlapsColliders / unstickSpawn), and the combined
 * session-start settle (settleSpawnFeet).
 */

/** Solid box collider — the same hand-built entry stair-walk.test.ts uses. */
function boxCollider(
  size: [number, number, number],
  center: [number, number, number],
  overrides: Partial<Pick<ColliderEntry, 'nodeId' | 'nodeType' | 'disabled'>> = {},
): ColliderEntry {
  const mesh = new Mesh(new BoxGeometry(...size))
  mesh.position.set(...center)
  mesh.updateMatrixWorld(true)
  return {
    mesh,
    bvh: bvhFor(mesh),
    inverse: new Matrix4().copy(mesh.matrixWorld).invert(),
    worldBox: new Box3().setFromObject(mesh),
    root: mesh,
    nodeId: 'slab-test',
    nodeType: 'slab',
    ...overrides,
  }
}

/** A single 4×4 plane tilted `tiltDeg` from horizontal, centered at Y. */
function planeCollider(tiltDeg: number, centerY: number): ColliderEntry {
  const mesh = new Mesh(new PlaneGeometry(4, 4))
  mesh.rotation.x = -Math.PI / 2 + (tiltDeg * Math.PI) / 180
  mesh.position.y = centerY
  mesh.updateMatrixWorld(true)
  return {
    mesh,
    bvh: bvhFor(mesh),
    inverse: new Matrix4().copy(mesh.matrixWorld).invert(),
    worldBox: new Box3().setFromObject(mesh),
    root: mesh,
    nodeId: 'roof-test',
    nodeType: 'roof',
  }
}

describe('spawn ground probe', () => {
  test('flat lot — nothing at the spawn XZ: ground stays on the terrain plane at 0', () => {
    const colliders = [boxCollider([4, 3, 4], [20, 1.5, 20])]
    expect(probeSpawnSurfaceY(colliders, 0, 0)).toBeNull()
    expect(spawnGroundY(colliders, 0, 0)).toBe(0)
  })

  test('raised slab under the spawn XZ: feet settle on the slab top (the half-buried repro)', () => {
    // A 0.7 m site slab — the old spawn.y = 0 started the capsule waist-deep.
    const colliders = [boxCollider([6, 0.7, 6], [0, 0.35, 0])]
    expect(probeSpawnSurfaceY(colliders, 0, 0)).toBeCloseTo(0.7, 5)
    expect(spawnGroundY(colliders, 0, 0)).toBeCloseTo(0.7 + SPAWN_SETTLE_EPS, 5)
  })

  test('probe point inside a thick volume resolves to its TOP face (lift out, never buried)', () => {
    // 2.4 m plinth: a probe "from" y=0 sits deep inside it — the ray starts
    // above every candidate top, so the top face still answers.
    const colliders = [boxCollider([6, 2.4, 6], [0, 1.2, 0])]
    expect(spawnGroundY(colliders, 0, 0)).toBeCloseTo(2.4 + SPAWN_SETTLE_EPS, 5)
  })

  test('stacked surfaces: the topmost walkable top wins', () => {
    const colliders = [
      boxCollider([6, 0.3, 6], [0, 0.15, 0]),
      boxCollider([2, 0.4, 2], [0, 0.9, 0]), // terrace on the slab, top 1.1
    ]
    expect(spawnGroundY(colliders, 0, 0)).toBeCloseTo(1.1 + SPAWN_SETTLE_EPS, 5)
  })

  test('faces steeper than the walkable limit are not spawn ground', () => {
    // 60° > the 50° walkable limit: not a floor, fall back to the lot plane.
    expect(spawnGroundY([planeCollider(60, 1)], 0, 0)).toBe(0)
    // 30° ramp IS walkable ground — feet land on it.
    expect(spawnGroundY([planeCollider(30, 1)], 0, 0)).toBeCloseTo(1 + SPAWN_SETTLE_EPS, 5)
  })

  test('session fixtures (__boots-depot) are never spawn ground', () => {
    const colliders = [boxCollider([6, 0.7, 6], [0, 0.35, 0], { nodeId: '__boots-depot' })]
    expect(spawnGroundY(colliders, 0, 0)).toBe(0)
  })

  test('disabled (voxelized-away) colliders are skipped', () => {
    const colliders = [boxCollider([6, 0.7, 6], [0, 0.35, 0], { disabled: true })]
    expect(spawnGroundY(colliders, 0, 0)).toBe(0)
  })

  test('recessed surface below the lot plane clamps up to 0', () => {
    // Sunken patio (top at −0.2): the infinite lot plane at 0 wins anyway.
    const colliders = [boxCollider([4, 1, 4], [0, -0.7, 0])]
    expect(probeSpawnSurfaceY(colliders, 0, 0)).toBeCloseTo(-0.2, 5)
    expect(spawnGroundY(colliders, 0, 0)).toBe(0)
  })
})

describe('spawn unstick', () => {
  test('a free capsule is untouched', () => {
    const colliders = [boxCollider([4, 3, 4], [20, 1.5, 20])]
    const feet = new Vector3(0, 0, 0)
    expect(unstickSpawn(colliders, feet, PLAYER_CAPSULE)).toBe(0)
    expect(feet.y).toBe(0)
  })

  test('an interpenetrated capsule lifts free in steps', () => {
    // Floating slab spanning y 0.2..0.9 across the capsule body.
    const colliders = [boxCollider([6, 0.7, 6], [0, 0.55, 0])]
    const feet = new Vector3(0, 0, 0)
    const lift = unstickSpawn(colliders, feet, PLAYER_CAPSULE)
    expect(lift).toBeGreaterThan(0)
    expect(feet.y).toBe(lift)
    // Truly free at rest — even at the full (unshrunk) capsule radius.
    expect(
      capsuleOverlapsColliders(
        colliders,
        feet.x,
        feet.y,
        feet.z,
        PLAYER_CAPSULE.radius,
        PLAYER_CAPSULE.height,
      ),
    ).toBe(false)
  })

  test('a shallow side graze stays with the regular push-out (no lift)', () => {
    // Wall face at x = 0.30: inside the full 0.34 radius (push-out territory)
    // but outside the slack-shrunk unstick radius — lifting here would pop
    // the player over fences the capsule merely touches.
    const colliders = [boxCollider([1, 3, 4], [0.8, 1.5, 0])]
    expect(
      capsuleOverlapsColliders(colliders, 0, 0, 0, PLAYER_CAPSULE.radius, PLAYER_CAPSULE.height),
    ).toBe(true)
    const feet = new Vector3(0, 0, 0)
    expect(unstickSpawn(colliders, feet, PLAYER_CAPSULE)).toBe(0)
    expect(feet.y).toBe(0)
  })

  test('hopeless burial: nothing free within the lift cap leaves feet unchanged', () => {
    // Plates every 0.5 m from 0 to 5 — the 1.2 m capsule segment always
    // crosses one, so no lift ≤ 3 m frees it.
    const colliders: ColliderEntry[] = []
    for (let k = 0; k <= 10; k++) colliders.push(boxCollider([4, 0.1, 4], [0, k * 0.5, 0]))
    const feet = new Vector3(0, 0, 0)
    expect(unstickSpawn(colliders, feet, PLAYER_CAPSULE)).toBe(0)
    expect(feet.y).toBe(0)
  })
})

describe('settleSpawnFeet (session-start combined settle)', () => {
  test('flat ground: feet stay exactly where the spawn put them', () => {
    const feet = new Vector3(3, 0, 3)
    settleSpawnFeet([boxCollider([4, 3, 4], [20, 1.5, 20])], feet, PLAYER_CAPSULE)
    expect(feet.y).toBe(0)
  })

  test('raised slab at the spawn XZ: feet land on the slab top + epsilon', () => {
    const feet = new Vector3(0, 0, 0)
    settleSpawnFeet([boxCollider([6, 0.7, 6], [0, 0.35, 0])], feet, PLAYER_CAPSULE)
    expect(feet.y).toBeCloseTo(0.7 + SPAWN_SETTLE_EPS, 5)
  })

  test('stale high spawn Y drops back to the live surface', () => {
    // The snapshot said 1.2 (old elevated-level guess / removed collider) —
    // the live probe finds flat ground and brings the feet down.
    const feet = new Vector3(0, 1.2, 0)
    settleSpawnFeet([boxCollider([4, 3, 4], [20, 1.5, 20])], feet, PLAYER_CAPSULE)
    expect(feet.y).toBe(0)
  })

  test('surface probe + unstick compose: settled feet never interpenetrate an overhang lip', () => {
    // Ground slab top 0.3 AND a beam crossing the capsule body above it —
    // the point probe sets feet on the slab, the unstick clears the beam.
    const colliders = [
      boxCollider([6, 0.3, 6], [0, 0.15, 0]),
      // Beam off the probe point but inside the capsule radius: x 0.2..0.6,
      // y 0.8..1.2 — the point probe can't see it, the overlap test must.
      boxCollider([0.4, 0.4, 6], [0.4, 1.0, 0]),
    ]
    const feet = new Vector3(0, 0, 0)
    settleSpawnFeet(colliders, feet, PLAYER_CAPSULE)
    expect(
      capsuleOverlapsColliders(
        colliders,
        feet.x,
        feet.y,
        feet.z,
        PLAYER_CAPSULE.radius - 0.05,
        PLAYER_CAPSULE.height,
      ),
    ).toBe(false)
  })
})
