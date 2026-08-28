import { Box3, Line3, Vector3 } from 'three'
import type { ColliderEntry } from './world'

/**
 * Capsule-vs-world resolution — the three-mesh-bvh `characterMovement`
 * pattern, per-mesh in local space (host transforms are rigid). Mutates
 * position (feet) and clips velocity against contact normals so the player
 * slides along walls instead of sticking.
 *
 * CLIMB FEEL additions:
 * - collideCapsule keeps `walkOnly` colliders (FEET SEE THE PLANE — the
 *   smooth merged-box plank of a voxel-clad placed ramp; bullets skip those
 *   entries and hit the voxel grid instead) and can report the ground
 *   contact normal so movement can ride slopes at full speed.
 * - moveCapsule is the integrate + slide + STEP OFFSET + ground-snap move
 *   the player runs: a horizontal block whose top is within STEP_OFFSET
 *   (with headroom) lifts the capsule and continues WITHOUT speed loss, so
 *   real sawtooth stairs climb at run speed instead of grinding on every
 *   riser. Zero per-frame allocations — module temps only.
 */

export type CapsuleConfig = { radius: number; height: number }

export const PLAYER_CAPSULE: CapsuleConfig = { radius: 0.34, height: 1.78 }
export const EYE_HEIGHT = 1.58

/** Capsule step-up: a blocking obstruction whose top is within this of the
 * feet gets climbed in-stride (standard character-controller step). Covers
 * code-max 0.27 m host risers with margin, but never a half-wall (0.93 m). */
export const STEP_OFFSET = 0.35

/** A flat slide that kept at least this fraction of its intended horizontal
 * advance was not meaningfully blocked — no step attempt. */
const STEP_BLOCK_RATIO = 0.9
/** The lifted slide must beat the flat slide by at least this (m) to win. */
const STEP_MIN_GAIN = 1e-3
/** Intended horizontal advance (m) under which stepping is pointless. */
const STEP_MIN_INPUT = 1e-4
/** The step's down-settle and the ground snap probe in slices this tall so
 * the push-out always resolves against the surface below, never sideways
 * out of a deep burial. */
const SETTLE_SLICES = 4
/** How far below the feet the ground snap searches when a previously
 * grounded, non-jumping mover loses contact (slope-parallel motion floats
 * off the plane by float noise; descending ramps outrun the contact). */
const GROUND_SNAP = STEP_OFFSET

const _segment = new Line3()
const _localSegment = new Line3()
const _worldBox = new Box3()
const _localBox = new Box3()
const _triPoint = new Vector3()
const _capsulePoint = new Vector3()
const _normal = new Vector3()

function refreshSegments(pos: Vector3, cfg: CapsuleConfig, collider: ColliderEntry): void {
  _segment.start.set(pos.x, pos.y + cfg.radius, pos.z)
  _segment.end.set(pos.x, pos.y + cfg.height - cfg.radius, pos.z)
  _localSegment.copy(_segment).applyMatrix4(collider.inverse)
}

/** Steepest ground contact of the CURRENT collideCapsule call (min normal.y
 * above the grounded threshold) — module state so the resolve loop stays
 * allocation-free. */
let _groundNy = Number.POSITIVE_INFINITY

/** Resolve the capsule out of every collider. Returns whether any contact
 * counted as ground (normal.y > 0.55) this pass. `walkOnly` colliders stay
 * solid here on purpose — movement sees the smooth plane, bullets see the
 * voxels. When `groundNormalOut` is given it receives the STEEPEST ground
 * contact normal of this pass (slope riding wants the ramp, not the seam's
 * flat neighbor), or (0, 1, 0) when only the lot plane grounds the capsule. */
export function collideCapsule(
  pos: Vector3,
  vel: Vector3,
  colliders: ColliderEntry[],
  cfg: CapsuleConfig = PLAYER_CAPSULE,
  groundNormalOut?: Vector3,
): boolean {
  let grounded = false
  _groundNy = Number.POSITIVE_INFINITY
  if (groundNormalOut) groundNormalOut.set(0, 1, 0)

  for (let iteration = 0; iteration < 3; iteration++) {
    let corrected = false
    _worldBox.min.set(pos.x - cfg.radius, pos.y, pos.z - cfg.radius)
    _worldBox.max.set(pos.x + cfg.radius, pos.y + cfg.height, pos.z + cfg.radius)

    for (const collider of colliders) {
      if (collider.disabled) continue
      if (!collider.worldBox.intersectsBox(_worldBox)) continue
      refreshSegments(pos, cfg, collider)
      _localBox.makeEmpty()
      _localBox.expandByPoint(_localSegment.start)
      _localBox.expandByPoint(_localSegment.end)
      _localBox.min.addScalar(-cfg.radius)
      _localBox.max.addScalar(cfg.radius)

      collider.bvh.shapecast({
        intersectsBounds: (box) => box.intersectsBox(_localBox),
        intersectsTriangle: (tri) => {
          const distance = tri.closestPointToSegment(_localSegment, _triPoint, _capsulePoint)
          if (distance >= cfg.radius) return false
          const depth = cfg.radius - distance
          _normal.subVectors(_capsulePoint, _triPoint)
          if (_normal.lengthSq() < 1e-12) return false
          _normal.normalize().transformDirection(collider.mesh.matrixWorld)
          pos.addScaledVector(_normal, depth)
          if (_normal.y > 0.55) {
            grounded = true
            if (groundNormalOut && _normal.y < _groundNy) {
              _groundNy = _normal.y
              groundNormalOut.copy(_normal)
            }
          }
          const into = vel.dot(_normal)
          if (into < 0) vel.addScaledVector(_normal, -into)
          corrected = true
          refreshSegments(pos, cfg, collider)
          return false
        },
      })
    }
    if (!corrected) break
  }

  // The lot itself: an infinite ground plane at y = 0.
  if (pos.y < 0) {
    pos.y = 0
    if (vel.y < 0) vel.y = 0
    grounded = true
  } else if (pos.y < 0.02 && vel.y <= 0.01) {
    grounded = true
  }

  return grounded
}

/**
 * Pure step-up decision (exported for tests): lift only when the flat slide
 * was truly blocked (kept under STEP_BLOCK_RATIO of its intended advance)
 * and the lifted slide actually got farther. All three are horizontal
 * distances in meters for one tick.
 */
export function stepUpWins(desired: number, flat: number, lifted: number): boolean {
  if (desired < STEP_MIN_INPUT) return false
  if (flat >= desired * STEP_BLOCK_RATIO) return false
  return lifted > flat + STEP_MIN_GAIN
}

const _moveStartPos = new Vector3()
const _moveStartVel = new Vector3()
const _stepPos = new Vector3()
const _stepVel = new Vector3()
const _snapPos = new Vector3()
const _snapVel = new Vector3()
const _flatNormal = new Vector3()

/**
 * One movement tick: integrate `pos` by `vel · dt`, resolve against the
 * colliders, and layer the two grounded-movement fixes on top:
 *
 * STEP OFFSET — when the slide was blocked horizontally while grounded, retry
 * from STEP_OFFSET higher and settle back down; if the lifted slide got
 * farther AND lands grounded (obstruction top within the offset, headroom
 * above — a ceiling that pushes the lifted probe back down aborts), commit it
 * and RESTORE the pre-move horizontal velocity: the step costs no speed.
 *
 * GROUND SNAP — a previously grounded, non-jumping mover that lost contact
 * (running down a ramp, float noise on slope-parallel motion) probes up to
 * GROUND_SNAP below and re-attaches; past a real edge the probe finds
 * nothing and the mover goes airborne exactly as before.
 *
 * Returns grounded. Extra resolve passes only run on blocked/detached
 * frames; the plain path costs exactly one collideCapsule, and everything
 * uses module temps (zero per-frame allocations).
 */
export function moveCapsule(
  pos: Vector3,
  vel: Vector3,
  dt: number,
  colliders: ColliderEntry[],
  wasGrounded: boolean,
  jumped: boolean,
  cfg: CapsuleConfig = PLAYER_CAPSULE,
  groundNormalOut?: Vector3,
): boolean {
  _moveStartPos.copy(pos)
  _moveStartVel.copy(vel)
  const desired = Math.hypot(vel.x, vel.z) * dt

  pos.addScaledVector(vel, dt)
  let grounded = collideCapsule(pos, vel, colliders, cfg, groundNormalOut)

  // STEP OFFSET: only for grounded movers with real horizontal intent.
  if (wasGrounded && !jumped && desired >= STEP_MIN_INPUT) {
    const flat = Math.hypot(pos.x - _moveStartPos.x, pos.z - _moveStartPos.z)
    if (flat < desired * STEP_BLOCK_RATIO) {
      if (groundNormalOut) _flatNormal.copy(groundNormalOut)
      _stepPos.copy(_moveStartPos)
      _stepPos.y += STEP_OFFSET
      _stepPos.addScaledVector(_moveStartVel, dt)
      _stepVel.copy(_moveStartVel)
      const liftedY = _stepPos.y
      collideCapsule(_stepPos, _stepVel, colliders, cfg)
      // Headroom: a ceiling that pushed the lifted probe back down means the
      // capsule can't stand on the step — abort before the settle.
      if (_stepPos.y >= liftedY - 1e-3) {
        // Settle back down in slices so the push-out resolves against the
        // step's TOP, not sideways out of a deep burial.
        let steppedGrounded = false
        for (let i = 0; i < SETTLE_SLICES && !steppedGrounded; i++) {
          _stepPos.y -= STEP_OFFSET / SETTLE_SLICES
          steppedGrounded = collideCapsule(_stepPos, _stepVel, colliders, cfg, groundNormalOut)
        }
        const lifted = Math.hypot(_stepPos.x - _moveStartPos.x, _stepPos.z - _moveStartPos.z)
        if (steppedGrounded && stepUpWins(desired, flat, lifted)) {
          pos.copy(_stepPos)
          // Lift-and-continue WITHOUT speed loss: the step never eats the
          // horizontal momentum the riser's face clipped away.
          vel.x = _moveStartVel.x
          vel.z = _moveStartVel.z
          vel.y = 0
          return true
        }
      }
      if (groundNormalOut) groundNormalOut.copy(_flatNormal)
    }
  }

  // GROUND SNAP: re-attach a grounded mover that only lost contact to
  // slope-parallel drift — never after a jump, never past a real drop.
  if (!grounded && wasGrounded && !jumped) {
    _snapPos.copy(pos)
    _snapVel.copy(vel)
    let snapped = false
    for (let i = 0; i < SETTLE_SLICES && !snapped; i++) {
      _snapPos.y -= GROUND_SNAP / SETTLE_SLICES
      snapped = collideCapsule(_snapPos, _snapVel, colliders, cfg, groundNormalOut)
    }
    if (snapped && _snapPos.y <= pos.y + 1e-4) {
      pos.copy(_snapPos)
      vel.copy(_snapVel)
      grounded = true
    } else if (groundNormalOut) {
      groundNormalOut.set(0, 1, 0)
    }
  }

  return grounded
}
