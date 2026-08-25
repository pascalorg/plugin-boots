'use client'

import { useFrame } from '@react-three/fiber'
import { type ReactNode, useEffect, useMemo, useRef } from 'react'
import { type Group, Matrix4, type Mesh, Vector3 } from 'three'
import { type WeaponId, useBoots } from '../store'
import { sfx } from './audio'
import { useDestruction } from './destruction'
import { playerRig } from './player'
import { getSession } from './session'
import { MinigunModel } from './weapon-models'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

/**
 * The gun tables: the small-arms table a few steps ahead of the player, and
 * the heavy table a bit farther BEHIND the spawn — turn around to find the
 * big rotary gun. Walk up, press E, gear up. Each table is a real collider
 * so it blocks movement and eats bullets like any other prop — the RENDERED
 * meshes double as the colliders, so when a table voxelizes the destruction
 * manager hides the very top + legs the player sees and the voxel replica
 * takes over ("everything should be able to break apart").
 */

/** store.ts gains 'minigun' in WeaponId this round (builder-3x3 agent); this
 * cast bridges until it lands and collapses to a no-op after. */
const MINIGUN = 'minigun' as WeaponId

const TABLE_SIZE: [number, number, number] = [1.7, 0.06, 0.8]
const TABLE_HEIGHT = 0.82
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
    world.spawn.x - fwdX * 3 + fwdZ * 0.6,
    0,
    world.spawn.z - fwdZ * 3 - fwdX * 0.6,
  )
}

export function GunTable({ world }: { world: GameWorld }) {
  const frontPos = useMemo(() => tablePosition(world), [world])
  const rearPos = useMemo(() => minigunTablePosition(world), [world])
  const geared = useBoots((s) => s.owned.includes('rifle'))
  const hasMinigun = useBoots((s) => s.owned.includes(MINIGUN))

  return (
    <>
      <WeaponTable
        world={world}
        position={frontPos}
        yaw={world.spawnYaw}
        nodeId="__boots-table"
        taken={geared}
        prompt="E — Gear up"
        promptOwner="guntable"
        onPickup={() => {
          const s = useBoots.getState()
          s.giveWeapon('pistol')
          s.giveWeapon('rifle')
          s.setWeapon('rifle')
        }}
      >
        {/* pistol on display */}
        <Spin position={[-0.4, TABLE_HEIGHT + 0.12, 0]}>
          <mesh>
            <boxGeometry args={[0.05, 0.07, 0.26]} />
            <meshStandardMaterial color="#23262b" metalness={0.4} roughness={0.4} />
          </mesh>
        </Spin>
        {/* rifle on display */}
        <Spin position={[0.35, TABLE_HEIGHT + 0.14, 0]}>
          <mesh>
            <boxGeometry args={[0.06, 0.09, 0.72]} />
            <meshStandardMaterial color="#33363b" metalness={0.35} roughness={0.45} />
          </mesh>
        </Spin>
      </WeaponTable>
      <WeaponTable
        world={world}
        position={rearPos}
        yaw={world.spawnYaw}
        nodeId="__boots-table-2"
        taken={hasMinigun}
        prompt="E — The big one"
        promptOwner="guntable2"
        onPickup={() => {
          const s = useBoots.getState()
          s.giveWeapon(MINIGUN)
          s.setWeapon(MINIGUN)
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

function WeaponTable({
  world,
  position,
  yaw,
  nodeId,
  taken,
  prompt,
  promptOwner,
  onPickup,
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
      {!taken && !broken && children}
    </group>
  )
}
