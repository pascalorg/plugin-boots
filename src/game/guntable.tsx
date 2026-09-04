'use client'

import { useFrame } from '@react-three/fiber'
import { type ComponentType, useEffect, useMemo, useRef, useState } from 'react'
import {
  CanvasTexture,
  type Color,
  type Group,
  type InstancedMesh,
  Matrix4,
  type Mesh,
  Object3D,
  Vector3,
} from 'three'
import { useBoots } from '../store'
import { sfx, type VehicleEngineHandle } from './audio'
import {
  CYBER_TRUCK_MAX_STEER_ANGLE,
  CYBER_TRUCK_WHEELBASE,
  CyberTruckModel,
} from './cyber-truck'
import { DepotMirror } from './depot-mirror'
import { damageTarget, useDestruction } from './destruction'
import { bots, damageBot, waveState } from './enemies-state'
import { groundSurfaceY } from './ground'
import { isHordeAuthority, setSharedWaves } from './horde-sync'
import { takeAction } from './input'
import { clearScatterInRadius } from './nature'
import {
  getParticipants,
  localSessionId,
  onFrame,
  onStateRequest,
  onStateSnapshot,
  publishFrame,
  registerFrameKind,
  requestState,
  sendStateSnapshot,
  shouldAnswerStateRequest,
} from './net'
import { playerDebug, playerRig } from './player'
import { ramRemotePlayersAt } from './pvp-damage'
import { getSession } from './session'
import { ramTreesAt } from './trees-destruct'
import {
  clearConvoyPose,
  convoyLocalToWorld,
  convoyPose,
  convoyWorldToLocal,
  readVehicleFrame,
  resetConvoyPose,
  shortestYawDelta,
  wrapVehicleYaw,
  VEHICLE_KIND,
  vehicleRig,
  type VehicleFrame,
} from './vehicle-state'
import * as weaponModels from './weapon-models'
import { HammerModel, MinigunModel, PistolModel, RifleModel } from './weapon-models'
import {
  bvhFor,
  type ColliderEntry,
  type GameWorld,
  probeSpawnSurfaceY,
  spawnGroundY,
} from './world'

/**
 * THE ARMORED SPAWN DEPOT (owner vision): the spawn gear is a PERMANENT,
 * INDESTRUCTIBLE structure — a weathered steel cargo container with one
 * open long side facing spawn, "all guns lined up, stuff unlimited", the
 * industrial zombie switch part of it — so that in future multiplayer
 * OTHER players walk up to the same depot and collect their gear too.
 * It replaces the three loose tables + the switch-wall stub while keeping
 * their exact interaction contracts:
 *
 * - BUILD BENCH (left bay): DECORATION. The build hammer and the spray
 *   can are the SPAWN LOADOUT (store defaults — building is the default
 *   verb, hammer in hand at spawn), so the bench keeps its tiny display
 *   hammer and START BUILDING stencil but prompts nothing.
 * - ARMORY RACK (center bay): pistol, rifle, the big rotary gun and the
 *   warhammer lined up vertically on a wall rack, the work boots on a
 *   floor mat below, GEAR UP stencil above. One E gives the GUNS — the
 *   depot's ONE interaction besides the breaker.
 *   The displays are PERMANENT — unlimited stock, they never flip to
 *   "taken"; only the small sign flips to the YOU ARE COOKED taunt.
 * - BREAKER PANEL (right end wall, outside): the massive two-hand
 *   industrial knife-switch + twin roof sirens + PUT YOUR BOOTS ON
 *   stencil, hazard stripes below. E throws the handle DOWN — the ONLY
 *   thing that wakes the horde (enemies-state.armWaves → the alert
 *   countdown theatre → waves) — and E again throws it back UP
 *   (disarmWaves: units power down, grace restored). Working it requires
 *   standing OUTSIDE the container facing the panel (breakerEngageable);
 *   the handle mirrors waveState.armed every frame.
 *
 * INDESTRUCTIBLE, mechanically: every depot mesh registers as a collider
 * with nodeType 'fixture' — outside shooting.ts's DESTRUCTIBLE set and the
 * grenade EXPLODABLE sets, so bullets spark and blasts wash over it (the
 * QA P6R1 'fixture' lane), and the '__boots-depot' nodeId is covered by
 * destruction.ts's '__boots' prevoxelize guard. The shell still blocks
 * movement, bots and bullets like any prop.
 *
 * WebGPU-safe by construction: box/cylinder primitive assembly with
 * CanvasTexture stencil signage, corrugation via ONE instanced rib
 * geometry, no GLB loads, and the single siren pointLight stays
 * always-mounted (only intensity animates — never a conditional light).
 * One grab arbitration map spans all three stations, so one E press
 * serves exactly one fixture.
 */

/**
 * Models owned by the arsenal agent land in weapon-models.tsx this round.
 * Guarded lookups so this file is green before/after they land; each has a
 * primitive fallback so the tables read right either way.
 */
const externalModels = weaponModels as unknown as Partial<Record<string, ComponentType>>
const ExternalWarhammer = externalModels.WarhammerModel
const BootsPair: ComponentType = externalModels.BootsPairModel ?? FallbackBootsPair
const SirenModel: ComponentType = externalModels.SirenBeaconModel ?? FallbackSirenBeacon

export const GRAB_RANGE = 2.4

// ---------------------------------------------------------------------------
// THE ARMORED SPAWN DEPOT — layout math (owner vision: one PERMANENT,
// INDESTRUCTIBLE cargo container replaces the loose tables; "all guns lined
// up, stuff unlimited", the industrial zombie switch part of it, so future
// multiplayer players collect their gear at the same structure).
//
// The container sits SET BACK, BEHIND the spawn point (owner ask: "en
// retrait, derrière le personnage") — the view toward the building stays
// clear; turn around and the opening faces you, base-camp style. Its
// center is a [lateral, forward] offset in the SPAWN FRAME (lateral
// positive = the player's right), and the cluster is spun DEPOT_YAW about
// that center so the open side keeps facing spawn. Stations and the
// breaker are DEPOT-LOCAL [x, z] points (the rendered group's own frame:
// +x toward the breaker end wall, +z out the opening), mapped to world by
// depotLocalToWorld — one rigid transform moves the whole cluster.
//
//        breaker end (right of the OPENING)              far end
//   x  ┌──────────────────────────────────────────────┐  ← back wall
//   ▐▌ │   (breaker         ARMORY rack + boots mat      BUILD bench
//   on │    outside)
//      └────────────────═══════─────────────═══════────┘
//                     open side (faces spawn)
//                          · spawn  (player looks AWAY at entry)
//
// Grab-range contract: NOTHING prompts at spawn anymore — every station
// (and the breaker) is walked to on purpose. The build/armory discs still
// overlap on the approach, so nearest-untaken arbitration stays
// load-bearing: one E press serves exactly one fixture.
// ---------------------------------------------------------------------------

/** Container footprint: [length (local x), height, depth (local z)]. */
export const DEPOT_SIZE: [number, number, number] = [6, 2.6, 2.5]
/** Depot center in the spawn frame: [lateral, forward] — behind spawn. */
export const DEPOT_OFFSET: [number, number] = [0.5, -4.5]
/** Cluster yaw about the center: π turns the open side back toward spawn
 * now that the container sits behind it. */
export const DEPOT_YAW = Math.PI
/** BUILD station grab point, depot-local (left bay of the opening). */
export const BUILD_STATION_LOCAL: [number, number] = [-1.7, 1.1]
/** ARMORY grab point, depot-local (center bay of the opening). */
export const ARMORY_STATION_LOCAL: [number, number] = [0, 0.65]
/** Breaker grab point, depot-local — proud of the +x end wall (3.0). */
export const BREAKER_LOCAL: [number, number] = [3.05, 0]

/** Spawn-frame → world: lateral positive is the player's right. Matches the
 * legacy table math (x += fwdX·fwd − fwdZ·lat, z += fwdZ·fwd + fwdX·lat). */
function offsetFromSpawn(world: GameWorld, lateral: number, forward: number): Vector3 {
  const fwdX = -Math.sin(world.spawnYaw)
  const fwdZ = -Math.cos(world.spawnYaw)
  return new Vector3(
    world.spawn.x + fwdX * forward - fwdZ * lateral,
    0,
    world.spawn.z + fwdZ * forward + fwdX * lateral,
  )
}

/** The container's center on the ground plane. */
export function depotPosition(world: GameWorld): Vector3 {
  return offsetFromSpawn(world, DEPOT_OFFSET[0], DEPOT_OFFSET[1])
}

/** The cluster's world yaw — the rendered root group's rotation. */
export function depotWorldYaw(world: GameWorld): number {
  return world.spawnYaw + DEPOT_YAW
}

/** Depot-local [x, z] → world: exactly the rendered group's transform
 * (rotation about Y by depotWorldYaw, then the center translation), in
 * plain math so grab points and tests share one source of truth. */
export function depotLocalToWorld(world: GameWorld, lx: number, lz: number): Vector3 {
  const yaw = depotWorldYaw(world)
  const cos = Math.cos(yaw)
  const sin = Math.sin(yaw)
  const c = depotPosition(world)
  return new Vector3(c.x + lx * cos + lz * sin, 0, c.z - lx * sin + lz * cos)
}

/** World → depot-local [x, z] (inverse of depotLocalToWorld). */
export function worldToDepotLocal(world: GameWorld, px: number, pz: number): [number, number] {
  const yaw = depotWorldYaw(world)
  const cos = Math.cos(yaw)
  const sin = Math.sin(yaw)
  const c = depotPosition(world)
  const dx = px - c.x
  const dz = pz - c.z
  return [dx * cos - dz * sin, dx * sin + dz * cos]
}

/** Runtime transform for systems that must follow the movable trailer. The
 * exported static helpers above remain the deterministic initial-layout API. */
export function liveDepotLocalToWorld(
  world: GameWorld,
  lx: number,
  lz: number,
  out = new Vector3(),
): Vector3 {
  if (!convoyPose.ready) return out.copy(depotLocalToWorld(world, lx, lz))
  const p = convoyLocalToWorld(lx, lz)
  return out.set(p.x, convoyPose.y, p.z)
}

export function liveWorldToDepotLocal(world: GameWorld, px: number, pz: number): [number, number] {
  if (!convoyPose.ready) return worldToDepotLocal(world, px, pz)
  const p = convoyWorldToLocal(px, pz)
  return [p.x, p.z]
}

/** BUILD station (left bay): E gives the builder only — the peaceful entry. */
export function buildStationPosition(world: GameWorld): Vector3 {
  return depotLocalToWorld(world, BUILD_STATION_LOCAL[0], BUILD_STATION_LOCAL[1])
}

/** ARMORY rack (center bay): E gives the full loadout. */
export function armoryStationPosition(world: GameWorld): Vector3 {
  return depotLocalToWorld(world, ARMORY_STATION_LOCAL[0], ARMORY_STATION_LOCAL[1])
}

/**
 * The deck height for the container — the MAX of the footprint's four
 * corners and its center, not one probe at the middle.
 *
 * The depot is a rigid 6 × 2.5 m box. On sculpted ground a single center
 * probe seats it at the average height, which buries the uphill end (the
 * owner's lots drop metres across a yard); taking the highest corner keeps
 * every doorway clear and leaves the gap at the low end, hidden by the
 * skirt. Pure and exported so the sweep tests can seat it on a slope.
 */
export function depotSeatY(world: GameWorld): number {
  const hx = DEPOT_SIZE[0] / 2
  const hz = DEPOT_SIZE[2] / 2
  const colliders = world.colliders ?? []
  let best = Number.NEGATIVE_INFINITY
  for (const [lx, lz] of DEPOT_SEAT_SAMPLES) {
    const p = depotLocalToWorld(world, lx * hx, lz * hz)
    const y = spawnGroundY(colliders, p.x, p.z)
    if (y > best) best = y
  }
  return Number.isFinite(best) ? best : 0
}

/** Footprint samples in half-extents: four corners plus the center. */
const DEPOT_SEAT_SAMPLES: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
]

/** The industrial breaker on the +x end wall: the ONLY combat trigger. */
export function breakerPosition(world: GameWorld): Vector3 {
  return depotLocalToWorld(world, BREAKER_LOCAL[0], BREAKER_LOCAL[1])
}

/** How square-on the player must look at the breaker to work it (cos):
 * within ~57° of dead-on — walking past sideways never throws it. */
export const BREAKER_FACING_DOT = 0.55

/**
 * The outside-and-facing gate on the breaker — pure, exported for tests.
 * The panel hangs on the end wall's OUTSIDE face, but grab arbitration is
 * a plain XZ disc: standing INSIDE the container you are within reach of
 * it straight through the steel, and one absent-minded E in there started
 * (or now, worse, CANCELLED) the war. Two checks, both required: the
 * player's spawn-frame lateral coordinate clears the end-wall plane (truly
 * outside, on the panel's side of the wall), and the look direction points
 * at the panel (facing it, not backing into it). `at` is the caller's
 * breakerPosition — passed in so the per-frame path allocates nothing.
 */
export function breakerEngageable(
  world: GameWorld,
  at: Vector3,
  px: number,
  pz: number,
  lookX: number,
  lookZ: number,
): boolean {
  // The player's depot-local x must clear the +x end-wall plane: truly
  // outside the container, on the panel's side of the steel.
  const [lx] = worldToDepotLocal(world, px, pz)
  if (lx <= DEPOT_SIZE[0] / 2) return false
  const tx = at.x - px
  const tz = at.z - pz
  const tLen = Math.hypot(tx, tz)
  const lLen = Math.hypot(lookX, lookZ)
  if (tLen < 1e-6 || lLen < 1e-6) return false
  return (tx * lookX + tz * lookZ) / (tLen * lLen) > BREAKER_FACING_DOT
}

/** Live fixtures' grab candidacy, keyed by nodeId — each WeaponTable (and
 * the switch wall) registers on mount and mirrors `taken`. The build and
 * gear grab discs overlap almost everywhere on the spawn approach, so one
 * E press must serve exactly ONE fixture: the nearest untaken one (a
 * double grant would hand out the rifle alongside the builder — and a
 * stray E must never reach the breaker switch by accident). */
const grabTables = new Map<string, { x: number; z: number; taken: boolean }>()

/** Nearest untaken table within grab range — pure, exported for tests.
 * Ties keep the first-registered entry (map order, deterministic). */
export function nearestGrabbable(
  px: number,
  pz: number,
  tables: ReadonlyMap<string, { x: number; z: number; taken: boolean }>,
  range = GRAB_RANGE,
): string | null {
  let best: string | null = null
  let bestDist = range
  for (const [id, table] of tables) {
    if (table.taken) continue
    const dist = Math.hypot(px - table.x, pz - table.z)
    if (dist < bestDist) {
      best = id
      bestDist = dist
    }
  }
  return best
}

/** Every solid depot mesh registers under this single destruction key —
 * '__boots'-prefixed (the prevoxelize guard skips it) AND nodeType
 * 'fixture' (shooting sparks, grenades skip): armored twice over. */
export const DEPOT_NODE_ID = '__boots-depot'
/** Outside shooting's DESTRUCTIBLE set and the grenade EXPLODABLE sets —
 * the QA P6R1 lane where hits only spark. Exported for the armor pin. */
export const DEPOT_NODE_TYPE = 'fixture'

/** Trailer-local placement. The truck sits beyond the quiet -X end so the
 * breaker on +X remains usable; its model points down -Z, hence the +π/2 turn. */
export const TRUCK_LOCAL_X = -6
export const TRUCK_LOCAL_Z = 0
export const TRUCK_LOCAL_YAW = Math.PI / 2
/** Cab-local coordinates in the tractor's heading frame (+X points rearward). */
export const DRIVER_DOOR_LOCAL: readonly [number, number] = [0.3, 1.45]
export const DRIVER_SEAT_LOCAL: readonly [number, number] = [0.28, 0.45]
export const DRIVER_EXIT_LOCAL: readonly [number, number] = [0.3, 1.65]
export const VEHICLE_ENTER_RANGE = 2.25
/** Container floor height above the trailer frame. Wheel tops are y=.76, so
 * this leaves visible suspension/deck clearance instead of drawing tyres
 * through the cargo box. */
export const TRAILER_DECK_LIFT = 0.84

const VEHICLE_MAX_FORWARD = 10
const VEHICLE_MAX_REVERSE = 4
const VEHICLE_ACCEL = 7
const VEHICLE_BRAKE = 10
const VEHICLE_COAST = 4
/** Real front-wheel steering geometry: a 33° lock gives this long truck a
 * useful ~5.5 m centerline radius instead of the old speed-dependent 12.8 m
 * circle. The trailer still follows through its hitch and articulation cap. */
const VEHICLE_PUBLISH_HZ = 12
const REMOTE_DRIVER_TIMEOUT_MS = 1800
/** Tractor center → rear hitch and trailer center → front hitch add to the
 * initial six-metre separation. The trailer yaw follows the standard
 * low-speed no-slip trailer equation φdot = v/L sin(θ−φ). */
export const TRUCK_HITCH_X = 2.75
export const TRAILER_HITCH_LENGTH = 3.25
export const TRAILER_MAX_ARTICULATION = Math.PI * 0.39

/** Bicycle-model yaw rate (rad/s). Reverse naturally flips the turn. */
export function truckYawRate(speed: number, steer: number): number {
  if (!Number.isFinite(speed) || !Number.isFinite(steer)) return 0
  const input = Math.max(-1, Math.min(1, steer))
  return (speed / CYBER_TRUCK_WHEELBASE) * Math.tan(input * CYBER_TRUCK_MAX_STEER_ANGLE)
}

export function stepTrailerYaw(
  trailerYaw: number,
  truckYaw: number,
  speed: number,
  dt: number,
): number {
  let next = wrapVehicleYaw(
    trailerYaw +
      (speed / TRAILER_HITCH_LENGTH) * Math.sin(shortestYawDelta(trailerYaw, truckYaw)) * dt,
  )
  const articulation = shortestYawDelta(next, truckYaw)
  if (Math.abs(articulation) > TRAILER_MAX_ARTICULATION) {
    next = wrapVehicleYaw(truckYaw - Math.sign(articulation) * TRAILER_MAX_ARTICULATION)
  }
  return next
}

export function trailerCenterFromHitch(
  truckX: number,
  truckZ: number,
  truckYaw: number,
  trailerYaw: number,
): { x: number; z: number } {
  const hitch = convoyLocalToWorld(TRUCK_HITCH_X, 0, { x: truckX, z: truckZ, yaw: truckYaw })
  return {
    x: hitch.x + TRAILER_HITCH_LENGTH * Math.cos(trailerYaw),
    z: hitch.z - TRAILER_HITCH_LENGTH * Math.sin(trailerYaw),
  }
}

const LEGACY_DRIVE_SAMPLES: ReadonlyArray<readonly [number, number, number]> = [
  [-8.45, 0, 0.9],
  [-7.3, 0, 1.05],
  [-5.5, 0, 1.05],
  [-3.8, 0, 1.1],
  [-2.1, 0, 1.3],
  [0, 0, 1.3],
  [2.1, 0, 1.3],
]
const TRUCK_DRIVE_SAMPLES: ReadonlyArray<readonly [number, number, number]> = [
  [-2.65, 0, 1.02],
  [-1.2, 0, 1.02],
  [0.5, 0, 1.02],
  [2.25, 0, 1.0],
]
const TRAILER_DRIVE_SAMPLES: ReadonlyArray<readonly [number, number, number]> = [
  [-2.45, 0, 1.3],
  [0, 0, 1.3],
  [2.4, 0, 1.3],
]

const DRIVE_OVER_TYPES = new Set(['site'])
const DRIVE_BREAK_TYPES = new Set([
  'wall',
  'door',
  'window',
  'item',
  'shelf',
  'cabinet',
  'cabinet-module',
  'counter',
  'kitchen-unit',
  'block',
  'column',
  'stair',
  'stair-segment',
  'fence',
])
const _impactBlockers: ColliderEntry[] = []
const _impactPoint = new Vector3()
const _impactDirection = new Vector3()
const VEHICLE_RAM_RADIUS = 1.9
const VEHICLE_MAX_SUPPORT_RISE = 0.45

/** A heavy road vehicle follows terrain, roads and shallow curbs, never the
 * highest walkable surface in the column (upper floors and roofs). */
export function heavyVehicleSupportY(terrainY: number, sampledY: number | null): number {
  if (sampledY === null || !Number.isFinite(sampledY)) return terrainY
  return sampledY <= terrainY + VEHICLE_MAX_SUPPORT_RISE
    ? Math.max(terrainY, sampledY)
    : terrainY
}

/** Convert broken material into a visible loss of momentum without making a
 * heavy convoy bounce or reverse. Repeated walls therefore cost speed while
 * the truck still has enough mass to push through them. */
export function speedAfterRamImpact(
  speed: number,
  removedVoxels: number,
  felledTrees: number,
): number {
  if (removedVoxels <= 0 && felledTrees <= 0) return speed
  const loss = 0.35 + Math.min(5, Math.max(0, removedVoxels) * 0.02) +
    Math.max(0, felledTrees) * 1.1
  return Math.sign(speed) * Math.max(0, Math.abs(speed) - loss)
}

/** Broad, conservative convoy sweep. Ground-like surfaces below axle height
 * are driveable; walls, furniture and other vertical solids block before the
 * rendered truck or trailer can cross them. */
function collectConvoyBlockers(
  colliders: readonly ColliderEntry[],
  x: number,
  y: number,
  z: number,
  yaw: number,
  out?: ColliderEntry[],
): boolean {
  const cos = Math.cos(yaw)
  const sin = Math.sin(yaw)
  let blocked = false
  for (const collider of colliders) {
    if (collider.disabled || collider.nodeId === DEPOT_NODE_ID) continue
    if (DRIVE_OVER_TYPES.has(collider.nodeType)) continue
    const box = collider.worldBox
    // Floors, slabs and low curbs are under the chassis; roofs/ceilings well
    // overhead do not stop a vehicle driving beneath them.
    if (box.max.y <= y + 0.34 || box.min.y >= y + 1.9) continue
    for (const [lx, lz, radius] of LEGACY_DRIVE_SAMPLES) {
      const px = x + lx * cos + lz * sin
      const pz = z - lx * sin + lz * cos
      const dx = px < box.min.x ? box.min.x - px : px > box.max.x ? px - box.max.x : 0
      const dz = pz < box.min.z ? box.min.z - pz : pz > box.max.z ? pz - box.max.z : 0
      if (dx * dx + dz * dz >= radius * radius) continue
      blocked = true
      if (out && !out.some((entry) => entry.nodeId === collider.nodeId)) out.push(collider)
      break
    }
  }
  return blocked
}

function collectBodyBlockers(
  colliders: readonly ColliderEntry[],
  x: number,
  y: number,
  z: number,
  yaw: number,
  samples: ReadonlyArray<readonly [number, number, number]>,
  out?: ColliderEntry[],
): boolean {
  const cos = Math.cos(yaw)
  const sin = Math.sin(yaw)
  const voxelTargets = out ? useDestruction.getState().targets : null
  let blocked = false
  for (const collider of colliders) {
    // Player-built walls voxelize immediately and disable their source
    // collider. They still need to enter the ram list or the truck passes
    // through a perfectly intact voxel wall without visually breaking it.
    const voxelized = collider.disabled && voxelTargets?.has(collider.nodeId)
    if ((collider.disabled && !voxelized) || collider.nodeId === DEPOT_NODE_ID) continue
    if (DRIVE_OVER_TYPES.has(collider.nodeType)) continue
    const box = collider.worldBox
    if (box.max.y <= y + 0.34 || box.min.y >= y + 1.9) continue
    for (const [lx, lz, radius] of samples) {
      const px = x + lx * cos + lz * sin
      const pz = z - lx * sin + lz * cos
      const dx = px < box.min.x ? box.min.x - px : px > box.max.x ? px - box.max.x : 0
      const dz = pz < box.min.z ? box.min.z - pz : pz > box.max.z ? pz - box.max.z : 0
      if (dx * dx + dz * dz >= radius * radius) continue
      if (!collider.disabled) blocked = true
      if (out && !out.some((entry) => entry.nodeId === collider.nodeId)) out.push(collider)
      break
    }
  }
  return blocked
}

export function collectArticulatedBlockers(
  colliders: readonly ColliderEntry[],
  y: number,
  trailer: { x: number; z: number; yaw: number },
  truck: { x: number; z: number; yaw: number },
  out?: ColliderEntry[],
): boolean {
  const trailerBlocked = collectBodyBlockers(
    colliders,
    trailer.x,
    y,
    trailer.z,
    trailer.yaw,
    TRAILER_DRIVE_SAMPLES,
    out,
  )
  const truckBlocked = collectBodyBlockers(
    colliders,
    truck.x,
    y,
    truck.z,
    truck.yaw,
    TRUCK_DRIVE_SAMPLES,
    out,
  )
  return trailerBlocked || truckBlocked
}

export function convoyCanOccupy(
  colliders: readonly ColliderEntry[],
  x: number,
  y: number,
  z: number,
  yaw: number,
): boolean {
  return !collectConvoyBlockers(colliders, x, y, z, yaw)
}

function articulatedGroundY(
  world: GameWorld,
  trailer: { x: number; z: number; yaw: number },
  truck: { x: number; z: number; yaw: number },
): number {
  let best = Number.NEGATIVE_INFINITY
  for (const [lx, lz] of [
    [-2.4, 0],
    [0, 0],
    [2.4, 0],
  ] as const) {
    const p = convoyLocalToWorld(lx, lz, trailer)
    const terrain = groundSurfaceY(p.x, p.z)
    best = Math.max(
      best,
      heavyVehicleSupportY(terrain, probeSpawnSurfaceY(world.colliders, p.x, p.z)),
    )
  }
  for (const [lx, lz] of [
    [-2.2, 0],
    [1.8, 0],
  ] as const) {
    const p = convoyLocalToWorld(lx, lz, truck)
    const terrain = groundSurfaceY(p.x, p.z)
    best = Math.max(
      best,
      heavyVehicleSupportY(terrain, probeSpawnSurfaceY(world.colliders, p.x, p.z)),
    )
  }
  return Number.isFinite(best) ? best : 0
}

function insideBody(
  x: number,
  z: number,
  pose: { x: number; z: number; yaw: number },
  halfX: number,
  halfZ: number,
): boolean {
  const local = convoyWorldToLocal(x, z, pose)
  return Math.abs(local.x) <= halfX && Math.abs(local.z) <= halfZ
}

/** Every client applies the synchronized convoy overlap to its locally drawn
 * horde. That keeps a remote driver's truck lethal even though bots are not
 * world colliders. A full-health droid dies in one unmistakable impact. */
function ramBotsWithConvoy(): number {
  // The convoy pose exists on every browser, but bot health belongs to the
  // elected simulator. Applying this overlap on followers made a remote
  // truck appear to kill early, then briefly resurrect on the next snapshot.
  if (!isHordeAuthority()) return 0
  let hit = 0
  const trailer = { x: convoyPose.x, z: convoyPose.z, yaw: convoyPose.yaw }
  const truck = {
    x: convoyPose.truckX,
    z: convoyPose.truckZ,
    yaw: convoyPose.truckYaw,
  }
  for (const bot of bots) {
    if (bot.state !== 'alive') continue
    if (
      !insideBody(bot.position.x, bot.position.z, truck, 3.05, 1.2) &&
      !insideBody(bot.position.x, bot.position.z, trailer, 3.2, 1.5)
    ) {
      continue
    }
    damageBot(bot, 10_000)
    hit++
  }
  return hit
}

function refreshConvoyColliders(world: GameWorld): void {
  for (const entry of world.colliders) {
    if (entry.disabled || entry.nodeId !== DEPOT_NODE_ID) continue
    const mesh = entry.mesh
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
    entry.inverse.copy(mesh.matrixWorld).invert()
    entry.worldBox.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld)
  }
}

function approach(value: number, target: number, amount: number): number {
  if (value < target) return Math.min(target, value + amount)
  if (value > target) return Math.max(target, value - amount)
  return value
}

/** Kept export name — game-root mounts <GunTable/>; it now builds the
 * armored spawn depot in place of the loose tables. */
export function GunTable({ world }: { world: GameWorld }) {
  return <SpawnDepot world={world} />
}

// Depot paint: weathered two-tone steel (per-mesh colors, no textures).
const BODY = '#4e5d68' // steel blue-gray walls
const BODY_DARK = '#41505a' // roof + header lip
const DECK = '#4b5157' // interior floor plate
const STEEL = '#3a3d42' // rails, struts, hangers
const CASTING = '#2b3036' // corner castings / skid feet
const RIB = '#46525c' // corrugation ribs

/** Corner castings (the container's skid feet + top blocks), local frame. */
const CASTINGS: Array<[number, number, number]> = [
  [-2.92, 0.13, -1.22],
  [2.92, 0.13, -1.22],
  [-2.92, 0.13, 1.22],
  [2.92, 0.13, 1.22],
  [-2.92, 2.47, -1.22],
  [2.92, 2.47, -1.22],
  [-2.92, 2.47, 1.22],
  [2.92, 2.47, 1.22],
]

/** Rust accents — thin proud patches over the two-tone paint. */
const RUST_PATCHES: Array<{
  pos: [number, number, number]
  size: [number, number, number]
  color: string
}> = [
  { pos: [-1.6, 0.55, -1.257], size: [0.8, 0.5, 0.012], color: '#7c4a2d' },
  { pos: [2.1, 1.9, -1.257], size: [0.5, 0.3, 0.012], color: '#8a5636' },
  { pos: [-3.007, 0.5, 0.4], size: [0.012, 0.6, 0.7], color: '#7c4a2d' },
  { pos: [3.007, 1.8, -0.6], size: [0.012, 0.4, 0.5], color: '#8a5636' },
  { pos: [-2.4, 2.28, 1.256], size: [0.6, 0.18, 0.012], color: '#8a5636' },
  { pos: [0.5, 0.09, 1.256], size: [1.2, 0.06, 0.012], color: '#7c4a2d' },
]

/**
 * The depot itself: one root group at depotPosition, rotated so the open
 * long side faces spawn (local +z = spawn-ward, +x = the player's right —
 * the same frame the tables used). Solid meshes collect into solidRefs and
 * register as '__boots-depot' / 'fixture' colliders: they block movement,
 * bots and bullets, but never voxelize — bullets spark, grenades wash over.
 */
function SpawnDepot({ world }: { world: GameWorld }) {
  const center = useMemo(() => depotPosition(world), [world])
  // Seat the container on whatever actually stands under its footprint —
  // the same probe that settles the player (spawnGroundY skips '__boots'
  // colliders, so the depot never stands on itself). On lots whose yard
  // is a raised site slab (warner-2: top at y≈0.69) a hardcoded y=0 left
  // the container embedded waist-deep in the terrain; on sculpted ground a
  // single center probe buries the uphill end, hence depotSeatY.
  const groundY = useMemo(() => depotSeatY(world), [world])
  const armoryAt = useMemo(() => armoryStationPosition(world), [world])
  const geared = useBoots((s) => s.owned.includes('rifle'))
  const rootRef = useRef<Group>(null)
  const truckRef = useRef<Group>(null)
  const awningRef = useRef<Group>(null)
  const rampRef = useRef<Group>(null)
  const strutsRef = useRef<Group>(null)
  const vehiclePrompt = useRef<string | null>(null)
  const publishClock = useRef(0)
  const engineRef = useRef<VehicleEngineHandle | null>(null)
  const solidRefs = useRef<(Mesh | null)[]>([])
  useFixtureColliders(world, solidRefs)
  const solid = (i: number) => (mesh: Mesh | null) => {
    solidRefs.current[i] = mesh
  }

  useEffect(() => {
    const engine = sfx.vehicleEngine()
    engineRef.current = engine
    return () => {
      engine.stop()
      if (engineRef.current === engine) engineRef.current = null
    }
  }, [])

  useEffect(() => {
    const initialYaw = depotWorldYaw(world)
    const initialTruck = depotLocalToWorld(world, TRUCK_LOCAL_X, TRUCK_LOCAL_Z)
    resetConvoyPose(
      center.x,
      groundY,
      center.z,
      initialYaw,
      initialTruck.x,
      initialTruck.z,
      initialYaw,
    )
    registerFrameKind(VEHICLE_KIND, readVehicleFrame)

    const accept = (frame: VehicleFrame, sender: string | null, now: number) => {
      const mine = localSessionId()
      if (sender && mine && sender === mine) return
      // Simultaneous entry is resolved identically everywhere: the lower
      // host-stamped session id keeps the wheel.
      if (vehicleRig.driving && frame.occupied && sender && mine && sender < mine) {
        vehicleRig.driving = false
      } else if (vehicleRig.driving) {
        return
      }
      if (frame.occupied) {
        if (
          convoyPose.remoteDriver &&
          now - convoyPose.remoteAt < REMOTE_DRIVER_TIMEOUT_MS &&
          sender &&
          convoyPose.remoteDriver < sender
        ) {
          return
        }
        convoyPose.remoteDriver = sender
        convoyPose.remoteAt = now
      } else if (!sender || convoyPose.remoteDriver === sender) {
        convoyPose.remoteDriver = null
        convoyPose.remoteAt = 0
      }
      convoyPose.targetX = frame.x
      convoyPose.targetY = frame.y
      convoyPose.targetZ = frame.z
      convoyPose.targetYaw = frame.yaw
      const legacyTruck = convoyLocalToWorld(TRUCK_LOCAL_X, TRUCK_LOCAL_Z, frame)
      convoyPose.targetTruckX = frame.truckX ?? legacyTruck.x
      convoyPose.targetTruckZ = frame.truckZ ?? legacyTruck.z
      convoyPose.targetTruckYaw = frame.truckYaw ?? frame.yaw
      convoyPose.speed = frame.speed
      convoyPose.targetSteer = frame.steer ?? 0
      convoyPose.occupied = frame.occupied
    }

    const offFrame = onFrame<VehicleFrame>(VEHICLE_KIND, (msg) => {
      accept(msg.data, msg.sessionId, Date.now())
    })
    const offSnapshot = onStateSnapshot(VEHICLE_KIND, ({ state }) => {
      const frame = readVehicleFrame(state)
      if (frame && !vehicleRig.driving && !convoyPose.remoteDriver) {
        // A snapshot establishes a resting location; a live driver stream,
        // if present, supersedes it on the next frame.
        accept({ ...frame, occupied: false }, null, Date.now())
        convoyPose.x = convoyPose.targetX
        convoyPose.y = convoyPose.targetY
        convoyPose.z = convoyPose.targetZ
        convoyPose.yaw = convoyPose.targetYaw
        convoyPose.truckX = convoyPose.targetTruckX
        convoyPose.truckZ = convoyPose.targetTruckZ
        convoyPose.truckYaw = convoyPose.targetTruckYaw
      }
    })
    const offRequest = onStateRequest(({ of, from }) => {
      const mine = localSessionId()
      if (of !== VEHICLE_KIND || !mine) return
      if (!shouldAnswerStateRequest(mine, from, getParticipants())) return
      sendStateSnapshot(VEHICLE_KIND, from, {
        x: convoyPose.x,
        y: convoyPose.y,
        z: convoyPose.z,
        yaw: convoyPose.yaw,
        truckX: convoyPose.truckX,
        truckZ: convoyPose.truckZ,
        truckYaw: convoyPose.truckYaw,
        speed: convoyPose.speed,
        occupied: false,
      } satisfies VehicleFrame)
    })
    requestState(VEHICLE_KIND)

    return () => {
      if (vehicleRig.driving) {
        publishFrame(VEHICLE_KIND, {
          x: convoyPose.x,
          y: convoyPose.y,
          z: convoyPose.z,
          yaw: convoyPose.yaw,
          truckX: convoyPose.truckX,
          truckZ: convoyPose.truckZ,
          truckYaw: convoyPose.truckYaw,
          speed: 0,
          steer: 0,
          occupied: false,
        } satisfies VehicleFrame)
      }
      offFrame()
      offSnapshot()
      offRequest()
      getSession()?.hud.prompt(null, 'vehicle')
      clearConvoyPose()
    }
  }, [center.x, center.z, groundY, world])

  // Priority -2: claim E before doors (-1) and move the root before Player
  // follows the cab at priority 0. Remote poses ease between 12 Hz packets;
  // the local driver remains exact and publishes latest-value frames.
  useFrame(({ camera }, rawDt) => {
    const root = rootRef.current
    const session = getSession()
    if (!root || !session || !convoyPose.ready) {
      engineRef.current?.setMotion(0, false, 0)
      return
    }
    const dt = Math.min(rawDt, 1 / 30)
    const now = Date.now()

    if (
      convoyPose.remoteDriver &&
      now - convoyPose.remoteAt > REMOTE_DRIVER_TIMEOUT_MS
    ) {
      convoyPose.remoteDriver = null
      convoyPose.occupied = false
      convoyPose.speed = 0
    }

    const truckPose = {
      x: convoyPose.truckX,
      z: convoyPose.truckZ,
      yaw: convoyPose.truckYaw,
    }
    const door = convoyLocalToWorld(DRIVER_DOOR_LOCAL[0], DRIVER_DOOR_LOCAL[1], truckPose)
    const nearDoor =
      Math.hypot(playerRig.position.x - door.x, playerRig.position.z - door.z) <=
      VEHICLE_ENTER_RANGE
    const remotelyOccupied = convoyPose.remoteDriver !== null

    if (vehicleRig.driving) {
      if (takeAction(session.input.state.actions, 'Tab')) {
        vehicleRig.view = vehicleRig.view === 'first' ? 'third' : 'first'
        session.hud.hint(
          `camera-${vehicleRig.view}`,
          vehicleRig.view === 'third'
            ? 'Third person · Tab returns to first person'
            : 'First person · Tab returns to third person',
        )
      }
      if (takeAction(session.input.state.actions, 'KeyE')) {
        vehicleRig.driving = false
        vehicleRig.speed = 0
        convoyPose.occupied = false
        convoyPose.speed = 0
        const exit = convoyLocalToWorld(DRIVER_EXIT_LOCAL[0], DRIVER_EXIT_LOCAL[1], truckPose)
        playerDebug.teleport?.(
          exit.x,
          exit.z,
          convoyPose.truckYaw + Math.PI / 2,
          playerRig.pitch,
          spawnGroundY(world.colliders, exit.x, exit.z),
        )
        publishFrame(VEHICLE_KIND, {
          x: convoyPose.x,
          y: convoyPose.y,
          z: convoyPose.z,
          yaw: convoyPose.yaw,
          truckX: convoyPose.truckX,
          truckZ: convoyPose.truckZ,
          truckYaw: convoyPose.truckYaw,
          speed: 0,
          steer: 0,
          occupied: false,
        } satisfies VehicleFrame)
      } else {
        const keys = session.input.state.keys
        const throttle = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0)
        const target =
          throttle > 0 ? VEHICLE_MAX_FORWARD : throttle < 0 ? -VEHICLE_MAX_REVERSE : 0
        const rate = throttle === 0 ? VEHICLE_COAST : Math.sign(target) === Math.sign(convoyPose.speed) || convoyPose.speed === 0
          ? VEHICLE_ACCEL
          : VEHICLE_BRAKE
        convoyPose.speed = approach(convoyPose.speed, target, rate * dt)

        const steer = (keys.has('KeyA') ? 1 : 0) - (keys.has('KeyD') ? 1 : 0)
        convoyPose.steer = convoyPose.targetSteer = approach(convoyPose.steer, steer, dt * 5)
        const oldTruckYaw = convoyPose.truckYaw
        let nextTruckYaw = oldTruckYaw
        if (Math.abs(convoyPose.steer) > 0.001 && Math.abs(convoyPose.speed) > 0.08) {
          nextTruckYaw = wrapVehicleYaw(
            nextTruckYaw + truckYawRate(convoyPose.speed, convoyPose.steer) * dt,
          )
        }
        const nextTruckX =
          convoyPose.truckX - Math.cos(nextTruckYaw) * convoyPose.speed * dt
        const nextTruckZ =
          convoyPose.truckZ + Math.sin(nextTruckYaw) * convoyPose.speed * dt
        const nextTrailerYaw = stepTrailerYaw(
          convoyPose.yaw,
          nextTruckYaw,
          convoyPose.speed,
          dt,
        )
        const nextTrailer = trailerCenterFromHitch(
          nextTruckX,
          nextTruckZ,
          nextTruckYaw,
          nextTrailerYaw,
        )
        const candidateTruck = { x: nextTruckX, z: nextTruckZ, yaw: nextTruckYaw }
        const candidateTrailer = { ...nextTrailer, yaw: nextTrailerYaw }
        const ny = articulatedGroundY(world, candidateTrailer, candidateTruck)
        const direction = convoyPose.speed >= 0 ? 1 : -1
        const impactX = direction > 0 ? -3.0 : 2.8
        const nose = convoyLocalToWorld(impactX, 0, {
          x: nextTruckX,
          z: nextTruckZ,
          yaw: nextTruckYaw,
        })
        const felledTrees = Math.abs(convoyPose.speed) > 1.1
          ? ramTreesAt(nose.x, nose.z, 1.45)
          : 0

        _impactBlockers.length = 0
        let blocked = collectArticulatedBlockers(
          world.colliders,
          ny,
          candidateTrailer,
          candidateTruck,
          _impactBlockers,
        )
        // A moving Cybertruck is a demolition tool. Break only vertical
        // structures/props (never the road or floor carrying it), then retry
        // the sweep in the same frame so a successful impact carries through.
        let removedVoxels = 0
        if (_impactBlockers.length > 0 && Math.abs(convoyPose.speed) > 1.1) {
          _impactDirection.set(
            -Math.cos(nextTruckYaw) * direction,
            0,
            Math.sin(nextTruckYaw) * direction,
          )
          for (const collider of _impactBlockers) {
            if (!DRIVE_BREAK_TYPES.has(collider.nodeType)) continue
            const box = collider.worldBox
            _impactPoint.set(
              Math.max(box.min.x, Math.min(box.max.x, nose.x)),
              Math.max(box.min.y, Math.min(box.max.y, ny + 1.0)),
              Math.max(box.min.z, Math.min(box.max.z, nose.z)),
            )
            removedVoxels += damageTarget(
              world,
              collider.nodeId,
              _impactPoint,
              VEHICLE_RAM_RADIUS,
              _impactDirection,
            )
          }
          blocked = collectArticulatedBlockers(
            world.colliders,
            ny,
            candidateTrailer,
            candidateTruck,
          )
        }
        convoyPose.speed = speedAfterRamImpact(
          convoyPose.speed,
          removedVoxels,
          felledTrees,
        )
        if (!blocked) {
          convoyPose.x = convoyPose.targetX = nextTrailer.x
          convoyPose.y = convoyPose.targetY = ny
          convoyPose.z = convoyPose.targetZ = nextTrailer.z
          convoyPose.yaw = convoyPose.targetYaw = nextTrailerYaw
          convoyPose.truckX = convoyPose.targetTruckX = nextTruckX
          convoyPose.truckZ = convoyPose.targetTruckZ = nextTruckZ
          convoyPose.truckYaw = convoyPose.targetTruckYaw = nextTruckYaw
          // Preserve the driver's look offset while the cab turns beneath
          // them. Without this, both first-person and chase cameras kept
          // staring along the old world heading after steering a corner.
          playerRig.yaw += shortestYawDelta(oldTruckYaw, nextTruckYaw)
          if (Math.abs(convoyPose.speed) > 1.1) {
            // The victim owns its damage application; the driver only records
            // the spatial hit. Two circles cover the bumper and cab flank.
            ramRemotePlayersAt(nose.x, nose.z, 1.65, now)
            ramRemotePlayersAt(nextTruckX, nextTruckZ, 1.35, now)
          }
        } else {
          convoyPose.speed = 0
        }

        publishClock.current += dt
        if (publishClock.current >= 1 / VEHICLE_PUBLISH_HZ) {
          publishClock.current = 0
          publishFrame(VEHICLE_KIND, {
            x: convoyPose.x,
            y: convoyPose.y,
            z: convoyPose.z,
            yaw: convoyPose.yaw,
            truckX: convoyPose.truckX,
            truckZ: convoyPose.truckZ,
            truckYaw: convoyPose.truckYaw,
            speed: convoyPose.speed,
            steer: convoyPose.steer,
            occupied: true,
          } satisfies VehicleFrame)
        }
      }
    } else {
      if (nearDoor && !remotelyOccupied && takeAction(session.input.state.actions, 'KeyE')) {
        vehicleRig.driving = true
        convoyPose.occupied = true
        convoyPose.speed = 0
        convoyPose.remoteDriver = null
        publishClock.current = 1 / VEHICLE_PUBLISH_HZ
        playerRig.yaw = convoyPose.truckYaw + Math.PI / 2
        playerRig.pitch = 0
      } else {
        const k = 1 - Math.exp(-14 * dt)
        convoyPose.x += (convoyPose.targetX - convoyPose.x) * k
        convoyPose.y += (convoyPose.targetY - convoyPose.y) * k
        convoyPose.z += (convoyPose.targetZ - convoyPose.z) * k
        convoyPose.yaw += shortestYawDelta(convoyPose.yaw, convoyPose.targetYaw) * k
        convoyPose.truckX += (convoyPose.targetTruckX - convoyPose.truckX) * k
        convoyPose.truckZ += (convoyPose.targetTruckZ - convoyPose.truckZ) * k
        convoyPose.truckYaw +=
          shortestYawDelta(convoyPose.truckYaw, convoyPose.targetTruckYaw) * k
        convoyPose.steer += (convoyPose.targetSteer - convoyPose.steer) * k
      }
    }

    root.position.set(convoyPose.x, convoyPose.y, convoyPose.z)
    root.rotation.y = convoyPose.yaw
    const truck = truckRef.current
    if (truck) {
      const local = convoyWorldToLocal(convoyPose.truckX, convoyPose.truckZ)
      truck.position.set(local.x, 0, local.z)
      truck.rotation.y = shortestYawDelta(convoyPose.yaw, convoyPose.truckYaw)
    }
    const panelsClosed = vehicleRig.driving || convoyPose.remoteDriver !== null
    if (awningRef.current) {
      awningRef.current.rotation.x = approach(
        awningRef.current.rotation.x,
        panelsClosed ? Math.PI / 2 : -0.5,
        dt * 4.8,
      )
    }
    if (rampRef.current) {
      rampRef.current.rotation.x = approach(
        rampRef.current.rotation.x,
        panelsClosed ? -Math.PI / 2 : 0.49,
        dt * 4.8,
      )
    }
    if (strutsRef.current) strutsRef.current.visible = !panelsClosed
    root.updateWorldMatrix(true, true)

    // Engine audio is derived from the same interpolated convoy pose every
    // player renders. Only listener-relative distance/bearing is local, so a
    // remote drive-by has the same RPM but moves naturally across the ears.
    const engineDx = convoyPose.truckX - camera.position.x
    const engineDy = convoyPose.y + 0.75 - camera.position.y
    const engineDz = convoyPose.truckZ - camera.position.z
    const engineDistance = Math.hypot(engineDx, engineDy, engineDz)
    const cameraRight = camera.matrixWorld.elements
    const enginePan =
      engineDistance > 0.001
        ? (engineDx * cameraRight[0]! +
            engineDy * cameraRight[1]! +
            engineDz * cameraRight[2]!) /
          engineDistance
        : 0
    engineRef.current?.setMotion(convoyPose.speed, panelsClosed, engineDistance, enginePan)

    refreshConvoyColliders(world)

    if (Math.abs(convoyPose.speed) > 1.1) {
      const currentNose = convoyLocalToWorld(-3.0, 0, {
        x: convoyPose.truckX,
        z: convoyPose.truckZ,
        yaw: convoyPose.truckYaw,
      })
      ramTreesAt(currentNose.x, currentNose.z, 1.45)
      ramBotsWithConvoy()
    }

    const seat = convoyLocalToWorld(DRIVER_SEAT_LOCAL[0], DRIVER_SEAT_LOCAL[1], {
      x: convoyPose.truckX,
      z: convoyPose.truckZ,
      yaw: convoyPose.truckYaw,
    })
    vehicleRig.seatX = seat.x
    vehicleRig.seatY = convoyPose.y + 0.08
    vehicleRig.seatZ = seat.z
    vehicleRig.speed = convoyPose.speed

    const prompt = vehicleRig.driving
      ? `W/S throttle · A/D steer · Tab ${vehicleRig.view === 'first' ? 'third-person' : 'first-person'} · E exit`
      : nearDoor
        ? remotelyOccupied
          ? 'Cybertruck occupied'
          : 'Press E — drive Cybertruck'
        : null
    if (prompt !== vehiclePrompt.current) {
      vehiclePrompt.current = prompt
      session.hud.prompt(prompt, 'vehicle')
    }
  }, -2)

  // Grass must not grow through the deck: zero-scale the nature scatter
  // under the footprint (three circles tile the 6 × 2.5 box). Nature
  // mounts in parallel with the depot, so sweep twice — frame 10 catches
  // the common case, frame 120 any straggler fields. Idempotent and
  // O(instances) per sweep (the crater budget), then the frame check is a
  // single compare forever.
  const sweepFrame = useRef(0)
  useFrame(() => {
    const frame = sweepFrame.current
    if (frame > 120) return
    sweepFrame.current = frame + 1
    if (frame !== 10 && frame !== 120) return
    for (const lx of [-2, 0, 2]) {
      const p = liveDepotLocalToWorld(world, lx, 0)
      clearScatterInRadius(p.x, p.z, 1.75)
    }
    const truck = liveDepotLocalToWorld(world, TRUCK_LOCAL_X, TRUCK_LOCAL_Z)
    clearScatterInRadius(truck.x, truck.z, 1.5)
  })

  return (
    <group
      ref={rootRef}
      position={[center.x, groundY, center.z]}
      rotation={[0, depotWorldYaw(world), 0]}
      userData={{ __boots: true }}
    >
      {/* The depot is now the truck's cargo trailer: four low-poly wheels,
          axles and a short drawbar to the pickup's rear hitch. */}
      <TrailerRunningGear />
      <mesh position={[-3.2, 0.42, 0]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.07, 0.07, 0.55, 8]} />
        <meshStandardMaterial color={CASTING} metalness={0.55} roughness={0.5} />
      </mesh>
      <group ref={truckRef} position={[TRUCK_LOCAL_X, 0, TRUCK_LOCAL_Z]}>
        <group rotation={[0, TRUCK_LOCAL_YAW, 0]}>
          <CyberTruckModel />
        </group>
        {/* Simple hidden hulls keep collision cheap; the detailed procedural
            body remains visual and low-poly. */}
        <mesh visible={false} position={[0, 0.85, 0]} ref={solid(10)}>
          <boxGeometry args={[5.65, 1.35, 1.95]} />
          <meshBasicMaterial />
        </mesh>
        <mesh visible={false} position={[0.28, 1.5, 0]} ref={solid(11)}>
          <boxGeometry args={[2.0, 0.75, 1.8]} />
          <meshBasicMaterial />
        </mesh>
      </group>
      {/* Loading ramp reaches the lifted deck without hiding the shop behind
          a full-width cosmetic skirt. Its real mesh is a walk collider. */}
      <group
        ref={rampRef}
        position={[0, TRAILER_DECK_LIFT + 0.12, 1.25]}
        rotation={[0.49, 0, 0]}
      >
        <mesh castShadow receiveShadow position={[0, 0, 0.86]} ref={solid(12)}>
          <boxGeometry args={[5.55, 0.1, 1.72]} />
          <meshStandardMaterial color={CASTING} metalness={0.35} roughness={0.72} />
        </mesh>
      </group>
      <group position={[0, TRAILER_DECK_LIFT, 0]}>
      {/* ── the armored shell (all colliders) ─────────────────────────── */}
      {/* floor plate — the interior deck the player steps onto */}
      <mesh castShadow receiveShadow position={[0, 0.06, 0]} ref={solid(0)}>
        <boxGeometry args={[6, 0.12, 2.5]} />
        <meshStandardMaterial color={DECK} roughness={0.9} />
      </mesh>
      {/* back wall */}
      <mesh castShadow position={[0, 1.36, -1.2]} ref={solid(1)}>
        <boxGeometry args={[6, 2.48, 0.1]} />
        <meshStandardMaterial color={BODY} metalness={0.25} roughness={0.7} />
      </mesh>
      {/* end walls */}
      <mesh castShadow position={[-2.95, 1.36, 0]} ref={solid(2)}>
        <boxGeometry args={[0.1, 2.48, 2.5]} />
        <meshStandardMaterial color={BODY} metalness={0.25} roughness={0.7} />
      </mesh>
      <mesh castShadow position={[2.95, 1.36, 0]} ref={solid(3)}>
        <boxGeometry args={[0.1, 2.48, 2.5]} />
        <meshStandardMaterial color={BODY} metalness={0.25} roughness={0.7} />
      </mesh>
      {/* roof */}
      <mesh castShadow position={[0, 2.55, 0]} ref={solid(4)}>
        <boxGeometry args={[6, 0.1, 2.5]} />
        <meshStandardMaterial color={BODY_DARK} metalness={0.25} roughness={0.7} />
      </mesh>
      {/* front header lip over the opening (clear height ~2.0 m) */}
      <mesh castShadow position={[0, 2.325, 1.2]} ref={solid(5)}>
        <boxGeometry args={[6, 0.35, 0.1]} />
        <meshStandardMaterial color={BODY_DARK} metalness={0.25} roughness={0.7} />
      </mesh>
      {/* fold-down awning panel, propped open over the shop front */}
      <group ref={awningRef} position={[0, 2.42, 1.25]} rotation={[-0.5, 0, 0]}>
        <mesh castShadow position={[0, 0, 0.575]} ref={solid(6)}>
          <boxGeometry args={[5.7, 0.05, 1.15]} />
          <meshStandardMaterial color="#5a6a76" metalness={0.25} roughness={0.65} />
        </mesh>
      </group>
      {/* awning prop struts (visual) */}
      <group ref={strutsRef}>
        {[-2.7, 2.7].map((x) => (
          <mesh key={x} position={[x, 2.625, 1.75]} rotation={[0.985, 0, 0]}>
            <cylinderGeometry args={[0.018, 0.018, 1.18, 8]} />
            <meshStandardMaterial color={STEEL} metalness={0.5} roughness={0.5} />
          </mesh>
        ))}
      </group>

      {/* ── set dressing (visual only) ─────────────────────────────────── */}
      <CorrugationRibs />
      {CASTINGS.map((pos, i) => (
        <mesh key={i} position={pos} castShadow>
          <boxGeometry args={[0.32, 0.26, 0.32]} />
          <meshStandardMaterial color={CASTING} metalness={0.4} roughness={0.6} />
        </mesh>
      ))}
      {/* roof lip rim */}
      {[-1.22, 1.22].map((z) => (
        <mesh key={z} position={[0, 2.63, z]}>
          <boxGeometry args={[6.04, 0.07, 0.07]} />
          <meshStandardMaterial color={CASTING} metalness={0.4} roughness={0.6} />
        </mesh>
      ))}
      {[-2.98, 2.98].map((x) => (
        <mesh key={x} position={[x, 2.63, 0]}>
          <boxGeometry args={[0.07, 0.07, 2.54]} />
          <meshStandardMaterial color={CASTING} metalness={0.4} roughness={0.6} />
        </mesh>
      ))}
      {RUST_PATCHES.map((patch, i) => (
        <mesh key={i} position={patch.pos}>
          <boxGeometry args={patch.size} />
          <meshStandardMaterial color={patch.color} roughness={0.95} />
        </mesh>
      ))}

      {/* ── signage ────────────────────────────────────────────────────── */}
      {/* the big painted DEPOT marquee, hanging off the awning edge */}
      {[-1.0, 1.0].map((x) => (
        <mesh key={x} position={[x, 2.93, 2.24]}>
          <boxGeometry args={[0.04, 0.14, 0.04]} />
          <meshStandardMaterial color={STEEL} metalness={0.5} roughness={0.5} />
        </mesh>
      ))}
      <StencilSign position={[0, 2.82, 2.25]} text="DEPOT" width={2.4} height={0.36} />
      {/* hazard stripes on the header, flagging the breaker end */}
      <HazardStripes position={[2.5, 2.325, 1.256]} size={[0.9, 0.28]} />

      {/* ── BUILD BENCH (left bay): DECORATION ONLY (owner call
       * 2026-08-29) — the build hammer and spray can are the spawn
       * loadout now (store defaults), so nothing prompts here. The bench,
       * its tiny display hammer and the sign stay exactly as they were;
       * the depot's ONE interaction is the armory's E (guns). */}
      {/* workbench at the shop front */}
      <mesh castShadow position={[-1.7, 0.945, 0.93]} ref={solid(7)}>
        <boxGeometry args={[1.15, 0.07, 0.6]} />
        <meshStandardMaterial color="#6e5137" roughness={0.8} />
      </mesh>
      {[-2.16, -1.24].map((x, i) => (
        <mesh key={x} castShadow position={[x, 0.515, 0.93]} ref={solid(8 + i)}>
          <boxGeometry args={[0.08, 0.79, 0.54]} />
          <meshStandardMaterial color="#54402c" roughness={0.85} />
        </mesh>
      ))}
      {/* under-shelf */}
      <mesh position={[-1.7, 0.42, 0.93]}>
        <boxGeometry args={[0.9, 0.04, 0.48]} />
        <meshStandardMaterial color="#54402c" roughness={0.85} />
      </mesh>
      {/* the tiny display hammer — PERMANENT (unlimited stock) */}
      <group position={[-1.62, 1.015, 1.01]} rotation={[0, 0.5, 0]}>
        <group rotation={[-Math.PI / 2 + 0.06, Math.PI / 2, 0]} scale={0.9}>
          <HammerModel />
        </group>
      </group>
      <StencilSign
        position={[-1.7, 2.325, 1.256]}
        text="START BUILDING"
        width={1.0}
        height={0.2}
      />

      {/* ── ARMORY RACK (center bay): the full loadout ─────────────────── */}
      <StationLogic
        world={world}
        at={armoryAt}
        nodeId="__boots-depot-armory"
        taken={geared}
        prompt="Press E — gear up"
        promptOwner="guntable"
        onPickup={() => {
          // GUNS ONLY (owner call 2026-08-29): builder + paint are the
          // spawn loadout, so the armory's E hands over the weapons rack —
          // and nothing else. Gear ONLY — the wave director never reads
          // ownership; combat waits for the breaker panel on the end wall.
          const s = useBoots.getState()
          s.giveWeapon('pistol')
          s.giveWeapon('rifle')
          s.giveWeapon('minigun')
          s.giveWeapon('hammer')
          s.setWeapon('rifle')
        }}
      />
      {/* rack rails on the back wall */}
      {[1.68, 0.72].map((y) => (
        <mesh key={y} position={[0, y, -1.11]}>
          <boxGeometry args={[3.3, 0.07, 0.07]} />
          <meshStandardMaterial color={STEEL} metalness={0.5} roughness={0.5} />
        </mesh>
      ))}
      {/* the guns, LINED UP vertically — PERMANENT displays: they never
       * flip to taken (unlimited, the next player collects too). The
       * MINIGUN is the exception (owner: it hung badly on the rack, and
       * "the gatling looked nice rotating horizontally") — it gets its own
       * showcase pedestal, lying flat and slowly turning. */}
      <group position={[-1.25, 1.2, -1.02]} rotation={[Math.PI / 2, 0, 0]} scale={1.3}>
        <PistolModel />
      </group>
      <group position={[-0.45, 1.2, -1.02]} rotation={[Math.PI / 2, 0, 0]} scale={1.15}>
        <RifleModel />
      </group>
      <group position={[0.45, 1.25, -1.02]} rotation={[Math.PI / 2, 0, 0]} scale={0.8}>
        {ExternalWarhammer ? <ExternalWarhammer /> : <HammerModel />}
      </group>
      <MinigunShowcase />
      {/* work boots on the floor mat, toes toward the player walking up */}
      <mesh position={[0, 0.135, 0.4]}>
        <boxGeometry args={[0.85, 0.03, 0.55]} />
        <meshStandardMaterial color="#22262a" roughness={0.95} />
      </mesh>
      <group position={[0, 0.15, 0.4]} rotation={[0, Math.PI + 0.35, 0]}>
        <BootsPair />
      </group>
      {/* the taunt flip lives ONLY on the sign — never on the displays */}
      <StencilSign
        position={[0, 2.325, 1.256]}
        text={geared ? 'YOU ARE COOKED' : 'GEAR UP'}
        width={1.2}
        height={0.24}
      />

      {/* ── THE MIRROR (far end of the back wall, past the rack) ────────
       * Owner ask: "maybe somewhere in the depot with the guns you can have a
       * mirror so people check themselves". A glazed wall cabinet with a
       * Pascaline inside who copies you — the only place in a first-person
       * game where you get to see the avatar everyone else sees. */}
      <DepotMirror world={world} />

      {/* ── BREAKER PANEL (right end wall, outside): the combat opt-in ── */}
      <BreakerPanel world={world} />
      {/* twin red alarm gyros DIRECTLY ABOVE THE LEVER (owner ask — they
       * pair with the siren sound the throw triggers, so they must be in
       * your face when you work the handle, not hidden up on the roof).
       * Wall brackets high on the end wall's outside face; the primary
       * carries the lot's single always-mounted red pointLight. */}
      {[-0.45, 0.45].map((z) => (
        <mesh key={z} position={[3.06, 2.18, z]}>
          <boxGeometry args={[0.18, 0.05, 0.16]} />
          <meshStandardMaterial color={STEEL} metalness={0.5} roughness={0.5} />
        </mesh>
      ))}
      <SirenBeacon position={[3.12, 2.2, -0.45]} primary />
      <SirenBeacon position={[3.12, 2.2, 0.45]} />
      </group>
    </group>
  )
}

const TRAILER_WHEELS: ReadonlyArray<readonly [number, number]> = [
  [-2.05, -1.28],
  [-2.05, 1.28],
  [1.85, -1.28],
  [1.85, 1.28],
]

function TrailerRunningGear() {
  return (
    <group>
      {[-2.05, 1.85].map((x) => (
        <mesh key={`axle:${x}`} position={[x, 0.38, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.075, 0.075, 2.62, 8]} />
          <meshStandardMaterial color={CASTING} metalness={0.55} roughness={0.55} />
        </mesh>
      ))}
      {TRAILER_WHEELS.map(([x, z]) => (
        <TrailerWheel key={`wheel:${x}:${z}`} x={x} z={z} />
      ))}
      <mesh position={[0, 0.3, 0]}>
        <boxGeometry args={[5.7, 0.16, 1.65]} />
        <meshStandardMaterial color={CASTING} metalness={0.45} roughness={0.62} />
      </mesh>
      {/* Visible longitudinal frame rails and suspension blocks make the
          container read as cargo carried above a chassis, not pierced by it. */}
      {[-0.72, 0.72].map((z) => (
        <mesh key={`rail:${z}`} position={[0, 0.57, z]}>
          <boxGeometry args={[5.75, 0.18, 0.12]} />
          <meshStandardMaterial color={CASTING} metalness={0.5} roughness={0.58} />
        </mesh>
      ))}
      {[-2.05, 1.85].map((x) => (
        <mesh key={`spring:${x}`} position={[x, 0.64, 0]}>
          <boxGeometry args={[0.72, 0.12, 1.78]} />
          <meshStandardMaterial color="#25282d" metalness={0.4} roughness={0.7} />
        </mesh>
      ))}
    </group>
  )
}

function TrailerWheel({ x, z }: { x: number; z: number }) {
  const rollRef = useRef<Group>(null)
  useFrame((_, dt) => {
    if (rollRef.current) {
      rollRef.current.rotation.y += (convoyPose.speed / 0.38) * Math.min(dt, 1 / 30)
    }
  })
  return (
    <group position={[x, 0.38, z]} rotation={[Math.PI / 2, 0, 0]}>
      <group ref={rollRef}>
        <mesh>
          <cylinderGeometry args={[0.38, 0.38, 0.24, 12]} />
          <meshStandardMaterial color="#15171a" roughness={0.95} />
        </mesh>
        <mesh position={[0, Math.sign(z) * 0.125, 0]}>
          <cylinderGeometry args={[0.16, 0.16, 0.025, 10]} />
          <meshStandardMaterial color={CASTING} metalness={0.55} roughness={0.4} />
        </mesh>
      </group>
    </group>
  )
}

/** Turntable speed for the minigun showcase (rad/s) — slow and steady. */
const SHOWCASE_SPIN = 0.45

/**
 * The minigun's showcase: it never hung right on the wall rack (owner —
 * "the gatling looked nice rotating horizontally"), so it lies FLAT on a
 * squat steel pedestal in the armory bay, slowly turning like a dealership
 * turntable. Purely decorative — no collider (like the other displays),
 * dt clamped the same way the drone rotors are so a hitch never spins it.
 */
function MinigunShowcase() {
  const spinRef = useRef<Group>(null)
  useFrame((_, rawDt) => {
    const g = spinRef.current
    if (g) g.rotation.y += SHOWCASE_SPIN * Math.min(rawDt, 1 / 30)
  })
  return (
    <group position={[1.35, 0, -0.55]}>
      {/* squat steel pedestal + cap plate */}
      <mesh castShadow position={[0, 0.36, 0]}>
        <boxGeometry args={[0.42, 0.72, 0.42]} />
        <meshStandardMaterial color={STEEL} metalness={0.45} roughness={0.55} />
      </mesh>
      <mesh position={[0, 0.735, 0]}>
        <boxGeometry args={[0.5, 0.03, 0.5]} />
        <meshStandardMaterial color={CASTING} metalness={0.5} roughness={0.5} />
      </mesh>
      {/* the gatling, flat, turning */}
      <group position={[0, 0.86, 0]} ref={spinRef}>
        <group scale={0.95}>
          <MinigunModel />
        </group>
      </group>
    </group>
  )
}

const BREAKER_NODE_ID = '__boots-switch'

/** Lever pose: rotation.x of the pivot group. UP tips the big handle just
 * off vertical toward the player; DOWN throws it well past horizontal. */
const LEVER_UP = 0.35
const LEVER_DOWN = 2.7
/** The full throw sweeps in ~0.4 s (rad/s) — same lerp both directions. */
const LEVER_RATE = (LEVER_DOWN - LEVER_UP) / 0.4

/** Scratch for the camera's world direction in BreakerPanel's frame loop. */
const _look = new Vector3()

/**
 * The breaker panel — the industrial zombie switch, now PART OF the depot:
 * mounted on the container's right end wall (outside face), a massive
 * two-hand knife-lever on a steel backplate. A real TOGGLE: E throws the
 * handle DOWN (armWaves — the ONLY way combat starts) and E again throws
 * it back UP (disarmWaves — units power down, grace restored). Both
 * directions demand standing OUTSIDE the container facing the panel
 * (breakerEngageable), so nobody flips the war on or off through the end
 * wall while browsing the armory. The handle chases waveState.armed every
 * frame — down for the whole assault, back up on shutdown or resetBots().
 * The end wall itself is the depot's collider; the panel joins the same
 * nearest-grabbable arbitration under the legacy '__boots-switch' key.
 * Rendered inside the depot's root group: local +z here faces OUTWARD
 * along the container's +x end (rotation π/2).
 */
function BreakerPanel({ world }: { world: GameWorld }) {
  const at = useMemo(() => breakerPosition(world), [world])
  const leverRef = useRef<Group>(null)
  const leverAngle = useRef(LEVER_UP)
  const prevE = useRef(false)
  const promptText = useRef<string | null>(null)

  // Grab arbitration entry: the breaker competes with the stations so one
  // E press serves exactly one fixture. Never `taken` — a toggle stays
  // claimable for as long as the session runs; the engageable gate (not
  // arbitration) is what keeps stray presses out.
  useEffect(() => {
    const entry = { x: at.x, z: at.z, taken: false }
    grabTables.set(BREAKER_NODE_ID, entry)
    return () => {
      grabTables.delete(BREAKER_NODE_ID)
    }
  }, [at])

  useFrame(({ camera }, dt) => {
    // The throw (both directions): chase armed's target pose at the 0.4 s
    // sweep rate — a real handle motion, not a snap.
    const target = waveState.armed ? LEVER_DOWN : LEVER_UP
    if (leverAngle.current !== target) {
      const delta = target - leverAngle.current
      leverAngle.current += Math.sign(delta) * Math.min(Math.abs(delta), LEVER_RATE * dt)
      if (leverRef.current) leverRef.current.rotation.x = leverAngle.current
    }

    const session = getSession()
    if (!session) return
    liveDepotLocalToWorld(world, BREAKER_LOCAL[0], BREAKER_LOCAL[1], at)
    const entry = grabTables.get(BREAKER_NODE_ID)
    if (entry) {
      entry.x = at.x
      entry.z = at.z
    }
    camera.getWorldDirection(_look)
    const [playerLocalX] = liveWorldToDepotLocal(world, playerRig.position.x, playerRig.position.z)
    const near =
      nearestGrabbable(playerRig.position.x, playerRig.position.z, grabTables) ===
        BREAKER_NODE_ID &&
      playerLocalX > DEPOT_SIZE[0] / 2 &&
      (() => {
        const tx = at.x - playerRig.position.x
        const tz = at.z - playerRig.position.z
        const len = Math.hypot(tx, tz) * Math.hypot(_look.x, _look.z)
        return len > 1e-6 && (tx * _look.x + tz * _look.z) / len > BREAKER_FACING_DOT
      })()
    // The verb tracks the handle: the prompt itself says which way the
    // next throw goes (and flips in place right after a toggle).
    const want = near
      ? waveState.armed
        ? 'Press E — shut it down'
        : 'Press E — throw the switch'
      : null
    if (want !== promptText.current) {
      promptText.current = want
      session.hud.prompt(want, 'switchwall')
    }
    const ePressed = session.input.state.keys.has('KeyE')
    if (near && ePressed && !prevE.current) {
      setSharedWaves(!waveState.armed)
      sfx.breakerThrow() // heavy knife-switch clunk, both directions
    }
    prevE.current = ePressed
  })

  return (
    <group position={[3.0, 0, 0]} rotation={[0, Math.PI / 2, 0]}>
      {/* SERVICE CABINET PLATE: the end-wall corrugation ribs stand 0.065 m
       * proud of the wall plane and were slicing across the sign and the
       * handle (owner report — vertical stripes in front of everything).
       * This plate spans wall→0.12 and the whole assembly mounts on it, so
       * sign, lever and stripes all read in FRONT of the ribs, square-on. */}
      <mesh position={[0, 0.93, 0.06]}>
        <boxGeometry args={[1.14, 1.58, 0.12]} />
        <meshStandardMaterial color={STEEL} metalness={0.45} roughness={0.55} />
      </mesh>
      {/* steel backplate on the cabinet */}
      <mesh position={[0, 0.88, 0.15]}>
        <boxGeometry args={[0.42, 0.55, 0.06]} />
        <meshStandardMaterial color="#2a2d33" metalness={0.5} roughness={0.5} />
      </mesh>
      {/* hinge bosses on the pivot line */}
      {[-0.11, 0.11].map((x) => (
        <mesh key={x} position={[x, 0.72, 0.2]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.035, 0.035, 0.05, 10]} />
          <meshStandardMaterial color="#54565c" metalness={0.6} roughness={0.4} />
        </mesh>
      ))}
      {/* the massive two-hand lever — pivot at the hinge line */}
      <group position={[0, 0.72, 0.2]} ref={leverRef} rotation={[LEVER_UP, 0, 0]}>
        {[-0.11, 0.11].map((x) => (
          <mesh key={x} position={[x, 0.21, 0]}>
            <boxGeometry args={[0.045, 0.42, 0.035]} />
            <meshStandardMaterial color="#6d7076" metalness={0.65} roughness={0.35} />
          </mesh>
        ))}
        {/* the big red cross-grip: grab it with both hands */}
        <mesh position={[0, 0.42, 0]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.034, 0.034, 0.36, 12]} />
          <meshStandardMaterial color="#c43a35" roughness={0.5} />
        </mesh>
      </group>
      {/* the marching orders, stenciled on the cabinet above the switch */}
      <StencilSign position={[0, 1.42, 0.135]} text="PUT YOUR BOOTS ON" width={1.05} height={0.2} />
      {/* hazard stripes under the handle's throw arc */}
      <HazardStripes position={[0, 0.34, 0.135]} size={[1.0, 0.26]} />
    </group>
  )
}

type SirenHandle = { start: () => void; stop: () => void }

/**
 * sfx.sirenLoop lands this round (feedback agent): a factory returning a
 * { start, stop } rotating-alarm whine. Guarded so the beacon stays a silent
 * prop until it exists; tolerates either a factory or a plain handle.
 */
function resolveSirenLoop(): SirenHandle | null {
  const raw = (sfx as unknown as Record<string, unknown>).sirenLoop
  let handle: unknown = null
  if (typeof raw === 'function') handle = (raw as (this: typeof sfx) => unknown).call(sfx)
  else if (raw && typeof raw === 'object') handle = raw
  const h = handle as Partial<SirenHandle> | null
  if (h && typeof h.start === 'function' && typeof h.stop === 'function') return h as SirenHandle
  return null
}

/**
 * The alert countdown window: bots-pathing owns the flag semantics in
 * enemies-state.ts — `waveState.countdownActive` is true exactly while the
 * post-throw ALERT_SECONDS countdown runs (false before, after, and on
 * resetBots()).
 */
function alertCountdownActive(): boolean {
  return waveState.countdownActive
}

/**
 * A siren beacon — now mounted on the switch wall's cap (it moved there
 * with the combat trigger). Dormant until the alert countdown starts, then:
 * the 'beacon-light' child (tagged by the model via userData) spins
 * ~7 rad/s, a small red point light flares for exactly the countdown
 * window, and sfx.sirenLoop plays quietly. Everything stops when the
 * countdown ends and on unmount. Exactly ONE beacon is `primary`: it owns
 * the single red pointLight (still always-mounted — moved, never
 * duplicated) and the siren voice; secondaries just spin their heads.
 */
function SirenBeacon({
  position,
  primary = false,
}: {
  position: [number, number, number]
  primary?: boolean
}) {
  const rootRef = useRef<Group>(null)
  const headRef = useRef<Object3D | null>(null)
  const activeRef = useRef(false)
  const [active, setActive] = useState(false)
  const sirenRef = useRef<SirenHandle | null>(null)
  const sirenResolved = useRef(false)

  useEffect(() => {
    const root = rootRef.current
    if (root) {
      root.traverse((obj) => {
        if (!headRef.current && (obj.userData as { role?: string })?.role === 'beacon-light') {
          headRef.current = obj
        }
      })
    }
    return () => {
      if (activeRef.current) sirenRef.current?.stop()
      activeRef.current = false
    }
  }, [])

  useFrame((_, dt) => {
    const on = alertCountdownActive()
    if (on !== activeRef.current) {
      activeRef.current = on
      setActive(on)
      // BOTH beacons GLOW (owner: "only 1 of the 2 gyros turns on") — the
      // single pointLight stays primary-only (adding a light mid-session
      // recompiles pipelines), but the head material's emissive is free:
      // flip it on every beacon so the secondary reads lit, not dead.
      const head = headRef.current
      if (head) {
        head.traverse((obj) => {
          const material = (obj as Mesh).material as
            | { emissive?: Color; emissiveIntensity?: number }
            | undefined
          if (material?.emissive) {
            material.emissive.set(on ? '#ff2222' : '#000000')
            material.emissiveIntensity = on ? 1.6 : 0
          }
        })
      }
      if (primary) {
        if (on) {
          if (!sirenResolved.current) {
            sirenResolved.current = true
            sirenRef.current = resolveSirenLoop()
          }
          sirenRef.current?.start()
        } else {
          sirenRef.current?.stop()
        }
      }
    }
    if (on && headRef.current) headRef.current.rotation.y += dt * 7
  })

  return (
    <group ref={rootRef} position={position}>
      <SirenModel />
      {/* ALWAYS mounted (primary only — the lot's single siren light):
       * adding a light mid-session recompiles pipelines (the gear-up lag
       * burst) — only intensity animates. */}
      {primary && (
        <pointLight
          color="#ff2222"
          distance={6}
          intensity={active ? 2 : 0}
          position={[0, 0.14, 0]}
        />
      )}
    </group>
  )
}

/**
 * Military-crate stencil signage — the depot's replacement for the wooden
 * table placards: a dark olive-steel plate, worn yellow stencil lettering
 * (monospace, hand-tracked per character), painted corner bolts. The plate
 * mounts flush at `position` facing local +z; text flips (GEAR UP → YOU
 * ARE COOKED) rebuild the texture exactly like TableSign did.
 */
function StencilSign({
  position,
  rotation = [0, 0, 0],
  text,
  width = 1.0,
  height = 0.22,
}: {
  position: [number, number, number]
  rotation?: [number, number, number]
  text: string
  width?: number
  height?: number
}) {
  const texture = useMemo(() => {
    if (typeof document === 'undefined') return null
    const canvas = document.createElement('canvas')
    canvas.width = 768
    canvas.height = 192
    const g = canvas.getContext('2d')!
    // olive-steel plate with a worn stencil frame
    g.fillStyle = '#39413a'
    g.fillRect(0, 0, 768, 192)
    g.strokeStyle = '#242a24'
    g.lineWidth = 10
    g.strokeRect(8, 8, 752, 176)
    // hand-tracked stencil lettering, shrunk to fit long lines
    const chars = [...text]
    const track = 10
    let font = 116
    g.font = `bold ${font}px "Courier New", monospace`
    let textW = g.measureText(text).width + track * (chars.length - 1)
    if (textW > 680) {
      font = Math.max(28, Math.floor((font * 680) / textW))
      g.font = `bold ${font}px "Courier New", monospace`
      textW = g.measureText(text).width + track * (chars.length - 1)
    }
    g.fillStyle = '#dfc95e'
    g.textAlign = 'left'
    g.textBaseline = 'middle'
    let x = (768 - textW) / 2
    for (const c of chars) {
      g.fillText(c, x, 102)
      x += g.measureText(c).width + track
    }
    // painted corner bolts
    g.fillStyle = '#1c211c'
    for (const [bx, by] of [
      [26, 26],
      [742, 26],
      [26, 166],
      [742, 166],
    ]) {
      g.beginPath()
      g.arc(bx!, by!, 9, 0, Math.PI * 2)
      g.fill()
    }
    return new CanvasTexture(canvas)
  }, [text])
  // R3F disposes the JSX material, never this externally created texture —
  // release it on unmount AND on every text flip or each session leaks one.
  useEffect(() => () => texture?.dispose(), [texture])
  return (
    <mesh position={position} rotation={rotation}>
      <boxGeometry args={[width, height, 0.02]} />
      {texture ? (
        <meshStandardMaterial map={texture} roughness={0.8} />
      ) : (
        <meshStandardMaterial color="#39413a" roughness={0.8} />
      )}
    </mesh>
  )
}

/** Yellow/black diagonal hazard stripes on a thin plate (CanvasTexture —
 * the industrial warning band by the breaker and on the header). */
function HazardStripes({
  position,
  rotation = [0, 0, 0],
  size,
}: {
  position: [number, number, number]
  rotation?: [number, number, number]
  size: [number, number]
}) {
  const texture = useMemo(() => {
    if (typeof document === 'undefined') return null
    const canvas = document.createElement('canvas')
    canvas.width = 256
    canvas.height = 64
    const g = canvas.getContext('2d')!
    g.fillStyle = '#d9b83b'
    g.fillRect(0, 0, 256, 64)
    g.fillStyle = '#15171a'
    for (let x = -64; x < 320; x += 56) {
      g.beginPath()
      g.moveTo(x, 64)
      g.lineTo(x + 28, 64)
      g.lineTo(x + 28 + 64, 0)
      g.lineTo(x + 64, 0)
      g.closePath()
      g.fill()
    }
    return new CanvasTexture(canvas)
  }, [])
  useEffect(() => () => texture?.dispose(), [texture])
  return (
    <mesh position={position} rotation={rotation}>
      <boxGeometry args={[size[0], size[1], 0.015]} />
      {texture ? (
        <meshStandardMaterial map={texture} roughness={0.85} />
      ) : (
        <meshStandardMaterial color="#d9b83b" roughness={0.85} />
      )}
    </mesh>
  )
}

/** Primitive stand-in until the arsenal agent's BootsPairModel lands. */
function FallbackBootsPair() {
  return (
    <group>
      {[-0.06, 0.06].map((x, i) => (
        <group key={i} position={[x, 0, 0]} rotation={[0, i ? -0.14 : 0.14, 0]}>
          {/* sole */}
          <mesh position={[0, 0.015, 0]}>
            <boxGeometry args={[0.085, 0.03, 0.26]} />
            <meshStandardMaterial color="#2e2620" roughness={0.9} />
          </mesh>
          {/* foot */}
          <mesh position={[0, 0.065, 0.02]}>
            <boxGeometry args={[0.08, 0.07, 0.2]} />
            <meshStandardMaterial color="#7a5a38" roughness={0.85} />
          </mesh>
          {/* shaft */}
          <mesh position={[0, 0.135, 0.07]}>
            <boxGeometry args={[0.078, 0.095, 0.1]} />
            <meshStandardMaterial color="#6b4d30" roughness={0.85} />
          </mesh>
        </group>
      ))}
    </group>
  )
}

/** Primitive stand-in until the arsenal agent's SirenBeaconModel lands —
 * same contract: the rotating head is tagged userData role 'beacon-light'. */
function FallbackSirenBeacon() {
  return (
    <group>
      {/* base puck */}
      <mesh position={[0, 0.02, 0]}>
        <cylinderGeometry args={[0.055, 0.065, 0.04, 12]} />
        <meshStandardMaterial color="#26282c" roughness={0.7} />
      </mesh>
      {/* rotating red head */}
      <group position={[0, 0.04, 0]} userData={{ role: 'beacon-light' }}>
        <mesh position={[0, 0.05, 0]}>
          <cylinderGeometry args={[0.042, 0.05, 0.095, 12]} />
          <meshStandardMaterial color="#c43a35" emissive="#7a1512" roughness={0.35} />
        </mesh>
        {/* lens slit so the spin reads */}
        <mesh position={[0, 0.05, -0.038]}>
          <boxGeometry args={[0.03, 0.055, 0.02]} />
          <meshStandardMaterial color="#ff6a5e" emissive="#ff2a1f" emissiveIntensity={1.2} roughness={0.3} />
        </mesh>
      </group>
    </group>
  )
}

/**
 * Register every solid depot mesh as a '__boots-depot' / 'fixture'
 * collider — the WeaponTable idiom (the RENDERED meshes ARE the
 * colliders), minus the voxelization: 'fixture' sits outside shooting's
 * DESTRUCTIBLE set and the grenade EXPLODABLE sets, so the depot blocks
 * movement, bots and bullets forever and only ever sparks.
 */
function useFixtureColliders(world: GameWorld, solidRefs: { current: (Mesh | null)[] }) {
  useEffect(() => {
    const entries: ColliderEntry[] = []
    for (const mesh of solidRefs.current) {
      if (!mesh) continue
      mesh.updateWorldMatrix(true, false)
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
      const entry: ColliderEntry = {
        mesh,
        // Lazy, like world.ts's host colliders: this effect registers every
        // depot mesh at once, and an eager build made all of them synchronously
        // at mount whether a ray ever came near them or not. The rays that need
        // one are broadphased (shooting.ts, interact.tsx), so most never build.
        get bvh() {
          return bvhFor(this.mesh)
        },
        inverse: new Matrix4().copy(mesh.matrixWorld).invert(),
        worldBox: mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld),
        root: mesh,
        nodeId: DEPOT_NODE_ID,
        nodeType: DEPOT_NODE_TYPE,
      }
      world.colliders.push(entry)
      entries.push(entry)
    }
    return () => {
      for (const entry of entries) entry.disabled = true
    }
  }, [world, solidRefs])
}

/**
 * One station's interaction contract — the WeaponTable prompt/pickup logic
 * with the geometry factored out (the depot shell owns the meshes now).
 * Registers the grab-arbitration entry at `at` and serves E exactly like
 * the tables did: prompt only while this station is the nearest untaken
 * fixture, one pickup per press edge, sfx.pickup on grant.
 */
function StationLogic({
  world,
  at,
  nodeId,
  taken,
  prompt,
  promptOwner,
  onPickup,
}: {
  world: GameWorld
  at: Vector3
  nodeId: string
  /** True once this station's gear is owned: prompt off, arbitration
   * falls through — the DISPLAYS stay (unlimited stock, owner call). */
  taken: boolean
  prompt: string
  promptOwner: string
  onPickup: () => void
}) {
  const prevE = useRef(false)
  const promptShown = useRef(false)

  // Grab arbitration entry (see grabTables): prompt and pickup only engage
  // on the station nearestGrabbable elects, so overlapping discs never
  // serve one E press twice.
  useEffect(() => {
    const entry = { x: at.x, z: at.z, taken }
    grabTables.set(nodeId, entry)
    return () => {
      grabTables.delete(nodeId)
    }
  }, [nodeId, at, taken])

  useFrame(() => {
    const session = getSession()
    if (!session) return

    // `at` is a stable scratch Vector3 owned by SpawnDepot. Mutating it and
    // the arbitration record makes the station ride the trailer without a
    // React render on every metre travelled.
    liveDepotLocalToWorld(world, ARMORY_STATION_LOCAL[0], ARMORY_STATION_LOCAL[1], at)
    const entry = grabTables.get(nodeId)
    if (entry) {
      entry.x = at.x
      entry.z = at.z
      entry.taken = taken
    }

    const near =
      !taken &&
      nearestGrabbable(playerRig.position.x, playerRig.position.z, grabTables) === nodeId
    if (near !== promptShown.current) {
      promptShown.current = near
      session.hud.prompt(near ? prompt : null, promptOwner)
    }
    const ePressed = session.input.state.keys.has('KeyE')
    if (near && ePressed && !prevE.current) {
      onPickup()
      sfx.pickup()
      session.hud.prompt(null, promptOwner)
      promptShown.current = false
    }
    prevE.current = ePressed
  })

  return null
}

/** Rib count: 17 across the back + 7 on each end wall. */
const RIB_COUNT = 31

/**
 * The corrugated read: ONE box geometry instanced over the closed sides
 * (thin vertical ribs, the classic container profile). Matrices are set
 * once on mount — zero per-frame work, no per-frame allocations.
 */
function CorrugationRibs() {
  const ref = useRef<InstancedMesh>(null)
  useEffect(() => {
    const mesh = ref.current
    if (!mesh) return
    const helper = new Object3D()
    let i = 0
    const place = (x: number, z: number, yaw: number) => {
      helper.position.set(x, 1.36, z)
      helper.rotation.set(0, yaw, 0)
      helper.updateMatrix()
      mesh.setMatrixAt(i++, helper.matrix)
    }
    // back wall exterior
    for (let n = 0; n < 17; n++) place(-2.72 + n * 0.34, -1.29, 0)
    // end walls exterior
    for (let n = 0; n < 7; n++) {
      const z = -1.02 + n * 0.34
      place(-3.04, z, Math.PI / 2)
      place(3.04, z, Math.PI / 2)
    }
    mesh.instanceMatrix.needsUpdate = true
  }, [])
  // frustumCulled off: the geometry's bounding sphere is one rib, not the
  // spread — a glancing camera would cull visible ribs otherwise.
  return (
    <instancedMesh args={[undefined, undefined, RIB_COUNT]} ref={ref} castShadow frustumCulled={false}>
      <boxGeometry args={[0.09, 2.34, 0.05]} />
      <meshStandardMaterial color={RIB} metalness={0.35} roughness={0.6} />
    </instancedMesh>
  )
}
