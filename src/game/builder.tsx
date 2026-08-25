'use client'

import { useFrame } from '@react-three/fiber'
import { useEffect, useRef, useState } from 'react'
import { BoxGeometry, Matrix4, type Group, type Mesh } from 'three'
import { type BuildPiece, type PlacedPiece, useBoots } from '../store'
import { sfx } from './audio'
import { EYE_HEIGHT } from './collision'
import { dropTarget } from './destruction'
import { playerRig } from './player'
import { getSession } from './session'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

/**
 * Build mode, battle-builder grammar: wall / floor / ramp (Q cycles), ghost
 * snapped to a 1.5 m grid + 90° yaw in front of you, LMB stamps it in.
 * Placements are game-only state — the panel's Keep converts walls into
 * real scene nodes afterwards, Discard forgets everything. G undoes.
 */

const GRID = 1.5
const WALL_H = 2.8
const LEVEL_STEP = 1.4

export const PIECE_DIMS: Record<BuildPiece, [number, number, number]> = {
  wall: [3, WALL_H, 0.12],
  floor: [3, 0.12, 3],
  ramp: [3, 0.12, 4.1],
}

const RAMP_TILT = -Math.atan2(WALL_H, 3)

export function piecePose(piece: BuildPiece, baseY: number): { y: number; tilt: number } {
  if (piece === 'wall') return { y: baseY + WALL_H / 2, tilt: 0 }
  if (piece === 'floor') return { y: baseY + 0.06, tilt: 0 }
  return { y: baseY + WALL_H / 2, tilt: RAMP_TILT }
}

const pieceGeometries = new Map<BuildPiece, BoxGeometry>()
function geometryFor(piece: BuildPiece): BoxGeometry {
  let geometry = pieceGeometries.get(piece)
  if (!geometry) {
    geometry = new BoxGeometry(...PIECE_DIMS[piece])
    pieceGeometries.set(piece, geometry)
  }
  return geometry
}

type GhostState = { x: number; y: number; z: number; yaw: number; piece: BuildPiece }

function snapGhost(piece: BuildPiece): GhostState {
  const fwdX = -Math.sin(playerRig.yaw)
  const fwdZ = -Math.cos(playerRig.yaw)
  const tx = playerRig.position.x + fwdX * 3.2
  const tz = playerRig.position.z + fwdZ * 3.2
  const feetY = playerRig.position.y - EYE_HEIGHT
  const baseY = Math.max(0, Math.round(feetY / LEVEL_STEP) * LEVEL_STEP)
  return {
    x: Math.round(tx / GRID) * GRID,
    y: baseY,
    z: Math.round(tz / GRID) * GRID,
    yaw: (Math.round(playerRig.yaw / (Math.PI / 2)) * Math.PI) / 2,
    piece,
  }
}

/** One placed piece: the RENDERED mesh doubles as its collider, so when the
 * piece voxelizes the destruction manager ledger-hides the mesh the player
 * sees and the voxel replica takes over. Pieces are immutable once placed —
 * register on mount, disable on unmount (undo). */
function PlacedPieceMesh({ piece, world }: { piece: PlacedPiece; world: GameWorld }) {
  const meshRef = useRef<Mesh>(null)

  useEffect(() => {
    const mesh = meshRef.current
    if (!mesh) return
    mesh.updateWorldMatrix(true, false)
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
    const entry: ColliderEntry = {
      mesh,
      bvh: bvhFor(mesh),
      inverse: new Matrix4().copy(mesh.matrixWorld).invert(),
      worldBox: mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld),
      root: mesh,
      nodeId: `__boots-piece-${piece.id}`,
      nodeType: 'block',
    }
    world.colliders.push(entry)
    return () => {
      entry.disabled = true
      // If the piece had voxelized, drop the replica too (G-undo would
      // otherwise leave carved voxels floating until exit).
      dropTarget(entry.nodeId)
    }
  }, [world, piece])

  const pose = piecePose(piece.piece, piece.position[1])
  return (
    <mesh
      castShadow
      geometry={geometryFor(piece.piece)}
      position={[piece.position[0], pose.y, piece.position[2]]}
      ref={meshRef}
      rotation={[piece.piece === 'ramp' ? pose.tilt : 0, piece.yaw, 0, 'YXZ']}
    >
      <meshStandardMaterial color="#9aa8b5" roughness={0.7} metalness={0.15} />
    </mesh>
  )
}

/** Solid, collidable render of everything placed this session. */
export function PlacedPieces({ world }: { world: GameWorld }) {
  const placed = useBoots((s) => s.placed)
  return (
    <group userData={{ __boots: true }}>
      {placed.map((piece) => (
        <PlacedPieceMesh key={piece.id} piece={piece} world={world} />
      ))}
    </group>
  )
}

export function Builder() {
  const ghostRef = useRef<Group>(null)
  const [ghost, setGhost] = useState<GhostState | null>(null)
  const prevFire = useRef(false)
  const prevUndo = useRef(false)
  const placeCooldown = useRef(0)

  const weapon = useBoots((s) => s.weapon)
  const buildPiece = useBoots((s) => s.buildPiece)
  const active = weapon === 'builder'

  useFrame((_, dt) => {
    const session = getSession()
    if (!session) return
    placeCooldown.current -= dt

    if (!active) {
      if (ghost) setGhost(null)
      prevFire.current = session.input.state.firing
      return
    }

    const next = snapGhost(buildPiece)
    if (
      !ghost ||
      ghost.x !== next.x ||
      ghost.y !== next.y ||
      ghost.z !== next.z ||
      ghost.yaw !== next.yaw ||
      ghost.piece !== next.piece
    ) {
      setGhost(next)
    }

    const firing = session.input.state.firing
    if (firing && !prevFire.current && placeCooldown.current <= 0 && ghost) {
      placeCooldown.current = 0.22
      useBoots.getState().addPlaced({
        piece: ghost.piece,
        position: [ghost.x, ghost.y, ghost.z],
        yaw: ghost.yaw,
      })
      sfx.place()
    }
    prevFire.current = firing

    const undoDown = session.input.state.keys.has('KeyG')
    if (undoDown && !prevUndo.current) {
      const removed = useBoots.getState().removeLastPlaced()
      if (removed) sfx.weaponSwitch()
    }
    prevUndo.current = undoDown
  })

  if (!active || !ghost) return null
  const pose = piecePose(ghost.piece, ghost.y)
  return (
    <group ref={ghostRef} userData={{ __boots: true }}>
      <mesh
        position={[ghost.x, pose.y, ghost.z]}
        rotation={[ghost.piece === 'ramp' ? pose.tilt : 0, ghost.yaw, 0, 'YXZ']}
      >
        <boxGeometry args={PIECE_DIMS[ghost.piece]} />
        <meshBasicMaterial color="#59a7ff" depthWrite={false} opacity={0.38} transparent />
      </mesh>
    </group>
  )
}
