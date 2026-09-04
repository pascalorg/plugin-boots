'use client'

import { useLayoutEffect, useMemo, useRef } from 'react'
import {
  BoxGeometry,
  CylinderGeometry,
  type InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three'
import { freezeStaticObject } from './nature'
import {
  ROAD_RENDER_HALF_LENGTH,
  ROAD_WIDTH,
  roadLoopFrame,
} from './road-loop'
import { type GameWorld, spawnGroundY } from './world'

/**
 * Long, repeating streetscape beside the lot. The road is one asphalt mesh,
 * two kerbs, and four instanced detail calls (markings, poles, arms, lamps):
 * its cost is effectively constant with distance instead of one React object
 * and draw call per streetlight. The visual corridor extends beyond the
 * vehicle wrap plane, hiding its geometric ends during a wrap.
 */

const ROAD_LENGTH = ROAD_RENDER_HALF_LENGTH * 2
const ROAD_LIFT = 0.035
const KERB_HEIGHT = 0.18
const KERB_WIDTH = 0.24
const LAMP_SPACING = 28
const LAMP_SIDE = ROAD_WIDTH / 2 + 1.05
const LAMP_HEIGHT = 6.8

const ASPHALT = new MeshStandardMaterial({ color: '#30353a', roughness: 0.96 })
const KERB = new MeshStandardMaterial({ color: '#9a9a94', roughness: 0.9 })
const MARKING = new MeshStandardMaterial({ color: '#eee9c9', roughness: 0.7 })
const POLE = new MeshStandardMaterial({ color: '#39434a', metalness: 0.5, roughness: 0.55 })
const LAMP = new MeshStandardMaterial({
  color: '#fff0bd',
  emissive: '#ffd98a',
  emissiveIntensity: 1.25,
  roughness: 0.35,
})

type RoadInstances = {
  dashes: Matrix4[]
  poles: Matrix4[]
  arms: Matrix4[]
  lamps: Matrix4[]
}

const IDENTITY = new Quaternion()
const UNIT = new Vector3(1, 1, 1)

export function buildRoadInstances(): RoadInstances {
  const dashes: Matrix4[] = []
  const poles: Matrix4[] = []
  const arms: Matrix4[] = []
  const lamps: Matrix4[] = []
  for (let x = -ROAD_RENDER_HALF_LENGTH + 4; x <= ROAD_RENDER_HALF_LENGTH - 4; x += 8) {
    dashes.push(new Matrix4().compose(new Vector3(x, ROAD_LIFT + 0.075, 0), IDENTITY, UNIT))
  }
  for (let x = -ROAD_RENDER_HALF_LENGTH + 14; x <= ROAD_RENDER_HALF_LENGTH - 14; x += LAMP_SPACING) {
    for (const side of [-1, 1]) {
      const z = side * LAMP_SIDE
      poles.push(new Matrix4().compose(new Vector3(x, LAMP_HEIGHT / 2, z), IDENTITY, UNIT))
      arms.push(
        new Matrix4().compose(
          new Vector3(x, LAMP_HEIGHT - 0.08, z - side * 0.55),
          IDENTITY,
          UNIT,
        ),
      )
      lamps.push(
        new Matrix4().compose(
          new Vector3(x, LAMP_HEIGHT - 0.16, z - side * 1.12),
          IDENTITY,
          UNIT,
        ),
      )
    }
  }
  return { dashes, poles, arms, lamps }
}

function upload(mesh: InstancedMesh | null, matrices: readonly Matrix4[]): void {
  if (!mesh) return
  for (let i = 0; i < matrices.length; i++) mesh.setMatrixAt(i, matrices[i]!)
  mesh.count = matrices.length
  mesh.instanceMatrix.needsUpdate = true
  mesh.computeBoundingSphere()
  mesh.frustumCulled = true
  freezeStaticObject(mesh)
}

export function EndlessRoad({ world }: { world: GameWorld }) {
  const frame = useMemo(() => roadLoopFrame(world), [world])
  const y = useMemo(
    () => spawnGroundY(world.colliders, frame.x, frame.z),
    [world, frame.x, frame.z],
  )
  const instances = useMemo(buildRoadInstances, [])
  const dashRef = useRef<InstancedMesh>(null)
  const poleRef = useRef<InstancedMesh>(null)
  const armRef = useRef<InstancedMesh>(null)
  const lampRef = useRef<InstancedMesh>(null)

  useLayoutEffect(() => {
    upload(dashRef.current, instances.dashes)
    upload(poleRef.current, instances.poles)
    upload(armRef.current, instances.arms)
    upload(lampRef.current, instances.lamps)
  }, [instances])

  return (
    <group
      name="boots-endless-streetscape"
      position={[frame.x, y, frame.z]}
      rotation={[0, frame.yaw, 0]}
      userData={{ __boots: true, __bootsRoadLoop: true }}
    >
      <mesh receiveShadow position={[0, ROAD_LIFT, 0]}>
        <boxGeometry args={[ROAD_LENGTH, 0.12, ROAD_WIDTH]} />
        <primitive attach="material" object={ASPHALT} />
      </mesh>
      {[-1, 1].map((side) => (
        <mesh
          key={side}
          receiveShadow
          position={[0, ROAD_LIFT + KERB_HEIGHT / 2, side * (ROAD_WIDTH / 2 + KERB_WIDTH / 2)]}
        >
          <boxGeometry args={[ROAD_LENGTH, KERB_HEIGHT, KERB_WIDTH]} />
          <primitive attach="material" object={KERB} />
        </mesh>
      ))}
      <instancedMesh ref={dashRef} args={[new BoxGeometry(3.6, 0.018, 0.12), MARKING, instances.dashes.length]} />
      <instancedMesh
        ref={poleRef}
        args={[new CylinderGeometry(0.075, 0.105, LAMP_HEIGHT, 7), POLE, instances.poles.length]}
      />
      <instancedMesh ref={armRef} args={[new BoxGeometry(0.08, 0.08, 1.2), POLE, instances.arms.length]} />
      <instancedMesh ref={lampRef} args={[new BoxGeometry(0.42, 0.12, 0.28), LAMP, instances.lamps.length]} />
    </group>
  )
}
