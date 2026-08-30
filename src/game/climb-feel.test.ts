import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, Matrix4, Mesh, Vector3 } from 'three'
import {
  collideCapsule,
  moveCapsule,
  PLAYER_CAPSULE,
  STEP_OFFSET,
  stepUpWins,
} from './collision'
import {
  collideVoxelTargets,
  damageTarget,
  ensureVoxelTarget,
  resetDestruction,
  useDestruction,
  WALK_ONLY_MAX_DAMAGE,
  walkOnlyExpired,
  setShellFlag,
} from './destruction'
import { MOVE, projectOnWalkableSlope, stepVelocity, WALKABLE_NORMAL_Y } from './movement'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

// S2 flips conforming shells DEFAULT ON. This suite pins the VOXEL-ONLY
// lane (awake voxelize, collider hand-over, replica collision/raycasts),
// so it throws the per-kind kill-switches before every test — the same
// session-latched setShell(kind, false) rollback QA uses (the latch
// re-arms via each test's resetDestruction). afterAll restores the
// defaults for whatever suite runs after this file.
beforeEach(() => {
  setShellFlag('wall', false)
  setShellFlag('roof', false)
  setShellFlag('slab', false)
})
afterAll(() => {
  setShellFlag('wall', true)
  setShellFlag('roof', true)
  setShellFlag('slab', true)
})


/**
 * CLIMB FEEL, headless: the owner's "the character blocks on each step"
 * live report. Three fixes under test —
 *   1. STEP OFFSET: a grounded mover blocked by an obstruction whose top is
 *      within STEP_OFFSET (with headroom) lifts and continues WITHOUT speed
 *      loss (collision.moveCapsule); too-high stays a wall.
 *   2. FULL-SPEED SLOPES: grounded velocity rides walkable slope planes so
 *      horizontal speed up a 43° ramp equals flat-ground run speed
 *      (movement.projectOnWalkableSlope), and standing on a ramp holds.
 *   3. FEET SEE THE PLANE: a placed stairs/roof piece keeps its smooth
 *      merged-box collider capsule-solid (`walkOnly`) after voxel-cladding
 *      — its coincident voxel grid stops colliding — until damage crosses
 *      WALK_ONLY_MAX_DAMAGE and the plank demotes to disabled.
 *
 * Movement sims mirror player.tsx's frame order exactly: stepVelocity →
 * projectOnWalkableSlope (grounded, non-jump frames) → moveCapsule, 60 Hz.
 */

/** ≈ the builder's stairs plank tilt: one STOREY (2.8) over one CELL (3). */
const RAMP_TILT = -Math.atan2(2.8, 3)

function boxCollider(
  nodeId: string,
  nodeType: string,
  size: [number, number, number],
  center: [number, number, number],
  rotX = 0,
  walkOnClad = false,
): ColliderEntry {
  const mesh = new Mesh(new BoxGeometry(size[0], size[1], size[2]))
  mesh.position.set(center[0], center[1], center[2])
  mesh.rotation.x = rotX
  mesh.updateMatrixWorld(true)
  mesh.geometry.computeBoundingBox()
  return {
    mesh,
    bvh: bvhFor(mesh),
    inverse: new Matrix4().copy(mesh.matrixWorld).invert(),
    worldBox: new Box3().setFromObject(mesh),
    root: mesh,
    nodeId,
    nodeType,
    ...(walkOnClad ? { walkOnClad: true } : {}),
  }
}

type SimResult = {
  pos: Vector3
  /** Slowest horizontal speed sampled at t ≥ measureFrom (m/s). */
  minSpeed: number
  /** Mean horizontal speed over t ≥ measureFrom (m/s). */
  meanSpeed: number
  /** Sim time when `goal(pos)` first held (Infinity when it never did). */
  arrivedAt: number
}

/** Player-loop sim: constant wish direction, run speed, no jumping. Stops
 * early when `goal(pos)` holds (finite landings — pushing past one walks
 * off the far edge, the stair-walk.test.ts convention). */
function simulate(
  colliders: ColliderEntry[],
  start: Vector3,
  wishX: number,
  wishZ: number,
  seconds: number,
  measureFrom = 0.5,
  goal?: (pos: Vector3) => boolean,
): SimResult {
  const pos = start.clone()
  const vel = new Vector3()
  const normal = new Vector3(0, 1, 0)
  let grounded = true
  const dt = 1 / 60
  let minSpeed = Number.POSITIVE_INFINITY
  let speedSum = 0
  let samples = 0
  for (let t = 0; t < seconds; t += dt) {
    const jumped = stepVelocity(vel, { wishX, wishZ, walk: false, jump: false }, grounded, dt, MOVE)
    if (grounded && !jumped) projectOnWalkableSlope(vel, normal.x, normal.y, normal.z)
    grounded = moveCapsule(pos, vel, dt, colliders, grounded, jumped, PLAYER_CAPSULE, normal)
    if (t >= measureFrom) {
      const speed = Math.hypot(vel.x, vel.z)
      if (speed < minSpeed) minSpeed = speed
      speedSum += speed
      samples++
    }
    if (goal?.(pos)) {
      return { pos, minSpeed, meanSpeed: samples > 0 ? speedSum / samples : 0, arrivedAt: t }
    }
  }
  return {
    pos,
    minSpeed,
    meanSpeed: samples > 0 ? speedSum / samples : 0,
    arrivedAt: Number.POSITIVE_INFINITY,
  }
}

// ── 1. STEP OFFSET ───────────────────────────────────────────────────────────

describe('step offset (collision.moveCapsule)', () => {
  test('stepUpWins: blocked + lifted advance → lift; unblocked or no gain → keep', () => {
    const desired = 0.1
    expect(stepUpWins(desired, 0.005, 0.098)).toBe(true) // blocked flat, clean lifted advance
    expect(stepUpWins(desired, 0.095, 0.1)).toBe(false) // barely impeded — no step needed
    expect(stepUpWins(desired, 0.005, 0.005)).toBe(false) // lift gained nothing (a wall)
    expect(stepUpWins(0, 0, 1)).toBe(false) // no horizontal intent
  })

  test('a 0.3 m ledge (top within STEP_OFFSET) is climbed in-stride at run speed', () => {
    expect(0.3).toBeLessThan(STEP_OFFSET)
    // Long ledge so the 2 s run ends ON it: top at y = 0.3, near face z = −1.
    const ledge = boxCollider('ledge', 'stair', [4, 0.3, 24], [0, 0.15, -13])
    const { pos, minSpeed } = simulate([ledge], new Vector3(0, 0, 0.8), 0, -1, 2)
    expect(pos.y).toBeGreaterThanOrEqual(0.28) // standing on top
    expect(pos.z).toBeLessThan(-8) // …and far onto it: never ground to a halt
    // NO SPEED LOSS: the step frame keeps full run momentum.
    expect(minSpeed).toBeGreaterThanOrEqual(MOVE.runSpeed * 0.9)
  })

  test('a 0.5 m ledge (top above STEP_OFFSET) still blocks', () => {
    expect(0.5).toBeGreaterThan(STEP_OFFSET)
    const ledge = boxCollider('ledge', 'stair', [4, 0.5, 24], [0, 0.25, -13])
    const { pos } = simulate([ledge], new Vector3(0, 0, 0.8), 0, -1, 1.5)
    expect(pos.y).toBeLessThan(0.05) // never climbed
    expect(pos.z).toBeGreaterThan(-1.1) // held at the face
  })

  test('no headroom over the step → refused (the lifted capsule cannot stand)', () => {
    // Standing under the 1.9 m ceiling fits (capsule 1.78); standing ON the
    // 0.3 m ledge would need 2.08 — the lifted probe is pushed back down.
    const ledge = boxCollider('ledge', 'stair', [4, 0.3, 24], [0, 0.15, -13])
    const ceiling = boxCollider('ceiling', 'slab', [4, 0.2, 26], [0, 2.0, -12])
    const { pos } = simulate([ledge, ceiling], new Vector3(0, 0, 0.8), 0, -1, 1.5)
    expect(pos.y).toBeLessThan(0.05)
    expect(pos.z).toBeGreaterThan(-1.1)
  })

  test('host sawtooth stairs (0.19 m risers) climb a full storey fast', () => {
    // Same staircase family as stair-walk.test.ts, driven through the NEW
    // move routine: risers resolve as steps, not per-riser speed bleed.
    const riser = 0.19
    const tread = 0.26
    const steps = 10
    const colliders: ColliderEntry[] = []
    for (let i = 0; i < steps; i++) {
      const top = riser * (i + 1)
      colliders.push(
        boxCollider(`step-${i}`, 'stair', [1.2, top, tread], [0, top / 2, -(i * tread + tread / 2)]),
      )
    }
    const rise = riser * steps
    const runLen = tread * steps
    colliders.push(boxCollider('landing', 'stair', [1.2, rise, 2], [0, rise / 2, -(runLen + 1)]))
    const onLanding = (p: Vector3) => p.z < -(runLen + 0.3) && p.y >= rise - 0.02
    const { arrivedAt } = simulate(colliders, new Vector3(0, 0, 0.8), 0, -1, 3, 0.5, onLanding)
    // The stair-walk.test.ts tripwire budget is 3 s; the climb-feel pass
    // reaches the storey landing in about a third of that.
    expect(arrivedAt).toBeLessThan(1.2)
  })
})

// ── 2. FULL-SPEED SLOPES ─────────────────────────────────────────────────────

describe('full-speed slopes (movement.projectOnWalkableSlope)', () => {
  test('pure: a 43° plane keeps horizontal speed and gains exactly the rise', () => {
    const tilt = Math.atan2(2.8, 3) // ≈ 43.0°
    const n = { x: 0, y: Math.cos(tilt), z: Math.sin(tilt) } // uphill toward −Z
    const vel = { x: 0, y: 0, z: -MOVE.runSpeed }
    projectOnWalkableSlope(vel, n.x, n.y, n.z)
    expect(Math.hypot(vel.x, vel.z)).toBeCloseTo(MOVE.runSpeed, 6) // |v_horizontal| untouched
    expect(vel.y).toBeCloseTo(MOVE.runSpeed * Math.tan(tilt), 6) // slope-plane rise
    // Flat ground is the degenerate case: vel.y snaps to rest.
    const flat = { x: 3, y: 0.4, z: -2 }
    projectOnWalkableSlope(flat, 0, 1, 0)
    expect(flat.y).toBeCloseTo(0, 12)
  })

  test('pure: steeper than walkable (~50°) is left to the legacy clip', () => {
    const ny = Math.cos((60 * Math.PI) / 180)
    expect(ny).toBeLessThan(WALKABLE_NORMAL_Y)
    const vel = { x: 0, y: -1, z: -MOVE.runSpeed }
    projectOnWalkableSlope(vel, 0, ny, Math.sin((60 * Math.PI) / 180))
    expect(vel.y).toBe(-1) // untouched
  })

  test('sim: horizontal speed up a 43° ramp ≈ flat-ground run speed', () => {
    // Builder-style plank, low edge on the ground near z = 0, rising toward
    // +Z for ~6 m of run (5.6 m of rise).
    const ramp = boxCollider('ramp', 'stair', [3, 0.12, 8.2], [0, 2.8, 3], RAMP_TILT)
    // Stop at the top: the vertical ground resolve (collision.ts, QA
    // 2026-08-28) climbs POSITIONALLY at full speed now, so a fixed-length
    // run tops out (~1.15 s) and falls off the far edge before it ends.
    const up = simulate([ramp], new Vector3(0, 0, -1), 0, 1, 1.5, 0.5, (p) => p.y >= 5)
    const flat = simulate([], new Vector3(0, 0, -1), 0, 1, 1.5)
    expect(up.pos.y).toBeGreaterThanOrEqual(5) // actually climbed the ramp…
    expect(up.arrivedAt).toBeLessThan(1.3) // …the whole 5+ m rise, FAST —
    // the POSITIONAL rate the live QA gate measures, not just velocity.
    // GENRE PARITY: uphill horizontal speed matches flat ground within 3%.
    expect(up.minSpeed).toBeGreaterThanOrEqual(flat.minSpeed * 0.97)
    expect(up.meanSpeed).toBeGreaterThanOrEqual(flat.meanSpeed * 0.97)
  })

  test('sim: standing on a 43° ramp holds — no sliding, no gravity creep', () => {
    const ramp = boxCollider('ramp', 'stair', [3, 0.12, 8.2], [0, 2.8, 3], RAMP_TILT)
    // Feet on the ramp surface mid-slope (top face at z = 3 is ~y 2.85).
    const start = new Vector3(0, 2.9, 3)
    const { pos } = simulate([ramp], start, 0, 0, 2, 0)
    expect(Math.abs(pos.x - start.x)).toBeLessThan(0.06) // contact-settle jitter only
    expect(Math.abs(pos.z - start.z)).toBeLessThan(0.06)
    expect(Math.abs(pos.y - start.y)).toBeLessThan(0.12) // just the contact settle
  })

  test('sim: running DOWN the ramp stays glued (ground snap) at full speed', () => {
    const ramp = boxCollider('ramp', 'stair', [3, 0.12, 8.2], [0, 2.8, 3], RAMP_TILT)
    const down = simulate([ramp], new Vector3(0, 5.5, 5.9), 0, -1, 1.2)
    expect(down.pos.z).toBeLessThan(0) // reached the bottom and ran off
    expect(down.pos.y).toBeLessThan(0.05) // on the lot plane, not airborne
    expect(down.minSpeed).toBeGreaterThanOrEqual(MOVE.runSpeed * 0.9)
  })
})

// ── 3. FEET SEE THE PLANE (walkOnly) ─────────────────────────────────────────

function plankWorld(): { world: GameWorld; plank: ColliderEntry } {
  const plank = boxCollider('__boots-piece-1', 'block', [3, 0.12, 3], [0, 1.4, 0], 0, true)
  const buildingAabb = new Box3().copy(plank.worldBox)
  return {
    world: {
      colliders: [plank],
      walls: new Map(),
      glass: [],
      doors: [],
      overlayRoots: [],
      buildingAabb,
      spawn: new Vector3(0, 0, 6),
      spawnYaw: 0,
      levelId: null,
    },
    plank,
  }
}

describe('feet see the plane: walkOnly planks (builder pieces)', () => {
  afterEach(() => {
    resetDestruction()
  })

  test('pure: the flip threshold is “MORE than 12% of cells removed”', () => {
    expect(WALK_ONLY_MAX_DAMAGE).toBe(0.12)
    expect(walkOnlyExpired(100, 100)).toBe(false) // pristine
    expect(walkOnlyExpired(88, 100)).toBe(false) // exactly 12% — still smooth
    expect(walkOnlyExpired(87, 100)).toBe(true) // past it — holes are real
  })

  test('clad handover: walkOnClad → walkOnly (not disabled); voxels skip the capsule', () => {
    const { world, plank } = plankWorld()
    const target = ensureVoxelTarget(world, plank.nodeId)!
    expect(target).not.toBeNull()
    expect(plank.walkOnly).toBe(true) // feet keep the smooth plane
    expect(plank.disabled).toBeFalsy() // …instead of the legacy hand-over
    expect(target.walkOnly).toBe(true)

    // The capsule sweep still stands on the plank…
    const pos = new Vector3(0, 1.45, 0)
    const vel = new Vector3(0, -0.5, 0)
    expect(collideCapsule(pos, vel, world.colliders)).toBe(true)
    expect(pos.y).toBeCloseTo(1.46, 2)

    // …while the coincident voxel grid stays OUT of movement: a capsule
    // shoved through the cells is neither pushed nor grounded by them.
    const inside = new Vector3(0, 1.34, 0)
    const still = new Vector3()
    expect(collideVoxelTargets(inside, still, PLAYER_CAPSULE.radius, PLAYER_CAPSULE.height)).toBe(
      false,
    )
    expect(inside.y).toBe(1.34)
    expect(useDestruction.getState().targets.get(plank.nodeId)!.grid.aliveCount).toBeGreaterThan(0)
  })

  test('light damage keeps the plane; crossing the threshold makes holes real', () => {
    const { world, plank } = plankWorld()
    const target = ensureVoxelTarget(world, plank.nodeId)!
    const total = target.grid.count

    // One small carve (well under 12% of cells): still smooth.
    damageTarget(world, plank.nodeId, new Vector3(1.3, 1.46, 1.3), 0.05)
    expect(total - target.grid.aliveCount).toBeGreaterThan(0)
    expect(walkOnlyExpired(target.grid.aliveCount, total)).toBe(false)
    expect(plank.walkOnly).toBe(true)
    expect(plank.disabled).toBeFalsy()

    // A big center carve blows past the threshold: the plank demotes and
    // the voxel grid (holes and all) owns movement too.
    damageTarget(world, plank.nodeId, new Vector3(0, 1.4, 0), 2)
    expect(walkOnlyExpired(target.grid.aliveCount, total)).toBe(true)
    expect(plank.walkOnly).toBe(false)
    expect(plank.disabled).toBe(true)
    expect(target.walkOnly).toBe(false)
    // Movement collides the surviving cells again.
    const pos = new Vector3(1.35, 1.42, 1.35)
    const vel = new Vector3()
    collideVoxelTargets(pos, vel, PLAYER_CAPSULE.radius, PLAYER_CAPSULE.height)
    expect(pos.y).not.toBe(1.42) // pushed by live rim voxels
  })

  test('host walls are untouched: hand-over still disables their colliders', () => {
    const wallEntry = boxCollider('wall-1', 'wall', [2, 2.7, 0.12], [0, 1.35, 5])
    const { world } = plankWorld()
    world.colliders.push(wallEntry)
    world.walls.set('wall-1', {
      node: { id: 'wall-1', start: [-1, 5], end: [1, 5], height: 2.7, thickness: 0.12 },
      root: wallEntry.root,
      meshes: [wallEntry.mesh],
    })
    ensureVoxelTarget(world, 'wall-1')
    expect(wallEntry.disabled).toBe(true)
    expect(wallEntry.walkOnly).toBeFalsy()
  })
})
