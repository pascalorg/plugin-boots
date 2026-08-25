'use client'

import { useMemo } from 'react'
import {
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  type InstancedMesh,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  RepeatWrapping,
  Vector3,
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { GameWorld } from './world'

/**
 * The lot: a grass field with scattered flora replacing the editor's flat
 * gray void. Optimization first — one InstancedMesh per species (grass is a
 * single draw call for ~20k blades), no shadows, static transforms, all
 * placement rejected out of the building's footprint.
 */

/** Deterministic RNG so re-entry looks identical. */
function mulberry32(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function groundTexture(): CanvasTexture | null {
  if (typeof document === 'undefined') return null
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const g = canvas.getContext('2d')!
  g.fillStyle = '#5d8a44'
  g.fillRect(0, 0, size, size)
  const rand = mulberry32(7)
  for (let i = 0; i < 900; i++) {
    const shade = 0.85 + rand() * 0.3
    g.fillStyle = `rgb(${Math.round(93 * shade)}, ${Math.round(138 * shade)}, ${Math.round(68 * shade)})`
    const r = 2 + rand() * 7
    g.beginPath()
    g.arc(rand() * size, rand() * size, r, 0, Math.PI * 2)
    g.fill()
  }
  const texture = new CanvasTexture(canvas)
  texture.wrapS = RepeatWrapping
  texture.wrapT = RepeatWrapping
  texture.repeat.set(28, 28)
  return texture
}

type Scatter = { matrices: Matrix4[]; colors: Color[] }

function scatter(
  world: GameWorld,
  seed: number,
  count: number,
  rMin: number,
  rMax: number,
  make: (rand: () => number, position: Vector3, matrix: Matrix4) => Color,
): Scatter {
  const rand = mulberry32(seed)
  const center = world.buildingAabb.isEmpty()
    ? new Vector3()
    : world.buildingAabb.getCenter(new Vector3())
  const pad = 1.6
  const min = world.buildingAabb.min
  const max = world.buildingAabb.max
  const matrices: Matrix4[] = []
  const colors: Color[] = []
  const position = new Vector3()
  let guard = count * 6
  while (matrices.length < count && guard-- > 0) {
    const angle = rand() * Math.PI * 2
    const radius = rMin + (rMax - rMin) * Math.sqrt(rand())
    position.set(center.x + Math.cos(angle) * radius, 0, center.z + Math.sin(angle) * radius)
    if (
      !world.buildingAabb.isEmpty() &&
      position.x > min.x - pad &&
      position.x < max.x + pad &&
      position.z > min.z - pad &&
      position.z < max.z + pad
    ) {
      continue
    }
    const matrix = new Matrix4()
    colors.push(make(rand, position, matrix))
    matrices.push(matrix)
  }
  return { matrices, colors }
}

function setInstances(mesh: InstancedMesh | null, data: Scatter): void {
  if (!mesh) return
  for (let i = 0; i < data.matrices.length; i++) {
    mesh.setMatrixAt(i, data.matrices[i]!)
    mesh.setColorAt(i, data.colors[i]!)
  }
  mesh.count = data.matrices.length
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
}

const GRASS_A = new Color('#6ea44f')
const GRASS_B = new Color('#4f7c38')
const _quat = new Quaternion()
const _scale = new Vector3()
const _yAxis = new Vector3(0, 1, 0)

export function Nature({ world }: { world: GameWorld }) {
  const texture = useMemo(groundTexture, [])

  const grassGeometry = useMemo(() => {
    const a = new PlaneGeometry(0.09, 1)
    const b = new PlaneGeometry(0.09, 1)
    b.rotateY(Math.PI / 2)
    const merged = mergeGeometries([a, b])!
    merged.translate(0, 0.5, 0)
    return merged
  }, [])

  const trunkGeometry = useMemo(
    () => new CylinderGeometry(0.14, 0.2, 2.4).translate(0, 1.2, 0),
    [],
  )
  const canopyGeometry = useMemo(() => new ConeGeometry(1.5, 3.4, 8).translate(0, 3.6, 0), [])

  const grass = useMemo(
    () =>
      scatter(world, 11, 20000, 2, 55, (rand, position, matrix) => {
        _quat.setFromAxisAngle(_yAxis, rand() * Math.PI)
        const h = 0.16 + rand() * 0.22
        _scale.set(1, h, 1)
        matrix.compose(position, _quat, _scale)
        return GRASS_A.clone().lerp(GRASS_B, rand())
      }),
    [world],
  )

  const trees = useMemo(
    () =>
      scatter(world, 23, 46, 12, 60, (rand, position, matrix) => {
        _quat.setFromAxisAngle(_yAxis, rand() * Math.PI * 2)
        const s = 0.8 + rand() * 0.9
        _scale.setScalar(s)
        matrix.compose(position, _quat, _scale)
        return new Color('#3f6d33').offsetHSL(0, 0, (rand() - 0.5) * 0.08)
      }),
    [world],
  )

  const bushes = useMemo(
    () =>
      scatter(world, 37, 70, 4, 45, (rand, position, matrix) => {
        _quat.setFromAxisAngle(_yAxis, rand() * Math.PI * 2)
        _scale.set(0.5 + rand() * 0.6, 0.35 + rand() * 0.3, 0.5 + rand() * 0.6)
        position.y = 0.15
        matrix.compose(position, _quat, _scale)
        return new Color('#54804a').offsetHSL(0, 0, (rand() - 0.5) * 0.1)
      }),
    [world],
  )

  const rocks = useMemo(
    () =>
      scatter(world, 51, 24, 6, 50, (rand, position, matrix) => {
        _quat.setFromAxisAngle(_yAxis, rand() * Math.PI * 2)
        _scale.set(0.25 + rand() * 0.5, 0.18 + rand() * 0.3, 0.25 + rand() * 0.5)
        position.y = 0.08
        matrix.compose(position, _quat, _scale)
        return new Color('#8d8d86').offsetHSL(0, 0, (rand() - 0.5) * 0.08)
      }),
    [world],
  )

  const center = world.buildingAabb.isEmpty()
    ? new Vector3()
    : world.buildingAabb.getCenter(new Vector3())

  return (
    <group userData={{ __boots: true }}>
      <mesh position={[center.x, 0.02, center.z]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[95, 48]} />
        {texture ? (
          <meshStandardMaterial map={texture} roughness={1} />
        ) : (
          <meshStandardMaterial color="#5d8a44" roughness={1} />
        )}
      </mesh>

      <instancedMesh
        args={[grassGeometry, undefined, grass.matrices.length]}
        frustumCulled={false}
        ref={(mesh) => setInstances(mesh, grass)}
      >
        <meshStandardMaterial roughness={1} side={2} />
      </instancedMesh>

      {/* Trees: trunk + canopy share the scatter transforms. */}
      <instancedMesh
        args={[trunkGeometry, undefined, trees.matrices.length]}
        frustumCulled={false}
        ref={(mesh) => {
          if (!mesh) return
          const trunk = new Color('#6b4f35')
          for (let i = 0; i < trees.matrices.length; i++) {
            mesh.setMatrixAt(i, trees.matrices[i]!)
            mesh.setColorAt(i, trunk)
          }
          mesh.count = trees.matrices.length
          mesh.instanceMatrix.needsUpdate = true
          if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
        }}
      >
        <meshStandardMaterial roughness={0.95} />
      </instancedMesh>
      <instancedMesh
        args={[canopyGeometry, undefined, trees.matrices.length]}
        frustumCulled={false}
        ref={(mesh) => setInstances(mesh, trees)}
      >
        <meshStandardMaterial roughness={0.95} />
      </instancedMesh>

      <instancedMesh
        args={[undefined, undefined, bushes.matrices.length]}
        frustumCulled={false}
        ref={(mesh) => setInstances(mesh, bushes)}
      >
        <icosahedronGeometry args={[0.6, 1]} />
        <meshStandardMaterial roughness={1} />
      </instancedMesh>

      <instancedMesh
        args={[undefined, undefined, rocks.matrices.length]}
        frustumCulled={false}
        ref={(mesh) => setInstances(mesh, rocks)}
      >
        <icosahedronGeometry args={[0.5, 0]} />
        <meshStandardMaterial roughness={0.9} />
      </instancedMesh>
    </group>
  )
}
