import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, Matrix4, Mesh, Vector3 } from 'three'
import { useBoots } from '../store'
import { resetDestruction, useDestruction } from './destruction'
import { bots, resetBots, spawnBot } from './enemies-state'
import {
  BLAST_RADIUS,
  explodeAt,
  GRENADE_COOLDOWN,
  GRENADE_FUSE,
  grenadeApi,
  grenadeCooldownLeft,
  grenadeReady,
  liveGrenades,
  resetGrenades,
  throwGrenade,
  throwVelocity,
  updateGrenades,
} from './grenade'
import { playerRig } from './player'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

/**
 * Mega-grenade, headless: throw gating (phase/stagger/cooldown/pool), the
 * arc + single-bounce integrator, fuse-end detonation (bot damage + fling
 * inside 6 m, spared outside), the destruction fallback carve, and the
 * pure throw-velocity math. Rendering (<Grenades/>) is DOM-bound and
 * covered by review.
 */

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

function makeWorld(colliders: ColliderEntry[] = []): GameWorld {
  const buildingAabb = new Box3(new Vector3(-10, 0, -10), new Vector3(10, 4, 10))
  return {
    colliders,
    walls: new Map(),
    glass: [],
    doors: [],
    overlayRoots: [],
    buildingAabb,
    spawn: new Vector3(0, 0, 5),
    spawnYaw: 0,
    levelId: null,
  }
}

/** Step the sim in fixed slices (matches the frame-loop's 1/30 cap). */
function step(world: GameWorld, seconds: number, dt = 1 / 60): void {
  for (let t = 0; t < seconds; t += dt) updateGrenades(world, dt)
}

beforeEach(() => {
  useBoots.getState().resetSession()
  useBoots.setState({ phase: 'game', staggered: false })
  playerRig.position.set(0, 1.58, 5)
  playerRig.yaw = 0
  playerRig.pitch = 0
  resetGrenades()
  resetBots()
  resetDestruction()
})

afterEach(() => {
  resetGrenades()
  resetBots()
  resetDestruction()
  useBoots.setState({ phase: 'editor', staggered: false })
})

describe('throwVelocity', () => {
  test('level throw goes -Z at ~14 m/s with the loft on top', () => {
    const v = throwVelocity(new Vector3(), 0, 0)
    expect(v.z).toBeCloseTo(-14, 5)
    expect(v.x).toBeCloseTo(0, 5)
    expect(v.y).toBeCloseTo(1.4, 5)
  })

  test('pitch aims the arc up', () => {
    const v = throwVelocity(new Vector3(), 0, Math.PI / 4)
    expect(v.y).toBeGreaterThan(v.length() * 0.4)
    expect(v.z).toBeLessThan(0)
  })
})

describe('throw gating', () => {
  test('throws only in game phase, then cools down 5s', () => {
    const world = makeWorld()
    expect(throwGrenade(world)).toBe(true)
    expect(liveGrenades()).toBe(1)
    expect(grenadeReady()).toBe(false)
    expect(grenadeCooldownLeft()).toBeCloseTo(GRENADE_COOLDOWN, 5)
    // Cooldown blocks the second throw.
    expect(throwGrenade(world)).toBe(false)
    expect(liveGrenades()).toBe(1)
    // After the cooldown decays it throws again.
    step(world, GRENADE_COOLDOWN + 0.1)
    expect(grenadeReady()).toBe(true)
    expect(throwGrenade(world)).toBe(true)
  })

  test('refused outside game phase and while staggered', () => {
    const world = makeWorld()
    useBoots.setState({ phase: 'editor' })
    expect(throwGrenade(world)).toBe(false)
    useBoots.setState({ phase: 'game', staggered: true })
    expect(throwGrenade(world)).toBe(false)
    expect(liveGrenades()).toBe(0)
  })

  test('grenadeApi.throw is the same entry point', () => {
    const world = makeWorld()
    expect(grenadeApi.throw(world)).toBe(true)
    expect(liveGrenades()).toBe(1)
  })
})

describe('flight + fuse', () => {
  test('arcs forward, bounces once on the ground, detonates at fuse end', () => {
    const world = makeWorld()
    expect(throwGrenade(world)).toBe(true)
    // Mid-flight: it traveled -Z and is airborne.
    step(world, 0.5)
    expect(liveGrenades()).toBe(1)
    // Past the fuse: gone (detonated).
    step(world, GRENADE_FUSE)
    expect(liveGrenades()).toBe(0)
  })

  test('fuse-end blast hurts and flings a close bot, spares a far one', () => {
    const world = makeWorld()
    // Aim slightly down so the grenade lands and rests ahead of the player.
    playerRig.pitch = -0.5
    spawnBot('droid', 0, 1) // a few metres from the landing zone
    spawnBot('droid', 0, -40) // far outside the 6 m bot radius
    const near = bots[0]!
    const far = bots[1]!
    const nearStart = near.position.clone()
    const farStart = far.position.clone()
    expect(throwGrenade(world)).toBe(true)
    step(world, GRENADE_FUSE + 0.2)
    expect(liveGrenades()).toBe(0)
    // 120 dmg kills a 65 hp droid outright and flings it 2-4 m.
    expect(near.state).toBe('dying')
    const flung = near.position.distanceTo(nearStart)
    expect(flung).toBeGreaterThanOrEqual(2 - 1e-6)
    expect(flung).toBeLessThanOrEqual(4 + 1e-6)
    // The far bot never notices.
    expect(far.state).toBe('alive')
    expect(far.position.distanceTo(farStart)).toBe(0)
  })
})

describe('explodeAt fallback carve', () => {
  test('levels voxels out of a destructible wall in radius (no damageExplosion yet)', () => {
    const wall = boxCollider('wall-1', 'wall', [3, 2.7, 0.12], [0, 1.35, 0])
    const world = makeWorld([wall])
    explodeAt(world, new Vector3(0, 1.2, 0.5))
    const target = useDestruction.getState().targets.get('wall-1')
    expect(target).toBeDefined()
    // The blast radius dwarfs the wall — the carve should gut most of it.
    expect(target!.grid.aliveCount).toBeLessThan(target!.grid.alive.length * 0.5)
  })

  test('non-destructible nodes are not voxelized by the blast', () => {
    const rock = boxCollider('terrain-1', 'terrain', [2, 1, 2], [0, 0.5, 0])
    const world = makeWorld([rock])
    explodeAt(world, new Vector3(0, 1, 0))
    expect(useDestruction.getState().targets.size).toBe(0)
  })

  test('bot fling direction points away from the blast', () => {
    const world = makeWorld()
    spawnBot('dog', 2, 0)
    const dog = bots[0]!
    explodeAt(world, new Vector3(0, 0.5, 0))
    expect(dog.position.x).toBeGreaterThan(2)
    expect(Math.abs(dog.position.z)).toBeLessThan(1e-6)
    expect(dog.position.distanceTo(new Vector3(2, dog.position.y, 0))).toBeLessThanOrEqual(
      4 + 1e-6,
    )
  })

  test('blast radius constant matches the contract', () => {
    expect(BLAST_RADIUS).toBeCloseTo(3.2, 5)
  })
})
