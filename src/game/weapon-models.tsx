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
 * silhouettes tuned to read at the low-right viewmodel pose — every weapon
 * gets per-part color contrast (dark frame / light steel / wood / one blue
 * accent) so the shapes separate at a glance. Static JSX only.
 */

export const MUZZLE_OFFSETS: Record<'pistol' | 'rifle', [number, number, number]> = {
  pistol: [0, 0.05, -0.26],
  rifle: [0, 0.055, -0.61],
}

const STEEL = '#2b2e33'
const STEEL_LIGHT = '#4a4f57'
const STEEL_DARK = '#17191c'
const POLYMER = '#3a3d42'
const POLYMER_DARK = '#2a2c30'
const WOOD = '#6b4f33'
const WOOD_DARK = '#57402a'
const BLADE = '#c9ccd1'
const BLADE_EDGE = '#eef1f4'
const ACCENT = '#4d8fd1'
const ACCENT_LIGHT = '#7db3e8'

export function PistolModel() {
  return (
    <group>
      {/* Grip: raked back, hangs below the frame. */}
      <mesh position={[0, -0.05, 0.03]} rotation={[0.32, 0, 0]}>
        <boxGeometry args={[0.04, 0.125, 0.055]} />
        <meshStandardMaterial color={POLYMER} roughness={0.7} />
      </mesh>
      {/* Stipple band: darker inset panel around the middle of the grip. */}
      <mesh position={[0, -0.055, 0.032]} rotation={[0.32, 0, 0]}>
        <boxGeometry args={[0.043, 0.062, 0.052]} />
        <meshStandardMaterial color={POLYMER_DARK} roughness={0.85} />
      </mesh>
      {/* Magazine baseplate: accent pop at the bottom of the grip. */}
      <mesh position={[0, -0.112, 0.05]} rotation={[0.32, 0, 0]}>
        <boxGeometry args={[0.044, 0.018, 0.06]} />
        <meshStandardMaterial color={ACCENT} roughness={0.5} />
      </mesh>
      {/* Beavertail: little shelf where the hand meets the slide. */}
      <mesh position={[0, 0.028, 0.062]} rotation={[0.32, 0, 0]}>
        <boxGeometry args={[0.036, 0.014, 0.045]} />
        <meshStandardMaterial color={POLYMER} roughness={0.7} />
      </mesh>
      {/* Frame / dust cover under the slide. */}
      <mesh position={[0, 0.016, -0.09]}>
        <boxGeometry args={[0.042, 0.032, 0.21]} />
        <meshStandardMaterial color={POLYMER} roughness={0.65} />
      </mesh>
      {/* Accessory rail nub at the front of the frame. */}
      <mesh position={[0, -0.002, -0.16]}>
        <boxGeometry args={[0.03, 0.012, 0.06]} />
        <meshStandardMaterial color={POLYMER_DARK} roughness={0.7} />
      </mesh>
      {/* Slide: the big steel block on top. */}
      <mesh position={[0, 0.054, -0.08]}>
        <boxGeometry args={[0.046, 0.044, 0.27]} />
        <meshStandardMaterial color={STEEL} metalness={0.45} roughness={0.4} />
      </mesh>
      {/* Slide top rib: lighter strip that catches the light. */}
      <mesh position={[0, 0.077, -0.08]}>
        <boxGeometry args={[0.028, 0.006, 0.26]} />
        <meshStandardMaterial color={STEEL_LIGHT} metalness={0.4} roughness={0.45} />
      </mesh>
      {/* Ejection port: dark inset on the right flank. */}
      <mesh position={[0.021, 0.058, -0.02]}>
        <boxGeometry args={[0.01, 0.026, 0.05]} />
        <meshStandardMaterial color={STEEL_DARK} metalness={0.5} roughness={0.35} />
      </mesh>
      {/* Rear slide serrations: lighter cap block. */}
      <mesh position={[0, 0.054, 0.042]}>
        <boxGeometry args={[0.049, 0.038, 0.035]} />
        <meshStandardMaterial color={STEEL_LIGHT} metalness={0.4} roughness={0.5} />
      </mesh>
      {/* Hammer: small nub tipped back off the rear of the slide. */}
      <mesh position={[0, 0.074, 0.068]} rotation={[-0.5, 0, 0]}>
        <boxGeometry args={[0.012, 0.026, 0.012]} />
        <meshStandardMaterial color={STEEL_LIGHT} metalness={0.45} roughness={0.4} />
      </mesh>
      {/* Muzzle: barrel stub poking out of the slide. */}
      <mesh position={[0, 0.05, -0.222]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.014, 0.014, 0.035, 10]} />
        <meshStandardMaterial color={STEEL_DARK} metalness={0.55} roughness={0.3} />
      </mesh>
      {/* Front sight post. */}
      <mesh position={[0, 0.084, -0.2]}>
        <boxGeometry args={[0.008, 0.014, 0.012]} />
        <meshStandardMaterial color={STEEL} roughness={0.5} />
      </mesh>
      {/* Rear sight: two ears with a notch between them. */}
      <mesh position={[-0.011, 0.084, 0.05]}>
        <boxGeometry args={[0.009, 0.012, 0.012]} />
        <meshStandardMaterial color={STEEL} roughness={0.5} />
      </mesh>
      <mesh position={[0.011, 0.084, 0.05]}>
        <boxGeometry args={[0.009, 0.012, 0.012]} />
        <meshStandardMaterial color={STEEL} roughness={0.5} />
      </mesh>
      {/* Trigger guard: front bar + lower bar close the loop. */}
      <mesh position={[0, -0.02, -0.062]}>
        <boxGeometry args={[0.014, 0.055, 0.012]} />
        <meshStandardMaterial color={POLYMER} roughness={0.7} />
      </mesh>
      <mesh position={[0, -0.045, -0.028]}>
        <boxGeometry args={[0.014, 0.012, 0.08]} />
        <meshStandardMaterial color={POLYMER} roughness={0.7} />
      </mesh>
      {/* Trigger: accent blue so it pops inside the guard. */}
      <mesh position={[0, -0.022, -0.03]} rotation={[0.25, 0, 0]}>
        <boxGeometry args={[0.008, 0.03, 0.008]} />
        <meshStandardMaterial color={ACCENT_LIGHT} metalness={0.3} roughness={0.4} />
      </mesh>
    </group>
  )
}

export function RifleModel() {
  return (
    <group>
      {/* Pistol grip at the origin. */}
      <mesh position={[0, -0.045, 0.015]} rotation={[0.34, 0, 0]}>
        <boxGeometry args={[0.038, 0.105, 0.05]} />
        <meshStandardMaterial color={POLYMER} roughness={0.7} />
      </mesh>
      {/* Grip cap. */}
      <mesh position={[0, -0.092, 0.032]} rotation={[0.34, 0, 0]}>
        <boxGeometry args={[0.041, 0.014, 0.054]} />
        <meshStandardMaterial color={POLYMER_DARK} roughness={0.8} />
      </mesh>
      {/* Receiver: long steel block, the spine of the gun. */}
      <mesh position={[0, 0.048, -0.06]}>
        <boxGeometry args={[0.05, 0.066, 0.32]} />
        <meshStandardMaterial color={STEEL} metalness={0.35} roughness={0.45} />
      </mesh>
      {/* Ejection port: dark inset on the right flank. */}
      <mesh position={[0.026, 0.05, -0.03]}>
        <boxGeometry args={[0.006, 0.03, 0.07]} />
        <meshStandardMaterial color={STEEL_DARK} metalness={0.45} roughness={0.35} />
      </mesh>
      {/* Charging handle: little tab on the right rear. */}
      <mesh position={[0.032, 0.068, 0.02]}>
        <boxGeometry args={[0.018, 0.012, 0.03]} />
        <meshStandardMaterial color={STEEL_LIGHT} metalness={0.4} roughness={0.4} />
      </mesh>
      {/* Carry-rail / sight rib on top. */}
      <mesh position={[0, 0.088, -0.07]}>
        <boxGeometry args={[0.026, 0.014, 0.26]} />
        <meshStandardMaterial color={STEEL_LIGHT} metalness={0.3} roughness={0.5} />
      </mesh>
      {/* Rear sight block. */}
      <mesh position={[0, 0.102, 0.03]}>
        <boxGeometry args={[0.03, 0.018, 0.04]} />
        <meshStandardMaterial color={STEEL} metalness={0.35} roughness={0.45} />
      </mesh>
      {/* Handguard: chunky wooden forend. */}
      <mesh position={[0, 0.046, -0.32]}>
        <boxGeometry args={[0.048, 0.056, 0.2]} />
        <meshStandardMaterial color={WOOD} roughness={0.75} />
      </mesh>
      {/* Barrel band: steel ring capping the front of the wood. */}
      <mesh position={[0, 0.046, -0.408]}>
        <boxGeometry args={[0.052, 0.06, 0.018]} />
        <meshStandardMaterial color={STEEL_LIGHT} metalness={0.45} roughness={0.4} />
      </mesh>
      {/* Barrel. */}
      <mesh position={[0, 0.055, -0.47]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.014, 0.014, 0.16, 10]} />
        <meshStandardMaterial color={STEEL_DARK} metalness={0.5} roughness={0.35} />
      </mesh>
      {/* Gas tube: thin rod riding above the barrel. */}
      <mesh position={[0, 0.078, -0.46]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.006, 0.006, 0.13, 8]} />
        <meshStandardMaterial color={STEEL} metalness={0.4} roughness={0.45} />
      </mesh>
      {/* Front sight: base block + post. */}
      <mesh position={[0, 0.078, -0.5]}>
        <boxGeometry args={[0.024, 0.022, 0.022]} />
        <meshStandardMaterial color={STEEL} metalness={0.35} roughness={0.45} />
      </mesh>
      <mesh position={[0, 0.098, -0.5]}>
        <boxGeometry args={[0.008, 0.024, 0.01]} />
        <meshStandardMaterial color={STEEL} roughness={0.5} />
      </mesh>
      {/* Muzzle brake: fat lighter cylinder + dark end ring. */}
      <mesh position={[0, 0.055, -0.575]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.019, 0.019, 0.05, 10]} />
        <meshStandardMaterial color={STEEL_LIGHT} metalness={0.5} roughness={0.35} />
      </mesh>
      <mesh position={[0, 0.055, -0.598]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.02, 0.02, 0.01, 10]} />
        <meshStandardMaterial color={STEEL_DARK} metalness={0.55} roughness={0.3} />
      </mesh>
      {/* Magazine: two angled segments imply the banana curve. */}
      <mesh position={[0, -0.022, -0.13]} rotation={[-0.18, 0, 0]}>
        <boxGeometry args={[0.038, 0.075, 0.052]} />
        <meshStandardMaterial color={STEEL_LIGHT} metalness={0.3} roughness={0.5} />
      </mesh>
      <mesh position={[0, -0.088, -0.156]} rotation={[-0.45, 0, 0]}>
        <boxGeometry args={[0.038, 0.08, 0.05]} />
        <meshStandardMaterial color={STEEL_LIGHT} metalness={0.3} roughness={0.5} />
      </mesh>
      {/* Mag baseplate: accent pop at the bottom of the curve. */}
      <mesh position={[0, -0.126, -0.184]} rotation={[-0.45, 0, 0]}>
        <boxGeometry args={[0.042, 0.016, 0.056]} />
        <meshStandardMaterial color={ACCENT} roughness={0.5} />
      </mesh>
      {/* Trigger guard + trigger. */}
      <mesh position={[0, -0.02, -0.055]}>
        <boxGeometry args={[0.014, 0.01, 0.075]} />
        <meshStandardMaterial color={POLYMER} roughness={0.7} />
      </mesh>
      <mesh position={[0, -0.005, -0.04]} rotation={[0.25, 0, 0]}>
        <boxGeometry args={[0.008, 0.028, 0.008]} />
        <meshStandardMaterial color={ACCENT_LIGHT} metalness={0.3} roughness={0.4} />
      </mesh>
      {/* Stock wedge: sloped wood filling grip-to-stock. */}
      <mesh position={[0, 0.004, 0.095]} rotation={[0.28, 0, 0]}>
        <boxGeometry args={[0.04, 0.05, 0.12]} />
        <meshStandardMaterial color={WOOD} roughness={0.75} />
      </mesh>
      {/* Stock: drops slightly and runs back over the shoulder. */}
      <mesh position={[0, 0.026, 0.17]} rotation={[-0.06, 0, 0]}>
        <boxGeometry args={[0.042, 0.06, 0.24]} />
        <meshStandardMaterial color={WOOD} roughness={0.75} />
      </mesh>
      {/* Butt pad: taller dark cap ends the silhouette cleanly. */}
      <mesh position={[0, 0.016, 0.295]}>
        <boxGeometry args={[0.048, 0.082, 0.026]} />
        <meshStandardMaterial color={WOOD_DARK} roughness={0.85} />
      </mesh>
    </group>
  )
}

export function KnifeModel() {
  return (
    <group>
      {/* Handle. */}
      <mesh position={[0, -0.012, 0.05]} rotation={[0.08, 0, 0]}>
        <boxGeometry args={[0.03, 0.038, 0.125]} />
        <meshStandardMaterial color="#2d2a26" roughness={0.8} />
      </mesh>
      {/* Wrap rings: three slightly-proud bands along the handle. */}
      <mesh position={[0, -0.01, 0.022]} rotation={[0.08, 0, 0]}>
        <boxGeometry args={[0.033, 0.041, 0.012]} />
        <meshStandardMaterial color="#3d3830" roughness={0.85} />
      </mesh>
      <mesh position={[0, -0.012, 0.052]} rotation={[0.08, 0, 0]}>
        <boxGeometry args={[0.033, 0.041, 0.012]} />
        <meshStandardMaterial color="#3d3830" roughness={0.85} />
      </mesh>
      <mesh position={[0, -0.014, 0.082]} rotation={[0.08, 0, 0]}>
        <boxGeometry args={[0.033, 0.041, 0.012]} />
        <meshStandardMaterial color="#3d3830" roughness={0.85} />
      </mesh>
      {/* Pommel. */}
      <mesh position={[0, -0.006, 0.12]}>
        <boxGeometry args={[0.034, 0.042, 0.018]} />
        <meshStandardMaterial color={STEEL_LIGHT} metalness={0.4} roughness={0.4} />
      </mesh>
      {/* Cross guard: wide flat bar. */}
      <mesh position={[0, -0.012, -0.022]}>
        <boxGeometry args={[0.022, 0.07, 0.014]} />
        <meshStandardMaterial color={STEEL_LIGHT} metalness={0.5} roughness={0.35} />
      </mesh>
      {/* Blade: thin, tall, slight upward sweep. */}
      <mesh position={[0, 0.004, -0.135]} rotation={[0.04, 0, 0]}>
        <boxGeometry args={[0.008, 0.05, 0.2]} />
        <meshStandardMaterial color={BLADE} metalness={0.7} roughness={0.25} />
      </mesh>
      {/* Fuller: dark groove line along the spine side. */}
      <mesh position={[0, 0.016, -0.125]} rotation={[0.04, 0, 0]}>
        <boxGeometry args={[0.0095, 0.012, 0.16]} />
        <meshStandardMaterial color={STEEL} metalness={0.5} roughness={0.4} />
      </mesh>
      {/* Cutting edge: bright strip along the underside. */}
      <mesh position={[0, -0.019, -0.13]} rotation={[0.04, 0, 0]}>
        <boxGeometry args={[0.006, 0.01, 0.19]} />
        <meshStandardMaterial color={BLADE_EDGE} metalness={0.75} roughness={0.2} />
      </mesh>
      {/* Tip: flattened cone taper. */}
      <mesh position={[0, 0.006, -0.25]} rotation={[-Math.PI / 2, 0, 0]} scale={[0.16, 1, 1]}>
        <coneGeometry args={[0.025, 0.055, 4]} />
        <meshStandardMaterial color={BLADE} metalness={0.7} roughness={0.25} />
      </mesh>
    </group>
  )
}

export function HammerModel() {
  return (
    <group>
      {/* Handle: tapered wood shaft. */}
      <mesh position={[0, 0.03, 0]}>
        <cylinderGeometry args={[0.015, 0.018, 0.28, 10]} />
        <meshStandardMaterial color="#7a5c3e" roughness={0.8} />
      </mesh>
      {/* Rubber grip sleeve at the bottom. */}
      <mesh position={[0, -0.068, 0]}>
        <cylinderGeometry args={[0.02, 0.022, 0.095, 10]} />
        <meshStandardMaterial color="#26282c" roughness={0.9} />
      </mesh>
      {/* Butt cap: accent ring. */}
      <mesh position={[0, -0.118, 0]}>
        <cylinderGeometry args={[0.022, 0.022, 0.012, 10]} />
        <meshStandardMaterial color={ACCENT} roughness={0.5} />
      </mesh>
      {/* Head: the blueprint-blue block. */}
      <mesh position={[0, 0.175, -0.015]}>
        <boxGeometry args={[0.06, 0.055, 0.13]} />
        <meshStandardMaterial color={ACCENT} metalness={0.3} roughness={0.4} />
      </mesh>
      {/* Top stripe: lighter blue highlight. */}
      <mesh position={[0, 0.204, -0.015]}>
        <boxGeometry args={[0.04, 0.008, 0.1]} />
        <meshStandardMaterial color={ACCENT_LIGHT} roughness={0.45} />
      </mesh>
      {/* Neck: steel collar where head meets handle. */}
      <mesh position={[0, 0.142, -0.01]}>
        <cylinderGeometry args={[0.021, 0.021, 0.02, 10]} />
        <meshStandardMaterial color={STEEL_LIGHT} metalness={0.4} roughness={0.4} />
      </mesh>
      {/* Striking face: steel cylinder + dark cap. */}
      <mesh position={[0, 0.175, -0.094]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.027, 0.027, 0.028, 10]} />
        <meshStandardMaterial color={STEEL_LIGHT} metalness={0.45} roughness={0.35} />
      </mesh>
      <mesh position={[0, 0.175, -0.11]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.024, 0.024, 0.008, 10]} />
        <meshStandardMaterial color={STEEL_DARK} metalness={0.5} roughness={0.3} />
      </mesh>
      {/* Claw: two prongs with a visible gap between them. */}
      <mesh position={[-0.013, 0.198, 0.075]} rotation={[-0.55, 0, 0]}>
        <boxGeometry args={[0.016, 0.014, 0.09]} />
        <meshStandardMaterial color={ACCENT} metalness={0.3} roughness={0.4} />
      </mesh>
      <mesh position={[0.013, 0.198, 0.075]} rotation={[-0.55, 0, 0]}>
        <boxGeometry args={[0.016, 0.014, 0.09]} />
        <meshStandardMaterial color={ACCENT} metalness={0.3} roughness={0.4} />
      </mesh>
      {/* Claw root: wedge joining the prongs to the head. */}
      <mesh position={[0, 0.188, 0.048]} rotation={[-0.3, 0, 0]}>
        <boxGeometry args={[0.05, 0.03, 0.05]} />
        <meshStandardMaterial color={ACCENT} metalness={0.3} roughness={0.4} />
      </mesh>
    </group>
  )
}
