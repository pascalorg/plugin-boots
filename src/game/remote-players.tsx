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
  SphereGeometry,
  TorusGeometry,
} from 'three'
import { type RemoteShotKind, sfx } from './audio'
import { EYE_HEIGHT } from './collision'
import { localUserId } from './net'
import { SprayerModel } from './paint'
import {
  DEFAULT_DIMS,
  GRIP_IN_HAND,
  instantiatePascaline,
  type PascalineDims,
  type PascalineTemplate,
  usePascalineTemplate,
} from './pascaline-model'
import {
  createSampledPose,
  INTERP_DELAY_MS,
  sampleAt,
  type SampledPose,
  shotsFired,
} from './presence-interp'
import {
  getRemotes,
  getRosterVersion,
  participantName,
  type RemotePlayer,
} from './presence'
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
 * Zero per-frame allocations: one module-level SampledPose + quaternions
 * are reused across every avatar; geometries/materials are module caches.
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

/** Gait phase advance per second at full speed (rad/s of the swing sine). */
export const GAIT_RATE = 7
/** Peak leg swing (rad) at full normalized speed. */
export const LEG_SWING_MAX = 0.55
/** Peak knee flexion (rad) mid-swing at full speed — the lifted knee of a run. */
export const KNEE_LIFT_MAX = 1.0
/** Counter-swing of the free arm, fraction of the leg swing. */
export const ARM_SWING_RATIO = 0.7
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
export const BREATH_AMP = 0.015
export const BREATH_RATE = 1.3
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

/**
 * Two-bone IK for one arm: the shoulder swing, yaw and elbow flexion that put
 * the grip at `target` (relative to that shoulder, three axes: x right, y up,
 * −z forward). Unreachable targets get a straight arm pointed at them. The
 * elbow always bends the human way: forward/up, never back.
 */
export function solveArm(target: readonly [number, number, number], arms: ArmDims = MODEL_ARMS): ArmSolution {
  const a = arms.upperArmLen
  const c = arms.reach
  const [vx, vy, vz] = target
  const h = Math.hypot(vx, vz)
  const yaw = h > 1e-6 ? Math.atan2(-vx, -vz) : 0
  const t = Math.atan2(h, -vy) // from straight down toward the target
  const D = Math.min(Math.hypot(h, vy), a + c - 1e-4)
  const cosElbowOuter = clamp((a * a + c * c - D * D) / (2 * a * c), -1, 1)
  const elbow = Math.PI - Math.acos(cosElbowOuter)
  const alpha = Math.acos(clamp((a * a + D * D - c * c) / (2 * a * D), -1, 1))
  const swing = t - alpha
  const du = limbDir(swing, yaw)
  const df = limbDir(swing + elbow, yaw)
  const hand: [number, number, number] = [
    a * du[0] + c * df[0],
    a * du[1] + c * df[1],
    a * du[2] + c * df[2],
  ]
  return { swing, yaw, elbow, hand }
}

/** A grip's hand point (inward, up, forward at zero pitch) as a right-shoulder-
 * relative three vector, the whole hold pivoted about the shoulder by `pitch`. */
function rightHandTarget(hand: readonly [number, number, number], pitch: number): [number, number, number] {
  const [inward, up, fwd] = hand
  const c = Math.cos(pitch)
  const s = Math.sin(pitch)
  return [-inward, fwd * s + up * c, -(fwd * c - up * s)]
}

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
  /** rotation.x of the torso pivot (slump, run lean, breathing). */
  torsoPitch: number
  /** rotation.x of the head pivot (tracks the remote view pitch). */
  headPitch: number
  /** Root bob (m) riding the stride. */
  bobY: number
}

export function createArticulation(): AvatarArticulation {
  return {
    legSwing: 0,
    kneeL: 0,
    kneeR: 0,
    armSwing: 0,
    armLYaw: 0,
    elbowL: FREE_ELBOW,
    armAim: 0,
    armRYaw: 0,
    elbowR: FREE_ELBOW,
    weaponTilt: 0,
    torsoPitch: 0,
    headPitch: 0,
    bobY: 0,
  }
}

/** Advance the walk-cycle phase: stride cadence scales with normalized
 * speed (a stopped or airborne player's legs settle, never treadmill). */
export function advanceGait(phase: number, s: number, dt: number): number {
  return phase + dt * GAIT_RATE * (s < 0 ? 0 : s)
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
): AvatarArticulation {
  const clampedPitch = clamp(pitch, -PITCH_CLAMP, PITCH_CLAMP)

  // Legs.
  if (grounded) {
    const swing = Math.sin(phase) * LEG_SWING_MAX * s
    out.legSwing = staggered ? swing * 0.5 : swing
    const lift = KNEE_LIFT_MAX * s
    const soft = staggered ? SLUMP_KNEE : 0
    out.kneeL = Math.max(0, Math.cos(phase)) * lift + soft
    out.kneeR = Math.max(0, -Math.cos(phase)) * lift + soft
    out.bobY = Math.abs(Math.cos(phase)) * 0.04 * s
  } else {
    out.legSwing = AIR_LEG_SPLIT
    out.kneeL = AIR_KNEE
    out.kneeR = AIR_KNEE
    out.bobY = 0
  }
  // What an arm does when it has nothing to hold.
  const freeSwing = grounded ? -Math.sin(phase) * LEG_SWING_MAX * ARM_SWING_RATIO * s : AIR_ARM_SWING

  // Torso and head.
  if (staggered) {
    out.torsoPitch = SLUMP_TORSO
    out.headPitch = -0.35
    out.armAim = SLUMP_ARM_AIM
    out.armRYaw = 0
    out.elbowR = 0.6
    out.weaponTilt = 0
    out.armSwing = freeSwing * 0.5
    out.armLYaw = 0
    out.elbowL = FREE_ELBOW
    return out
  }
  out.torsoPitch = RUN_LEAN * (grounded ? s : 0) + BREATH_AMP * Math.sin(t * BREATH_RATE)
  out.headPitch = clamp(clampedPitch, -HEAD_PITCH_MAX, HEAD_PITCH_MAX)

  // Arms, by grip — solved from where the hands have to be.
  if (grip === 'none') {
    out.armAim = -freeSwing
    out.armRYaw = 0
    out.elbowR = FREE_ELBOW
    out.weaponTilt = 0
    out.armSwing = freeSwing
    out.armLYaw = 0
    out.elbowL = FREE_ELBOW
    return out
  }
  const g = GRIPS[grip]
  const right = solveArm(rightHandTarget(g.hand, clampedPitch), arms)
  out.armAim = right.swing
  out.armRYaw = right.yaw
  out.elbowR = right.elbow
  // The barrel points where the peer looks, whatever the forearm does.
  const barrel = g.barrelFromDown + clampedPitch
  out.weaponTilt = barrel - (right.swing + right.elbow)
  if (g.foregrip > 0) {
    // The left hand takes the foregrip: that far from the right hand along the
    // barrel (which carries the right arm's yaw), a touch to the left of it.
    const bd = limbDir(barrel, right.yaw)
    const [hx, hy, hz] = right.hand
    const leftTarget: [number, number, number] = [
      hx + 2 * arms.shoulderX + g.foregrip * bd[0] - 0.03,
      hy + g.foregrip * bd[1],
      hz + g.foregrip * bd[2],
    ]
    const left = solveArm(leftTarget, arms)
    out.armSwing = left.swing
    out.armLYaw = left.yaw
    out.elbowL = left.elbow
  } else {
    out.armSwing = freeSwing
    out.armLYaw = 0
    out.elbowL = FREE_ELBOW
  }
  return out
}

/**
 * Write a pose onto a body's handles — the one place the sign conventions
 * live: the right leg mirrors the left, knees bend backward (−x), elbows bend
 * forward (+x), arm yaws are written as given. Handles a body does not have
 * (the box rig's elbows and knees) are simply absent.
 */
export function applyArticulation(refs: AvatarRigRefs, a: AvatarArticulation): void {
  const setX = (r: { current: Group | null } | undefined, x: number) => {
    if (r?.current) r.current.rotation.x = x
  }
  setX(refs.legL, a.legSwing)
  setX(refs.legR, -a.legSwing)
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
  setX(refs.torso, a.torsoPitch)
  setX(refs.head, a.headPitch)
}

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
const SKIN_MATERIAL = new MeshStandardMaterial({ color: '#e8b48f', roughness: 0.65 })
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

function makeNameTexture(name: string, tint: string): CanvasTexture | null {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 64
  const g = canvas.getContext('2d')
  if (!g) return null
  g.fillStyle = 'rgba(12,14,16,0.72)'
  g.beginPath()
  g.roundRect(4, 8, 248, 48, 12)
  g.fill()
  // The vest color, again, around the name: the tag is where a player LEARNS
  // which color is which, so it has to carry both halves of the pairing.
  g.strokeStyle = tint
  g.lineWidth = 4
  g.stroke()
  g.fillStyle = 'rgba(255,255,255,0.92)'
  g.font = 'bold 28px system-ui, sans-serif'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(name.slice(0, 16), 128, 33)
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
 * pinned-typings casts elsewhere: an older Hud without the chip is a no-op). */
type PresenceHud = { presenceChip?: (count: number) => void }

function driveChip(count: number): void {
  const hud = getSession()?.hud as unknown as PresenceHud | undefined
  hud?.presenceChip?.(count)
}

// ── Reused frame temps (zero per-frame allocations) ──────────────────────────

const _pose: SampledPose = createSampledPose()
const _artic: AvatarArticulation = createArticulation()
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
  fx?: { current: Group | null }
  flash?: { current: Group | null }
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
          <mesh geometry={HAND_GEO} material={SKIN_MATERIAL} position={[0, -0.5, 0]} />
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
          <mesh geometry={HAND_GEO} material={SKIN_MATERIAL} position={[0, -0.5, 0]} />
          <HeldWeapon refs={refs} weapon={weapon} />
        </group>
      </group>
    </>
  )
}

/**
 * The held weapon, in THE ARM FRAME: hanging −y from the shoulder, barrel down
 * the arm (weapon-models contract: grip at the origin, barrel down −Z), muzzle
 * fx parented to the gun. One definition for both bodies — the box rig mounts
 * it straight under its arm pivot, the model under its arm frame (see
 * pascaline-model.ts), and the two agree on where a rifle is in space.
 * `reach` is shoulder → grip: the box rig's 0.52, the model's arm plus a hand.
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
  if (!Weapon) return null
  return (
    <group position={[0, -reach, 0.02]} ref={refs.weapon} rotation={[-Math.PI / 2, 0, 0]}>
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

function RemoteAvatar({ paletteIndex, remote }: { paletteIndex: number; remote: RemotePlayer }) {
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
  const tagRef = useRef<Group>(null)
  const tagMatRef = useRef<MeshBasicMaterial>(null)
  const speakRef = useRef<Mesh>(null)
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
    fx: fxRef,
    flash: flashRef,
  }).current
  const flashT = useRef(0)
  const lastShots = useRef(-1)
  // Change-gated React state: weapon swaps and late-resolving names are
  // EVENTS (a handful per session), so a state write from useFrame is fine.
  const [weapon, setWeapon] = useState(remote.w)
  const [name, setName] = useState(() => participantName(remote.userId))

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
    if (!sampleAt(remote.ring, now - offset - INTERP_DELAY_MS, _pose)) return

    // Capped dt like every game loop here (a hitch never teleports a limb).
    const dt = Math.min(rawDt, 1 / 30)

    // ONE distance, spent three ways: the gunfire mix, the tag fade, the LOD.
    const camera = rootState.camera
    const dx = camera.position.x - _pose.x
    const dy = camera.position.y - _pose.y
    const dz = camera.position.z - _pose.z
    const distSq = dx * dx + dy * dy + dz * dz

    gaitPhase.current = advanceGait(gaitPhase.current, _pose.g ? _pose.s : 0, dt)
    // The peer's own clock drives their breathing, so a lobby does not breathe
    // in unison; the wire weapon decides the hold.
    articulate(
      _artic,
      gaitPhase.current,
      _pose.s,
      _pose.pitch,
      _pose.g,
      _pose.st,
      gripFor(_pose.w),
      (now - remote.joinedAt) / 1000,
    )

    // Wire positions are EYE positions — plant the feet.
    root.position.set(_pose.x, _pose.y - EYE_HEIGHT + _artic.bobY, _pose.z)
    root.rotation.y = _pose.yaw
    const scale = spawnScale(now - remote.joinedAt)
    if (scale !== lastScale.current) {
      lastScale.current = scale
      root.scale.setScalar(scale)
    }
    applyArticulation(rigRefs, _artic)

    // Weapon swap — change-gated, so per-frame calls are free while held.
    if (_pose.w !== weapon) setWeapon(_pose.w)

    // Gunfire: every round this peer has fired since the last sample becomes a
    // flash at their muzzle and a report voiced at their distance and bearing.
    // The fx group only exists while they hold a gun, so `fx` IS the melee and
    // spray-can guard — a knife swing can never bloom a muzzle flash.
    const shots = shotsFired(lastShots.current, _pose.f)
    lastShots.current = _pose.f
    const fx = fxRef.current
    if (fx) {
      if (shots > 0) {
        const dist = Math.sqrt(distSq)
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
        // Bearing: how far along the camera's own right axis (column 0 of its
        // world matrix) the shooter sits, normalized to ±1 — so a shot from
        // behind your left shoulder arrives in the left ear.
        const e = camera.matrixWorld.elements
        const pan = dist > 0.001 ? (-dx * e[0]! - dy * e[1]! - dz * e[2]!) / dist : 0
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

    // Name tag: distance fade + billboard (parent-compensated camera copy).
    const tag = tagRef.current
    if (tag) {
      const opacity = tagOpacity(distSq)
      const visible = opacity > 0
      if (tag.visible !== visible) tag.visible = visible
      if (visible) {
        // Change-gated (per-avatar JSX-owned material — never shared).
        const material = tagMatRef.current
        if (material && Math.abs(material.opacity - opacity) > 0.01) {
          material.opacity = opacity
        }
        root.getWorldQuaternion(_worldQuat).invert()
        tag.quaternion.copy(_worldQuat.multiply(camera.quaternion))
        // Speaking dot: one map lookup (isPeerTalking, not talkingPeers() —
        // that one allocates an array per call, and a dozen avatars asking it
        // every frame is hundreds of throwaway arrays a second for one boolean
        // each). `now` is passed explicitly so a peer whose last voice frame
        // stopped arriving goes quiet on WALL time; the voice module's own clock
        // only advances while its tick is running.
        const speak = speakRef.current
        if (speak) {
          const talking = isPeerTalking(remote.sessionId, now)
          if (speak.visible !== talking) speak.visible = talking
        }
      }
    }

    // Late-resolving roster names: re-check ~every 2 s until it lands.
    if (++frame.current % 120 === 0 && name === 'builder') {
      const fresh = participantName(remote.userId)
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
      {/* Name-tag billboard — hidden past 40 m, texture disposed on despawn. */}
      <group ref={tagRef} position={[0, 2.05, 0]}>
        {tagTexture ? (
          <mesh>
            <planeGeometry args={[0.72, 0.18]} />
            <meshBasicMaterial ref={tagMatRef} map={tagTexture} transparent depthWrite={false} />
          </mesh>
        ) : null}
        {/* Speaking dot — above the name, hidden until this peer transmits.
            Mounted always (not conditionally rendered) so turning it on is a
            boolean on an existing object rather than a mid-firefight remount. */}
        <mesh
          geometry={SPEAK_GEO}
          material={SPEAK_MATERIAL}
          position={[0, 0.16, 0]}
          ref={speakRef}
          visible={false}
        />
      </group>
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
 * poll + the change-gated HUD chip drive ("N builders here").
 */
export function RemotePlayers() {
  const versionSeen = useRef(-1)
  const chipCount = useRef(-1)
  const [roster, setRoster] = useState<RemotePlayer[]>([])
  const [colors, setColors] = useState<Map<string, number>>(() => new Map())

  useFrame(() => {
    const version = getRosterVersion()
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
      // Chip rides the same edge (roster changes are the only count moves);
      // feature-detected like every cross-module hud call.
      if (list.length !== chipCount.current) {
        chipCount.current = list.length
        driveChip(list.length)
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
        />
      ))}
    </>
  )
}
