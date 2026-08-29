'use client'

import { useFrame } from '@react-three/fiber'
import { type ComponentType, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { CanvasTexture, type Group, Matrix4, type Mesh, type Object3D, Vector3 } from 'three'
import { useBoots } from '../store'
import { sfx } from './audio'
import { useDestruction } from './destruction'
import { armWaves, waveState } from './enemies-state'
import { playerRig } from './player'
import { getSession } from './session'
import * as weaponModels from './weapon-models'
import { HammerModel, MinigunModel, PistolModel, RifleModel } from './weapon-models'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

/**
 * The gun tables: the small BUILD table dead ahead of the player (nearest —
 * E there equips ONLY the builder tool, no alert, no waves), the small-arms
 * table a few steps ahead of the player, and the heavy table a bit farther
 * BEHIND the spawn — turn around to find the big rotary gun. Walk up, press
 * E, gear up. Each table is a real collider so it blocks movement and eats
 * bullets like any other prop — the RENDERED meshes double as the colliders,
 * so when a table voxelizes the destruction manager hides the very top +
 * legs the player sees and the voxel replica takes over ("everything should
 * be able to break apart").
 *
 * Set dressing (phase 4):
 * - First table: a pair of work boots beside the guns. Picking up here
 *   grants the gear and NOTHING else — combat is strictly opt-in (see the
 *   switch wall below); the table's own sign flips GEAR UP → YOU ARE COOKED.
 * - Rear table: the warhammer lies next to the rotary gun; picking up there
 *   grants BOTH — the big one and the hammer join the loadout together.
 *
 * THE SWITCH WALL (combat opt-in): a short concrete stub of wall beside the
 * spawn tables carrying a MASSIVE two-hand industrial breaker switch — the
 * big metal handle sits UP and throws DOWN on E (retro-lab vibes), and
 * that throw is the ONLY thing that wakes the horde (enemies-state.armWaves
 * → the alert countdown theatre → waves). The siren beacons live up here
 * now (they moved off the gear table with the trigger), the placard reads
 * PUT YOUR BOOTS ON, and the handle mirrors waveState.armed every frame —
 * down for the whole assault, back up when resetBots() re-arms the grace.
 * The stub joins the same grab arbitration as the tables, so one E press
 * still serves exactly one fixture.
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

export const TABLE_SIZE: [number, number, number] = [1.7, 0.06, 0.8]
/** The build table is deliberately small — a side stand, not an armory. */
export const BUILD_TABLE_SIZE: [number, number, number] = [1.0, 0.06, 0.55]
const TABLE_HEIGHT = 0.82
const TABLE_TOP = TABLE_HEIGHT + 0.03
export const GRAB_RANGE = 2.4

// ---------------------------------------------------------------------------
// THE ARMORED SPAWN DEPOT — layout math (owner vision: one PERMANENT,
// INDESTRUCTIBLE cargo container replaces the loose tables; "all guns lined
// up, stuff unlimited", the industrial zombie switch part of it, so future
// multiplayer players collect their gear at the same structure).
//
// Everything is expressed in the SPAWN FRAME the tests use: [lateral,
// forward] offsets from world.spawn, lateral positive = the player's right.
// The container's long axis lies lateral, its one OPEN long side (the shop
// front) faces spawn, and the three stations sit in the opening:
//
//        left end                                    right end (breaker)
//   x  ┌──────────────────────────────────────────────┐  ← back wall
//      │   BUILD bench      ARMORY rack + boots mat   ▐▌ breaker on the
//      └────═══════─────────────═══════───────────────┘  end wall OUTSIDE
//                     open side (faces spawn)
//                          · spawn
//
// Grab-range contract (unchanged from the tables): the BUILD station is the
// only prompt inside GRAB_RANGE at spawn; the armory and the breaker are
// walked to on purpose. The overlap probe 0.4 m ahead of spawn still sits
// inside BOTH the build and armory discs, so nearest-untaken arbitration
// stays load-bearing.
// ---------------------------------------------------------------------------

/** Container footprint: [length (lateral), height, depth (spawn-ward)]. */
export const DEPOT_SIZE: [number, number, number] = [6, 2.6, 2.5]
/** Depot center in the spawn frame: [lateral, forward]. */
export const DEPOT_OFFSET: [number, number] = [0.8, 3.2]
/** BUILD station grab point — 2.29 m from spawn: nearest, inside range. */
export const BUILD_STATION_OFFSET: [number, number] = [-0.9, 2.1]
/** ARMORY grab point — 2.67 m from spawn: outside range on the peaceful
 * entry, inside the 0.4 m approach probe's disc. */
export const ARMORY_STATION_OFFSET: [number, number] = [0.8, 2.55]
/** Breaker grab point — proud of the right end wall (lat 0.8 + 3.05). */
export const BREAKER_OFFSET: [number, number] = [3.85, 3.2]

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

/** The container's center on the ground plane, rotated to face spawn. */
export function depotPosition(world: GameWorld): Vector3 {
  return offsetFromSpawn(world, DEPOT_OFFSET[0], DEPOT_OFFSET[1])
}

/** BUILD station (left bay): E gives the builder only — the peaceful entry. */
export function buildStationPosition(world: GameWorld): Vector3 {
  return offsetFromSpawn(world, BUILD_STATION_OFFSET[0], BUILD_STATION_OFFSET[1])
}

/** ARMORY rack (center bay): E gives the full loadout. */
export function armoryStationPosition(world: GameWorld): Vector3 {
  return offsetFromSpawn(world, ARMORY_STATION_OFFSET[0], ARMORY_STATION_OFFSET[1])
}

/** The industrial breaker on the right end wall: the ONLY combat trigger. */
export function breakerPosition(world: GameWorld): Vector3 {
  return offsetFromSpawn(world, BREAKER_OFFSET[0], BREAKER_OFFSET[1])
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

export function tablePosition(world: GameWorld): Vector3 {
  const fwdX = -Math.sin(world.spawnYaw)
  const fwdZ = -Math.cos(world.spawnYaw)
  return new Vector3(
    world.spawn.x + fwdX * 2.6 - fwdZ * 0.9,
    0,
    world.spawn.z + fwdZ * 2.6 + fwdX * 0.9,
  )
}

/** The build table: nearest of the three, almost dead ahead — side-stepped
 * OPPOSITE the gear table so the two footprints keep clear air between
 * them, and inside GRAB_RANGE so the prompt is up the moment you spawn. */
export function buildTablePosition(world: GameWorld): Vector3 {
  const fwdX = -Math.sin(world.spawnYaw)
  const fwdZ = -Math.cos(world.spawnYaw)
  return new Vector3(
    world.spawn.x + fwdX * 2.3 + fwdZ * 0.55,
    0,
    world.spawn.z + fwdZ * 2.3 - fwdX * 0.55,
  )
}

/** The switch wall's stub footprint (w, h, d) — chest-high and a bit more. */
export const SWITCH_WALL_SIZE: [number, number, number] = [1.2, 1.35, 0.18]

/** The switch wall: past the gear table on its side of the lot, outside
 * grab range at spawn (the peaceful entry keeps a single BUILD prompt) and
 * clear of the gear table's footprint — you walk to the breaker on purpose. */
export function switchWallPosition(world: GameWorld): Vector3 {
  const fwdX = -Math.sin(world.spawnYaw)
  const fwdZ = -Math.cos(world.spawnYaw)
  return new Vector3(
    world.spawn.x + fwdX * 3.4 - fwdZ * 2.2,
    0,
    world.spawn.z + fwdZ * 3.4 + fwdX * 2.2,
  )
}

/** The heavy table: mirrored behind the spawn with the opposite side-step. */
export function minigunTablePosition(world: GameWorld): Vector3 {
  const fwdX = -Math.sin(world.spawnYaw)
  const fwdZ = -Math.cos(world.spawnYaw)
  return new Vector3(
    world.spawn.x - fwdX * 4.5 + fwdZ * 0.6,
    0,
    world.spawn.z - fwdZ * 4.5 - fwdX * 0.6,
  )
}

export function GunTable({ world }: { world: GameWorld }) {
  const frontPos = useMemo(() => tablePosition(world), [world])
  const rearPos = useMemo(() => minigunTablePosition(world), [world])
  const buildPos = useMemo(() => buildTablePosition(world), [world])
  const switchPos = useMemo(() => switchWallPosition(world), [world])
  const geared = useBoots((s) => s.owned.includes('rifle'))
  const hasMinigun = useBoots((s) => s.owned.includes('minigun'))
  const hasBuilder = useBoots((s) => s.owned.includes('builder'))

  return (
    <>
      {/* BUILD table: the peaceful entry. Grants ONLY the builder tool —
       * and since the wave director keys off the breaker switch alone, no
       * pickup anywhere wakes the horde. */}
      <WeaponTable
        world={world}
        position={buildPos}
        yaw={world.spawnYaw}
        nodeId="__boots-table-3"
        size={BUILD_TABLE_SIZE}
        taken={hasBuilder}
        prompt="Press E — start building"
        promptOwner="guntable3"
        onPickup={() => {
          const s = useBoots.getState()
          s.giveWeapon('builder')
          s.setWeapon('builder')
        }}
        fixtures={
          <TableSign
            position={[0, TABLE_TOP, -0.19]}
            rotation={[0, 0, 0]}
            scale={0.7}
            text={hasBuilder ? 'BUILD AWAY' : 'START BUILDING'}
          />
        }
      >
        {/* tiny construction hammer on display — flat like the small arms
         * (haft along the tabletop, head raked up a touch). */}
        <group position={[0.08, TABLE_TOP + 0.035, 0.08]} rotation={[0, 0.5, 0]}>
          <group rotation={[-Math.PI / 2 + 0.06, Math.PI / 2, 0]} scale={0.9}>
            <HammerModel />
          </group>
        </group>
      </WeaponTable>
      <WeaponTable
        world={world}
        position={frontPos}
        yaw={world.spawnYaw}
        nodeId="__boots-table"
        taken={geared}
        prompt="Press E — gear up"
        promptOwner="guntable"
        onPickup={() => {
          // Gear ONLY — the wave director never reads ownership; combat
          // waits for the breaker switch (SwitchWall below).
          const s = useBoots.getState()
          s.giveWeapon('pistol')
          s.giveWeapon('rifle')
          s.setWeapon('rifle')
        }}
        fixtures={
          /* The placard is a FIXTURE: it outlives the pickup (and flips
           * to the taunt once you're geared). */
          <TableSign
            position={[0, TABLE_TOP, -0.28]}
            rotation={[0, 0, 0]}
            text={geared ? 'YOU ARE COOKED' : 'GEAR UP'}
          />
        }
      >
        {/* pistol on display — lying flat on the tabletop (owner call) */}
        <group position={[-0.4, TABLE_TOP + 0.03, 0.05]} rotation={[0, 0.45, 0]}>
          <group rotation={[-Math.PI / 2 + 0.08, Math.PI / 2, 0]} scale={1.3}>
            <PistolModel />
          </group>
        </group>
        {/* rifle on display — lying flat along the table (owner call) */}
        <group position={[0.35, TABLE_TOP + 0.04, -0.08]} rotation={[0, -0.12, 0]}>
          <group rotation={[-Math.PI / 2 + 0.06, Math.PI / 2, 0]} scale={1.15}>
            <RifleModel />
          </group>
        </group>
        {/* work boots, sitting beside the guns — toes toward the player
         * walking up (owner call: you should recognize the boots at a
         * glance), with a small placard behind them. */}
        <group position={[-0.68, TABLE_TOP, 0.12]} rotation={[0, Math.PI + 0.35, 0]}>
          <BootsPair />
        </group>
      </WeaponTable>
      <WeaponTable
        world={world}
        position={rearPos}
        yaw={world.spawnYaw}
        nodeId="__boots-table-2"
        taken={hasMinigun}
        prompt="Press E — the big one"
        promptOwner="guntable2"
        onPickup={() => {
          const s = useBoots.getState()
          s.giveWeapon('minigun')
          s.giveWeapon('hammer')
          s.setWeapon('minigun')
        }}
      >
        {/* the big one on display: the real model, laid along the table */}
        <Spin position={[0, TABLE_HEIGHT + 0.26, 0]}>
          <group scale={1.5} rotation={[0, Math.PI / 2, 0]}>
            <group position={[0, 0, 0.35]}>
              <MinigunModel />
            </group>
          </group>
        </Spin>
        {/* the warhammer, LEANING against the table's right end — flat on
            the tabletop it vanished behind the minigun from the spawn side
            (QA p4r1). Pommel on the floor just past the top's +x edge, the
            haft rests on the table-edge corner (z-roll 0.25 leans it toward
            -x; the pommel sits 0.18·cos(0.25) below the group origin), and
            the big steel head crowns ~4 cm above the tabletop where the
            approach sightline can't miss it. Pickup grants both weapons. */}
        <group position={[1.03, 0.18, 0.18]} rotation={[0, 0.15, 0.25]}>
          {ExternalWarhammer ? (
            <group scale={0.8}>
              <ExternalWarhammer />
            </group>
          ) : (
            <group scale={0.8}>
              <HammerModel />
            </group>
          )}
        </group>
      </WeaponTable>
      {/* The combat opt-in: sirens, placard and the breaker all live here. */}
      <SwitchWall position={switchPos} world={world} yaw={world.spawnYaw} />
    </>
  )
}

/** Slow display spin, in place around the item's own y axis. */
function Spin({ position, children }: { position: [number, number, number]; children: ReactNode }) {
  const ref = useRef<Group>(null)
  useFrame((_, dt) => {
    if (ref.current) ref.current.rotation.y += dt * 0.9
  })
  return (
    <group position={position} ref={ref}>
      {children}
    </group>
  )
}

const SWITCH_NODE_ID = '__boots-switch'

/** Lever pose: rotation.x of the pivot group. UP tips the big handle just
 * off vertical toward the player; DOWN throws it well past horizontal. */
const LEVER_UP = 0.35
const LEVER_DOWN = 2.7
/** The full throw sweeps in ~0.4 s (rad/s) — same lerp both directions. */
const LEVER_RATE = (LEVER_DOWN - LEVER_UP) / 0.4

/**
 * The switch wall: a short concrete stub by the spawn tables carrying the
 * industrial breaker switch — a massive two-hand knife-lever on a steel
 * backplate, handle UP at rest, thrown DOWN on E. That throw (armWaves) is
 * the ONLY way combat starts; the handle chases waveState.armed every frame
 * so it stays down for the whole assault and swings back up when
 * resetBots() restores the grace. The siren beacons and the PUT YOUR BOOTS
 * ON placard live here. The stub's slab + cap are real colliders (and a
 * voxelizable destruction target) exactly like the tables, and the E
 * interaction joins the tables' nearest-grabbable arbitration.
 */
function SwitchWall({
  world,
  position,
  yaw,
}: {
  world: GameWorld
  position: Vector3
  yaw: number
}) {
  const solidRefs = useRef<(Mesh | null)[]>([])
  const leverRef = useRef<Group>(null)
  const leverAngle = useRef(LEVER_UP)
  const prevE = useRef(false)
  const promptShown = useRef(false)
  const broken = useDestruction((s) => s.targets.has(SWITCH_NODE_ID))

  // Grab arbitration entry: the stub competes with the tables so one E
  // press serves exactly one fixture. `taken` mirrors waveState.armed —
  // refreshed per frame below (the flag lives outside React), so a thrown
  // switch stops prompting and a reset re-arms it without a remount.
  useEffect(() => {
    grabTables.set(SWITCH_NODE_ID, { x: position.x, z: position.z, taken: waveState.armed })
    return () => {
      grabTables.delete(SWITCH_NODE_ID)
    }
  }, [position])

  // The slab + cap are colliders for the session — the WeaponTable idiom:
  // the RENDERED meshes register, so voxelization hides exactly what the
  // player sees and the voxel replica is wall-shaped.
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
        nodeId: SWITCH_NODE_ID,
        nodeType: 'item',
      }
      world.colliders.push(entry)
      entries.push(entry)
    }
    return () => {
      for (const entry of entries) entry.disabled = true
    }
  }, [world])

  useFrame((_, dt) => {
    // The throw (and the reset): chase armed's target pose at the 0.4 s
    // sweep rate — a real handle motion, not a snap.
    const target = waveState.armed ? LEVER_DOWN : LEVER_UP
    if (leverAngle.current !== target) {
      const delta = target - leverAngle.current
      leverAngle.current += Math.sign(delta) * Math.min(Math.abs(delta), LEVER_RATE * dt)
      if (leverRef.current) leverRef.current.rotation.x = leverAngle.current
    }

    const session = getSession()
    if (!session) return
    const entry = grabTables.get(SWITCH_NODE_ID)
    if (entry) entry.taken = waveState.armed || broken
    const near =
      !waveState.armed &&
      !broken &&
      nearestGrabbable(playerRig.position.x, playerRig.position.z, grabTables) === SWITCH_NODE_ID
    if (near !== promptShown.current) {
      promptShown.current = near
      session.hud.prompt(near ? 'Press E — throw the switch' : null, 'switchwall')
    }
    const ePressed = session.input.state.keys.has('KeyE')
    if (near && ePressed && !prevE.current) {
      armWaves() // the ONLY combat trigger — the wave director takes over
      sfx.breakerThrow() // heavy knife-switch clunk — the assault is armed
      session.hud.prompt(null, 'switchwall')
      promptShown.current = false
    }
    prevE.current = ePressed
  })

  const [wallW, wallH, wallD] = SWITCH_WALL_SIZE
  return (
    <group position={[position.x, 0, position.z]} rotation={[0, yaw, 0]} userData={{ __boots: true }}>
      {/* the stub: chest-high concrete and a steel cap the sirens bolt onto */}
      <mesh
        castShadow
        position={[0, wallH / 2, 0]}
        ref={(mesh) => {
          solidRefs.current[0] = mesh
        }}
      >
        <boxGeometry args={[wallW, wallH, wallD]} />
        <meshStandardMaterial color="#8d9096" roughness={0.9} />
      </mesh>
      <mesh
        castShadow
        position={[0, wallH + 0.025, 0]}
        ref={(mesh) => {
          solidRefs.current[1] = mesh
        }}
      >
        <boxGeometry args={[wallW + 0.06, 0.05, wallD + 0.06]} />
        <meshStandardMaterial color="#3a3d42" metalness={0.4} roughness={0.55} />
      </mesh>
      {!broken && (
        <>
          {/* the industrial breaker switch, on the spawn-facing face */}
          <group position={[0, 0, wallD / 2]}>
            {/* steel backplate */}
            <mesh position={[0, 0.88, 0.03]}>
              <boxGeometry args={[0.42, 0.55, 0.06]} />
              <meshStandardMaterial color="#2a2d33" metalness={0.5} roughness={0.5} />
            </mesh>
            {/* hinge bosses on the pivot line */}
            {[-0.11, 0.11].map((x) => (
              <mesh key={x} position={[x, 0.72, 0.08]} rotation={[0, 0, Math.PI / 2]}>
                <cylinderGeometry args={[0.035, 0.035, 0.05, 10]} />
                <meshStandardMaterial color="#54565c" metalness={0.6} roughness={0.4} />
              </mesh>
            ))}
            {/* the massive two-hand lever — pivot at the hinge line */}
            <group position={[0, 0.72, 0.08]} ref={leverRef} rotation={[LEVER_UP, 0, 0]}>
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
          </group>
          {/* the marching orders moved here with the trigger */}
          <TableSign
            position={[0, 1.02, wallD / 2 + 0.005]}
            rotation={[0, 0, 0]}
            scale={0.9}
            text="PUT YOUR BOOTS ON"
          />
          {/* twin sirens on the cap — the primary carries the lot's single
           * always-mounted red pointLight (moved off the gear table). */}
          <SirenBeacon position={[-0.42, wallH + 0.05, 0]} primary />
          <SirenBeacon position={[0.42, wallH + 0.05, 0]} />
        </>
      )}
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

/** Small tabletop placard — canvas-textured board on a stub post. */
function TableSign({
  position,
  rotation,
  text,
  scale = 1,
}: {
  position: [number, number, number]
  rotation: [number, number, number]
  text: string
  /** Uniform shrink for the small build table — the position stays put. */
  scale?: number
}) {
  const texture = useMemo(() => {
    if (typeof document === 'undefined') return null
    const canvas = document.createElement('canvas')
    canvas.width = 768
    canvas.height = 96
    const g = canvas.getContext('2d')!
    g.fillStyle = '#efe8d8'
    g.fillRect(0, 0, 768, 96)
    g.strokeStyle = '#7a5c3e'
    g.lineWidth = 6
    g.strokeRect(3, 3, 762, 90)
    g.fillStyle = '#3a2f22'
    g.font = 'bold 44px system-ui, sans-serif'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText(text, 384, 50)
    return new CanvasTexture(canvas)
  }, [text])
  // R3F disposes the JSX material, never this externally created texture —
  // release it on unmount AND on every text flip or each session leaks one.
  useEffect(() => () => texture?.dispose(), [texture])
  return (
    <group position={position} rotation={rotation} scale={scale}>
      {[-0.42, 0.42].map((x) => (
        <mesh key={x} position={[x, 0.09, 0]}>
          <cylinderGeometry args={[0.008, 0.008, 0.18]} />
          <meshStandardMaterial color="#7a5c3e" roughness={0.8} />
        </mesh>
      ))}
      <mesh position={[0, 0.22, 0]}>
        <boxGeometry args={[1.02, 0.13, 0.014]} />
        {texture ? (
          <meshStandardMaterial map={texture} roughness={0.85} />
        ) : (
          <meshStandardMaterial color="#efe8d8" roughness={0.85} />
        )}
      </mesh>
    </group>
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

function WeaponTable({
  world,
  position,
  yaw,
  nodeId,
  size = TABLE_SIZE,
  taken,
  prompt,
  promptOwner,
  onPickup,
  fixtures,
  children,
}: {
  world: GameWorld
  position: Vector3
  yaw: number
  /** Destruction key — each table is its own voxelizable target. */
  nodeId: string
  /** Footprint (w, top thickness, d) — legs inset from the corners. */
  size?: [number, number, number]
  /** True once this table's gear is owned: displays gone, prompt off. */
  taken: boolean
  prompt: string
  promptOwner: string
  onPickup: () => void
  /** Persistent set dressing: survives the pickup, leaves only if the table
   * breaks (the siren beacon — its whole job happens AFTER `taken`). */
  fixtures?: ReactNode
  children: ReactNode
}) {
  const solidRefs = useRef<(Mesh | null)[]>([])
  const prevE = useRef(false)
  const promptShown = useRef(false)

  // Grab arbitration entry (see grabTables): prompt and pickup only engage
  // on the table nearestGrabbable elects, so overlapping discs never serve
  // one E press twice.
  useEffect(() => {
    grabTables.set(nodeId, { x: position.x, z: position.z, taken })
    return () => {
      grabTables.delete(nodeId)
    }
  }, [nodeId, position, taken])

  // Once the table voxelizes its solid meshes are ledger-hidden; the display
  // guns aren't colliders, so drop them here (blown off with the first hit).
  const broken = useDestruction((s) => s.targets.has(nodeId))

  // Register the rendered top + legs as colliders for the session. Using the
  // visible meshes themselves (not an invisible proxy) means voxelization
  // hides exactly what the player sees, and the voxel volume is table-shaped
  // — shoot the legs out and the top crumbles as an unsupported island.
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
        nodeId,
        nodeType: 'item',
      }
      world.colliders.push(entry)
      entries.push(entry)
    }
    return () => {
      for (const entry of entries) entry.disabled = true
    }
  }, [world, nodeId])

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

  return (
    <group position={[position.x, 0, position.z]} rotation={[0, yaw, 0]} userData={{ __boots: true }}>
      {/* top */}
      <mesh
        castShadow
        position={[0, TABLE_HEIGHT, 0]}
        ref={(mesh) => {
          solidRefs.current[0] = mesh
        }}
      >
        <boxGeometry args={size} />
        <meshStandardMaterial color="#6e5137" roughness={0.8} />
      </mesh>
      {/* legs — inset from the top's corners, whatever the footprint */}
      {[
        [-(size[0] / 2 - 0.1), -(size[2] / 2 - 0.08)],
        [size[0] / 2 - 0.1, -(size[2] / 2 - 0.08)],
        [-(size[0] / 2 - 0.1), size[2] / 2 - 0.08],
        [size[0] / 2 - 0.1, size[2] / 2 - 0.08],
      ].map(([x, z], i) => (
        <mesh
          key={i}
          position={[x!, TABLE_HEIGHT / 2, z!]}
          ref={(mesh) => {
            solidRefs.current[i + 1] = mesh
          }}
        >
          <boxGeometry args={[0.07, TABLE_HEIGHT, 0.07]} />
          <meshStandardMaterial color="#54402c" roughness={0.85} />
        </mesh>
      ))}
      {!broken && fixtures}
      {!taken && !broken && children}
    </group>
  )
}
