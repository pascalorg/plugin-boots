'use client'

import { useFrame } from '@react-three/fiber'
import { useRef } from 'react'
import type { Group } from 'three'
import { convoyPose } from './vehicle-state'

/**
 * Presentational low-poly cyber truck in metre-scale MODEL SPACE: the origin
 * is the truck's ground-plane center, its nose points down -Z, and +X is right.
 */

export const CYBER_TRUCK_SIZE: readonly [number, number, number] = [2.24, 1.9, 5.7]
export const CYBER_TRUCK_WHEELBASE = 3.6

const BODY = '#c8ccd0'
const GLASS = '#20262b'
const TYRE = '#141518'
const TRIM = '#2b2e33'
const LIGHT = '#ffd27a'
const TAIL_LIGHT = '#ef3c32'
const CABIN = '#30363b'

const WHEEL_POSITIONS: ReadonlyArray<readonly [number, number]> = [
  [-0.94, -CYBER_TRUCK_WHEELBASE / 2],
  [0.94, -CYBER_TRUCK_WHEELBASE / 2],
  [-0.94, CYBER_TRUCK_WHEELBASE / 2],
  [0.94, CYBER_TRUCK_WHEELBASE / 2],
]

const WHEEL_RADIUS = 0.42
/** Shared by the visible front wheels and the bicycle steering model. */
export const CYBER_TRUCK_MAX_STEER_ANGLE = 0.58
/** Full steering lock remains available around buildings. Above this speed,
 * lock falls inversely with velocity, keeping high-speed yaw rate bounded. */
export const CYBER_TRUCK_FULL_STEER_SPEED = 12

export function cyberTruckSteerAtSpeed(speed: number, steer: number): number {
  if (!Number.isFinite(speed) || !Number.isFinite(steer)) return 0
  const input = Math.max(-1, Math.min(1, steer))
  const scale = Math.min(1, CYBER_TRUCK_FULL_STEER_SPEED / Math.max(1, Math.abs(speed)))
  return input * scale
}

function TruckWheel({ x, z }: { x: number; z: number }) {
  const steerRef = useRef<Group>(null)
  const rollRef = useRef<Group>(null)
  const front = z < 0
  useFrame((_, dt) => {
    if (rollRef.current) {
      rollRef.current.rotation.x += (convoyPose.speed / WHEEL_RADIUS) * Math.min(dt, 1 / 30)
    }
    if (front && steerRef.current) {
      steerRef.current.rotation.y +=
        (cyberTruckSteerAtSpeed(convoyPose.speed, convoyPose.steer) *
          CYBER_TRUCK_MAX_STEER_ANGLE -
          steerRef.current.rotation.y) *
        (1 - Math.exp(-14 * Math.min(dt, 1 / 30)))
    }
  })
  return (
    <group ref={steerRef} position={[x, 0.42, z]}>
      <group ref={rollRef}>
        <mesh rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[WHEEL_RADIUS, WHEEL_RADIUS, 0.3, 12]} />
          <meshStandardMaterial color={TYRE} roughness={0.92} />
        </mesh>
        <mesh rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.19, 0.19, 0.315, 10]} />
          <meshStandardMaterial color={TRIM} metalness={0.55} roughness={0.38} />
        </mesh>
      </group>
    </group>
  )
}

const SIDE_WINDOW_POSITIONS: ReadonlyArray<readonly [number, number]> = [
  [-0.902, -0.08],
  [0.902, -0.08],
  [-0.902, 0.55],
  [0.902, 0.55],
]

export function CyberTruckModel() {
  return (
    <group>
      {/* Long, low stainless lower body, centered evenly between the bumpers. */}
      <mesh position={[0, 0.67, 0.1]}>
        <boxGeometry args={[1.9, 0.48, 5.1]} />
        <meshStandardMaterial color={BODY} metalness={0.6} roughness={0.35} />
      </mesh>
      <mesh position={[0, 0.98, -0.18]}>
        <boxGeometry args={[1.96, 0.32, 4.55]} />
        <meshStandardMaterial color={BODY} metalness={0.6} roughness={0.35} />
      </mesh>

      {/* The shallow hood and low front face establish the wedge-shaped nose. */}
      <mesh position={[0, 1.08, -1.75]} rotation={[-0.1, 0, 0]}>
        <boxGeometry args={[1.86, 0.18, 1.85]} />
        <meshStandardMaterial color={BODY} metalness={0.6} roughness={0.35} />
      </mesh>
      <mesh position={[0, 0.78, -2.72]}>
        <boxGeometry args={[1.9, 0.42, 0.26]} />
        <meshStandardMaterial color={BODY} metalness={0.6} roughness={0.35} />
      </mesh>
      <mesh position={[0, 0.49, -2.76]}>
        <boxGeometry args={[1.94, 0.18, 0.18]} />
        <meshStandardMaterial color={TRIM} metalness={0.35} roughness={0.5} />
      </mesh>
      {/* Warm full-width front light bar. */}
      <mesh position={[0, 0.84, -2.842]}>
        <boxGeometry args={[1.72, 0.075, 0.015]} />
        <meshBasicMaterial color={LIGHT} toneMapped={false} />
      </mesh>

      {/* Faceted cabin core, raked windshield, and thin roof cap. */}
      <mesh position={[0, 1.45, 0.28]}>
        <boxGeometry args={[1.78, 0.56, 1.32]} />
        <meshStandardMaterial color={BODY} metalness={0.6} roughness={0.35} />
      </mesh>
      <mesh position={[0, 1.8, 0.25]} rotation={[0.04, 0, 0]}>
        <boxGeometry args={[1.84, 0.14, 1.52]} />
        <meshStandardMaterial color={BODY} metalness={0.6} roughness={0.35} />
      </mesh>
      <mesh position={[0, 1.49, -0.71]} rotation={[0.61, 0, 0]}>
        <boxGeometry args={[1.7, 0.8, 0.045]} />
        <meshStandardMaterial
          color={GLASS}
          transparent
          opacity={0.52}
          metalness={0.1}
          roughness={0.2}
        />
      </mesh>
      {/* Stainless A-pillars frame the windshield's sharp rake. */}
      <mesh position={[-0.88, 1.49, -0.71]} rotation={[0.61, 0, 0]}>
        <boxGeometry args={[0.08, 0.82, 0.06]} />
        <meshStandardMaterial color={BODY} metalness={0.6} roughness={0.35} />
      </mesh>
      <mesh position={[0.88, 1.49, -0.71]} rotation={[0.61, 0, 0]}>
        <boxGeometry args={[0.08, 0.82, 0.06]} />
        <meshStandardMaterial color={BODY} metalness={0.6} roughness={0.35} />
      </mesh>

      {/* Paired dark side panes leave a solid central door pillar. */}
      {SIDE_WINDOW_POSITIONS.map(([x, z]) => (
        <mesh key={`${x}:${z}`} position={[x, 1.51, z]}>
          <boxGeometry args={[0.025, 0.42, 0.54]} />
          <meshStandardMaterial
            color={GLASS}
            transparent
            opacity={0.52}
            metalness={0.1}
            roughness={0.2}
          />
        </mesh>
      ))}
      <mesh position={[0, 1.51, 0.951]}>
        <boxGeometry args={[1.58, 0.38, 0.035]} />
        <meshStandardMaterial
          color={GLASS}
          transparent
          opacity={0.52}
          metalness={0.1}
          roughness={0.2}
        />
      </mesh>

      {/* A visible cabin matters in both chase view and through the glazing:
          two seats, dash and steering wheel replace the former empty box. */}
      {[-0.48, 0.48].map((x) => (
        <group key={`seat:${x}`} position={[x, 1.2, 0.25]}>
          <mesh position={[0, 0, 0.14]} rotation={[-0.12, 0, 0]}>
            <boxGeometry args={[0.46, 0.12, 0.48]} />
            <meshStandardMaterial color={CABIN} roughness={0.82} />
          </mesh>
          <mesh position={[0, 0.25, 0.34]} rotation={[-0.12, 0, 0]}>
            <boxGeometry args={[0.44, 0.52, 0.11]} />
            <meshStandardMaterial color={CABIN} roughness={0.82} />
          </mesh>
        </group>
      ))}
      <mesh position={[0, 1.24, -0.48]} rotation={[-0.14, 0, 0]}>
        <boxGeometry args={[1.58, 0.13, 0.42]} />
        <meshStandardMaterial color={TRIM} metalness={0.2} roughness={0.7} />
      </mesh>
      <mesh position={[-0.5, 1.4, -0.58]} rotation={[-0.2, 0, 0]}>
        <torusGeometry args={[0.17, 0.026, 8, 18]} />
        <meshStandardMaterial color="#17191c" roughness={0.85} />
      </mesh>

      {/* Mirrors, door shut-lines and handles give the broad slab sides
          scale without adding a texture payload. */}
      {[-1, 1].map((side) => (
        <group key={`side-detail:${side}`}>
          <mesh position={[side * 1.06, 1.47, -0.43]}>
            <boxGeometry args={[0.16, 0.13, 0.28]} />
            <meshStandardMaterial color={GLASS} metalness={0.35} roughness={0.28} />
          </mesh>
          <mesh position={[side * 0.988, 1.05, 0.25]}>
            <boxGeometry args={[0.014, 0.48, 1.48]} />
            <meshStandardMaterial color={TRIM} roughness={0.65} />
          </mesh>
          <mesh position={[side * 0.999, 1.22, 0.22]}>
            <boxGeometry args={[0.018, 0.035, 0.24]} />
            <meshStandardMaterial color={TRIM} metalness={0.45} roughness={0.45} />
          </mesh>
        </group>
      ))}

      {/* Open rear-third pickup bed: dark floor, raised rails, and tailgate. */}
      <mesh position={[0, 1.16, 1.83]}>
        <boxGeometry args={[1.56, 0.08, 1.68]} />
        <meshStandardMaterial color={TRIM} metalness={0.25} roughness={0.62} />
      </mesh>
      <mesh position={[-0.885, 1.25, 1.83]}>
        <boxGeometry args={[0.19, 0.32, 1.72]} />
        <meshStandardMaterial color={BODY} metalness={0.6} roughness={0.35} />
      </mesh>
      <mesh position={[0.885, 1.25, 1.83]}>
        <boxGeometry args={[0.19, 0.32, 1.72]} />
        <meshStandardMaterial color={BODY} metalness={0.6} roughness={0.35} />
      </mesh>
      <mesh position={[0, 1.08, 2.72]}>
        <boxGeometry args={[1.9, 0.42, 0.15]} />
        <meshStandardMaterial color={BODY} metalness={0.6} roughness={0.35} />
      </mesh>
      <mesh position={[0, 1.27, 2.798]}>
        <boxGeometry args={[1.72, 0.055, 0.018]} />
        <meshStandardMaterial color={TRIM} metalness={0.35} roughness={0.5} />
      </mesh>
      {[-0.7, 0.7].map((x) => (
        <mesh key={`tail-light:${x}`} position={[x, 1.09, 2.802]}>
          <boxGeometry args={[0.42, 0.07, 0.018]} />
          <meshBasicMaterial color={TAIL_LIGHT} toneMapped={false} />
        </mesh>
      ))}
      <mesh position={[0, 0.49, 2.75]}>
        <boxGeometry args={[1.94, 0.18, 0.2]} />
        <meshStandardMaterial color={TRIM} metalness={0.35} roughness={0.5} />
      </mesh>

      {/* Dark rocker strips sharpen the lower side-panel break. */}
      <mesh position={[-0.956, 0.61, 0.05]}>
        <boxGeometry args={[0.018, 0.13, 4.55]} />
        <meshStandardMaterial color={TRIM} metalness={0.25} roughness={0.6} />
      </mesh>
      <mesh position={[0.956, 0.61, 0.05]}>
        <boxGeometry args={[0.018, 0.13, 4.55]} />
        <meshStandardMaterial color={TRIM} metalness={0.25} roughness={0.6} />
      </mesh>

      {/* Four low-sided chunky tyres; their radius puts contact exactly at y=0. */}
      {WHEEL_POSITIONS.map(([x, z]) => <TruckWheel key={`wheel:${x}:${z}`} x={x} z={z} />)}
      {/* Faceted fender rings keep the stainless body visibly clear of the
          tyres and make the wheel wells read from a chase camera. */}
      {WHEEL_POSITIONS.map(([x, z]) => (
        <mesh key={`fender:${x}:${z}`} position={[Math.sign(x) * 1.005, 0.43, z]} rotation={[0, Math.PI / 2, 0]}>
          <torusGeometry args={[0.47, 0.035, 6, 16]} />
          <meshStandardMaterial color={TRIM} metalness={0.35} roughness={0.55} />
        </mesh>
      ))}
    </group>
  )
}
