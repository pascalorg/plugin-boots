'use client'

import { useFrame } from '@react-three/fiber'
import { useLayoutEffect, useMemo, useRef } from 'react'
import { Color, DynamicDrawUsage, type InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three'
import { useDestruction, type VoxelWall } from './destruction'

/**
 * Renders every damaged wall as one InstancedMesh of voxels (plus its
 * framing, revealed as the shell breaks). Voxel removal writes a zero-scale
 * matrix at the voxel's index — indices stay stable, uploads stay small.
 */

const _matrix = new Matrix4()
const _pos = new Vector3()
const _scale = new Vector3()
const _quat = new Quaternion()
const _color = new Color()
const ZERO = new Matrix4().makeScale(0, 0, 0)

function VoxelWallMesh({ wall }: { wall: VoxelWall }) {
  const meshRef = useRef<InstancedMesh>(null!)
  const revision = useRef(-1)

  useLayoutEffect(() => {
    const mesh = meshRef.current
    const { grid } = wall
    mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    const size = grid.cell * 0.99
    _scale.setScalar(size)
    _quat.identity()
    for (let i = 0; i < grid.count; i++) {
      if (grid.alive[i]) {
        _pos.set(grid.centers[i * 3]!, grid.centers[i * 3 + 1]!, grid.centers[i * 3 + 2]!)
        _matrix.compose(_pos, _quat, _scale)
        mesh.setMatrixAt(i, _matrix)
      } else {
        mesh.setMatrixAt(i, ZERO)
      }
      // Subtle per-voxel shade jitter — the "block" read.
      const jitter = ((i * 2654435761) % 97) / 97
      _color.copy(wall.baseColor).offsetHSL(0, 0, (jitter - 0.5) * 0.09)
      mesh.setColorAt(i, _color)
    }
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    mesh.frustumCulled = false
    revision.current = wall.revision
  }, [wall])

  useFrame(() => {
    const mesh = meshRef.current
    if (!mesh || revision.current === wall.revision) return
    revision.current = wall.revision
    for (const idx of wall.removedQueue.splice(0)) {
      mesh.setMatrixAt(idx, ZERO)
    }
    mesh.instanceMatrix.needsUpdate = true
  })

  return (
    <group userData={{ __boots: true }}>
      <instancedMesh args={[undefined, undefined, wall.grid.count]} ref={meshRef}>
        <boxGeometry />
        <meshStandardMaterial roughness={0.92} />
      </instancedMesh>
      {wall.studs.map((stud, i) => (
        <mesh
          key={`${wall.nodeId}-stud-${i}`}
          position={stud.center}
          rotation={[0, -stud.yaw, 0]}
        >
          <boxGeometry args={stud.size} />
          <meshStandardMaterial color="#b08d57" roughness={0.85} />
        </mesh>
      ))}
    </group>
  )
}

export function VoxelWalls() {
  const version = useDestruction((s) => s.version)
  const walls = useMemo(() => {
    void version
    return Array.from(useDestruction.getState().walls.values())
  }, [version])
  return (
    <>
      {walls.map((wall) => (
        <VoxelWallMesh key={wall.nodeId} wall={wall} />
      ))}
    </>
  )
}
