'use client'

import { useFrame } from '@react-three/fiber'
import { useLayoutEffect, useMemo, useRef } from 'react'
import {
  Color,
  DynamicDrawUsage,
  type InstancedMesh,
  Matrix4,
  type Mesh,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three'
import { useDestruction, type VoxelTarget } from './destruction'

/**
 * Renders every voxelized target as one InstancedMesh of voxels (for walls:
 * the two drywall skins), plus the stud cavity revealed as the shell breaks.
 * Voxel removal writes a zero-scale matrix at the voxel's index — indices
 * stay stable, uploads stay small.
 *
 * Studs are individual meshes (≤ ~40 per wall) driven by StudMember state:
 * intact = wood box, damaged (hp below max) = darker tint + pinched
 * cross-section (the dent), broken = hidden (debris already covered the
 * fall). Chip damage does NOT bump the target revision (only breaks do), so
 * stud visuals sync every frame — an allocation-free pass of plain
 * assignments over a handful of meshes.
 */

const _matrix = new Matrix4()
const _pos = new Vector3()
const _scale = new Vector3()
const _quat = new Quaternion()
const _color = new Color()
const ZERO = new Matrix4().makeScale(0, 0, 0)
const UP = new Vector3(0, 1, 0)

// Shared stud materials — swapped per mesh on damage, never mutated.
const STUD_WOOD = new MeshStandardMaterial({ color: '#b08d57', roughness: 0.85 })
const STUD_WOOD_DAMAGED = new MeshStandardMaterial({ color: '#8f6f45', roughness: 0.85 })

/** Apply StudMember state to the stud meshes: visibility, tint, dent. */
function syncStuds(target: VoxelTarget, refs: (Mesh | null)[], maxHp: number): void {
  for (let i = 0; i < target.studs.length; i++) {
    const mesh = refs[i]
    if (!mesh) continue
    const stud = target.studs[i]!
    mesh.visible = !stud.broken
    if (stud.broken) continue
    const damaged = stud.hp < maxHp
    mesh.material = damaged ? STUD_WOOD_DAMAGED : STUD_WOOD
    if (damaged) {
      // The dent: pinch the cross-section, keep the long axis full length
      // (plates lie sideways, so pick axes by size instead of assuming Y).
      const pinch = 0.6 + (0.4 * Math.max(0, stud.hp)) / maxHp
      const [sx, sy, sz] = stud.size
      if (sx >= sy && sx >= sz) mesh.scale.set(1, pinch, pinch)
      else if (sy >= sx && sy >= sz) mesh.scale.set(pinch, 1, pinch)
      else mesh.scale.set(pinch, pinch, 1)
    } else {
      mesh.scale.set(1, 1, 1)
    }
  }
}

function VoxelWallMesh({ wall }: { wall: VoxelTarget }) {
  const meshRef = useRef<InstancedMesh>(null!)
  const studRefs = useRef<(Mesh | null)[]>([])
  const studMaxHp = useRef(1)
  const revision = useRef(-1)

  useLayoutEffect(() => {
    const mesh = meshRef.current
    const { grid } = wall
    mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    // Per-axis scale: anisotropic wall grids have thin skin cells along the
    // thickness axis — a uniform grid.cell cube would visually fill the cavity.
    _scale.set(grid.cellX * 0.99, grid.cellY * 0.99, grid.cellZ * 0.99)
    // Yaw-local grids (diagonal walls): cells are axis-aligned in the grid's
    // rotated frame — rotate each instance out to world (matches stud meshes'
    // rotation={[0, -yaw, 0]}). World-aligned grids keep identity.
    if (grid.yaw === 0) _quat.identity()
    else _quat.setFromAxisAngle(UP, -grid.yaw)
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
    // Full hp = the healthiest member at voxelize time (fresh studs are
    // all at max; robust even if we mount mid-fight).
    let max = 1
    for (const stud of wall.studs) if (stud.hp > max) max = stud.hp
    studMaxHp.current = max
    syncStuds(wall, studRefs.current, max)
  }, [wall])

  useFrame(() => {
    const mesh = meshRef.current
    if (!mesh) return
    if (revision.current !== wall.revision) {
      revision.current = wall.revision
      for (const idx of wall.removedQueue.splice(0)) {
        mesh.setMatrixAt(idx, ZERO)
      }
      mesh.instanceMatrix.needsUpdate = true
    }
    // Studs sync unconditionally: chips (hp loss without break) never bump
    // revision. Plain assignments only — no allocations.
    syncStuds(wall, studRefs.current, studMaxHp.current)
  })

  return (
    <group userData={{ __boots: true }}>
      <instancedMesh args={[undefined, undefined, wall.grid.count]} ref={meshRef}>
        <boxGeometry />
        <meshStandardMaterial roughness={0.92} />
      </instancedMesh>
      {wall.studs.map((stud, i) => (
        <mesh
          key={`${wall.nodeId}-stud-${stud.id}`}
          material={STUD_WOOD}
          position={stud.center}
          ref={(m: Mesh | null) => {
            studRefs.current[i] = m
          }}
          rotation={[0, -stud.yaw, 0]}
        >
          <boxGeometry args={stud.size} />
        </mesh>
      ))}
    </group>
  )
}

export function VoxelWalls() {
  const version = useDestruction((s) => s.version)
  const walls = useMemo(() => {
    void version
    return Array.from(useDestruction.getState().targets.values())
  }, [version])
  return (
    <>
      {walls.map((wall) => (
        <VoxelWallMesh key={wall.nodeId} wall={wall} />
      ))}
    </>
  )
}
