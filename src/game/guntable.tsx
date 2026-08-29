'use client'

import { useFrame } from '@react-three/fiber'
import { type ComponentType, useEffect, useMemo, useRef, useState } from 'react'
import {
  CanvasTexture,
  type Group,
  type InstancedMesh,
  Matrix4,
  type Mesh,
  Object3D,
  Vector3,
} from 'three'
import { useBoots } from '../store'
import { sfx } from './audio'
import { armWaves, disarmWaves, waveState } from './enemies-state'
import { clearScatterInRadius } from './nature'
import { playerRig } from './player'
import { getSession } from './session'
import * as weaponModels from './weapon-models'
import { HammerModel, MinigunModel, PistolModel, RifleModel } from './weapon-models'
import { bvhFor, type ColliderEntry, type GameWorld, spawnGroundY } from './world'

/**
 * THE ARMORED SPAWN DEPOT (owner vision): the spawn gear is a PERMANENT,
 * INDESTRUCTIBLE structure — a weathered steel cargo container with one
 * open long side facing spawn, "all guns lined up, stuff unlimited", the
 * industrial zombie switch part of it — so that in future multiplayer
 * OTHER players walk up to the same depot and collect their gear too.
 * It replaces the three loose tables + the switch-wall stub while keeping
 * their exact interaction contracts:
 *
 * - BUILD STATION (left bay): a workbench at the shop front with the tiny
 *   hammer on display and a START BUILDING stencil. E gives ONLY the
 *   builder tool — no alert, no waves, the peaceful entry. Its prompt is
 *   the one up at spawn ("Press E — start building").
 * - ARMORY RACK (center bay): pistol, rifle, the big rotary gun and the
 *   warhammer lined up vertically on a wall rack, the work boots on a
 *   floor mat below, GEAR UP stencil above. One E gives the FULL loadout
 *   (the old gear + heavy tables merged: pistol/rifle/minigun/hammer).
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

/** BUILD station (left bay): E gives the builder only — the peaceful entry. */
export function buildStationPosition(world: GameWorld): Vector3 {
  return depotLocalToWorld(world, BUILD_STATION_LOCAL[0], BUILD_STATION_LOCAL[1])
}

/** ARMORY rack (center bay): E gives the full loadout. */
export function armoryStationPosition(world: GameWorld): Vector3 {
  return depotLocalToWorld(world, ARMORY_STATION_LOCAL[0], ARMORY_STATION_LOCAL[1])
}

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
  // Seat the container on whatever actually stands at its center — the
  // same probe that settles the player (spawnGroundY skips '__boots'
  // colliders, so the depot never stands on itself). On lots whose yard
  // is a raised site slab (warner-2: top at y≈0.69) a hardcoded y=0 left
  // the container embedded waist-deep in the terrain.
  const groundY = useMemo(
    () => spawnGroundY(world.colliders ?? [], center.x, center.z),
    [world, center],
  )
  const buildAt = useMemo(() => buildStationPosition(world), [world])
  const armoryAt = useMemo(() => armoryStationPosition(world), [world])
  const hasBuilder = useBoots((s) => s.owned.includes('builder'))
  const geared = useBoots((s) => s.owned.includes('rifle'))
  const solidRefs = useRef<(Mesh | null)[]>([])
  useFixtureColliders(world, solidRefs)
  const solid = (i: number) => (mesh: Mesh | null) => {
    solidRefs.current[i] = mesh
  }

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
      const p = depotLocalToWorld(world, lx, 0)
      clearScatterInRadius(p.x, p.z, 1.75)
    }
  })

  return (
    <group
      position={[center.x, groundY, center.z]}
      rotation={[0, depotWorldYaw(world), 0]}
      userData={{ __boots: true }}
    >
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
      <group position={[0, 2.42, 1.25]} rotation={[-0.5, 0, 0]}>
        <mesh castShadow position={[0, 0, 0.575]} ref={solid(6)}>
          <boxGeometry args={[5.7, 0.05, 1.15]} />
          <meshStandardMaterial color="#5a6a76" metalness={0.25} roughness={0.65} />
        </mesh>
      </group>
      {/* awning prop struts (visual) */}
      {[-2.7, 2.7].map((x) => (
        <mesh key={x} position={[x, 2.625, 1.75]} rotation={[0.985, 0, 0]}>
          <cylinderGeometry args={[0.018, 0.018, 1.18, 8]} />
          <meshStandardMaterial color={STEEL} metalness={0.5} roughness={0.5} />
        </mesh>
      ))}

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

      {/* ── BUILD STATION (left bay): the peaceful entry ───────────────── */}
      <StationLogic
        at={buildAt}
        nodeId="__boots-depot-build"
        taken={hasBuilder}
        prompt="Press E — start building"
        promptOwner="guntable3"
        onPickup={() => {
          const s = useBoots.getState()
          s.giveWeapon('builder')
          s.setWeapon('builder')
        }}
      />
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
        text={hasBuilder ? 'BUILD AWAY' : 'START BUILDING'}
        width={1.0}
        height={0.2}
      />

      {/* ── ARMORY RACK (center bay): the full loadout ─────────────────── */}
      <StationLogic
        at={armoryAt}
        nodeId="__boots-depot-armory"
        taken={geared}
        prompt="Press E — gear up"
        promptOwner="guntable"
        onPickup={() => {
          // The WHOLE kit in one stop (owner ask: take everything at the
          // same time) — guns, hammer, builder and the paint can together.
          // Gear ONLY — the wave director never reads ownership; combat
          // waits for the breaker panel on the end wall.
          const s = useBoots.getState()
          s.giveWeapon('pistol')
          s.giveWeapon('rifle')
          s.giveWeapon('minigun')
          s.giveWeapon('hammer')
          s.giveWeapon('builder')
          s.giveWeapon('paint')
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
       * flip to taken (unlimited, the next player collects too). */}
      <group position={[-1.25, 1.2, -1.02]} rotation={[Math.PI / 2, 0, 0]} scale={1.3}>
        <PistolModel />
      </group>
      <group position={[-0.45, 1.2, -1.02]} rotation={[Math.PI / 2, 0, 0]} scale={1.15}>
        <RifleModel />
      </group>
      <group position={[0.45, 1.25, -1.02]} rotation={[Math.PI / 2, 0, 0]} scale={0.95}>
        <MinigunModel />
      </group>
      <group position={[1.35, 1.25, -1.02]} rotation={[Math.PI / 2, 0, 0]} scale={0.8}>
        {ExternalWarhammer ? <ExternalWarhammer /> : <HammerModel />}
      </group>
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

      {/* ── BREAKER PANEL (right end wall, outside): the combat opt-in ── */}
      <BreakerPanel world={world} />
      {/* twin sirens on the roof above the breaker end — the primary
       * carries the lot's single always-mounted red pointLight. */}
      <SirenBeacon position={[2.55, 2.6, -0.45]} primary />
      <SirenBeacon position={[2.55, 2.6, 0.45]} />
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
    grabTables.set(BREAKER_NODE_ID, { x: at.x, z: at.z, taken: false })
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
    camera.getWorldDirection(_look)
    const near =
      nearestGrabbable(playerRig.position.x, playerRig.position.z, grabTables) ===
        BREAKER_NODE_ID &&
      breakerEngageable(world, at, playerRig.position.x, playerRig.position.z, _look.x, _look.z)
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
      if (waveState.armed) disarmWaves() // stand down — the lot powers off
      else armWaves() // the ONLY combat trigger — the wave director takes over
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
        bvh: bvhFor(mesh),
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
  at,
  nodeId,
  taken,
  prompt,
  promptOwner,
  onPickup,
}: {
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
    grabTables.set(nodeId, { x: at.x, z: at.z, taken })
    return () => {
      grabTables.delete(nodeId)
    }
  }, [nodeId, at, taken])

  useFrame(() => {
    const session = getSession()
    if (!session) return

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
