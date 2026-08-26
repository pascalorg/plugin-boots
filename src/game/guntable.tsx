'use client'

import { useFrame } from '@react-three/fiber'
import { type ComponentType, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { CanvasTexture, type Group, Matrix4, type Mesh, type Object3D, Vector3 } from 'three'
import { useBoots } from '../store'
import { sfx } from './audio'
import { useDestruction } from './destruction'
import { waveState } from './enemies-state'
import { playerRig } from './player'
import { getSession } from './session'
import * as weaponModels from './weapon-models'
import { HammerModel, MinigunModel, PistolModel, RifleModel } from './weapon-models'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

/**
 * The gun tables: the small-arms table a few steps ahead of the player, and
 * the heavy table a bit farther BEHIND the spawn — turn around to find the
 * big rotary gun. Walk up, press E, gear up. Each table is a real collider
 * so it blocks movement and eats bullets like any other prop — the RENDERED
 * meshes double as the colliders, so when a table voxelizes the destruction
 * manager hides the very top + legs the player sees and the voxel replica
 * takes over ("everything should be able to break apart").
 *
 * Set dressing (phase 4):
 * - First table: a pair of work boots beside the guns, and the SIREN BEACON
 *   on the far corner. The beacon is a persistent fixture — it survives the
 *   pickup (that's when it matters) and only leaves if the table breaks.
 *   While the post-pickup alert countdown runs it spins its light ~7 rad/s,
 *   casts a small red point light, and drives sfx.sirenLoop quietly.
 * - Rear table: the warhammer lies next to the rotary gun; picking up there
 *   grants BOTH — the big one and the hammer join the loadout together.
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

const TABLE_SIZE: [number, number, number] = [1.7, 0.06, 0.8]
const TABLE_HEIGHT = 0.82
const TABLE_TOP = TABLE_HEIGHT + 0.03
const GRAB_RANGE = 2.4

export function tablePosition(world: GameWorld): Vector3 {
  const fwdX = -Math.sin(world.spawnYaw)
  const fwdZ = -Math.cos(world.spawnYaw)
  return new Vector3(
    world.spawn.x + fwdX * 2.6 - fwdZ * 0.9,
    0,
    world.spawn.z + fwdZ * 2.6 + fwdX * 0.9,
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
  const geared = useBoots((s) => s.owned.includes('rifle'))
  const hasMinigun = useBoots((s) => s.owned.includes('minigun'))

  return (
    <>
      <WeaponTable
        world={world}
        position={frontPos}
        yaw={world.spawnYaw}
        nodeId="__boots-table"
        taken={geared}
        prompt="Press E — gear up"
        promptOwner="guntable"
        onPickup={() => {
          const s = useBoots.getState()
          s.giveWeapon('pistol')
          s.giveWeapon('rifle')
          s.setWeapon('rifle')
        }}
        fixtures={
          <>
            <SirenBeacon />
            {/* The placard is a FIXTURE: it outlives the pickup (and flips
             * to the taunt once you're geared). */}
            <TableSign
              position={[0, TABLE_TOP, -0.28]}
              rotation={[0, 0, 0]}
              text={geared ? 'YOU ARE COOKED' : 'PUT YOUR BOOTS ON'}
            />
          </>
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
 * post-pickup ALERT_SECONDS countdown runs (false before, after, and on
 * resetBots()).
 */
function alertCountdownActive(): boolean {
  return waveState.countdownActive
}

/**
 * The siren beacon on the first table's corner. Dormant until the alert
 * countdown starts, then: the 'beacon-light' child (tagged by the model via
 * userData) spins ~7 rad/s, a small red point light exists for exactly the
 * countdown window, and sfx.sirenLoop plays quietly. Everything stops when
 * the countdown ends and on unmount.
 */
function SirenBeacon() {
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
    if (on && headRef.current) headRef.current.rotation.y += dt * 7
  })

  return (
    <group ref={rootRef} position={[0.76, TABLE_TOP, -0.3]}>
      <SirenModel />
      {/* ALWAYS mounted: adding a light mid-session recompiles pipelines
       * (the gear-up lag burst) — only intensity animates. */}
      <pointLight color="#ff2222" distance={6} intensity={active ? 2 : 0} position={[0, 0.14, 0]} />
    </group>
  )
}

/** Small tabletop placard — canvas-textured board on a stub post. */
function TableSign({
  position,
  rotation,
  text,
}: {
  position: [number, number, number]
  rotation: [number, number, number]
  text: string
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
  return (
    <group position={position} rotation={rotation}>
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
      Math.hypot(playerRig.position.x - position.x, playerRig.position.z - position.z) <
        GRAB_RANGE
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
        <boxGeometry args={TABLE_SIZE} />
        <meshStandardMaterial color="#6e5137" roughness={0.8} />
      </mesh>
      {/* legs */}
      {[
        [-0.75, -0.32],
        [0.75, -0.32],
        [-0.75, 0.32],
        [0.75, 0.32],
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
