'use client'

import { createPortal, useFrame } from '@react-three/fiber'
import { type ReactElement, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  BoxGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  type Group,
  type Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  RingGeometry,
  SphereGeometry,
  TorusGeometry,
} from 'three'
import { type RemoteShotKind, sfx } from './audio'
import { EYE_HEIGHT } from './collision'
import {
  type LodCamera,
  noopRaycast,
  ringGeometry,
  ringMaterialFor,
  ringVisible,
  SPECTATOR_RING_RENDER_ORDER,
  spectatorTagOpacity,
  tagDepthTest,
  tagFontPx,
  tagLiftY,
  tagRenderOrder,
  tagScale,
  worldPerPixel,
} from './far-lod'
import { clampFrameDt } from './feel'
import { gripQuaternion, gripToShoulder, holdFor, leftGripFor } from './hand-grips'
import { AVATAR_SKIN_HEX } from './hand-pose'
import { HandMesh } from './hand-rig'
import { MOVE } from './movement'
import { localUserId } from './net'
import { SprayerModel } from './paint'
import {
  DEFAULT_DIMS,
  faceOpenStatus,
  GRIP_IN_HAND,
  instantiatePascaline,
  mouthOpenAt,
  type PascalineDims,
  type PascalineFace,
  type PascalineTemplate,
  setMouth,
  usePascalineTemplate,
} from './pascaline-model'
import {
  createSampledPose,
  createSmoother,
  INTERP_DELAY_MIN_MS,
  interpDelayFor,
  sampleAt,
  type SampledPose,
  shotsFired,
  slewDelay,
  smoothPose,
} from './presence-interp'
import {
  getRemotes,
  getRosterVersion,
  participantName,
  registerPresenceDebugSource,
  type RemotePlayer,
  wrapAngle,
} from './presence'
import { footPlants, remoteFootstep } from './remote-footsteps'
import { remoteLabel, sameNames } from './roster-names'
import { getSession } from './session'
import { isPeerTalking } from './voice'
import {
  HammerModel,
  KnifeModel,
  MinigunModel,
  MUZZLE_OFFSETS,
  PistolModel,
  RifleModel,
  WarhammerModel,
} from './weapon-models'

/**
 * Remote-player avatars — the render side of co-presence. <RemotePlayers/>
 * maps the live remote registry (presence.ts) onto <RemoteAvatar> rigs,
 * articulated purely from the sampled wire pose (body yaw, head/weapon-arm
 * pitch, gait-sine leg swing driven by normalized speed, airborne tuck when
 * !g, slump when st), the held weapon silhouette reusing the viewmodel's
 * weapon-models components (swapped on `w`, change-gated), and a name-tag
 * billboard CanvasTexture (the guntable TableSign idiom — disposed on
 * despawn, solid to 24 m then faded out to nothing by 40 m). Avatars scale
 * in over 200 ms on join.
 *
 * EVERY PEER IS PASCALINE (owner ask, 2026-09-01: "our avatars should look
 * like pascalines, only slightly customized"). The rig is the mascot as the
 * official render pack draws her — white hard hat with the Pascal logotype,
 * long dark hair to the shoulders, black jacket, charcoal cargo pants, the
 * leather tool belt with its pouch and yellow tape, tan work boots (the
 * reason this plugin's name fits) — built from cached primitives, not a
 * loaded mesh: an avatar has to cost nothing, and there are up to twelve.
 *
 * THE ONE THING THAT VARIES IS THE COLOR: a site vest over the jacket (front
 * and back, so it reads from any angle) plus the hard-hat band, in one of 8
 * tints. `assignPalette` hands out DISTINCT tints across the people actually
 * in the lot, local player included, so "I'm the blue one" is true rather
 * than probable. Everything else is on-model, identical for everyone.
 *
 * DETAIL FALLS AWAY WITH DISTANCE (detailVisible): past 14 m the pouch,
 * tape, logotype, eyes and side locks stop drawing, because at that range
 * silhouette and vest color are the whole message. Near, an avatar is ~26
 * primitives; far, ~14 — a full lobby stays a bounded draw cost.
 *
 * The roster this renders is HARD-CAPPED upstream at
 * presence.MAX_REMOTE_AVATARS, so the mounted rig count is bounded no matter
 * how busy the lobby gets.
 *
 * THEY SHOOT AND YOU KNOW IT (owner ask, 2026-09-01: "last time I could not
 * hear or see other players shoot"). The pose carries a fire counter, so this
 * file compares it against the last count it SAW for that peer and turns each
 * new round into a muzzle flash + tracer streak at the actual muzzle of the
 * actual gun they are holding — the fx hang off the weapon group, so they
 * inherit the whole arm chain for free and point exactly where the peer aims —
 * plus one sfx.remoteShot voiced at their distance and bearing. The flash grows
 * slightly with range so a firefight across the lot still reads; the IMPACT end
 * needs nothing from here, because a remote carve already throws its own dust
 * and debris where the round landed (destruction.ts's remote runtime).
 *
 * ANTI-GOAL (deliberate, do not "fix"): avatars NEVER join the world's
 * colliders and are NEVER shootable. They are pure visuals — never pushed
 * into world.colliders, never registered as a voxel/segment/bot target
 * (shooting.ts raycasts its own registries, not the scene graph), and the
 * root is tagged userData.__boots so identifyAim attributes them. Peers
 * cannot block doorways, eat bullets, or brace a collapsing build; each
 * client's game stays exactly as solo, plus ghosts.
 *
 * THEY MOVE LIKE PEOPLE (2026-09-02 motion pass): the gait is a stride length
 * paced by the speed the body is DRAWN moving at (never the wire `s`), the root
 * drops so the stance foot plants, a strafe steps sideways and a backpedal runs
 * the cycle backwards, the legs lag the aim while the torso carries the whole
 * view yaw (the gun stays on the peer's true aim), landings squash, shots kick
 * the arm, and each foot plant voices a footstep at the peer's bearing. Between
 * the wire and the root: a per-peer adaptive interpolation delay and a residual
 * smoother (presence-interp.ts), so late frames glide instead of popping.
 *
 * THEY ARE SEEN AND HEARD (2026-09-02 avatar pass): a spectator in the editor
 * gets the far-LOD tag (far-lod.ts) — constant ~36 px, lifted, drawn through
 * walls over a floor ring — while the in-game tag stays depth-tested and
 * unscaled; a talking peer wears a green halo around the tag and the dot above
 * it, and the face plate flaps between its closed and open-mouth paints
 * (pascaline-model.ts setMouth); the fists are the first-person hands
 * (hand-rig.tsx) on the grip table's points (hand-grips.ts), the support arm
 * solved to exactly the table's point; the roster chip carries names.
 *
 * Zero per-frame allocations: one module-level SampledPose + quaternions +
 * two arm solutions are reused across every avatar; geometries/materials are
 * module caches.
 */

// ── Palette (pure, tested) ───────────────────────────────────────────────────

/** 8 avatar tints — assigned by userId hash, so a player keeps their color
 * across sessions and every client agrees on it without coordination. */
export const AVATAR_PALETTE = [
  '#d95d4e', // clay red
  '#4d8fd1', // work blue
  '#58b368', // site green
  '#d8a13a', // hi-vis amber
  '#9a6dd7', // violet
  '#45b8ac', // teal
  '#d16fa8', // pink
  '#8a9a5b', // moss
] as const

/** FNV-1a over the userId — stable, fast, good spread on short ids. */
export function hashUserId(userId: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export function paletteIndexFor(userId: string): number {
  return hashUserId(userId) % AVATAR_PALETTE.length
}

/**
 * Hand out DISTINCT tints to the people in this lot.
 *
 * The hash alone is stable but not unique: with 8 slots, two of five players
 * share a color about half the time, and "the blue one" stops being a way to
 * name a teammate. So the hash becomes a PREFERENCE and collisions walk
 * forward to the first free slot.
 *
 * It has to agree on every screen without a single byte of coordination,
 * which is why it is a pure function of the SORTED id set: same roster in,
 * same assignment out, on every client. Past 8 players the palette is
 * genuinely exhausted and ids fall back to their preferred slot — a duplicate
 * beyond the eighth peer, not an error. Duplicate ids collapse (one person on
 * two devices is one color, in both windows).
 */
export function assignPalette(userIds: readonly string[]): Map<string, number> {
  const out = new Map<string, number>()
  const taken = new Set<number>()
  for (const userId of [...new Set(userIds)].sort()) {
    const preferred = paletteIndexFor(userId)
    let slot = preferred
    if (taken.size < AVATAR_PALETTE.length) {
      for (let step = 0; step < AVATAR_PALETTE.length; step++) {
        const candidate = (preferred + step) % AVATAR_PALETTE.length
        if (!taken.has(candidate)) {
          slot = candidate
          break
        }
      }
    }
    taken.add(slot)
    out.set(userId, slot)
  }
  return out
}

// ── Articulation (pure, tested) ──────────────────────────────────────────────

/**
 * THE GAIT IS A STRIDE LENGTH, NOT A CADENCE. A leg of LEG_LEN_M swung ±θ
 * covers 2·L·sin θ of ground per step, so for the feet to PLANT rather than
 * slide the phase must advance π per stepLength(s) of DISPLAYED travel:
 * gaitRate(s) = v·π / stepLength(s). The old fixed cadence (7 rad/s at full
 * speed, 0.55 rad swing) covered 2.9 m of ground per 0.87 m foot arc — the
 * treadmill everyone saw. The renderer feeds these the speed the avatar is
 * actually drawn moving at (updateMotion), never the sender's wire `s`, so an
 * extrapolating or frozen peer's legs stop with its body.
 */
/** Hip to sole (m) — the mascot's thigh + shin. */
export const LEG_LEN_M = DEFAULT_DIMS.thighLen + DEFAULT_DIMS.shinLen
/** Full normalized speed in m/s (the wire's s = 1). */
export const RUN_SPEED_M_S = MOVE.runSpeed
/** The normalized speed of a walk. */
export const WALK_S = MOVE.walkSpeed / MOVE.runSpeed
/** Below this normalized speed nobody takes a step: the legs settle. */
export const GAIT_MIN_S = 0.08
/** Peak hip swing (rad) at a full run — geometry, not taste: past this the
 * stiff-legged body would bounce more than 15 cm. */
export const LEG_SWING_CAP = 0.6
/** Ground covered per step (m) at a walk … */
export const STEP_LEN_WALK_M = 0.75
/** … and at a full run (what LEG_SWING_CAP reaches). */
export const STEP_LEN_RUN_M = 2 * LEG_LEN_M * Math.sin(LEG_SWING_CAP)
/** Fastest cadence (rad/s of phase; 5.6 steps/s). Above ~4.8 m/s the feet
 * slide the remainder rather than blur — ~20 % at a full sprint. */
export const GAIT_RATE_MAX = 17.5
/** How fast the legs come together once the body has stopped (rad/s). */
export const GAIT_SETTLE_RATE = 10
/** Lateral hip swing per rad of what a forward step would have been, when the
 * displacement is sideways (strafing): rotation.z of both hip pivots. */
export const LATERAL_SWING = 0.8

/**
 * THE FOOT PLANT (m). With both legs straight at the stride's extremes and the
 * hips split ±θ (fore-aft, lateral, or both — the hypot), both soles hang
 * L·(1 − cos θ) above the ground; the root must drop by exactly that for the
 * straight stance leg's foot to touch at every phase. articulate folds it
 * into bobY, so EVERY consumer of the articulation — the peers' rigs and the
 * depot mirror's reflection of the local player alike — stands on the ground
 * without knowing about it. Exported so the geometry is pinned once.
 */
export function footPlantDrop(a: { legSwing: number; legSide: number }): number {
  const split = Math.sqrt(a.legSwing * a.legSwing + a.legSide * a.legSide)
  return LEG_LEN_M * (1 - Math.cos(split))
}

/** Step length for a normalized speed: a walk's below WALK_S, then lengthening
 * linearly to the run's at s = 1. */
export function stepLength(s: number): number {
  if (s <= WALK_S) return STEP_LEN_WALK_M
  const k = (Math.min(1, s) - WALK_S) / (1 - WALK_S)
  return STEP_LEN_WALK_M + (STEP_LEN_RUN_M - STEP_LEN_WALK_M) * k
}

/** Phase advance (rad/s) that plants the feet at normalized speed s. */
export function gaitRate(s: number): number {
  if (s < GAIT_MIN_S) return 0
  const rate = (Math.min(1, s) * RUN_SPEED_M_S * Math.PI) / stepLength(s)
  return rate > GAIT_RATE_MAX ? GAIT_RATE_MAX : rate
}

/** Peak hip swing (rad) at normalized speed s — the half-angle whose chord is
 * the step; fades to 0 continuously below GAIT_MIN_S so a stop never snaps. */
export function legSwingFor(s: number): number {
  const c = s / GAIT_MIN_S
  const fade = c < 0 ? 0 : c > 1 ? 1 : c
  return Math.asin(stepLength(s) / (2 * LEG_LEN_M)) * fade
}

/** Gait phase advance per second at full speed (rad/s of the swing sine). */
export const GAIT_RATE = GAIT_RATE_MAX
/** Peak leg swing (rad) at full normalized speed. */
export const LEG_SWING_MAX = legSwingFor(1)
/** Peak knee flexion (rad) mid-swing at full speed — the lifted knee of a run. */
export const KNEE_LIFT_MAX = 1.0
/** Counter-swing of the free arm, fraction of the leg swing. */
export const ARM_SWING_RATIO = 0.85
/** A free arm's resting elbow bend (rad) — nobody walks with a locked elbow. */
export const FREE_ELBOW = 0.35
/** Forward lean of the torso at full speed (rad). */
export const RUN_LEAN = 0.12
/** Fixed airborne pose: legs split, knees tucked, free arm thrown back. */
export const AIR_LEG_SPLIT = 0.45
export const AIR_KNEE = 0.7
export const AIR_ARM_SWING = -0.5
/** Slump lean while staggered (rad), the hanging weapon arm, soft knees. */
export const SLUMP_TORSO = 0.4
export const SLUMP_ARM_AIM = 0.35
export const SLUMP_KNEE = 0.25
/** Idle breathing on the torso: amplitude (rad) and rate (rad/s). */
export const BREATH_AMP = 0.02
export const BREATH_RATE = 1.3
/** Below this normalized speed the idle layer is fully in; it fades out by IDLE_FADE_S. */
export const IDLE_FADE_S = 0.25
/** The idle layer: a standing body is never still. Slow weight shift (torso
 * roll + alternating soft knees + a lateral lean), a slower sway (torso yaw),
 * the head looking around on two incommensurate sines, the free arm drifting. */
export const IDLE = {
  swayYaw: 0.07,
  swayRate: 0.45,
  shiftRoll: 0.035,
  shiftRate: 0.6,
  shiftKnee: 0.1,
  shiftLean: 0.02,
  lookYaw: 0.3,
  lookPitch: 0.06,
  armDrift: 0.05,
} as const
/** The stride layer: the shoulders twist against the legs, the hips roll over
 * the stance leg, the head counters the twist to stay on target, the root sways. */
export const STRIDE = {
  twist: 0.09,
  roll: 0.045,
  headCounter: 0.6,
  sway: 0.015,
  /** A free arm swinging forward bends its elbow this much more (per rad of swing). */
  elbowPerSwing: 0.6,
} as const
/** Pose blending rates (1/s): legs stay crisp (a 17.5 rad/s run swing must
 * come through at full amplitude — 22/s lost a fifth of the stride), arms
 * and the trunk ease. */
export const BLEND_RATE = { legs: 60, arms: 12, trunk: 9, hands: 14 } as const
/** A native hand holding something collapses out of sight while the correctly
 * posed grip hand takes over. Non-zero avoids singular skinned matrices. */
export const HAND_COLLAPSE = 0.001
/** Procedural grip hands are camera-readable without dwarfing Pascaline arms. */
export const AVATAR_GRIP_HAND_SCALE = 0.82
/**
 * The arm the poses are solved for: shoulder half-width, upper arm, and the
 * reach from elbow to the grip in the palm. The mascot model's numbers (the box
 * fallback is close enough to borrow them).
 */
export type ArmDims = { shoulderX: number; upperArmLen: number; reach: number }
export const MODEL_ARMS: ArmDims = {
  shoulderX: DEFAULT_DIMS.shoulderX,
  upperArmLen: DEFAULT_DIMS.upperArmLen,
  reach: DEFAULT_DIMS.foreArmLen + GRIP_IN_HAND * DEFAULT_DIMS.handLen,
}

/**
 * HOW EACH WEAPON IS HELD, as a point, not as angles: where the right hand
 * grips it, relative to the right shoulder at zero pitch — [inward toward the
 * body's centre line, up, forward] in metres — and how far along the barrel
 * the left hand takes the foregrip (0 = no second hand). The whole hold pivots
 * about the shoulder with the view pitch, and two-bone IK (solveArm) finds the
 * shoulder swing, yaw and elbow that put each hand there. Points are what you
 * tune by looking at the picture; angles never read as anything. The arms are
 * stylized-short (0.49 m shoulder to palm), so every point — and the foregrip
 * the left hand has to reach from ITS shoulder — must stay inside that; the
 * tests check it.
 */
export const GRIPS = {
  /** Long gun (rifle, minigun): shouldered — grip in front of the chest, close
   * in, barrel level with the eyes, left hand well forward on the handguard. */
  long: { hand: [0.14, -0.1, 0.18] as const, foregrip: 0.22, barrelFromDown: Math.PI / 2 },
  /** Pistol: both arms out, hands cupped on the grip at chest height. */
  short: { hand: [0.14, -0.02, 0.36] as const, foregrip: 0.05, barrelFromDown: Math.PI / 2 },
  /** A tool (knife, hammer, builder, spray can): one relaxed hand low by the
   * hip, the tool pointing forward-down. */
  tool: { hand: [-0.03, -0.46, 0.15] as const, foregrip: 0, barrelFromDown: 1.0 },
} as const
const HEAD_PITCH_MAX = 0.6
const PITCH_CLAMP = 1.2

export type ArmSolution = {
  /** rotation.x of the shoulder pivot (0 = hanging, π/2 = level forward). */
  swing: number
  /** rotation.y of the shoulder pivot (YXZ order: applied after the swing). */
  yaw: number
  /** Elbow flexion (rad, ≥ 0). */
  elbow: number
  /** Where the grip ended up, relative to the shoulder (three axes: x right, y up, −z forward). */
  hand: [number, number, number]
}

/** The direction of a limb segment swung `theta` from hanging and yawed `yaw`
 * about the vertical (three axes). Exported for the tests' forward kinematics. */
export function limbDir(theta: number, yaw: number): [number, number, number] {
  const st = Math.sin(theta)
  return [-st * Math.sin(yaw), -Math.cos(theta), -st * Math.cos(yaw)]
}

/** A blank solution to solve into (solveArm's optional `out`). */
export function createArmSolution(): ArmSolution {
  return { swing: 0, yaw: 0, elbow: 0, hand: [0, 0, 0] }
}

/**
 * Two-bone IK for one arm: the shoulder swing, yaw and elbow flexion that put
 * the grip at `target` (relative to that shoulder, three axes: x right, y up,
 * −z forward). Unreachable targets get a straight arm pointed at them. The
 * elbow always bends the human way: forward/up, never back. Writes into `out`
 * when given (the frame loop's scratch — no allocation), a fresh object otherwise.
 */
export function solveArm(
  target: readonly [number, number, number],
  arms: ArmDims = MODEL_ARMS,
  out: ArmSolution = createArmSolution(),
): ArmSolution {
  const a = arms.upperArmLen
  const c = arms.reach
  const vx = target[0]
  const vy = target[1]
  const vz = target[2]
  const h = Math.hypot(vx, vz)
  const yaw = h > 1e-6 ? Math.atan2(-vx, -vz) : 0
  const t = Math.atan2(h, -vy) // from straight down toward the target
  const D = Math.min(Math.hypot(h, vy), a + c - 1e-4)
  const cosElbowOuter = clamp((a * a + c * c - D * D) / (2 * a * c), -1, 1)
  const elbow = Math.PI - Math.acos(cosElbowOuter)
  const alpha = Math.acos(clamp((a * a + D * D - c * c) / (2 * a * D), -1, 1))
  const swing = t - alpha
  // limbDir, inlined twice: the frame loop solves two arms per avatar per frame.
  const su = Math.sin(swing)
  const sf = Math.sin(swing + elbow)
  const sy = Math.sin(yaw)
  const cy = Math.cos(yaw)
  out.swing = swing
  out.yaw = yaw
  out.elbow = elbow
  out.hand[0] = a * (-su * sy) + c * (-sf * sy)
  out.hand[1] = a * -Math.cos(swing) + c * -Math.cos(swing + elbow)
  out.hand[2] = a * (-su * cy) + c * (-sf * cy)
  return out
}

/** A grip's hand point (inward, up, forward at zero pitch) as a right-shoulder-
 * relative three vector, the whole hold pivoted about the shoulder by `pitch`.
 * Writes into `out` (module scratch in the frame loop). */
function rightHandTarget(
  hand: readonly [number, number, number],
  pitch: number,
  out: [number, number, number],
): [number, number, number] {
  const inward = hand[0]
  const up = hand[1]
  const fwd = hand[2]
  const c = Math.cos(pitch)
  const s = Math.sin(pitch)
  out[0] = -inward
  out[1] = fwd * s + up * c
  out[2] = -(fwd * c - up * s)
  return out
}

/** Frame-loop scratch for the two arm solutions and their targets. */
const _rightTarget: [number, number, number] = [0, 0, 0]
const _leftTarget: [number, number, number] = [0, 0, 0]
const _rightSol = createArmSolution()
const _leftSol = createArmSolution()

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** How a weapon is held — what the two arms do with it. */
export type Grip = 'long' | 'short' | 'tool' | 'none'

/** Weapon id → grip. An id this build does not know (a newer peer's weapon)
 * reads as a tool in hand rather than as empty hands. */
export function gripFor(weapon: string): Grip {
  switch (weapon) {
    case 'rifle':
    case 'minigun':
      return 'long'
    case 'pistol':
      return 'short'
    case '':
      return 'none'
    default:
      return 'tool'
  }
}

export type AvatarArticulation = {
  /** rotation.x of the LEFT hip pivot (right leg mirrors with -legSwing). */
  legSwing: number
  /** rotation.z of BOTH hip pivots — the lateral stepping of a strafe. */
  legSide: number
  /** Knee flexion per leg (rad, ≥ 0) — applied as −rotation.x on the knee pivot. */
  kneeL: number
  kneeR: number
  /** rotation.x of the LEFT arm pivot: counter-swings the gait, or reaches the gun. */
  armSwing: number
  /** rotation.y of the left arm pivot — negative brings a forward arm in toward the body. */
  armLYaw: number
  /** Left elbow flexion (rad, ≥ 0) — applied as +rotation.x on the elbow pivot. */
  elbowL: number
  /** rotation.x of the RIGHT (weapon) arm pivot. */
  armAim: number
  /** rotation.y of the right arm pivot — positive brings it in toward the body. */
  armRYaw: number
  /** Right elbow flexion (rad, ≥ 0). */
  elbowR: number
  /** How far the held weapon is tilted off the forearm's line (rad, about the
   * lateral axis) so its barrel points where the peer looks. */
  weaponTilt: number
  /** Hands closed on something (0 open … 1 fist): the hand bone collapses and a fist shows. */
  gripL: number
  gripR: number
  /** rotation.x of the torso pivot (slump, run lean, breathing). */
  torsoPitch: number
  /** rotation.y / rotation.z of the torso pivot (stride twist, idle sway / hip roll, weight shift). */
  torsoYaw: number
  torsoRoll: number
  /** rotation.x of the head pivot (tracks the remote view pitch). */
  headPitch: number
  /** rotation.y of the head pivot (counters the twist; looks around at rest). */
  headYaw: number
  /** Root bob (m) riding the stride. */
  bobY: number
  /** Root lateral sway (m, the body's own +x) — stride and weight shift. */
  swayX: number
}

export function createArticulation(): AvatarArticulation {
  return {
    legSwing: 0,
    legSide: 0,
    kneeL: 0,
    kneeR: 0,
    armSwing: 0,
    armLYaw: 0,
    elbowL: FREE_ELBOW,
    armAim: 0,
    armRYaw: 0,
    elbowR: FREE_ELBOW,
    weaponTilt: 0,
    gripL: 0,
    gripR: 0,
    torsoPitch: 0,
    torsoYaw: 0,
    torsoRoll: 0,
    headPitch: 0,
    headYaw: 0,
    bobY: 0,
    swayX: 0,
  }
}

/**
 * Advance the walk-cycle phase by the stride-length cadence for normalized
 * speed s (gaitRate). Below GAIT_MIN_S the phase SETTLES toward the nearest
 * k·π — legs together — at GAIT_SETTLE_RATE, never rewinding past it, so a
 * stop ends with the feet under the body instead of mid-stride. Hostile or
 * NaN speeds read as 0.
 */
export function advanceGait(phase: number, s: number, dt: number): number {
  const sp = s > 1 ? 1 : s > 0 ? s : 0
  const step = dt > 0 ? dt : 0
  if (sp < GAIT_MIN_S) {
    const target = Math.round(phase / Math.PI) * Math.PI
    const d = target - phase
    const max = GAIT_SETTLE_RATE * step
    if (d > max) return phase + max
    if (d < -max) return phase - max
    return target
  }
  return phase + step * gaitRate(sp)
}

/**
 * Pose the rig from the sampled wire fields — the ONE articulation rule
 * set, pure so tests pin every stance:
 * - grounded gait: leg swing sine scaled by s, the leg that is swinging
 *   forward lifts its knee (cos > 0 for the left, cos < 0 for the right),
 *   stride bob, a forward lean that grows with speed
 * - airborne (!g): legs split, knees tucked, free arm thrown back, no bob
 * - staggered (st): torso slump, hung weapon arm, soft knees, halved shuffle
 * - the WEAPON decides the arms (grip): a long gun is shouldered with both
 *   hands and the free arm reaches across to the foregrip; a pistol is held
 *   out in both hands; a tool rides in one relaxed hand at the hip while the
 *   other swings; empty hands both swing. Each hold is a grip POINT near the
 *   body (GRIPS) solved by two-bone IK for both arms, and the weapon is tilted
 *   in the hand so its BARREL points where the peer looks
 * - head tracks the remote pitch (clamped); `t` (s) drives the idle breath
 * - `leftGrip`, when given, is the support hand's palm in the HELD-WEAPON
 *   frame (hand-grips' leftGripFor — the one grip table the first-person hands
 *   use), and the left arm is solved to EXACTLY that point through the right
 *   arm's chain (gripToShoulder); without it the legacy foregrip-along-the-
 *   barrel approximation (GRIPS.foregrip) stands
 */
export function articulate(
  out: AvatarArticulation,
  phase: number,
  s: number,
  pitch: number,
  grounded: boolean,
  staggered: boolean,
  grip: Grip = 'tool',
  t = 0,
  arms: ArmDims = MODEL_ARMS,
  seed = 0,
  moveRel = 0,
  leftGrip: readonly [number, number, number] | null = null,
): AvatarArticulation {
  const clampedPitch = clamp(pitch, -PITCH_CLAMP, PITCH_CLAMP)
  // How much of the idle layer applies: all of it standing, none at a jog.
  const idle = grounded ? clamp(1 - s / IDLE_FADE_S, 0, 1) : 0
  // The stride's hip amplitude — a stride LENGTH, so nearly constant above a
  // creep and fading to nothing only under GAIT_MIN_S (legSwingFor).
  const amp = legSwingFor(s)

  // Legs, and the trunk's stride and idle layers. `moveRel` is the angle from
  // the body's facing to its displacement: 0 forward, ±π/2 a strafe, π a
  // backpedal — the fore-aft swing takes cos, the lateral step takes sin, so a
  // strafing peer steps sideways and a backpedaling one runs the cycle in
  // reverse instead of moonwalking.
  const shift = Math.sin(t * IDLE.shiftRate + seed) // slow weight shift, −1..1
  if (grounded) {
    const swing = Math.sin(phase) * amp * Math.cos(moveRel)
    out.legSwing = staggered ? swing * 0.5 : swing
    out.legSide = staggered ? 0 : Math.sin(phase) * amp * Math.sin(moveRel) * LATERAL_SWING
    const lift = KNEE_LIFT_MAX * s
    const soft = staggered ? SLUMP_KNEE : 0
    // Standing, the weight sits on one leg and the other knee softens.
    out.kneeL = Math.max(0, Math.cos(phase)) * lift + soft + idle * IDLE.shiftKnee * (0.5 + 0.5 * shift)
    out.kneeR = Math.max(0, -Math.cos(phase)) * lift + soft + idle * IDLE.shiftKnee * (0.5 - 0.5 * shift)
    // The stride's bob, minus the foot plant: the hips split, the root drops.
    out.bobY = Math.abs(Math.cos(phase)) * 0.04 * s - footPlantDrop(out)
    out.swayX = Math.sin(phase) * STRIDE.sway * s + idle * IDLE.shiftLean * shift
    out.torsoYaw = -Math.sin(phase) * STRIDE.twist * s + idle * IDLE.swayYaw * Math.sin(t * IDLE.swayRate + seed * 2)
    out.torsoRoll = Math.sin(phase) * STRIDE.roll * s + idle * IDLE.shiftRoll * shift
  } else {
    out.legSwing = AIR_LEG_SPLIT
    out.legSide = 0
    out.kneeL = AIR_KNEE
    out.kneeR = AIR_KNEE
    out.bobY = 0
    out.swayX = 0
    out.torsoYaw = 0
    out.torsoRoll = 0
  }
  // What an arm does when it has nothing to hold: counter-swings the stride,
  // and at rest drifts a little so it never hangs like a rope.
  // (The arm follows the stride's amplitude whatever its direction, and swings
  // wider the faster the body goes.)
  const freeSwing = grounded
    ? -Math.sin(phase) * amp * ARM_SWING_RATIO * (0.5 + 0.5 * s) + idle * IDLE.armDrift * Math.sin(t * 0.9 + seed)
    : AIR_ARM_SWING
  const freeElbow = FREE_ELBOW + STRIDE.elbowPerSwing * Math.max(0, freeSwing)

  // Torso and head.
  if (staggered) {
    out.torsoPitch = SLUMP_TORSO
    out.torsoYaw = 0
    out.torsoRoll = 0
    out.headPitch = -0.35
    out.headYaw = 0
    out.armAim = SLUMP_ARM_AIM
    out.armRYaw = 0
    out.elbowR = 0.6
    out.weaponTilt = 0
    out.armSwing = freeSwing * 0.5
    out.armLYaw = 0
    out.elbowL = FREE_ELBOW
    out.gripR = grip === 'none' ? 0 : 1
    out.gripL = 0
    return out
  }
  out.torsoPitch = RUN_LEAN * (grounded ? s : 0) + BREATH_AMP * Math.sin(t * BREATH_RATE + seed)
  // The head counters the shoulders' twist to stay on target, and at rest
  // looks around on two sines that never line up.
  out.headYaw =
    -out.torsoYaw * STRIDE.headCounter +
    idle * IDLE.lookYaw * Math.sin(t * 0.33 + seed * 5) * Math.sin(t * 0.21 + seed)
  out.headPitch =
    clamp(clampedPitch, -HEAD_PITCH_MAX, HEAD_PITCH_MAX) + idle * IDLE.lookPitch * Math.sin(t * 0.5 + seed * 3)

  // Arms, by grip — solved from where the hands have to be.
  if (grip === 'none') {
    out.armAim = -freeSwing
    out.armRYaw = 0
    out.elbowR = FREE_ELBOW + STRIDE.elbowPerSwing * Math.max(0, -freeSwing)
    out.weaponTilt = 0
    out.armSwing = freeSwing
    out.armLYaw = 0
    out.elbowL = freeElbow
    out.gripL = 0
    out.gripR = 0
    return out
  }
  const g = GRIPS[grip]
  const right = solveArm(rightHandTarget(g.hand, clampedPitch, _rightTarget), arms, _rightSol)
  out.armAim = right.swing
  out.armRYaw = right.yaw
  out.elbowR = right.elbow
  // The barrel points where the peer looks, whatever the forearm does.
  const barrel = g.barrelFromDown + clampedPitch
  out.weaponTilt = barrel - (right.swing + right.elbow)
  if (g.foregrip > 0) {
    if (leftGrip) {
      // The support hand is EXACTLY where the grip table puts it on the gun:
      // that point, carried through the right arm's chain and the weapon's
      // tilt, into the left shoulder's frame.
      gripToShoulder(leftGrip, right, barrel, arms.shoulderX, _leftTarget)
    } else {
      // Legacy: that far from the right hand along the barrel (which carries
      // the right arm's yaw), a touch to the left of it.
      const bd = limbDir(barrel, right.yaw)
      _leftTarget[0] = right.hand[0] + 2 * arms.shoulderX + g.foregrip * bd[0] - 0.03
      _leftTarget[1] = right.hand[1] + g.foregrip * bd[1]
      _leftTarget[2] = right.hand[2] + g.foregrip * bd[2]
    }
    const left = solveArm(_leftTarget, arms, _leftSol)
    out.armSwing = left.swing
    out.armLYaw = left.yaw
    out.elbowL = left.elbow
    out.gripL = 1
  } else {
    out.armSwing = freeSwing
    out.armLYaw = 0
    out.elbowL = freeElbow
    out.gripL = 0
  }
  out.gripR = 1
  return out
}

const LEG_FIELDS = ['legSwing', 'legSide', 'kneeL', 'kneeR', 'bobY', 'swayX'] as const
const ARM_FIELDS = ['armSwing', 'armLYaw', 'elbowL', 'armAim', 'armRYaw', 'elbowR', 'weaponTilt'] as const
const TRUNK_FIELDS = ['torsoPitch', 'torsoYaw', 'torsoRoll', 'headPitch', 'headYaw'] as const
const HAND_FIELDS = ['gripL', 'gripR'] as const

/**
 * Ease the live pose toward the target — the one thing that turns a set of
 * rules into motion. A weapon swap, a stop, a jump no longer snap: arms and
 * trunk arrive over a few frames, legs stay crisp so the stride keeps its
 * beat. Exponential, frame-rate independent: k = 1 − e^(−rate·dt).
 */
export function blendArticulation(live: AvatarArticulation, target: AvatarArticulation, dt: number): void {
  const step = (rate: number) => 1 - Math.exp(-rate * Math.max(0, dt))
  const kLegs = step(BLEND_RATE.legs)
  const kArms = step(BLEND_RATE.arms)
  const kTrunk = step(BLEND_RATE.trunk)
  const kHands = step(BLEND_RATE.hands)
  for (const f of LEG_FIELDS) live[f] += (target[f] - live[f]) * kLegs
  for (const f of ARM_FIELDS) live[f] += (target[f] - live[f]) * kArms
  for (const f of TRUNK_FIELDS) live[f] += (target[f] - live[f]) * kTrunk
  for (const f of HAND_FIELDS) live[f] += (target[f] - live[f]) * kHands
}

/**
 * Write a pose onto a body's handles — the one place the sign conventions
 * live: the right leg mirrors the left, knees bend backward (−x), elbows bend
 * forward (+x), arm yaws are written as given, native hands remain full-size,
 * and any legacy procedural fists stay hidden. Handles a body does not have
 * (the box rig's elbows and knees) are simply absent. The root's bob and sway are
 * the caller's — it owns the root's world position.
 */
export function applyArticulation(refs: AvatarRigRefs, a: AvatarArticulation): void {
  const setX = (r: { current: Group | null } | undefined, x: number) => {
    if (r?.current) r.current.rotation.x = x
  }
  setX(refs.legL, a.legSwing)
  setX(refs.legR, -a.legSwing)
  // Both hips swing the same way sideways: a strafe shuffles, it never crosses.
  if (refs.legL.current) refs.legL.current.rotation.z = a.legSide
  if (refs.legR.current) refs.legR.current.rotation.z = a.legSide
  setX(refs.kneeL, -a.kneeL)
  setX(refs.kneeR, -a.kneeR)
  const armL = refs.armL.current
  if (armL) {
    armL.rotation.x = a.armSwing
    armL.rotation.y = a.armLYaw
  }
  const armR = refs.armR.current
  if (armR) {
    armR.rotation.x = a.armAim
    armR.rotation.y = a.armRYaw
  }
  setX(refs.elbowL, a.elbowL)
  setX(refs.elbowR, a.elbowR)
  // The held weapon hangs barrel-down the forearm at rest (Rx(−π/2)); the
  // tilt swings the barrel forward/up off that line.
  setX(refs.weapon, -Math.PI / 2 + a.weaponTilt)
  const torso = refs.torso.current
  if (torso) {
    torso.rotation.x = a.torsoPitch
    torso.rotation.y = a.torsoYaw
    torso.rotation.z = a.torsoRoll
  }
  const head = refs.head.current
  if (head) {
    head.rotation.x = a.headPitch
    head.rotation.y = a.headYaw
  }
  const hand = (
    bone: { current: Group | null } | undefined,
    fist: { current: Group | null } | undefined,
    grip: number,
  ) => {
    // A native hand is hidden only when a mounted replacement can take its
    // place. Some heavy weapons deliberately use the model hands instead.
    const gripping = grip > 0.5 && fist?.current != null
    // Switch on one threshold: the replacement never overlaps a visible
    // native hand, including during weapon-change interpolation.
    if (bone?.current) bone.current.scale.setScalar(gripping ? HAND_COLLAPSE : 1)
    if (fist?.current) fist.current.visible = gripping
  }
  hand(refs.handL, refs.fistL, a.gripL)
  hand(refs.handR, refs.fistR, a.gripR)
}

/** Where the root goes this frame: feet at `feet`, lifted by the bob, swayed
 * along the body's own +x (facing −Z at yaw 0, +x is (cos yaw, 0, −sin yaw)). */
export function placeRoot(
  root: { position: { set(x: number, y: number, z: number): unknown } },
  feetX: number,
  feetY: number,
  feetZ: number,
  yaw: number,
  a: AvatarArticulation,
): void {
  root.position.set(feetX + a.swayX * Math.cos(yaw), feetY + a.bobY, feetZ - a.swayX * Math.sin(yaw))
}

// ── Motion layer (pure, tested) ──────────────────────────────────────────────

/**
 * WHAT THE WIRE DOES NOT CARRY, DERIVED FROM WHAT IT DOES. The pose is a
 * position, a view yaw and a few flags at 12 Hz; a body is what happens
 * between them. This layer keeps, per avatar, the state that makes the drawn
 * position read as a person:
 * - DISPLAYED speed and its direction in the body's frame (the gait's input —
 *   never the sender's `s`, which keeps cycling while a stalled peer is frozen);
 * - a BODY YAW that lags the view: standing, the body holds until the head has
 *   turned past a dead zone (with hysteresis), then follows; moving, it
 *   follows closely; the torso carries the WHOLE remaining difference, so the
 *   gun, the muzzle flash and the tracer always point exactly where the peer
 *   is aiming (shooter-authoritative PvP depends on it) while the legs and
 *   feet stay planted;
 * - a LANDING squash gated on a real fall speed (the local sfx.land threshold,
 *   so a stair-step blip does nothing);
 * - a RECOIL kick per shot the gun arm springs back from.
 * updateMotion advances it from the drawn position; layerMotion adds it onto
 * the blended articulation. Both are allocation-free.
 */
export type AvatarMotion = {
  primed: boolean
  /** Last drawn eye position fed in. */
  lx: number
  ly: number
  lz: number
  /** Displayed horizontal speed (m/s, smoothed; snaps to 0 under SPEED_DISP_ZERO). */
  speedDisp: number
  /** Displacement in the body's frame (m/s, smoothed): along the facing, along +x. */
  fwd: number
  right: number
  /** Angle from the body's facing to the displacement (rad; 0 forward, ±π/2 strafe, π back). */
  moveRel: number
  /** Where the LEGS face (root rotation.y). */
  bodyYaw: number
  /** Smoothed body turn rate (rad/s) — the lean. */
  yawRate: number
  /** Standing dead-zone state: is the body currently chasing the view? */
  turning: boolean
  wasGrounded: boolean
  /** Most negative vertical speed seen this airborne spell (m/s). */
  minVy: number
  /** Highest eye Y seen this airborne spell (the apex) — the drop from it is
   * the robust impact-speed estimate at 12 Hz (see updateMotion). */
  airTopY: number
  /** Landing squash: time left (s) and its strength (0.4..1.2). */
  landT: number
  landPower: number
  /** Recoil spring on the gun arm (rad, rad/s). */
  recoilX: number
  recoilV: number
}

/** Displayed-speed EMA rate (1/s): ~70 ms to follow, so a stop is a settle. */
export const SPEED_DISP_SMOOTH = 14
/** Under this displayed speed (m/s) the EMA snaps to exactly 0. */
export const SPEED_DISP_ZERO = 0.05
/** Displayed speed is clamped here (m/s) — a snap is never read as a sprint. */
export const SPEED_DISP_MAX = RUN_SPEED_M_S * 1.15
/** One drawn step beyond this (m) is a teleport/snap and is not a speed sample. */
export const SPEED_DISP_SNAP_M = 1.0
/** Body-follows-view rules. */
export const TURN = {
  /** Standing: the body holds until the view is this far off it (rad) … */
  deadzone: 0.35,
  /** … and keeps chasing until it is back within this (rad). */
  release: 0.1,
  /** Chase rates (1/s) standing and moving. */
  rateStanding: 8,
  rateMoving: 12,
  /** Displayed speed (m/s) above which the body is "moving" and always follows. */
  movingSpeed: 0.8,
  /** The torso twist limit (rad): past it the legs snap round to keep the aim honest. */
  torsoMax: 0.6,
  /** Lean into a turn: torso roll per rad/s of body yaw rate, capped. */
  leanPerRadS: 0.025,
  leanMax: 0.12,
  /** Yaw-rate smoothing (1/s). */
  rateSmooth: 10,
} as const
/** Landing squash: duration (s), knee bend, torso pitch, root dip (m) at full
 * power; minFall is the local player's sfx.land threshold (player.tsx), so a
 * hop or a stair blip never squashes; fullFall gives power 1. */
export const LAND = { squashS: 0.22, knee: 0.45, pitch: 0.16, dip: 0.06, minFall: 4, fullFall: 8 } as const
/** Recoil spring (rad): stiffness, damping, and how much of the arm's kick the
 * torso and head take. ω ≈ 20 rad/s, ζ ≈ 0.73 — back in ~200 ms. */
export const RECOIL = { k: 420, damp: 30, torsoShare: 0.3, headShare: 0.35 } as const
/** Arm kick per round (rad) by weapon; anything else kicks nothing. */
export const AVATAR_RECOIL: Record<string, number> = { pistol: 0.18, rifle: 0.11, minigun: 0.05 }

export function createMotion(): AvatarMotion {
  return {
    primed: false,
    lx: 0,
    ly: 0,
    lz: 0,
    speedDisp: 0,
    fwd: 0,
    right: 0,
    moveRel: 0,
    bodyYaw: 0,
    yawRate: 0,
    turning: false,
    wasGrounded: true,
    minVy: 0,
    airTopY: 0,
    landT: 0,
    landPower: 0,
    recoilX: 0,
    recoilV: 0,
  }
}

/**
 * Advance the motion state from this frame's DRAWN eye position and the sampled
 * pose flags. `vy` is the sampled vertical velocity (m/s), `shots` the rounds
 * read this frame, `weapon` the wire id. Returns the displayed speed
 * NORMALIZED (speedDisp / RUN_SPEED_M_S) — the gait's `s`. The first call
 * primes (body faces the view) and returns 0.
 */
export function updateMotion(
  m: AvatarMotion,
  x: number,
  y: number,
  z: number,
  viewYaw: number,
  grounded: boolean,
  staggered: boolean,
  shots: number,
  weapon: string,
  vy: number,
  dt: number,
): number {
  if (!m.primed) {
    m.primed = true
    m.lx = x
    m.ly = y
    m.lz = z
    m.bodyYaw = wrapAngle(viewYaw)
    m.wasGrounded = grounded
    return 0
  }
  const step = dt > 0 ? dt : 0
  const k = 1 - Math.exp(-SPEED_DISP_SMOOTH * step)
  const dx = x - m.lx
  const dz = z - m.lz
  m.lx = x
  m.ly = y
  m.lz = z
  const d = Math.sqrt(dx * dx + dz * dz)

  // ── displayed speed + direction in the body frame ──
  if (step > 0 && d <= SPEED_DISP_SNAP_M) {
    let v = d / step
    if (v > SPEED_DISP_MAX) v = SPEED_DISP_MAX
    m.speedDisp += (v - m.speedDisp) * k
    // facing = (−sin yaw, −cos yaw), right = (cos yaw, −sin yaw) — placeRoot's frame.
    const sy = Math.sin(m.bodyYaw)
    const cy = Math.cos(m.bodyYaw)
    const fwd = (-dx * sy - dz * cy) / step
    const right = (dx * cy - dz * sy) / step
    m.fwd += (fwd - m.fwd) * k
    m.right += (right - m.right) * k
  } else {
    // A snap (teleport, spawn) is not motion: let the speed settle toward 0
    // (the legs come together, never a sprint read off a jump cut) and keep
    // the direction — moveRel below only refreshes from real motion.
    m.speedDisp += (0 - m.speedDisp) * k
  }
  if (m.speedDisp < SPEED_DISP_ZERO) {
    m.speedDisp = 0
    m.fwd = 0
    m.right = 0
  }
  // The direction only updates while there is real motion to read it from; a
  // stopping body keeps its last direction so the legs settle, not swivel.
  if (Math.sqrt(m.fwd * m.fwd + m.right * m.right) > TURN.movingSpeed * 0.5) {
    m.moveRel = Math.atan2(m.right, m.fwd)
  }

  // ── body yaw: lags the view standing, follows it moving, never twists past torsoMax ──
  const moving = m.speedDisp > TURN.movingSpeed
  const before = m.bodyYaw
  let diff = wrapAngle(viewYaw - m.bodyYaw)
  if (diff > TURN.torsoMax) {
    m.bodyYaw = wrapAngle(viewYaw - TURN.torsoMax)
    diff = TURN.torsoMax
  } else if (diff < -TURN.torsoMax) {
    m.bodyYaw = wrapAngle(viewYaw + TURN.torsoMax)
    diff = -TURN.torsoMax
  }
  const ad = diff < 0 ? -diff : diff
  if (moving || staggered) m.turning = true
  else if (m.turning) m.turning = ad > TURN.release
  else m.turning = ad > TURN.deadzone
  if (m.turning) {
    const rate = moving ? TURN.rateMoving : TURN.rateStanding
    m.bodyYaw = wrapAngle(m.bodyYaw + diff * (1 - Math.exp(-rate * step)))
  }
  const turned = wrapAngle(m.bodyYaw - before)
  const rateInst = step > 0 ? turned / step : 0
  m.yawRate += (rateInst - m.yawRate) * (1 - Math.exp(-TURN.rateSmooth * step))

  // ── landing: the impact speed of the airborne spell, judged on the grounded edge ──
  // Two estimates, the larger wins. The sampled slope (minVy) is exact for a
  // long fall but at 12 Hz it AVERAGES the last 84 ms — a plain jump's 5.4 m/s
  // impact reads as 2.7-5 depending on where the frames fell — so the drop from
  // the spell's apex (√(2·g·h), the same kinematics the sender ran) is the one
  // that catches every jump; a stair blip has no apex to speak of.
  if (!grounded) {
    if (!m.wasGrounded) {
      if (vy < m.minVy) m.minVy = vy
      if (y > m.airTopY) m.airTopY = y
    } else {
      m.minVy = vy < 0 ? vy : 0
      m.airTopY = y
    }
  } else {
    if (!m.wasGrounded) {
      // The landing bracket itself reads grounded (discrete fields ride the
      // newer snapshot) but carries the fall's final slope — count it.
      const slope = vy < m.minVy ? -vy : -m.minVy
      const drop = m.airTopY - y
      const fromApex = drop > 0 ? Math.sqrt(2 * MOVE.gravity * drop) : 0
      const fall = slope > fromApex ? slope : fromApex
      if (fall >= LAND.minFall) {
        m.landT = LAND.squashS
        const power = fall / LAND.fullFall
        m.landPower = power < 0.4 ? 0.4 : power > 1.2 ? 1.2 : power
      }
    }
    m.minVy = 0
  }
  m.wasGrounded = grounded
  if (m.landT > 0) m.landT = m.landT - step < 0 ? 0 : m.landT - step

  // ── recoil: an instant kick per round, sprung back ──
  if (shots > 0) {
    const kick = AVATAR_RECOIL[weapon] ?? 0
    m.recoilX += shots * kick
  }
  if (m.recoilX !== 0 || m.recoilV !== 0) {
    m.recoilV += (-RECOIL.k * m.recoilX - RECOIL.damp * m.recoilV) * step
    m.recoilX += m.recoilV * step
    if (Math.abs(m.recoilX) < 1e-4 && Math.abs(m.recoilV) < 1e-3) {
      m.recoilX = 0
      m.recoilV = 0
    }
  }

  return m.speedDisp / RUN_SPEED_M_S
}

const ARTIC_FIELDS = [
  'legSwing',
  'legSide',
  'kneeL',
  'kneeR',
  'armSwing',
  'armLYaw',
  'elbowL',
  'armAim',
  'armRYaw',
  'elbowR',
  'weaponTilt',
  'gripL',
  'gripR',
  'torsoPitch',
  'torsoYaw',
  'torsoRoll',
  'headPitch',
  'headYaw',
  'bobY',
  'swayX',
] as const

/**
 * Layer the motion state onto the blended articulation: `out` = `live` plus
 * - the torso twist that makes up the WHOLE difference between the view yaw
 *   and the body yaw (the upper body aims; the head is left alone — it already
 *   tracks the view pitch and counters the stride twist);
 * - a lean into the turn;
 * - the landing squash (knees, torso, root dip) on a 4u(1−u) envelope;
 * - the recoil kick on the gun arm, shared into the torso and head.
 * (The foot plant is NOT here: articulate folds it into bobY, so a consumer
 * without a motion layer — the depot mirror — stands on the ground too.)
 * `live` is untouched; `out` is caller-owned scratch. At rest it is the
 * identity.
 */
export function layerMotion(
  out: AvatarArticulation,
  live: AvatarArticulation,
  m: AvatarMotion,
  viewYaw: number,
): AvatarArticulation {
  for (const f of ARTIC_FIELDS) out[f] = live[f]
  out.torsoYaw += wrapAngle(viewYaw - m.bodyYaw)
  const lean = -m.yawRate * TURN.leanPerRadS
  out.torsoRoll += lean < -TURN.leanMax ? -TURN.leanMax : lean > TURN.leanMax ? TURN.leanMax : lean
  if (m.landT > 0) {
    const u = m.landT / LAND.squashS
    const env = 4 * u * (1 - u) * m.landPower
    out.kneeL += LAND.knee * env
    out.kneeR += LAND.knee * env
    out.torsoPitch += LAND.pitch * env
    out.bobY -= LAND.dip * env
  }
  if (m.recoilX !== 0) {
    out.armAim += m.recoilX
    out.torsoPitch -= m.recoilX * RECOIL.torsoShare
    out.headPitch += m.recoilX * RECOIL.headShare
  }
  return out
}

// ── Per-avatar QA stats (plain numbers, copied out) ──────────────────────────

export type AvatarStats = {
  /** Displayed speed (m/s) the gait is running at. */
  speedDisp: number
  /** Interpolation delay in use (ms). */
  delayMs: number
  /** Smoother corrections so far, and the largest drawn step since the last read (m). */
  corrections: number
  maxStepM: number
  bodyYaw: number
  /** Torso twist = view − body (rad). */
  twist: number
  moveRel: number
  landT: number
  recoilX: number
  frozen: boolean
  /** The smoother's residual this frame (m): drawn − sampled target. Non-zero
   * only while a late/popped sample is gliding in — the exact amount by which
   * the picture (and the PvP capsule) differs from the raw ring sample. */
  resX: number
  resY: number
  resZ: number
}

const avatarStats = new Map<string, AvatarStats>()
const smootherOf = new Map<string, { maxStepM: number }>()

/** Plain copies of every mounted avatar's motion numbers, keyed by sessionId.
 * Reading resets each maxStepM (a running max between reads). */
export function avatarDebug(): Record<string, AvatarStats> {
  const out: Record<string, AvatarStats> = {}
  for (const [id, st] of avatarStats) {
    out[id] = { ...st }
    const sm = smootherOf.get(id)
    if (sm) sm.maxStepM = 0
  }
  return out
}

registerPresenceDebugSource('avatars', avatarDebug)
// The talking mouth's loader state (pascaline-model.ts) rides the same dump —
// `__boots.presence().extra.face` — so a QA can tell "never opened" from
// "plate never decoded".
registerPresenceDebugSource('face', faceOpenStatus)

// ── Join scale-in + name-tag gate (pure, tested) ─────────────────────────────

export const SPAWN_SCALE_MS = 200
/** Name tags hide past this distance (m). */
export const TAG_MAX_DIST = 40
/** Tags are fully solid within this distance (m), then ramp out to the cutoff. */
export const TAG_FADE_START = 24

/** 200 ms ease-out scale-in on join; floored so the matrix never hits 0. */
export function spawnScale(ageMs: number): number {
  const t = ageMs <= 0 ? 0 : ageMs >= SPAWN_SCALE_MS ? 1 : ageMs / SPAWN_SCALE_MS
  const eased = t * (2 - t)
  return eased < 0.001 ? 0.001 : eased
}

export function tagVisible(distSq: number): boolean {
  return distSq <= TAG_MAX_DIST * TAG_MAX_DIST
}

/** Past this distance (m) the fine Pascaline detail stops drawing. */
export const DETAIL_MAX_DIST = 14

/**
 * The LOD gate: is this avatar close enough for the small stuff (belt pouch,
 * tape measure, hat logotype, eyes, side locks)? Beyond 14 m those are
 * sub-pixel decoration, while the hat, hair mass, vest color and boots carry
 * the whole read. Toggling one group's `visible` costs a boolean and takes
 * ~12 primitives off each far avatar.
 */
export function detailVisible(distSq: number): boolean {
  return distSq <= DETAIL_MAX_DIST * DETAIL_MAX_DIST
}

/**
 * Name-tag opacity ramp: solid nearby, linear fade to nothing at
 * TAG_MAX_DIST. A lobby crowd stays readable at conversation range without
 * a picket fence of labels along the horizon (and the far ones stop
 * competing with the world for attention).
 */
export function tagOpacity(distSq: number): number {
  const near = TAG_FADE_START * TAG_FADE_START
  if (distSq <= near) return 1
  const far = TAG_MAX_DIST * TAG_MAX_DIST
  if (distSq >= far) return 0
  return (TAG_MAX_DIST - Math.sqrt(distSq)) / (TAG_MAX_DIST - TAG_FADE_START)
}

// ── Remote gunfire (pure, tested) ────────────────────────────────────────────

/**
 * Muzzle anchor for a held weapon id, in the weapon group's local space —
 * or null when this peer is not holding a gun.
 *
 * Null is the whole point of the function: a peer swinging a knife, a hammer,
 * the builder or a spray can still bumps their fire counter for the melee/paint
 * branches one day, and a muzzle flash blooming off the end of a crowbar is
 * worse than no effect at all. Only the three guns have a muzzle, so only the
 * three guns flash.
 */
export function remoteMuzzle(weapon: string): [number, number, number] | null {
  if (weapon === 'pistol' || weapon === 'rifle' || weapon === 'minigun') {
    return MUZZLE_OFFSETS[weapon]
  }
  return null
}

/**
 * Which voice a remote shot uses. Unknown ids from a newer peer fall back to
 * the rifle report rather than going silent — a shot you cannot place is worse
 * than a shot with the wrong timbre.
 */
export function shotKindFor(weapon: string): RemoteShotKind {
  if (weapon === 'pistol') return 'pistol'
  if (weapon === 'minigun') return 'minigun'
  return 'rifle'
}

/** Muzzle flash lifetime (s) — one or two frames at 60 fps, like a real one. */
export const FLASH_LIFE_S = 0.05
/** Seconds between the voices of rounds that arrived in the SAME sample, so a
 * burst recovered from a dropped frame reads as a burst instead of one clap. */
export const BURST_STAGGER_S = 0.04

/**
 * Flash scale vs distance. A 7 cm flash is a couple of pixels across the lot,
 * so it grows with range — the far one stays roughly the same size ON SCREEN,
 * which is what "some visual for the shooting" has to mean at 60 m. Capped, or
 * a peer at the fence would fire a beach ball.
 */
export function flashScale(distance: number): number {
  const d = distance > 0 ? distance : 0
  return 1 + (d * 0.06 > 3 ? 3 : d * 0.06)
}

// ── Cached geometries + materials (module-lifetime, bounded) ─────────────────

const TORSO_GEO = new BoxGeometry(0.42, 0.55, 0.24)
const HEAD_GEO = new BoxGeometry(0.26, 0.26, 0.26)
const LIMB_GEO = new BoxGeometry(0.12, 0.8, 0.12) // legs; arms reuse it scaled
const FOOT_GEO = new BoxGeometry(0.14, 0.09, 0.24)

// ── Pascaline, in primitives ─────────────────────────────────────────────────
// Every measurement here is read off the official render pack (docs/brand):
// white hat with the logotype, hair to the shoulders, black jacket, charcoal
// cargo pants, leather belt with a pouch and the yellow tape, tan boots.

/** Hard hat: a half-sphere crown over a flat brim, plus the band that carries
 * the player's color. Low segment counts — this is a 26 cm prop. */
const HAT_CROWN_GEO = new SphereGeometry(0.155, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2)
const HAT_BRIM_GEO = new CylinderGeometry(0.205, 0.205, 0.022, 14)
const HAT_BAND_GEO = new CylinderGeometry(0.162, 0.162, 0.04, 14)
/** The logotype patch on the crown — a stripe at this size, which is exactly
 * what the wordmark reads as on a hard hat from two metres away. */
const HAT_MARK_GEO = new BoxGeometry(0.1, 0.028, 0.008)
/** Hair: one mass behind the head falling to the shoulders + two side locks. */
const HAIR_BACK_GEO = new BoxGeometry(0.28, 0.4, 0.15)
const HAIR_LOCK_GEO = new BoxGeometry(0.055, 0.3, 0.13)
/** Eyes — the facing cue that used to be a visor. */
const EYE_GEO = new BoxGeometry(0.035, 0.03, 0.01)
/** The site vest over the jacket: one plate on the chest, one on the back. */
const VEST_GEO = new BoxGeometry(0.3, 0.4, 0.02)
/** Tool belt, its pouch, and the tape measure clipped on the other hip. */
const BELT_GEO = new BoxGeometry(0.44, 0.075, 0.26)
const POUCH_GEO = new BoxGeometry(0.1, 0.13, 0.07)
const TAPE_GEO = new BoxGeometry(0.06, 0.07, 0.05)
/** Boots: a tan leather upper on a dark sole. */
const SOLE_GEO = new BoxGeometry(0.15, 0.035, 0.25)
/** Hands, so a sleeve does not end in nothing. */
const HAND_GEO = new BoxGeometry(0.09, 0.09, 0.09)

const HAT_MATERIAL = new MeshStandardMaterial({ color: '#f4f4f2', roughness: 0.45 })
const HAT_MARK_MATERIAL = new MeshStandardMaterial({ color: '#1a1a1c', roughness: 0.5 })
const JACKET_MATERIAL = new MeshStandardMaterial({ color: '#22242a', roughness: 0.7 })
const PANTS_MATERIAL = new MeshStandardMaterial({ color: '#2f3238', roughness: 0.85 })
const HAIR_MATERIAL = new MeshStandardMaterial({ color: '#3b2419', roughness: 0.8 })
/** The mascot's skin tone (hand-pose.ts: the GLB's hand/forearm texels), so the
 * box rig's head and the procedural hands meet the modelled wrist without a step. */
const SKIN_MATERIAL = new MeshStandardMaterial({ color: AVATAR_SKIN_HEX, roughness: 0.65 })
const EYE_MATERIAL = new MeshStandardMaterial({ color: '#241a14', roughness: 0.4 })
const LEATHER_MATERIAL = new MeshStandardMaterial({ color: '#8a5a33', roughness: 0.8 })
const TAPE_MATERIAL = new MeshStandardMaterial({ color: '#e8c229', roughness: 0.5 })

/**
 * The speaking dot — a small unlit disc over the name tag, shown while that peer
 * is transmitting (voice.ts's talk gate, carried on their own frames).
 *
 * Which mouth a voice belongs to is the one thing a call in a game needs and a
 * call on a phone does not: six people in one building, and without this the
 * answer to "who said that" is to ask. It rides INSIDE the tag group so it
 * billboards with the name and disappears at the same distance for free.
 *
 * Geometry AND material are shared across avatars, which is why the dot does not
 * fade with the tag the way the name does — a shared material has one opacity, so
 * fading it for the far avatar would fade it for the near one too. It blinks out
 * with the group at the tag cutoff instead, which is the honest version of the
 * same idea and costs one program for a whole lobby.
 */
const SPEAK_GEO = new CircleGeometry(0.045, 12)
const SPEAK_MATERIAL = new MeshBasicMaterial({
  color: '#7ee081',
  depthWrite: false,
  transparent: true,
})
/** The same green with depth off — the spectator's X-ray tag carries its
 * speaking cues through walls too (one material per mode; both shared). */
const SPEAK_MATERIAL_XRAY = new MeshBasicMaterial({
  color: '#7ee081',
  depthTest: false,
  depthWrite: false,
  transparent: true,
})
/**
 * The speaking HALO — a ring stretched around the whole name tag (0.72 × 0.18
 * m), lit while the peer transmits. The dot above the name is a 9 cm cue; the
 * halo is the one you see from across the lot, and it scales with the tag for
 * a spectator. Non-uniform X scale on a plain ring: the sides come out a little
 * thicker than the top and bottom, which reads as a brush stroke, not a bug.
 */
const SPEAK_RING_GEO = new RingGeometry(0.16, 0.19, 32)
export const SPEAK_SCALE_X = 2.4
/** Tan work boots, dark sole — the pack's are caramel leather, well worn. */
const BOOT_MATERIAL = new MeshStandardMaterial({ color: '#9c6b3f', roughness: 0.85 })
const SOLE_MATERIAL = new MeshStandardMaterial({ color: '#26221e', roughness: 0.95 })

/**
 * Muzzle flash + tracer stub: a hot core, a short cone of gas down the barrel,
 * and one streak of tracer just past the muzzle.
 *
 * Unlit (MeshBasic) on purpose — a muzzle flash IS the light source, so it must
 * not take a shading pass that would dim it in a shadowed room, which is where
 * you most need to see who is shooting. The cone is open-ended (no cap) because
 * you only ever see it from outside.
 *
 * Shared across every avatar, like SPEAK_MATERIAL and for the same reason: one
 * program for the whole lobby. The same constraint follows — a shared material
 * has ONE opacity, so a per-avatar fade is impossible here and the flash is a
 * `visible` toggle instead. At 50 ms that is the right shape anyway; nobody
 * watches a muzzle flash decay.
 */
const FLASH_CORE_GEO = new SphereGeometry(0.05, 6, 4)
const FLASH_CONE_GEO = new ConeGeometry(0.075, 0.24, 5, 1, true)
/** Tracer stub length (m) — a streak leaving the barrel, not a laser to the
 * target: the impact end already announces itself with dust and debris. */
export const TRACER_LEN = 2.6
const TRACER_GEO = new BoxGeometry(0.018, 0.018, TRACER_LEN)
const FLASH_MATERIAL = new MeshBasicMaterial({
  color: '#ffe6a8',
  depthWrite: false,
  transparent: true,
})
const TRACER_MATERIAL = new MeshBasicMaterial({
  color: '#ffd27a',
  depthWrite: false,
  opacity: 0.75,
  transparent: true,
})

const _tint = new Color()
const tintedMaterials = new Map<number, { vest: MeshStandardMaterial; band: MeshStandardMaterial }>()

/**
 * The two tinted materials — the ONLY per-player color on the rig: the vest
 * plates (full tint) and the hard-hat band (a darker cut of the same, so the
 * hat still reads as white with a colored band rather than as a colored hat).
 *
 * Created lazily and cached for the module's life (8 slots × 2 = bounded;
 * sharing across avatars keeps a crowd at a handful of programs).
 */
export function materialsFor(paletteIndex: number): {
  vest: MeshStandardMaterial
  band: MeshStandardMaterial
} {
  let entry = tintedMaterials.get(paletteIndex)
  if (!entry) {
    const hex = AVATAR_PALETTE[paletteIndex % AVATAR_PALETTE.length]!
    _tint.set(hex)
    entry = {
      vest: new MeshStandardMaterial({ color: hex, roughness: 0.75 }),
      band: new MeshStandardMaterial({
        color: _tint.clone().multiplyScalar(0.55),
        roughness: 0.8,
      }),
    }
    tintedMaterials.set(paletteIndex, entry)
  }
  return entry
}

// ── Name-tag texture (TableSign idiom — external texture, disposed) ─────────

/** 512 × 128: crisp at the 1× in-game size AND when a spectator's constant-
 * pixel tag is scaled up to 12× (far-lod.ts) — the texture is what gets read. */
function makeNameTexture(name: string, tint: string): CanvasTexture | null {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 128
  const g = canvas.getContext('2d')
  if (!g) return null
  g.fillStyle = 'rgba(12,14,16,0.72)'
  g.beginPath()
  g.roundRect(8, 16, 496, 96, 24)
  g.fill()
  // The vest color, again, around the name: the tag is where a player LEARNS
  // which color is which, so it has to carry both halves of the pairing.
  g.strokeStyle = tint
  g.lineWidth = 8
  g.stroke()
  g.fillStyle = 'rgba(255,255,255,0.92)'
  const label = name.slice(0, 16)
  // Shrink-to-fit: a long nickname gets a smaller face, never a clipped one.
  const px = tagFontPx((size) => {
    g.font = `bold ${size}px system-ui, sans-serif`
    return g.measureText(label).width
  }, 470)
  g.font = `bold ${px}px system-ui, sans-serif`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(label, 256, 66)
  return new CanvasTexture(canvas)
}

// ── Held weapon silhouette ───────────────────────────────────────────────────

/** Weapon id → viewmodel component (weapon-models contract: grip at the
 * origin, barrel down -Z). Unknown ids from newer peers render bare hands. */
const WEAPON_COMPONENT: Record<string, () => ReactElement> = {
  knife: KnifeModel,
  pistol: PistolModel,
  rifle: RifleModel,
  minigun: MinigunModel,
  hammer: WarhammerModel,
  builder: HammerModel,
  paint: SprayerModel,
}

/** Feature-detected HUD surface (structural — same defensive idiom as the
 * pinned-typings casts elsewhere: an older Hud without the chip is a no-op;
 * one that only knows the count ignores the names). */
type PresenceHud = { presenceChip?: (count: number, names?: readonly string[]) => void }

function driveChip(count: number, names?: readonly string[]): void {
  const hud = getSession()?.hud as unknown as PresenceHud | undefined
  hud?.presenceChip?.(count, names)
}

/**
 * The roster chip's names: every listed remote's label (nick, else the host
 * roster's name, else 'builder' — roster-names' one rule), sorted so the chip
 * reads the same on every screen. Allocates: roster edges and slow polls only.
 */
export function rosterNames(list: readonly Pick<RemotePlayer, 'nick' | 'userId'>[]): string[] {
  const names: string[] = []
  for (const remote of list) names.push(remoteLabel(remote))
  names.sort()
  return names
}

/** How often (frames) RemotePlayers re-reads the names for the chip between
 * roster edges: a nick that resolves late must reach the chip too. */
const CHIP_NAME_POLL_FRAMES = 120

// ── Reused frame temps (zero per-frame allocations) ──────────────────────────

const _pose: SampledPose = createSampledPose()
const _artic: AvatarArticulation = createArticulation()
const _layered: AvatarArticulation = createArticulation()
const _drawn = { x: 0, y: 0, z: 0 }
const _worldQuat = new Quaternion()

// ── The rig itself (shared: peers AND the depot mirror) ─────────────────────

/**
 * The handles an animator needs on one Pascaline. Structural `{ current }` so
 * either a React ref or a plain object satisfies it.
 *
 * `fx`/`flash` are OPTIONAL, and that is the whole reason this is a type rather
 * than a fixed list: omit them and the rig draws no gunfire hardware at all.
 * The depot mirror's dummy is a reflection — it never fires, so it must not
 * carry a muzzle flash waiting to be triggered.
 */
export type AvatarRigRefs = {
  torso: { current: Group | null }
  head: { current: Group | null }
  armL: { current: Group | null }
  armR: { current: Group | null }
  legL: { current: Group | null }
  legR: { current: Group | null }
  /** LOD group under the head pivot (logotype, eyes, side locks). */
  headDetail: { current: Group | null }
  /** LOD group under the torso pivot (belt pouch, tape). */
  bodyDetail: { current: Group | null }
  /** Elbows and knees — the model has them, the box rig does not. */
  elbowL?: { current: Group | null }
  elbowR?: { current: Group | null }
  kneeL?: { current: Group | null }
  kneeR?: { current: Group | null }
  /** The held weapon's group (HeldWeapon) — tilted per frame so the barrel tracks the aim. */
  weapon?: { current: Group | null }
  /** Native hands and the posed grip replacements. The former collapse on
   * the same threshold that the latter appear, so only one pair renders. */
  handL?: { current: Group | null }
  handR?: { current: Group | null }
  fistL?: { current: Group | null }
  fistR?: { current: Group | null }
  fx?: { current: Group | null }
  flash?: { current: Group | null }
  /** The face plate's two mouths (the model only) — setMouth flips them. */
  face?: { current: PascalineFace | null }
}

/** A fresh set of empty handles — for callers that are not React components
 * (or that just want one stable object instead of eight useRef calls). */
export function createRigRefs(): AvatarRigRefs {
  return {
    torso: { current: null },
    head: { current: null },
    armL: { current: null },
    armR: { current: null },
    legL: { current: null },
    legR: { current: null },
    headDetail: { current: null },
    bodyDetail: { current: null },
    elbowL: { current: null },
    elbowR: { current: null },
    kneeL: { current: null },
    kneeR: { current: null },
    weapon: { current: null },
    handL: { current: null },
    handR: { current: null },
    fistL: { current: null },
    fistR: { current: null },
    face: { current: null },
  }
}

/**
 * PASCALINE, IN PRIMITIVES — the box body, kept as the FALLBACK: it is what a
 * peer wears for the first frames before the real model has decoded, and
 * forever if that decode fails (no Draco decoder, a hostile CSP). Same six
 * pivots, same weapon frame, same tint materials as the model, so the
 * animator never knows which body it is posing.
 *
 * Purely presentational: it mounts the hierarchy (hip pivots, torso, neck, two
 * arms, the held weapon, the two LOD groups) and hands the pivots back through
 * `refs`. Every frame-by-frame decision — where she stands, which way she
 * faces, how the gait swings, when detail drops — belongs to the caller.
 */
function PrimitiveRig({
  paletteIndex,
  refs,
  weapon,
}: {
  paletteIndex: number
  refs: AvatarRigRefs
  weapon: string
}) {
  const { vest, band } = materialsFor(paletteIndex)

  return (
    <>
      {/* Legs: pivots at the hip so the gait swings them. Charcoal cargo
          pants into tan boots on dark soles — the pack's exact stack. */}
      <group ref={refs.legL} position={[-0.11, 0.85, 0]}>
        <mesh geometry={LIMB_GEO} material={PANTS_MATERIAL} position={[0, -0.4, 0]} />
        <mesh geometry={FOOT_GEO} material={BOOT_MATERIAL} position={[0, -0.81, -0.04]} />
        <mesh geometry={SOLE_GEO} material={SOLE_MATERIAL} position={[0, -0.867, -0.04]} />
      </group>
      <group ref={refs.legR} position={[0.11, 0.85, 0]}>
        <mesh geometry={LIMB_GEO} material={PANTS_MATERIAL} position={[0, -0.4, 0]} />
        <mesh geometry={FOOT_GEO} material={BOOT_MATERIAL} position={[0, -0.81, -0.04]} />
        <mesh geometry={SOLE_GEO} material={SOLE_MATERIAL} position={[0, -0.867, -0.04]} />
      </group>
      {/* Torso pivot at the hip — slumps forward while staggered. */}
      <group ref={refs.torso} position={[0, 0.85, 0]}>
        {/* Black jacket, with the site vest over it: one plate front, one
            back, so a teammate's color reads whichever way they are facing. */}
        <mesh geometry={TORSO_GEO} material={JACKET_MATERIAL} position={[0, 0.3, 0]} />
        <mesh geometry={VEST_GEO} material={vest} position={[0, 0.3, -0.125]} />
        <mesh geometry={VEST_GEO} material={vest} position={[0, 0.3, 0.125]} />
        {/* Tool belt at the waist; pouch and tape are LOD detail. */}
        <mesh geometry={BELT_GEO} material={LEATHER_MATERIAL} position={[0, 0.07, 0]} />
        <group ref={refs.bodyDetail}>
          <mesh geometry={POUCH_GEO} material={LEATHER_MATERIAL} position={[0.2, 0.0, 0.02]} />
          <mesh geometry={TAPE_GEO} material={TAPE_MATERIAL} position={[-0.21, 0.03, 0.04]} />
        </group>
        {/* Head pivot at the neck. Hair falls behind to the shoulders, the
            hard hat sits on top, the eyes mark the facing (-Z). */}
        <group ref={refs.head} position={[0, 0.6, 0]}>
          <mesh geometry={HEAD_GEO} material={SKIN_MATERIAL} position={[0, 0.15, 0]} />
          <mesh geometry={HAIR_BACK_GEO} material={HAIR_MATERIAL} position={[0, 0.06, 0.075]} />
          {/* Hard hat: white crown, flat brim, colored band, logotype. */}
          <mesh geometry={HAT_CROWN_GEO} material={HAT_MATERIAL} position={[0, 0.27, 0]} />
          <mesh geometry={HAT_BRIM_GEO} material={HAT_MATERIAL} position={[0, 0.275, -0.01]} />
          <mesh geometry={HAT_BAND_GEO} material={band} position={[0, 0.295, 0]} />
          <group ref={refs.headDetail}>
            <mesh geometry={HAT_MARK_GEO} material={HAT_MARK_MATERIAL} position={[0, 0.35, -0.12]} />
            <mesh geometry={HAIR_LOCK_GEO} material={HAIR_MATERIAL} position={[-0.145, 0.06, 0.02]} />
            <mesh geometry={HAIR_LOCK_GEO} material={HAIR_MATERIAL} position={[0.145, 0.06, 0.02]} />
            <mesh geometry={EYE_GEO} material={EYE_MATERIAL} position={[-0.06, 0.16, -0.132]} />
            <mesh geometry={EYE_GEO} material={EYE_MATERIAL} position={[0.06, 0.16, -0.132]} />
          </group>
        </group>
        {/* Free (left) arm counter-swings the gait — jacket sleeve, bare hand. */}
        <group ref={refs.armL} position={[-0.28, 0.5, 0]} rotation-order="YXZ">
          <mesh
            geometry={LIMB_GEO}
            material={JACKET_MATERIAL}
            position={[0, -0.26, 0]}
            scale={[0.85, 0.7, 0.85]}
          />
          <group ref={refs.handL} position={[0, -0.5, 0]}>
            <mesh geometry={HAND_GEO} material={SKIN_MATERIAL} />
          </group>
        </group>
        {/* Weapon (right) arm aims with the remote pitch; the held model
            hangs off the hand, barrel aligned down the arm. */}
        <group ref={refs.armR} position={[0.28, 0.5, 0]} rotation-order="YXZ">
          <mesh
            geometry={LIMB_GEO}
            material={JACKET_MATERIAL}
            position={[0, -0.26, 0]}
            scale={[0.85, 0.7, 0.85]}
          />
          <group ref={refs.handR} position={[0, -0.5, 0]}>
            <mesh geometry={HAND_GEO} material={SKIN_MATERIAL} />
          </group>
          <HeldWeapon refs={refs} weapon={weapon} />
        </group>
      </group>
    </>
  )
}

/** Does this hold put the support hand ON the weapon (articulate's gripL)? The
 * grip decides, not the table: a warhammer has a second hand in the table, but
 * the avatar carries tools one-handed at the hip (GRIPS.tool.foregrip = 0). */
export function twoHanded(weapon: string): boolean {
  const grip = gripFor(weapon)
  return grip !== 'none' && GRIPS[grip].foregrip > 0 && leftGripFor(weapon) !== null
}

/** The minigun reads better with the Pascaline model's native hands: its
 * broad two-arm carry already lands both wrists on the grips, while the small
 * procedural hands make the heavy body look offset to one side. Thin tools
 * such as the knife still need a posed hand wrapped around their handle. */
export function usesPosedGripHands(weapon: string): boolean {
  return weapon !== 'minigun'
}

/**
 * The held weapon, in THE ARM FRAME: hanging −y from the shoulder, barrel down
 * the arm (weapon-models contract: grip at the origin, barrel down −Z), muzzle
 * fx parented to the gun. One definition for both bodies — the box rig mounts
 * it straight under its arm pivot, the model under its arm frame (see
 * pascaline-model.ts), and the two agree on where a rifle is in space.
 * `reach` is shoulder → grip: the box rig's 0.52, the model's arm plus a hand.
 *
 * A correctly posed grip hand rides the weapon at the same grip-table point
 * as first person. applyArticulation hides the native straight hand on the
 * exact frame this replacement appears, so the knife sits inside a hand and
 * mirrors never show both versions at once.
 */
function HeldWeapon({
  reach = 0.52,
  refs,
  weapon,
}: {
  reach?: number
  refs: AvatarRigRefs
  weapon: string
}) {
  const Weapon = WEAPON_COMPONENT[weapon]
  const muzzle = refs.fx ? remoteMuzzle(weapon) : null
  const hold = holdFor(weapon)
  const support = twoHanded(weapon) ? hold.left : null
  const posedHands = usesPosedGripHands(weapon)
  const qR = useMemo(() => gripQuaternion(hold.right, 'R', new Quaternion()), [hold])
  const qL = useMemo(() => (support ? gripQuaternion(support, 'L', new Quaternion()) : null), [support])
  if (!Weapon) return null
  const r = hold.right.position
  return (
    <group position={[0, -reach, 0.02]} ref={refs.weapon} rotation={[-Math.PI / 2, 0, 0]}>
      {/* Palm at the origin: the weapon sits behind the right hand's table offset. */}
      <group position={[-r[0], -r[1], -r[2]]}>
        <Weapon />
        {/* Muzzle fx, parented to the gun: the flash points wherever the
            peer aims for free, through the arm chain, with no per-frame
            math of ours. Mounted once and toggled, like the speaking dot,
            so firing is a boolean rather than a mid-firefight remount. */}
        {muzzle ? (
          <group position={muzzle} ref={refs.fx} visible={false}>
            <group ref={refs.flash}>
              <mesh geometry={FLASH_CORE_GEO} material={FLASH_MATERIAL} />
              <mesh
                geometry={FLASH_CONE_GEO}
                material={FLASH_MATERIAL}
                position={[0, 0, -0.13]}
                rotation={[-Math.PI / 2, 0, 0]}
              />
            </group>
            {/* Tracer stub — a streak leaving the barrel, deliberately
                NOT a beam to the target: the round's own impact already
                throws dust and debris on this client. */}
            <mesh
              geometry={TRACER_GEO}
              material={TRACER_MATERIAL}
              position={[0, 0, -(TRACER_LEN / 2) - 0.1]}
            />
          </group>
        ) : null}
        {posedHands ? (
          <group position={[r[0], r[1], r[2]]} quaternion={qR} ref={refs.fistR} visible={false}>
            <HandMesh pose={hold.right.pose} side="R" scale={AVATAR_GRIP_HAND_SCALE} />
          </group>
        ) : null}
        {posedHands && support && qL ? (
          <group
            position={[support.position[0], support.position[1], support.position[2]]}
            quaternion={qL}
            ref={refs.fistL}
            visible={false}
          >
            <HandMesh pose={support.pose} side="L" scale={AVATAR_GRIP_HAND_SCALE} />
          </group>
        ) : null}
      </group>
    </group>
  )
}

// ── Tint bands for the model (shared geometry per body measurement) ──────────

const bandGeometries = new Map<string, { hat: TorusGeometry; sleeve: CylinderGeometry }>()

/** The hat band ring and the sleeve band, sized to the body they wrap. */
function bandGeometriesFor(dims: PascalineDims) {
  const key = `${dims.hatRadius}|${dims.armRadius}`
  let entry = bandGeometries.get(key)
  if (!entry) {
    entry = {
      hat: new TorusGeometry(dims.hatRadius, 0.014, 8, 40),
      sleeve: new CylinderGeometry(dims.armRadius, dims.armRadius, 0.055, 18, 1, true),
    }
    bandGeometries.set(key, entry)
  }
  return entry
}

/**
 * PASCALINE, THE MODEL — the mascot's own body (pascaline-model.ts), posed
 * through the SAME six handles as the box rig. The animator gets the pivots;
 * the weapon rides the right arm frame; the tint that tells players apart is a
 * band on the hard hat and a band on each sleeve — the face, jacket and belt
 * are hers and stay hers.
 */
function PascalineRig({
  paletteIndex,
  refs,
  template,
  weapon,
}: {
  paletteIndex: number
  refs: AvatarRigRefs
  template: PascalineTemplate
  weapon: string
}) {
  const body = useMemo(() => instantiatePascaline(template), [template])
  const { vest } = materialsFor(paletteIndex)
  const geo = bandGeometriesFor(body.dims)
  // The caller's refs object may be rebuilt per render (RemoteAvatar's is),
  // but the handles inside are stable; re-pointing them is six assignments.
  useLayoutEffect(() => {
    refs.torso.current = body.pivots.torso
    refs.head.current = body.pivots.head
    refs.armL.current = body.pivots.armL
    refs.armR.current = body.pivots.armR
    refs.legL.current = body.pivots.legL
    refs.legR.current = body.pivots.legR
    refs.headDetail.current = body.detail.head
    refs.bodyDetail.current = body.detail.body
    if (refs.elbowL) refs.elbowL.current = body.joints.elbowL
    if (refs.elbowR) refs.elbowR.current = body.joints.elbowR
    if (refs.kneeL) refs.kneeL.current = body.joints.kneeL
    if (refs.kneeR) refs.kneeR.current = body.joints.kneeR
    if (refs.handL) refs.handL.current = body.hands.L as Group | null
    if (refs.handR) refs.handR.current = body.hands.R as Group | null
    if (refs.face) refs.face.current = body.face
  })
  const d = body.dims
  return (
    <>
      {/* Geometry and materials are the template's, shared by every body on
          the lot — never disposed with one avatar. */}
      <primitive dispose={null} object={body.root} />
      {/* In the hand frame under the elbow: the grip sits in the palm, the
          barrel runs down the forearm, and a bent elbow raises the gun. */}
      {createPortal(
        <HeldWeapon reach={d.foreArmLen + d.handLen * GRIP_IN_HAND} refs={refs} weapon={weapon} />,
        body.handFrames.R,
      )}
      {/* Hat band: a ring around the shell just above the brim. */}
      {createPortal(
        <mesh
          geometry={geo.hat}
          material={vest}
          position={[0, d.hatBandZ - d.neckZ, 0]}
          rotation={[Math.PI / 2, 0, 0]}
        />,
        body.pivots.head,
      )}
      {/* Sleeve bands, a little below each shoulder, in the arm frame (hanging −y). */}
      {createPortal(<mesh geometry={geo.sleeve} material={vest} position={[0, -0.13, 0]} />, body.armFrames.L)}
      {createPortal(<mesh geometry={geo.sleeve} material={vest} position={[0, -0.13, 0]} />, body.armFrames.R)}
      {/* HeldWeapon supplies the posed grip hand; applyArticulation hides the
          native straight hand on the same threshold, so there is one pair. */}
    </>
  )
}

/**
 * THE BODY — the same one for every peer streamed off the wire and for the
 * reflection in the depot mirror, which is what keeps the mirror honest: if it
 * looks right in the glass, that IS what your teammates see.
 *
 * The mascot's model when it has loaded (usePascalineTemplate kicks the one
 * decode off), the primitive box rig until then or if it never does. Both
 * expose the same six pivots through `refs`, both hang the same weapon in the
 * same frame, and every frame-by-frame decision — stand, facing, gait, LOD —
 * stays the caller's.
 */
export function AvatarRig(props: { paletteIndex: number; refs: AvatarRigRefs; weapon: string }) {
  const template = usePascalineTemplate()
  if (!template) return <PrimitiveRig {...props} />
  return <PascalineRig template={template} {...props} />
}

/**
 * One peer. `spectator` (constant for the component's life) switches the name
 * tag to the far-LOD path (far-lod.ts): a constant-pixel tag lifted so it never
 * covers the body, drawn through walls and last, over a floor ring once the
 * body itself has stopped reading as a person. The IN-GAME path is untouched —
 * a depth-tested, unscaled tag fading at 24–40 m is PvP fairness.
 */
function RemoteAvatar({
  paletteIndex,
  remote,
  spectator = false,
}: {
  paletteIndex: number
  remote: RemotePlayer
  spectator?: boolean
}) {
  const rootRef = useRef<Group>(null)
  const torsoRef = useRef<Group>(null)
  const headRef = useRef<Group>(null)
  const armLRef = useRef<Group>(null)
  const armRRef = useRef<Group>(null)
  const legLRef = useRef<Group>(null)
  const legRRef = useRef<Group>(null)
  const elbowLRef = useRef<Group>(null)
  const elbowRRef = useRef<Group>(null)
  const kneeLRef = useRef<Group>(null)
  const kneeRRef = useRef<Group>(null)
  const weaponRef = useRef<Group>(null)
  const handLRef = useRef<Group>(null)
  const handRRef = useRef<Group>(null)
  const fistLRef = useRef<Group>(null)
  const fistRRef = useRef<Group>(null)
  // The LIVE pose this body wears, eased toward each frame's target.
  const pose = useRef(createArticulation())
  // A per-peer phase so a lobby does not breathe, sway and glance in unison.
  const idleSeed = useMemo(() => ((hashUserId(remote.userId) % 1000) / 1000) * Math.PI * 2, [remote.userId])
  const tagRef = useRef<Group>(null)
  const tagMatRef = useRef<MeshBasicMaterial>(null)
  const speakRef = useRef<Mesh>(null)
  const speakRingRef = useRef<Mesh>(null)
  // Spectator far LOD: the floor ring and the last tag scale written.
  const ringRef = useRef<Mesh>(null)
  const lastTagScale = useRef(1)
  const faceRef = useRef<PascalineFace | null>(null)
  // The two LOD groups (head detail lives under the head pivot, body detail
  // under the torso pivot, so the gate needs a handle on each).
  const headDetailRef = useRef<Group>(null)
  const bodyDetailRef = useRef<Group>(null)
  const lastDetail = useRef(true)
  const gaitPhase = useRef(0)
  const lastScale = useRef(-1)
  const frame = useRef(0)
  // Gunfire: the fx group at the muzzle, the inner group that takes the random
  // roll, the flash's remaining life, and the last fire count we SAW for this
  // peer. -1 means "never sampled" — shotsFired returns 0 for it, so walking
  // up to someone mid-magazine does not replay their whole magazine at you.
  const fxRef = useRef<Group>(null)
  const flashRef = useRef<Group>(null)
  // One stable handle object for the body: every ref inside is stable, so the
  // rig never sees a handle change, and the frame loop and the rig share it.
  const rigRefs = useRef<AvatarRigRefs>({
    torso: torsoRef,
    head: headRef,
    armL: armLRef,
    armR: armRRef,
    legL: legLRef,
    legR: legRRef,
    headDetail: headDetailRef,
    bodyDetail: bodyDetailRef,
    elbowL: elbowLRef,
    elbowR: elbowRRef,
    kneeL: kneeLRef,
    kneeR: kneeRRef,
    weapon: weaponRef,
    handL: handLRef,
    handR: handRRef,
    fistL: fistLRef,
    fistR: fistRRef,
    fx: fxRef,
    flash: flashRef,
    face: faceRef,
  }).current
  const flashT = useRef(0)
  const lastShots = useRef(-1)
  // Motion: displayed speed/direction, body yaw, landing, recoil (updateMotion);
  // the residual smoother between the sample and the root; the per-peer
  // adaptive interpolation delay, slewed. All plain objects, allocated once.
  const motion = useRef(createMotion())
  const smoother = useRef(createSmoother())
  const delay = useRef(INTERP_DELAY_MIN_MS)
  const stats = useRef<AvatarStats>({
    speedDisp: 0,
    delayMs: INTERP_DELAY_MIN_MS,
    corrections: 0,
    maxStepM: 0,
    bodyYaw: 0,
    twist: 0,
    moveRel: 0,
    landT: 0,
    recoilX: 0,
    frozen: false,
    resX: 0,
    resY: 0,
    resZ: 0,
  })
  useEffect(() => {
    avatarStats.set(remote.sessionId, stats.current)
    smootherOf.set(remote.sessionId, smoother.current)
    return () => {
      avatarStats.delete(remote.sessionId)
      smootherOf.delete(remote.sessionId)
    }
  }, [remote.sessionId])
  // Change-gated React state: weapon swaps and late-resolving names are
  // EVENTS (a handful per session), so a state write from useFrame is fine.
  const [weapon, setWeapon] = useState(remote.w)
  // The chosen nickname (off the peer's pose) wins over the host roster name.
  const [name, setName] = useState(() => remote.nick || participantName(remote.userId))

  // The tint is the tag's business here (the rig paints itself from the index).
  const tint = AVATAR_PALETTE[paletteIndex % AVATAR_PALETTE.length]!

  const tagTexture = useMemo(() => makeNameTexture(name, tint), [name, tint])
  // R3F disposes JSX-owned materials, never this externally created texture —
  // release it on unmount and on every name flip (TableSign contract).
  useEffect(() => () => tagTexture?.dispose(), [tagTexture])

  useFrame((rootState, rawDt) => {
    const root = rootRef.current
    if (!root) return
    const now = Date.now()
    const offset = Number.isFinite(remote.clockOffset) ? remote.clockOffset : 0

    // The one frame delta every integrator here uses (feel.ts): capped so a
    // hitch never teleports a limb, and a rewound clock's negative dt is 0.
    const dt = clampFrameDt(rawDt)

    // The interpolation delay this peer has earned from its measured arrival
    // timing, slewed so it never steps; then the sample at that point in the
    // past, then the residual smoother between the sample and the root.
    delay.current = slewDelay(delay.current, interpDelayFor(remote.timing), dt)
    if (!sampleAt(remote.ring, now - offset - delay.current, _pose)) return
    smoothPose(smoother.current, _pose.x, _pose.y, _pose.z, _pose.vx, _pose.vy, _pose.vz, rawDt, dt, _drawn)
    // Published for the consumers that must agree with the picture (PvP, voice).
    remote.drawnX = _drawn.x
    remote.drawnY = _drawn.y
    remote.drawnZ = _drawn.z
    remote.drawnAt = now
    remote.delayMs = delay.current

    // ONE distance, spent four ways: gunfire and footsteps, the tag fade, the LOD.
    const camera = rootState.camera
    const dx = camera.position.x - _drawn.x
    const dy = camera.position.y - _drawn.y
    const dz = camera.position.z - _drawn.z
    const distSq = dx * dx + dy * dy + dz * dz

    // Gunfire counter FIRST — the recoil kick belongs to this frame's pose.
    const shots = shotsFired(lastShots.current, _pose.f)
    lastShots.current = _pose.f

    // The motion state runs off the DRAWN position: the gait is paced by the
    // speed the body is actually seen moving at, so an extrapolating or frozen
    // peer's legs stop with it instead of treadmilling on the wire's `s`.
    const m = motion.current
    const sDisp = updateMotion(m, _drawn.x, _drawn.y, _drawn.z, _pose.yaw, _pose.g, _pose.st, shots, _pose.w, _pose.vy, dt)
    const prevPhase = gaitPhase.current
    gaitPhase.current = advanceGait(prevPhase, _pose.g && !_pose.frozen ? sDisp : 0, dt)
    // The peer's own clock drives their breathing, so a lobby does not breathe
    // in unison; the wire weapon decides the hold.
    articulate(
      _artic,
      gaitPhase.current,
      sDisp,
      _pose.pitch,
      _pose.g,
      _pose.st,
      gripFor(_pose.w),
      (now - remote.joinedAt) / 1000,
      MODEL_ARMS,
      idleSeed,
      m.moveRel,
      leftGripFor(_pose.w),
    )
    blendArticulation(pose.current, _artic, dt)
    layerMotion(_layered, pose.current, m, _pose.yaw)

    // Wire positions are EYE positions — plant the feet. The ROOT faces where
    // the body faces; the torso carries the rest of the view yaw (layerMotion).
    placeRoot(root, _drawn.x, _drawn.y - EYE_HEIGHT, _drawn.z, m.bodyYaw, _layered)
    root.rotation.y = m.bodyYaw
    const scale = spawnScale(now - remote.joinedAt)
    if (scale !== lastScale.current) {
      lastScale.current = scale
      root.scale.setScalar(scale)
    }
    applyArticulation(rigRefs, _layered)

    // QA numbers (plain fields on a long-lived object — no allocation).
    const st = stats.current
    st.speedDisp = m.speedDisp
    st.delayMs = delay.current
    st.corrections = smoother.current.corrections
    st.maxStepM = smoother.current.maxStepM
    st.bodyYaw = m.bodyYaw
    st.twist = wrapAngle(_pose.yaw - m.bodyYaw)
    st.moveRel = m.moveRel
    st.landT = m.landT
    st.recoilX = m.recoilX
    st.frozen = _pose.frozen
    st.resX = smoother.current.ex
    st.resY = smoother.current.ey
    st.resZ = smoother.current.ez

    // Weapon swap — change-gated, so per-frame calls are free while held.
    if (_pose.w !== weapon) setWeapon(_pose.w)

    // Footsteps: one per k·π crossing of the gait phase — exactly the instant
    // the drawn foot plants — while grounded and actually stepping.
    const plants = _pose.g && sDisp >= GAIT_MIN_S ? footPlants(prevPhase, gaitPhase.current) : 0
    // Distance and bearing, computed once and only on a frame that needs them.
    let dist = 0
    let pan = 0
    if (shots > 0 || plants > 0) {
      dist = Math.sqrt(distSq)
      // Bearing: how far along the camera's own right axis (column 0 of its
      // world matrix) the peer sits, normalized to ±1 — so a sound from behind
      // your left shoulder arrives in the left ear.
      const e = camera.matrixWorld.elements
      pan = dist > 0.001 ? (-dx * e[0]! - dy * e[1]! - dz * e[2]!) / dist : 0
    }
    if (plants > 0) remoteFootstep(dist, pan)

    // Gunfire: every round this peer has fired since the last sample becomes a
    // flash at their muzzle and a report voiced at their distance and bearing.
    // The fx group only exists while they hold a gun, so `fx` IS the melee and
    // spray-can guard — a knife swing can never bloom a muzzle flash.
    const fx = fxRef.current
    if (fx) {
      if (shots > 0) {
        fx.visible = true
        flashT.current = FLASH_LIFE_S
        const flash = flashRef.current
        if (flash) {
          // A fresh roll and a little shimmer per round: without them, repeated
          // flashes stamp the same shape in the same place and read as a decal
          // glued to the barrel rather than as firing.
          flash.rotation.z = Math.random() * Math.PI * 2
          flash.scale.setScalar(flashScale(dist) * (0.85 + Math.random() * 0.3))
        }
        const kind = shotKindFor(weapon)
        for (let n = 0; n < shots; n++) {
          sfx.remoteShot(kind, dist, pan, n * BURST_STAGGER_S)
        }
      } else if (flashT.current > 0) {
        flashT.current -= dt
        if (flashT.current <= 0) fx.visible = false
      }
    }

    // Pascaline's small parts, dropped past 14 m — change-gated, so this is a
    // comparison per frame and two boolean writes per crossing.
    const detail = detailVisible(distSq)
    if (detail !== lastDetail.current) {
      lastDetail.current = detail
      if (headDetailRef.current) headDetailRef.current.visible = detail
      if (bodyDetailRef.current) bodyDetailRef.current.visible = detail
    }

    // Voice: one map lookup (isPeerTalking, not talkingPeers() — that one
    // allocates an array per call, and a dozen avatars asking it every frame is
    // hundreds of throwaway arrays a second for one boolean each). `now` is
    // passed explicitly so a peer whose last voice frame stopped arriving goes
    // quiet on WALL time; the voice module's own clock only advances while its
    // tick is running.
    const talking = isPeerTalking(remote.sessionId, now)

    // The talking mouth: the face plate flaps between its two paints on the
    // wall clock while the peer transmits (setMouth is change-gated — two
    // boolean writes per flip, nothing otherwise). Sub-pixel past the detail
    // range, so it stays closed there.
    const face = faceRef.current
    if (face) setMouth(face, detail && mouthOpenAt(talking, now))

    // Name tag: distance fade + billboard (parent-compensated camera copy).
    const tag = tagRef.current
    if (tag) {
      const opacity = spectator ? spectatorTagOpacity(distSq) : tagOpacity(distSq)
      const visible = opacity > 0
      if (tag.visible !== visible) tag.visible = visible
      const ring = ringRef.current
      if (visible) {
        // Change-gated (per-avatar JSX-owned material — never shared).
        const material = tagMatRef.current
        if (material && Math.abs(material.opacity - opacity) > 0.01) {
          material.opacity = opacity
        }
        root.getWorldQuaternion(_worldQuat).invert()
        tag.quaternion.copy(_worldQuat.multiply(camera.quaternion))
        if (spectator) {
          // FAR LOD (far-lod.ts): the tag reads ~36 px tall from wherever the
          // editor camera is — perspective or plan view — lifted with its
          // scale so it grows upward off the body, over a floor ring once the
          // avatar is a speck. One sqrt per avatar per frame; writes only when
          // the scale moved by more than 2 %.
          const s = tagScale(
            worldPerPixel(camera as unknown as LodCamera, Math.sqrt(distSq), rootState.size.height),
          )
          if (Math.abs(s - lastTagScale.current) > 0.02) {
            lastTagScale.current = s
            tag.scale.setScalar(s)
            tag.position.y = tagLiftY(s)
            if (ring) ring.scale.set(s, s, 1)
          }
          if (ring) {
            const ringOn = ringVisible(s)
            if (ring.visible !== ringOn) ring.visible = ringOn
          }
        }
        // Speaking cues: the dot over the name and the halo around the tag.
        const speak = speakRef.current
        if (speak && speak.visible !== talking) speak.visible = talking
        const halo = speakRingRef.current
        if (halo && halo.visible !== talking) halo.visible = talking
      } else if (ring?.visible) {
        ring.visible = false
      }
    }

    // A late-resolving roster name OR a peer's rename: re-check ~every 2 s.
    if (++frame.current % 120 === 0) {
      const fresh = remote.nick || participantName(remote.userId)
      if (fresh !== name) setName(fresh)
    }
  })

  return (
    // Non-solid, non-shootable by construction (see the anti-goal above);
    // __boots tags every surface for identifyAim attribution.
    <group
      name={`boots-remote-${remote.sessionId}`}
      ref={rootRef}
      scale={0.001}
      userData={{ __boots: true, __bootsRemote: remote.sessionId }}
    >
      {/* The body — the same rig the depot mirror poses (AvatarRig). The refs
          object is rebuilt per render, but every ref INSIDE it is stable, so
          React never detaches a handle; renders here are weapon/name events. */}
      <AvatarRig paletteIndex={paletteIndex} refs={rigRefs} weapon={weapon} />
      {/* Name-tag billboard — hidden past 40 m in game (200 m for a spectator,
          who also gets it depth-free and drawn last); texture disposed on
          despawn. Never a raycast target: a depth-ignoring plane must not
          become the editor's hover/selection hit. */}
      <group ref={tagRef} position={[0, 2.05, 0]}>
        {tagTexture ? (
          <mesh raycast={noopRaycast} renderOrder={tagRenderOrder(spectator)}>
            <planeGeometry args={[0.72, 0.18]} />
            <meshBasicMaterial
              ref={tagMatRef}
              map={tagTexture}
              transparent
              depthWrite={false}
              depthTest={tagDepthTest(spectator)}
            />
          </mesh>
        ) : null}
        {/* Speaking dot — above the name, hidden until this peer transmits.
            Mounted always (not conditionally rendered) so turning it on is a
            boolean on an existing object rather than a mid-firefight remount. */}
        <mesh
          geometry={SPEAK_GEO}
          material={spectator ? SPEAK_MATERIAL_XRAY : SPEAK_MATERIAL}
          position={[0, 0.16, 0]}
          raycast={noopRaycast}
          ref={speakRef}
          renderOrder={tagRenderOrder(spectator)}
          visible={false}
        />
        {/* Speaking halo — the ring around the whole tag, same boolean. */}
        <mesh
          geometry={SPEAK_RING_GEO}
          material={spectator ? SPEAK_MATERIAL_XRAY : SPEAK_MATERIAL}
          position={[0, 0, -0.002]}
          raycast={noopRaycast}
          ref={speakRingRef}
          renderOrder={tagRenderOrder(spectator)}
          scale={[SPEAK_SCALE_X, 1, 1]}
          visible={false}
        />
      </group>
      {/* Spectator only: the floor ring that grounds a far speck (far-lod.ts),
          in the vest tint, depth-free, under the tag in draw order. `spectator`
          is constant for the component's life and this is not a light, so the
          conditional mount is fine. */}
      {spectator ? (
        <mesh
          geometry={ringGeometry()}
          material={ringMaterialFor(tint)}
          position={[0, 0.02, 0]}
          raycast={noopRaycast}
          ref={ringRef}
          renderOrder={SPECTATOR_RING_RENDER_ORDER}
          rotation={[-Math.PI / 2, 0, 0]}
          visible={false}
        />
      ) : null}
    </group>
  )
}

/** The last deal RemotePlayers made — see localPaletteIndex. */
let lastDeal: ReadonlyMap<string, number> = new Map()
/** Told when OUR OWN slot moves (the depot mirror re-renders on it). */
const localPaletteListeners = new Set<() => void>()

/**
 * Watch our own tint. Our slot is not fixed for the session: the deal walks
 * collisions forward through the sorted id set, so a peer joining with a
 * lower-sorted id and the same preferred slot pushes us to the next one. The
 * mirror has to hear about that — showing yesterday's color is exactly the lie
 * it exists to prevent.
 */
export function subscribeLocalPalette(fn: () => void): () => void {
  localPaletteListeners.add(fn)
  return () => {
    localPaletteListeners.delete(fn)
  }
}

/**
 * OUR OWN tint, the one the lot's deal reserved for us.
 *
 * We never render ourselves, so nothing needed this until the depot mirror:
 * a mirror that showed a different color than the one your teammates see would
 * be worse than no mirror, because the whole point of the vest color is that
 * "I'm the amber one" is a thing you can say out loud. So the mirror asks the
 * same deal every avatar in the lot was painted from (assignPalette already
 * includes the local id precisely to reserve the slot).
 *
 * Before any roster arrives — solo play, or the first frames of a session — it
 * falls back to the hash of our id, which is the slot the deal would prefer
 * anyway, and to the first tint when we have no id at all.
 */
export function localPaletteIndex(): number {
  const mine = localUserId()
  if (!mine) return 0
  return lastDeal.get(mine) ?? paletteIndexFor(mine)
}

/**
 * Mounts one <RemoteAvatar> per live in-game remote. Re-renders only when
 * the roster version bumps (join/leave); per-frame work is the version
 * poll + the change-gated HUD chip drive ("2 players: Alice, Bob").
 * `spectator` (spectator.tsx mounts it so) switches every avatar's tag to the
 * far-LOD path; the game mounts it bare.
 */
export function RemotePlayers({ spectator = false }: { spectator?: boolean } = {}) {
  const versionSeen = useRef(-1)
  const chipCount = useRef(-1)
  const chipNames = useRef<readonly string[]>([])
  const chipFrame = useRef(0)
  const [roster, setRoster] = useState<RemotePlayer[]>([])
  const [colors, setColors] = useState<Map<string, number>>(() => new Map())

  useFrame(() => {
    const version = getRosterVersion()
    // Between edges, a nick can still resolve late (it rides the peer's pose
    // frame): every ~2 s the names are re-read and the chip re-driven if they
    // moved. A same-text drive is a no-op in the HUD, so this is an array per
    // two seconds, never per frame.
    if (version === versionSeen.current && roster.length > 0 && ++chipFrame.current % CHIP_NAME_POLL_FRAMES === 0) {
      const fresh = rosterNames(roster)
      if (!sameNames(fresh, chipNames.current)) {
        chipNames.current = fresh
        driveChip(roster.length, fresh)
      }
    }
    if (version !== versionSeen.current) {
      versionSeen.current = version
      const list: RemotePlayer[] = []
      for (const remote of getRemotes().values()) {
        if (remote.ph === 'game') list.push(remote)
      }
      setRoster(list)
      // Colors are re-dealt on the roster edge only. OUR OWN id goes into the
      // deal even though we never render ourselves: it reserves our tint, so
      // nobody else in the lot wears it and "I'm the amber one" holds.
      const ids = list.map((remote) => remote.userId)
      const mine = localUserId()
      if (mine) ids.push(mine)
      const deal = assignPalette(ids)
      // Published for localPaletteIndex (the depot mirror wears our own tint),
      // and anyone watching hears it only when OUR slot actually moved.
      const wasMine = mine ? lastDeal.get(mine) : undefined
      lastDeal = deal
      if (mine && deal.get(mine) !== wasMine) {
        for (const listener of localPaletteListeners) listener()
      }
      setColors(deal)
      // Chip rides the same edge (roster changes are the only count moves),
      // WITH the names — the label rule the spectator pill and the toasts use;
      // feature-detected like every cross-module hud call.
      const names = rosterNames(list)
      if (list.length !== chipCount.current || !sameNames(names, chipNames.current)) {
        chipCount.current = list.length
        chipNames.current = names
        driveChip(list.length, names)
      }
    }
  })

  useEffect(
    () => () => {
      // Session over (or remount): blank the chip; a live session's next
      // roster poll re-drives it.
      driveChip(0)
    },
    [],
  )

  return (
    <>
      {roster.map((remote) => (
        <RemoteAvatar
          key={remote.sessionId}
          paletteIndex={colors.get(remote.userId) ?? paletteIndexFor(remote.userId)}
          remote={remote}
          spectator={spectator}
        />
      ))}
    </>
  )
}
