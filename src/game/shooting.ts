import { Color, Matrix4, Ray, Vector3 } from 'three'
import { sfx } from './audio'
import { spawnDebris } from './debris'
import * as destruct from './destruction'
import {
  damageStud,
  damageTarget,
  raycastStuds,
  raycastVoxelTargets,
  useDestruction,
} from './destruction'
import { spawnDust } from './dust'
import { bots, damageBot, raycastBots } from './enemies-state'
import { hitGlass, raycastGlass } from './glass'
import { playerRig } from './player'
import type { WeaponDef } from './weapons'
import type { GameWorld } from './world'

/**
 * Hitscan resolution across every target class, phase-3 edition:
 * solid host meshes (BVH), voxelized skins (grid DDA), framing SEGMENTS
 * (charcoal-stick studs), trees, glass panes, bots. Nearest hit wins; on a
 * near-tie (within 1 cm) the higher class wins:
 *
 *   bot > glass > tree > segment > voxel skin > solid collider
 *
 * First bullet into a pristine destructible node converts it to voxels and
 * carves in the same shot — walls get the skins + framing anatomy
 * automatically. Kind-'wall' targets carve at weapon.tearRadius (drywall
 * tears MASSIVE holes fast); everything else carves at weapon.holeRadius.
 * SMASH weapons (weapon.smashRadius — the warhammer) override both lanes
 * (`smashRadius ?? tearRadius ?? holeRadius` / `smashRadius ?? holeRadius`),
 * add 4-6 ragged rim nibbles per crater, and shove every bot within
 * 1.5×range of the impact point (see smashKnockback).
 *
 * ── Sound ownership (no double-voicing) ───────────────────────────────
 *   voxel skins   drywallCrunch here (carve); plain volumes self-voice in
 *                 damageTarget.
 *   segments      damageSegment / damageStud voice chip + snap — silent
 *                 here (tiny voxelCrunch only when the hit went stale).
 *   trees/glass/bots  their modules voice themselves.
 *
 * ── Dust (single-emission policy) ──────────────────────────────────────
 *   destruction.ts owns ALL dust/debris emission for wall damage — carve,
 *   sheet fly-off, crumble. This file MUST NOT also emit for wall carves.
 *   Non-wall hits emit only a small kind-'chip' spawnDust (surface normal
 *   when the hit exposes one, shot direction as the fallback) or nothing:
 *   bots and non-destructible solids are sparks-only. Heavy NON-WALL
 *   carves (removed > 6) add one kind-'puff' pushed along the shot so
 *   carve-through reads inside the hole.
 *
 * ── Phase-3 destruction contract (feature-detected) ────────────────────
 * destruction.ts is being extended by a parallel agent. This file routes
 * through the new surface the moment it exists and falls back to the
 * legacy stud lane meanwhile. Expected exports (build against these — a
 * mismatch fails tsc AT THE CAST BELOW on purpose, loudly):
 *   raycastSegments(origin, direction, maxDist)
 *       → { nodeId, segmentId, distance, point } | null
 *   damageSegment(world, nodeId, segmentId, damage, point) → boolean
 *   damageTarget(world, nodeId, point, radius, direction?) — direction is
 *       the new optional carve-through param; legacy 4-arg calls still work.
 *
 * ── Tree routes (registry) ─────────────────────────────────────────────
 * trees-destruct owns tree combat; it registers here at module init:
 *   registerTreeRoutes({
 *     raycast: treesRaycast,   // (origin, direction, maxDist) → hit | null
 *     damage: (world, hit, damage, radius, direction) =>
 *       treesDamage(world, hit, damage, radius, direction),
 *   })
 * Hits only need { distance, point }; the damage callback receives the
 * exact object its paired raycast returned, so extra fields flow through.
 * Until registration, trees resolve as plain solid colliders (sparks).
 */

export type FireOutcome = 'bot' | 'wall' | 'glass' | 'tree' | 'solid' | 'none'

type HitClass = 'none' | 'solid' | 'voxel' | 'segment' | 'tree' | 'glass' | 'bot'

/** Near-tie window: hits this close resolve by class priority, not range. */
const TIE = 0.01

/** Node types that route through the voxel destruction manager. Anything
 * else (terrain, fixtures we can't voxelize…) just sparks. */
const DESTRUCTIBLE = new Set([
  'wall',
  'door',
  // Window FRAMES (world.ts routes a window's glass meshes to world.glass,
  // never into colliders, so this only voxelizes the solid surround —
  // hammer/rifle on a window band reads as breakable, not sparks-only).
  'window',
  'slab',
  'floor',
  'ceiling',
  'roof',
  'roof-segment',
  'item',
  'shelf',
  'cabinet',
  'cabinet-module',
  'block',
  'column',
  'stair',
  'stair-segment',
  'counter',
  'kitchen-unit',
])

// --- Phase-3 destruction façade (see contract in the doc block) ---------

type SegmentRayHit = {
  nodeId: string
  /** Phase-3 field name; the legacy stud lane fills studId instead. */
  segmentId?: number
  studId?: number
  distance: number
  point: Vector3
}

type Phase3Destruction = {
  raycastSegments?: (origin: Vector3, direction: Vector3, maxDist: number) => SegmentRayHit | null
  damageSegment?: (
    world: GameWorld,
    nodeId: string,
    segmentId: number,
    damage: number,
    point: Vector3,
  ) => boolean
}

/** Guarded view of the parallel agent's new exports — every use checks
 * existence, so this file is green before AND after they land. */
const d3: Phase3Destruction = destruct as Phase3Destruction

/** damageTarget with the phase-3 carve-through direction; calling the
 * legacy 4-arg implementation with a 5th arg is harmless until it lands. */
const carveTarget = damageTarget as (
  world: GameWorld,
  nodeId: string,
  point: Vector3,
  radius: number,
  direction?: Vector3,
) => number

// --- Tree combat routes (registered by trees-destruct at module init) ---

export type TreeRayHit = { distance: number; point: Vector3 }

export type TreeCombatRoutes<H extends TreeRayHit = TreeRayHit> = {
  /** Nearest live tree part along the ray, culled at maxDist. */
  raycast: (origin: Vector3, direction: Vector3, maxDist: number) => H | null
  /** hit is the exact object this route's raycast returned. direction is
   * the normalized shot direction (felling / carve-through). */
  damage: (world: GameWorld, hit: H, damage: number, radius: number, direction: Vector3) => void
}

let treeRoutes: TreeCombatRoutes | null = null

/** Wire (or clear, with null) tree combat. The generic ties the damage
 * callback to its own raycast's hit type, so richer hit shapes need no
 * casts on the caller side. */
export function registerTreeRoutes<H extends TreeRayHit>(routes: TreeCombatRoutes<H> | null): void {
  treeRoutes = routes as TreeCombatRoutes | null
}

// -------------------------------------------------------------------------

const _origin = new Vector3()
const _direction = new Vector3()
const _ray = new Ray()
const _inverse = new Matrix4()
const _point = new Vector3()
const SPARK = new Color('#c9c2b4')

export function aimDirection(target: Vector3, spread: number): Vector3 {
  target.set(0, 0, -1)
  // yaw/pitch → forward (YXZ order, same as the camera).
  const cp = Math.cos(playerRig.pitch)
  target.set(
    -Math.sin(playerRig.yaw) * cp,
    Math.sin(playerRig.pitch),
    -Math.cos(playerRig.yaw) * cp,
  )
  if (spread > 0) {
    // Movement widens the cone — reward planted feet. Aiming down sights
    // (playerRig.ads 0..1, written by viewmodel) tightens it: full ADS cuts
    // spread to 25% — the accuracy payoff for the zoom.
    const ads = playerRig.ads < 0 ? 0 : playerRig.ads > 1 ? 1 : playerRig.ads
    const total =
      spread * (1 + playerRig.speed * 0.25) * (playerRig.grounded ? 1 : 1.8) * (1 - 0.75 * ads)
    target.x += (Math.random() - 0.5) * 2 * total
    target.y += (Math.random() - 0.5) * 2 * total
    target.z += (Math.random() - 0.5) * 2 * total
    target.normalize()
  }
  return target
}

// --- Dust façade (dust.tsx is owned by a parallel agent) -----------------

/** Frozen phase-3 dust contract: position-first with an opts bag. The cast
 * bridges the rewrite window (dust.tsx still ships the legacy scalar
 * signature in some checkouts); existence stays guarded at every call. */
type DustOpts = {
  normal?: Vector3
  direction?: Vector3
  /** Shape kinds plus the phase-4 material tags (dust.tsx resolves the
   * materials to shape + styling; 'wood' deliberately emits nothing). */
  kind?: 'chip' | 'puff' | 'plume' | 'drywall' | 'concrete' | 'wood'
}
const dust = spawnDust as unknown as (
  position: Vector3,
  intensity: number,
  opts?: DustOpts,
) => void

/** Small impact chip — the ONLY dust a non-wall hit emits. Opts vectors
 * are cloned so the emitter may retain them past this shot's scratch
 * reuse; position is read synchronously at spawn (contract). */
function chip(point: Vector3, intensity: number, normal?: Vector3): void {
  if (typeof spawnDust !== 'function') return
  dust(
    point,
    intensity,
    normal ? { kind: 'chip', normal: normal.clone() } : { kind: 'chip', direction: _direction.clone() },
  )
}

const _puffPoint = new Vector3()

/** One extra puff for heavy NON-WALL carves, pushed along the shot so the
 * dissolve reads INSIDE the hole. Never for walls — destruction.ts owns
 * every gram of drywall dust (contract 4). */
function heavyPuff(point: Vector3, direction: Vector3, removed: number): void {
  if (removed <= 6) return
  if (typeof spawnDust !== 'function') return
  _puffPoint.copy(point).addScaledVector(direction, 0.25)
  dust(_puffPoint, Math.min(1, 0.5 + removed / 30), { kind: 'puff', direction: direction.clone() })
}

/** Kind-'wall' predictor that works BEFORE first-blood voxelization too:
 * ensureVoxelTarget assigns kind 'wall' exactly when world.walls has the
 * node, so radius choice and emission policy agree with destruction.ts. */
function isWallTarget(world: GameWorld, nodeId: string): boolean {
  return useDestruction.getState().targets.get(nodeId)?.kind === 'wall' || world.walls.has(nodeId)
}

/** SMASH nibble scratch (warhammer ragged rim) — module temps, no per-swing
 * allocations. */
const _nibbleDir = new Vector3()
const _nibblePoint = new Vector3()

/** Carve into a destructible node. Walls tear at weapon.tearRadius (falls
 * back to holeRadius) and get the papery crunch on top — but emit NO dust
 * here; destruction.ts owns all wall emission. Non-wall volumes carve at
 * holeRadius with a small chip (+ carve-through puff when heavy). Returns
 * voxels removed.
 *
 * SMASH weapons (warhammer — weapon.smashRadius set) use the canonical
 * resolution from weapons.ts: `smashRadius ?? tearRadius ?? holeRadius` for
 * walls, `smashRadius ?? holeRadius` for everything else — and the crater
 * gets 4–6 extra small carve spheres at random points on its rim, so the
 * blow reads as a ragged crushed edge (≈ 36+ voxels), never a clean ball. */
function carve(
  world: GameWorld,
  nodeId: string,
  point: Vector3,
  weapon: WeaponDef,
  direction: Vector3,
): number {
  const wall = isWallTarget(world, nodeId)
  const radius = wall
    ? (weapon.smashRadius ?? weapon.tearRadius ?? weapon.holeRadius)
    : (weapon.smashRadius ?? weapon.holeRadius)
  let removed = carveTarget(world, nodeId, point, radius, direction)
  if (removed === 0) return 0
  if (weapon.smashRadius !== undefined) {
    // Ragged edge: nibble the crater rim with 4-6 small off-center spheres.
    const nibbles = 4 + Math.floor(Math.random() * 3)
    for (let i = 0; i < nibbles; i++) {
      _nibbleDir
        .set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
        .normalize()
      _nibblePoint.copy(point).addScaledVector(_nibbleDir, radius * (0.85 + Math.random() * 0.3))
      removed += carveTarget(world, nodeId, _nibblePoint, 0.12 + Math.random() * 0.09, direction)
    }
  }
  if (wall) {
    sfx.drywallCrunch(Math.min(1, removed / 10))
  } else {
    chip(point, Math.min(0.5, 0.2 + removed / 60))
    heavyPuff(point, direction, removed)
  }
  return removed
}

const _smashCenter = new Vector3()
const _smashPush = new Vector3()

/** Warhammer follow-through: every bot near the impact gets shoved hard
 * away from it — positions moved directly (2.4 m at the center tapering to
 * ~0.6 m at the edge); the pathing capsule pass resolves any wall they land
 * against next frame. Drones keep their altitude — the blow reads on XZ. */
function smashKnockback(center: Vector3, range: number): void {
  for (const bot of bots) {
    if (bot.state !== 'alive') continue
    const d = bot.position.distanceTo(center)
    if (d > range) continue
    _smashPush.subVectors(bot.position, center)
    _smashPush.y = 0
    if (_smashPush.lengthSq() < 1e-6) _smashPush.set(-_direction.x, 0, -_direction.z)
    if (_smashPush.lengthSq() < 1e-6) _smashPush.set(1, 0, 0)
    _smashPush.normalize()
    bot.position.addScaledVector(_smashPush, 0.6 + 1.8 * (1 - d / range))
  }
}

export function fire(world: GameWorld, weapon: WeaponDef): FireOutcome {
  _origin.copy(playerRig.position)
  aimDirection(_direction, weapon.spread)

  // Candidates are cast in ascending class priority, each culled at the
  // current winner's distance + TIE. Any hit a later cast returns is either
  // strictly nearer or a near-tie — and near-ties go to the higher class —
  // so "last accepted wins" resolves both rules at once.
  let bestDist = weapon.range
  let winner: HitClass = 'none'
  let solidNodeId: string | null = null
  let solidNodeType: string | null = null
  _point.set(0, 0, 0)

  // Solid host meshes (lowest priority).
  for (const collider of world.colliders) {
    if (collider.disabled) continue
    _inverse.copy(collider.inverse)
    _ray.origin.copy(_origin).applyMatrix4(_inverse)
    _ray.direction.copy(_direction).transformDirection(_inverse)
    const hit = collider.bvh.raycastFirst(_ray, 2)
    if (!hit) continue
    const world_ = hit.point.applyMatrix4(collider.mesh.matrixWorld)
    const distance = world_.distanceTo(_origin)
    if (distance < bestDist) {
      bestDist = distance
      winner = 'solid'
      solidNodeId = collider.nodeId
      solidNodeType = collider.nodeType
      _point.copy(world_)
    }
  }

  // Already-voxelized skins (walls, doors, slabs, items…).
  const voxelHit = raycastVoxelTargets(_origin, _direction, bestDist + TIE)
  if (voxelHit) {
    bestDist = voxelHit.distance
    winner = 'voxel'
    _point.copy(voxelHit.point)
  }

  // Framing segments in opened cavities (falls back to the legacy whole-stud
  // lane until the segment API lands).
  const segmentHit: SegmentRayHit | null =
    d3.raycastSegments && d3.damageSegment
      ? d3.raycastSegments(_origin, _direction, bestDist + TIE)
      : raycastStuds(_origin, _direction, bestDist + TIE)
  if (segmentHit) {
    bestDist = segmentHit.distance
    winner = 'segment'
  }

  // Trees (once trees-destruct has registered its routes).
  const treeHit = treeRoutes ? treeRoutes.raycast(_origin, _direction, bestDist + TIE) : null
  if (treeHit) {
    bestDist = treeHit.distance
    winner = 'tree'
  }

  // Glass.
  const glassHit = raycastGlass(world, _origin, _direction, bestDist + TIE)
  if (glassHit) {
    bestDist = glassHit.distance
    winner = 'glass'
  }

  // Bots.
  const botHit = raycastBots(_origin, _direction, bestDist + TIE)
  if (botHit) winner = 'bot'

  // SMASH weapons (warhammer): heavy area knockback around the impact —
  // whatever class the blow landed on (a whiff still shoves at max reach).
  // Runs BEFORE the class dispatch so a killed bot still flings its pack.
  if (weapon.smashRadius !== undefined) {
    const impactDist = winner === 'bot' && botHit ? botHit.distance : bestDist
    _smashCenter.copy(_origin).addScaledVector(_direction, impactDist)
    smashKnockback(_smashCenter, weapon.range * 1.5)
  }

  if (winner === 'bot' && botHit) {
    damageBot(botHit.bot, weapon.damage)
    // Metal chassis: sparks only, no dust.
    for (let i = 0; i < 2; i++) {
      spawnDebris(botHit.point.x, botHit.point.y, botHit.point.z, 0.03, SPARK, 1.6, 0.5)
    }
    return 'bot'
  }
  if (winner === 'glass' && glassHit) {
    hitGlass(glassHit)
    chip(glassHit.point, 0.2, glassHit.normal)
    return 'glass'
  }
  if (winner === 'tree' && treeHit && treeRoutes) {
    // Tree module owns its own voxel-burst/char sfx.
    treeRoutes.damage(world, treeHit, weapon.damage, weapon.holeRadius, _direction)
    chip(treeHit.point, 0.3)
    return 'tree'
  }
  if (winner === 'segment' && segmentHit) {
    // Knife whittles (1 hp per swing); guns hit at full damage. The damage
    // routine owns the chip/snap sfx — no extra sound here.
    const memberId = segmentHit.segmentId ?? segmentHit.studId ?? -1
    const dmg = weapon.melee ? 1 : weapon.damage
    const applied = d3.damageSegment
      ? d3.damageSegment(world, segmentHit.nodeId, memberId, dmg, segmentHit.point)
      : damageStud(world, segmentHit.nodeId, memberId, dmg, segmentHit.point)
    if (!applied) sfx.voxelCrunch(0.25)
    // Material contract (phase 4): framing is WOOD — no dust at all, the
    // splinters come from damageSegment's own debris (dust.tsx returns
    // early on kind 'wood'; skipping the call keeps that intent local).
    return 'wall'
  }
  if (winner === 'voxel' && voxelHit) {
    carve(world, voxelHit.nodeId, _point, weapon, _direction)
    return 'wall'
  }
  if (winner === 'solid' && solidNodeId) {
    if (solidNodeType && DESTRUCTIBLE.has(solidNodeType)) {
      // First blood: voxelize + carve in one go (walls keep their skins +
      // framing anatomy via the destruction manager).
      if (carve(world, solidNodeId, _point, weapon, _direction) > 0) return 'wall'
    }
    // Non-destructible surface (or one that refused to voxelize): sparks
    // and a thunk — no dust.
    for (let i = 0; i < 3; i++) {
      spawnDebris(_point.x, _point.y, _point.z, 0.035, SPARK, 1.4, 0.6)
    }
    if (weapon.melee) sfx.knifeHit()
    else sfx.voxelCrunch(0.25)
    return 'solid'
  }
  return 'none'
}
