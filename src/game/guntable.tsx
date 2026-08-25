'use client'

import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import { Matrix4, type Mesh, Vector3 } from 'three'
import { useBoots } from '../store'
import { sfx } from './audio'
import { useDestruction } from './destruction'
import { playerRig } from './player'
import { getSession } from './session'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

/**
 * The gun table: spawns a few steps from the player, guns laid out on top.
 * Walk up, press E, gear up. Also a real collider so it blocks movement
 * and eats bullets like any other prop — the RENDERED meshes double as the
 * colliders, so when the table voxelizes the destruction manager hides the
 * very top + legs the player sees and the voxel replica takes over
 * ("everything should be able to break apart").
 */

const TABLE_SIZE: [number, number, number] = [1.7, 0.06, 0.8]
const TABLE_HEIGHT = 0.82

export function tablePosition(world: GameWorld): Vector3 {
  const fwdX = -Math.sin(world.spawnYaw)
  const fwdZ = -Math.cos(world.spawnYaw)
  return new Vector3(
    world.spawn.x + fwdX * 2.6 - fwdZ * 0.9,
    0,
    world.spawn.z + fwdZ * 2.6 + fwdX * 0.9,
  )
}

export function GunTable({ world }: { world: GameWorld }) {
  const position = useMemo(() => tablePosition(world), [world])
  const spinRef = useRef<Mesh>(null)
  const spinRef2 = useRef<Mesh>(null)
  const solidRefs = useRef<(Mesh | null)[]>([])
  const prevE = useRef(false)
  const promptShown = useRef(false)

  const geared = useBoots((s) => s.owned.includes('rifle'))
  // Once the table voxelizes its solid meshes are ledger-hidden; the display
  // guns aren't colliders, so drop them here (blown off with the first hit).
  const broken = useDestruction((s) => s.targets.has('__boots-table'))

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
        nodeId: '__boots-table',
        nodeType: 'item',
      }
      world.colliders.push(entry)
      entries.push(entry)
    }
    return () => {
      for (const entry of entries) entry.disabled = true
    }
  }, [world])

  useFrame((state, dt) => {
    const session = getSession()
    if (!session) return
    if (spinRef.current) spinRef.current.rotation.y += dt * 0.9
    if (spinRef2.current) spinRef2.current.rotation.y += dt * 0.9

    const near =
      !geared &&
      Math.hypot(playerRig.position.x - position.x, playerRig.position.z - position.z) < 2.4
    if (near !== promptShown.current) {
      promptShown.current = near
      session.hud.prompt(near ? 'E — Gear up' : null, 'guntable')
    }
    const ePressed = session.input.state.keys.has('KeyE')
    if (near && ePressed && !prevE.current) {
      const s = useBoots.getState()
      s.giveWeapon('pistol')
      s.giveWeapon('rifle')
      s.setWeapon('rifle')
      sfx.pickup()
      session.hud.prompt(null, 'guntable')
      promptShown.current = false
    }
    prevE.current = ePressed
  })

  return (
    <group position={[position.x, 0, position.z]} rotation={[0, world.spawnYaw, 0]} userData={{ __boots: true }}>
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
      {!geared && !broken && (
        <>
          {/* pistol on display */}
          <mesh position={[-0.4, TABLE_HEIGHT + 0.12, 0]} ref={spinRef}>
            <boxGeometry args={[0.05, 0.07, 0.26]} />
            <meshStandardMaterial color="#23262b" metalness={0.4} roughness={0.4} />
          </mesh>
          {/* rifle on display */}
          <mesh position={[0.35, TABLE_HEIGHT + 0.14, 0]} ref={spinRef2}>
            <boxGeometry args={[0.06, 0.09, 0.72]} />
            <meshStandardMaterial color="#33363b" metalness={0.35} roughness={0.45} />
          </mesh>
        </>
      )}
    </group>
  )
}
