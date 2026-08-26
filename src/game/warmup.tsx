'use client'

import { useFrame } from '@react-three/fiber'
import { useState } from 'react'
import { useBoots } from '../store'
import {
  HammerModel,
  KnifeModel,
  MinigunModel,
  PistolModel,
  RifleModel,
} from './weapon-models'

/**
 * WebGPU pipeline pre-warm. Materials/lights that first appear MID-session
 * (weapon switch, siren light, bot spawns) each trigger pipeline
 * compilation — the "lag burst when picking up the guns". Rendering one of
 * everything far below the ground for the first few frames moves all of
 * that compile cost into the spawn moment, which is already a loading beat.
 * Unmounts itself after WARM_FRAMES.
 */

const WARM_FRAMES = 6

export function PipelineWarmup() {
  const [done, setDone] = useState(false)
  const frames = { current: 0 } as { current: number }

  useFrame(() => {
    if (done) return
    frames.current++
    if (frames.current >= WARM_FRAMES) setDone(true)
  })

  // Re-warm on every session (component remounts with ActiveGame).
  const phase = useBoots((s) => s.phase)
  if (done || phase !== 'game') return null

  return (
    <group position={[0, -60, 0]} userData={{ __boots: true }}>
      <KnifeModel />
      <PistolModel />
      <RifleModel />
      <MinigunModel />
      <HammerModel />
      {/* bot material palette (droid panels / dog yellow / drone dark + LED) */}
      <mesh>
        <boxGeometry args={[0.1, 0.1, 0.1]} />
        <meshStandardMaterial color="#dfe3e8" metalness={0.35} roughness={0.4} />
      </mesh>
      <mesh position={[0.2, 0, 0]}>
        <boxGeometry args={[0.1, 0.1, 0.1]} />
        <meshStandardMaterial color="#e8b23a" metalness={0.3} roughness={0.5} />
      </mesh>
      <mesh position={[0.4, 0, 0]}>
        <sphereGeometry args={[0.05]} />
        <meshStandardMaterial color="#ff3b30" />
      </mesh>
      {/* wood + drywall + glass-shard debris tints */}
      <mesh position={[0.6, 0, 0]}>
        <boxGeometry args={[0.1, 0.1, 0.1]} />
        <meshStandardMaterial color="#8a6a43" roughness={0.9} />
      </mesh>
      <mesh position={[0.8, 0, 0]}>
        <planeGeometry args={[0.1, 0.1]} />
        <meshBasicMaterial color="#ffd27a" depthWrite={false} transparent opacity={0.9} />
      </mesh>
    </group>
  )
}
