'use client'

import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import { NormalBlending } from 'three'
import { useBoots } from '../store'
import { sfx } from './audio'
import { buildCraterGeometry, buildScorchGeometry } from './craters'
import { prevoxelizeTick } from './destruction'
import {
  HammerModel,
  KnifeModel,
  MinigunModel,
  PistolModel,
  RifleModel,
} from './weapon-models'
import type { GameWorld } from './world'

/**
 * WebGPU pipeline pre-warm. Materials/lights that first appear MID-session
 * (weapon switch, siren light, bot spawns) each trigger pipeline
 * compilation — the "lag burst when picking up the guns". Rendering one of
 * everything far below the ground for the first few frames moves all of
 * that compile cost into the spawn moment, which is already a loading beat.
 * The warm meshes unmount after WARM_FRAMES.
 *
 * Perf round 2026-08-27 — two more first-use costs land here:
 *
 * - Crater pipelines (grenade finding B5): the first boom on the lawn used
 *   to compile the vertex-colored dirt patch AND the RGBA-vertex-color
 *   NormalBlending scorch decal at detonation time. The warm group now
 *   renders one tiny instance of each, built by craters.tsx's own geometry
 *   builders so the attribute layouts (vec3 color + normals / vec4 color)
 *   match the real pipelines exactly.
 *
 * - Lazy collider BVHs (minigun finding A1): world.ts builds each
 *   collider's MeshBVH on first `.bvh` touch, and before this warmup the
 *   whole deferred pile landed on the FIRST hitscan shot ("freezes then
 *   smooths out"). shooting.ts's new worldBox broadphase stops one shot
 *   from forcing them ALL, and this component drains the rest in the
 *   background: once the prevoxelize pass reports done (a zero-budget
 *   prevoxelizeTick is a cheap "all walls voxelized?" probe — never work),
 *   it touches a few colliders per frame under BVH_BUDGET_MS so the cost
 *   dissolves into the gear-up beat. Purely cache-warming — zero visual
 *   or behavioral change.
 *
 * Session start also primes the audio graph (sfx.prime): the 1 s noise
 * buffer fill + context/compressor build otherwise ran inside the first
 * shot's frame (finding A3).
 *
 * `world` is optional so game-root can pass its snapshot directly; without
 * the prop we read the same snapshot off the __boots dev handle ActiveGame
 * publishes on mount (read-only — never retained past the frame).
 */

const WARM_FRAMES = 6
/** Per-frame budget (ms) for background BVH builds — mirrors Prevoxelize. */
const BVH_BUDGET_MS = 4

function readWorldHandle(): GameWorld | null {
  const handle = (globalThis as { __boots?: { world?: GameWorld } }).__boots
  return handle?.world ?? null
}

export function PipelineWarmup({ world }: { world?: GameWorld } = {}) {
  const [done, setDone] = useState(false)
  const frames = useRef(0)
  const bvhCursor = useRef(0)
  const bvhDone = useRef(false)

  // First-use audio costs move into the session-start beat (finding A3).
  useEffect(() => {
    sfx.prime()
  }, [])

  // Tiny crater patch + scorch decal for the warm group — craters.tsx's own
  // builders so the warmed pipelines are the exact ones the first boom needs.
  const craterGeometry = useMemo(() => buildCraterGeometry(0.4, 1), [])
  const scorchGeometry = useMemo(() => buildScorchGeometry(0.4), [])
  useEffect(
    () => () => {
      craterGeometry.dispose()
      scorchGeometry.dispose()
    },
    [craterGeometry, scorchGeometry],
  )

  useFrame(() => {
    if (!done) {
      frames.current++
      if (frames.current >= WARM_FRAMES) setDone(true)
      return
    }
    // Background BVH warmup — after the warm meshes retire, and only once
    // the prevoxelize pass has finished (both tick at ~4 ms; never stack).
    if (bvhDone.current) return
    const w = world ?? readWorldHandle()
    if (!w) return
    if (!prevoxelizeTick(w, 0)) return
    const colliders = w.colliders
    const deadline = performance.now() + BVH_BUDGET_MS
    let i = bvhCursor.current
    while (i < colliders.length && performance.now() < deadline) {
      const collider = colliders[i]!
      // Touching the lazy getter builds + caches (WeakMap in world.ts);
      // disabled colliders handed collision to their voxel grids already.
      if (!collider.disabled) void collider.bvh
      i++
    }
    bvhCursor.current = i
    if (i >= colliders.length) bvhDone.current = true
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
      {/* crater dirt patch + scorch decal (material configs mirror
          craters.tsx's CraterMesh exactly — first-boom finding B5) */}
      <mesh geometry={craterGeometry} position={[1.0, 0, 0]}>
        <meshStandardMaterial
          polygonOffset
          polygonOffsetFactor={-1}
          polygonOffsetUnits={-1}
          roughness={1}
          vertexColors
        />
      </mesh>
      <mesh geometry={scorchGeometry} position={[1.4, 0, 0]}>
        <meshBasicMaterial
          blending={NormalBlending}
          depthWrite={false}
          polygonOffset
          polygonOffsetFactor={-2}
          polygonOffsetUnits={-2}
          transparent
          vertexColors
        />
      </mesh>
    </group>
  )
}
