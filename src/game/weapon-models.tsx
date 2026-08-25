'use client'

/**
 * Low-poly primitive weapon models for the first-person viewmodel.
 *
 * Contract (consumed by viewmodel.tsx):
 * - Each component takes no props and renders in MODEL SPACE: grip at the
 *   origin, barrel pointing down -Z. The viewmodel wraps each in a bare
 *   visibility-toggle group, so model space == pose space.
 * - MUZZLE_OFFSETS gives the muzzle tip (flash anchor) per gun in that space.
 *
 * Style: chunky cartoony primitives, standard materials only (WebGPU-safe),
 * silhouettes that read instantly — slide/grip/guard for the pistol,
 * stock/receiver/mag/handguard for the rifle.
 */

export const MUZZLE_OFFSETS: Record<'pistol' | 'rifle', [number, number, number]> = {
  pistol: [0, 0.052, -0.27],
  rifle: [0, 0.06, -0.56],
}

const STEEL = '#2b2e33'
const STEEL_LIGHT = '#4a4f57'
const POLYMER = '#3a3d42'
const WOOD = '#6b4f33'
const WOOD_DARK = '#57402a'
const BLADE = '#c9ccd1'
const ACCENT = '#4d8fd1'

export function PistolModel() {
  return (
    <group>
      {/* Grip: raked back, hangs below the frame. */}
      <mesh position={[0, -0.045, 0.028]} rotation={[0.3, 0, 0]}>
        <boxGeometry args={[0.038, 0.115, 0.052]} />
        <meshStandardMaterial color={POLYMER} roughness={0.7} />
      </mesh>
      {/* Frame rail under the slide. */}
      <mesh position={[0, 0.018, -0.06]}>
        <boxGeometry args={[0.042, 0.03, 0.19]} />
        <meshStandardMaterial color={POLYMER} roughness={0.65} />
      </mesh>
      {/* Slide: the big block on top. */}
      <mesh position={[0, 0.052, -0.075]}>
        <boxGeometry args={[0.044, 0.042, 0.24]} />
        <meshStandardMaterial color={STEEL} metalness={0.45} roughness={0.4} />
      </mesh>
      {/* Rear slide serrations: lighter cap block. */}
      <mesh position={[0, 0.052, 0.032]}>
        <boxGeometry args={[0.047, 0.036, 0.03]} />
        <meshStandardMaterial color={STEEL_LIGHT} metalness={0.4} roughness={0.5} />
      </mesh>
      {/* Muzzle: barrel stub poking out of the slide. */}
      <mesh position={[0, 0.048, -0.2]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.013, 0.013, 0.03, 10]} />
        <meshStandardMaterial color="#17191c" metalness={0.55} roughness={0.3} />
      </mesh>
      {/* Sights. */}
      <mesh position={[0, 0.078, -0.185]}>
        <boxGeometry args={[0.008, 0.012, 0.012]} />
        <meshStandardMaterial color={STEEL} roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.078, 0.038]}>
        <boxGeometry args={[0.024, 0.01, 0.012]} />
        <meshStandardMaterial color={STEEL} roughness={0.5} />
      </mesh>
      {/* Trigger guard: front bar + lower bar. */}
      <mesh position={[0, -0.018, -0.052]}>
        <boxGeometry args={[0.012, 0.05, 0.01]} />
        <meshStandardMaterial color={POLYMER} roughness={0.7} />
      </mesh>
      <mesh position={[0, -0.04, -0.022]}>
        <boxGeometry args={[0.012, 0.01, 0.07]} />
        <meshStandardMaterial color={POLYMER} roughness={0.7} />
      </mesh>
      {/* Trigger. */}
      <mesh position={[0, -0.02, -0.024]} rotation={[0.25, 0, 0]}>
        <boxGeometry args={[0.008, 0.028, 0.007]} />
        <meshStandardMaterial color={STEEL_LIGHT} metalness={0.4} roughness={0.4} />
      </mesh>
    </group>
  )
}

export function RifleModel() {
  return (
    <group>
      {/* Pistol grip at the origin. */}
      <mesh position={[0, -0.04, 0.012]} rotation={[0.32, 0, 0]}>
        <boxGeometry args={[0.036, 0.1, 0.048]} />
        <meshStandardMaterial color={POLYMER} roughness={0.7} />
      </mesh>
      {/* Receiver. */}
      <mesh position={[0, 0.045, -0.07]}>
        <boxGeometry args={[0.048, 0.062, 0.3]} />
        <meshStandardMaterial color={STEEL} metalness={0.35} roughness={0.45} />
      </mesh>
      {/* Carry-rail / sight rib on top. */}
      <mesh position={[0, 0.083, -0.09]}>
        <boxGeometry args={[0.024, 0.014, 0.24]} />
        <meshStandardMaterial color={STEEL_LIGHT} metalness={0.3} roughness={0.5} />
      </mesh>
      {/* Handguard: chunky wooden forend. */}
      <mesh position={[0, 0.045, -0.3]}>
        <boxGeometry args={[0.044, 0.052, 0.18]} />
        <meshStandardMaterial color={WOOD} roughness={0.75} />
      </mesh>
      {/* Barrel. */}
      <mesh position={[0, 0.052, -0.46]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.013, 0.013, 0.18, 10]} />
        <meshStandardMaterial color="#1e2023" metalness={0.5} roughness={0.35} />
      </mesh>
      {/* Muzzle brake. */}
      <mesh position={[0, 0.052, -0.545]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.018, 0.018, 0.04, 10]} />
        <meshStandardMaterial color={STEEL_LIGHT} metalness={0.5} roughness={0.35} />
      </mesh>
      {/* Front sight post. */}
      <mesh position={[0, 0.085, -0.38]}>
        <boxGeometry args={[0.008, 0.02, 0.01]} />
        <meshStandardMaterial color={STEEL} roughness={0.5} />
      </mesh>
      {/* Magazine: curved forward, hangs under the receiver. */}
      <mesh position={[0, -0.035, -0.14]} rotation={[-0.28, 0, 0]}>
        <boxGeometry args={[0.036, 0.11, 0.05]} />
        <meshStandardMaterial color={STEEL_LIGHT} metalness={0.3} roughness={0.5} />
      </mesh>
      {/* Trigger guard. */}
      <mesh position={[0, -0.015, -0.05]}>
        <boxGeometry args={[0.012, 0.008, 0.07]} />
        <meshStandardMaterial color={POLYMER} roughness={0.7} />
      </mesh>
      {/* Stock: drops slightly and runs back over the shoulder. */}
      <mesh position={[0, 0.028, 0.14]} rotation={[-0.08, 0, 0]}>
        <boxGeometry args={[0.04, 0.055, 0.2]} />
        <meshStandardMaterial color={WOOD} roughness={0.75} />
      </mesh>
      {/* Butt pad. */}
      <mesh position={[0, 0.02, 0.245]}>
        <boxGeometry args={[0.044, 0.075, 0.024]} />
        <meshStandardMaterial color={WOOD_DARK} roughness={0.85} />
      </mesh>
    </group>
  )
}

export function KnifeModel() {
  return (
    <group>
      {/* Handle. */}
      <mesh position={[0, -0.01, 0.045]} rotation={[0.08, 0, 0]}>
        <boxGeometry args={[0.028, 0.036, 0.12]} />
        <meshStandardMaterial color="#2d2a26" roughness={0.8} />
      </mesh>
      {/* Pommel. */}
      <mesh position={[0, -0.005, 0.108]}>
        <boxGeometry args={[0.032, 0.04, 0.016]} />
        <meshStandardMaterial color={STEEL_LIGHT} metalness={0.4} roughness={0.4} />
      </mesh>
      {/* Cross guard. */}
      <mesh position={[0, -0.012, -0.02]}>
        <boxGeometry args={[0.02, 0.062, 0.016]} />
        <meshStandardMaterial color={STEEL_LIGHT} metalness={0.5} roughness={0.35} />
      </mesh>
      {/* Blade: thin, tall, slight upward sweep. */}
      <mesh position={[0, 0.002, -0.125]} rotation={[0.04, 0, 0]}>
        <boxGeometry args={[0.007, 0.046, 0.19]} />
        <meshStandardMaterial color={BLADE} metalness={0.7} roughness={0.25} />
      </mesh>
      {/* Tip: flattened cone taper. */}
      <mesh position={[0, 0.008, -0.235]} rotation={[-Math.PI / 2, 0, 0]} scale={[0.16, 1, 1]}>
        <coneGeometry args={[0.023, 0.05, 4]} />
        <meshStandardMaterial color={BLADE} metalness={0.7} roughness={0.25} />
      </mesh>
    </group>
  )
}

export function HammerModel() {
  return (
    <group>
      {/* Handle. */}
      <mesh position={[0, 0.02, 0]} rotation={[0, 0, 0]}>
        <cylinderGeometry args={[0.014, 0.017, 0.26, 8]} />
        <meshStandardMaterial color="#7a5c3e" roughness={0.8} />
      </mesh>
      {/* Head: the blueprint-blue block. */}
      <mesh position={[0, 0.16, -0.01]}>
        <boxGeometry args={[0.055, 0.05, 0.12]} />
        <meshStandardMaterial color={ACCENT} metalness={0.3} roughness={0.4} />
      </mesh>
      {/* Striking face. */}
      <mesh position={[0, 0.16, -0.078]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.024, 0.024, 0.02, 10]} />
        <meshStandardMaterial color={STEEL_LIGHT} metalness={0.45} roughness={0.35} />
      </mesh>
      {/* Claw: tapered wedge at the back. */}
      <mesh position={[0, 0.175, 0.07]} rotation={[-0.5, 0, 0]}>
        <boxGeometry args={[0.04, 0.016, 0.06]} />
        <meshStandardMaterial color={ACCENT} metalness={0.3} roughness={0.4} />
      </mesh>
    </group>
  )
}
