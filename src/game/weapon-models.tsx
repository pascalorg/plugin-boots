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
 *
 * Prop models (same conventions — grip/rest point at the origin, -Z forward):
 * - WarhammerModel: massive two-handed hammer, haft rises +Y from the grip.
 * - GrenadeModel: canister grenade, body centered on the origin.
 * - BootsPairModel: pair of work boots, soles on y=0 (tabletop-ready).
 * - SirenBeaconModel: rotating beacon, base on y=0; the inner light bar
 *   lives in a child group tagged userData={{ role: 'beacon-light' }} —
 *   consumers find it by that tag and drive rotation.y for the sweep.
 */

export const MUZZLE_OFFSETS: Record<
  'pistol' | 'rifle' | 'minigun' | 'hammer',
  [number, number, number]
> = {
  pistol: [0, 0.05, -0.26],
  rifle: [0, 0.055, -0.61],
  minigun: [0, 0.07, -0.82],
  // Melee: never shows a muzzle flash, but the weapon-id index in the
  // viewmodel is typed over all gun-shaped ids — this is the strike face.
  hammer: [0, 0.175, -0.11],
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
      {/* Magazine baseplate: accent cap tucked flush on the grip's raked axis. */}
      <mesh position={[0, -0.116, 0.008]} rotation={[0.32, 0, 0]}>
        <boxGeometry args={[0.042, 0.014, 0.057]} />
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

/** Six barrel sockets around the rotary axis (x, y offsets in barrel-group space). */
const MINIGUN_RING = 0.048
const MINIGUN_BARRELS: ReadonlyArray<readonly [number, number]> = [0, 1, 2, 3, 4, 5].map((i) => {
  const a = (i / 6) * Math.PI * 2
  return [Math.cos(a) * MINIGUN_RING, Math.sin(a) * MINIGUN_RING] as const
})

/**
 * The big one: six-barrel rotary gun. The barrel cluster lives in a child
 * group tagged userData={{ role: 'barrels' }} whose origin IS the spin axis
 * (bore center) — the viewmodel finds it by that tag and drives rotation.z
 * (idle 0 → ~28 rad/s at full spin). Reads heavy at viewmodel range: fat
 * rear drum, top carry handle, hanging ammo box with a feed chute.
 */
export function MinigunModel() {
  return (
    <group>
      {/* Rear grip at the origin, raked like the rifle's. */}
      <mesh position={[0, -0.05, 0.02]} rotation={[0.34, 0, 0]}>
        <boxGeometry args={[0.044, 0.12, 0.055]} />
        <meshStandardMaterial color={POLYMER} roughness={0.7} />
      </mesh>
      <mesh position={[0, -0.104, 0.04]} rotation={[0.34, 0, 0]}>
        <boxGeometry args={[0.047, 0.016, 0.059]} />
        <meshStandardMaterial color={POLYMER_DARK} roughness={0.8} />
      </mesh>
      {/* Trigger: accent pop under the receiver. */}
      <mesh position={[0, -0.012, -0.045]} rotation={[0.25, 0, 0]}>
        <boxGeometry args={[0.01, 0.034, 0.01]} />
        <meshStandardMaterial color={ACCENT_LIGHT} metalness={0.3} roughness={0.4} />
      </mesh>
      {/* Rear housing: boxy block the grip hangs off. */}
      <mesh position={[0, 0.05, 0.03]}>
        <boxGeometry args={[0.11, 0.13, 0.16]} />
        <meshStandardMaterial color={POLYMER_DARK} roughness={0.7} />
      </mesh>
      {/* Main drum: the fat rotor housing — the silhouette's mass. */}
      <mesh position={[0, 0.07, -0.1]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.095, 0.095, 0.28, 14]} />
        <meshStandardMaterial color={STEEL} metalness={0.4} roughness={0.45} />
      </mesh>
      {/* Drum front plate: lighter ring the barrels emerge from. */}
      <mesh position={[0, 0.07, -0.245]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.088, 0.088, 0.025, 14]} />
        <meshStandardMaterial color={STEEL_LIGHT} metalness={0.45} roughness={0.4} />
      </mesh>
      {/* Accent band around the drum: the one blue pop. */}
      <mesh position={[0, 0.07, -0.02]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.098, 0.098, 0.03, 14]} />
        <meshStandardMaterial color={ACCENT} metalness={0.3} roughness={0.5} />
      </mesh>
      {/* Barrel cluster: spins around this group's z axis (the bore line). */}
      <group position={[0, 0.07, -0.26]} userData={{ role: 'barrels' }}>
        {MINIGUN_BARRELS.map(([x, y], i) => (
          <mesh key={i} position={[x, y, -0.26]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.016, 0.016, 0.52, 8]} />
            <meshStandardMaterial
              color={i % 2 ? STEEL_DARK : STEEL}
              metalness={0.5}
              roughness={0.35}
            />
          </mesh>
        ))}
        {/* Central shaft the barrels ride on. */}
        <mesh position={[0, 0, -0.24]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.02, 0.02, 0.46, 8]} />
          <meshStandardMaterial color={STEEL_DARK} metalness={0.5} roughness={0.4} />
        </mesh>
        {/* Mid clamp + muzzle retaining plate — spin with the cluster so the
            rotation reads even when the thin barrels blur together. */}
        <mesh position={[0, 0, -0.3]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.072, 0.072, 0.024, 12]} />
          <meshStandardMaterial color={STEEL_LIGHT} metalness={0.45} roughness={0.4} />
        </mesh>
        <mesh position={[0, 0, -0.5]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.068, 0.068, 0.03, 12]} />
          <meshStandardMaterial color={STEEL_LIGHT} metalness={0.45} roughness={0.4} />
        </mesh>
      </group>
      {/* Carry handle: arch over the drum. */}
      <mesh position={[0, 0.2, -0.1]}>
        <boxGeometry args={[0.034, 0.022, 0.2]} />
        <meshStandardMaterial color={POLYMER} roughness={0.7} />
      </mesh>
      <mesh position={[0, 0.175, -0.015]}>
        <boxGeometry args={[0.026, 0.04, 0.024]} />
        <meshStandardMaterial color={POLYMER} roughness={0.7} />
      </mesh>
      <mesh position={[0, 0.175, -0.185]}>
        <boxGeometry args={[0.026, 0.04, 0.024]} />
        <meshStandardMaterial color={POLYMER} roughness={0.7} />
      </mesh>
      {/* Front support grip under the drum. */}
      <mesh position={[0, -0.04, -0.2]} rotation={[-0.12, 0, 0]}>
        <boxGeometry args={[0.038, 0.11, 0.045]} />
        <meshStandardMaterial color={WOOD_DARK} roughness={0.8} />
      </mesh>
      {/* Ammo box hint: hangs off the left flank, accent lid + feed chute. */}
      <mesh position={[-0.115, -0.01, 0.0]}>
        <boxGeometry args={[0.1, 0.13, 0.17]} />
        <meshStandardMaterial color={POLYMER_DARK} roughness={0.75} />
      </mesh>
      <mesh position={[-0.115, 0.058, 0.0]}>
        <boxGeometry args={[0.102, 0.012, 0.172]} />
        <meshStandardMaterial color={ACCENT} roughness={0.5} />
      </mesh>
      {/* Feed chute: angled link from box lid into the receiver flank. */}
      <mesh position={[-0.082, 0.075, 0.0]} rotation={[0, 0, 0.6]}>
        <boxGeometry args={[0.075, 0.03, 0.07]} />
        <meshStandardMaterial color={STEEL_LIGHT} metalness={0.35} roughness={0.5} />
      </mesh>
    </group>
  )
}

export function KnifeModel() {
  return (
    <group>
      {/* Grip: short contoured wood handle, raked slightly downward. */}
      <mesh position={[0, -0.014, 0.052]} rotation={[0.12, 0, 0]}>
        <boxGeometry args={[0.028, 0.04, 0.075]} />
        <meshStandardMaterial color={WOOD} roughness={0.8} />
      </mesh>
      {/* Palm swell: proud dark band at the middle of the grip. */}
      <mesh position={[0, -0.017, 0.055]} rotation={[0.12, 0, 0]}>
        <boxGeometry args={[0.032, 0.046, 0.034]} />
        <meshStandardMaterial color={WOOD_DARK} roughness={0.85} />
      </mesh>
      {/* Bolster: steel collar where the grip meets the guard. */}
      <mesh position={[0, -0.008, 0.01]} rotation={[0.12, 0, 0]}>
        <boxGeometry args={[0.03, 0.044, 0.02]} />
        <meshStandardMaterial color={STEEL_LIGHT} metalness={0.45} roughness={0.4} />
      </mesh>
      {/* Pommel: steel cap ends the grip. */}
      <mesh position={[0, -0.025, 0.094]} rotation={[0.12, 0, 0]}>
        <boxGeometry args={[0.032, 0.046, 0.016]} />
        <meshStandardMaterial color={STEEL_LIGHT} metalness={0.4} roughness={0.4} />
      </mesh>
      {/* Cross guard: wide flat steel bar. */}
      <mesh position={[0, -0.004, -0.004]}>
        <boxGeometry args={[0.02, 0.078, 0.013]} />
        <meshStandardMaterial color={STEEL_LIGHT} metalness={0.5} roughness={0.35} />
      </mesh>
      {/* Blade belly: wide at the ricasso, dominates the silhouette. */}
      <mesh position={[0, 0.002, -0.068]}>
        <boxGeometry args={[0.009, 0.062, 0.115]} />
        <meshStandardMaterial color={BLADE} metalness={0.7} roughness={0.25} />
      </mesh>
      {/* Taper: flattened cone runs the blade out to the tip. */}
      <mesh position={[0, 0.002, -0.168]} rotation={[-Math.PI / 2, 0, 0]} scale={[0.15, 1, 1]}>
        <coneGeometry args={[0.031, 0.086, 4]} />
        <meshStandardMaterial color={BLADE} metalness={0.7} roughness={0.25} />
      </mesh>
      {/* Spine: darker flat strip along the top of the belly. */}
      <mesh position={[0, 0.029, -0.062]}>
        <boxGeometry args={[0.011, 0.009, 0.1]} />
        <meshStandardMaterial color={STEEL} metalness={0.5} roughness={0.4} />
      </mesh>
      {/* Cutting edge: bright strip along the underside. */}
      <mesh position={[0, -0.027, -0.066]}>
        <boxGeometry args={[0.006, 0.009, 0.108]} />
        <meshStandardMaterial color={BLADE_EDGE} metalness={0.75} roughness={0.2} />
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

/* ---------------------------------------------------------------------------
 * Prop / heavy-weapon models (phase 4).
 * ------------------------------------------------------------------------- */

const GRIP_WRAP = '#54381f'
const GRIP_WRAP_DARK = '#3f2a17'
const LEATHER = '#a97b4f'
const LEATHER_DARK = '#7d5732'
const LACE = '#d9c8a0'
const SOLE_RUBBER = '#332a22'
const OLIVE = '#4b5240'
const OLIVE_DARK = '#383e30'
const BEACON_RED = '#d8362a'
const BEACON_GLOW = '#ff4b3a'

/** Leather wrap band heights around the warhammer grip (alternating shades). */
const WARHAMMER_WRAPS: readonly number[] = [-0.17, -0.125, -0.08, -0.035, 0.01, 0.055]

/**
 * Massive two-handed war hammer. Grip at the origin (both hands stack just
 * above/below it), long dark-wood haft rising +Y, huge worn-steel head up
 * top: flat strike face toward -Z, tapered back spike toward +Z.
 */
export function WarhammerModel() {
  return (
    <group>
      {/* Haft: long tapered dark-wood shaft, grip-heavy at the bottom. */}
      <mesh position={[0, 0.3, 0]}>
        <cylinderGeometry args={[0.019, 0.024, 1.05, 10]} />
        <meshStandardMaterial color={WOOD_DARK} roughness={0.8} />
      </mesh>
      {/* Wrapped grip: stacked leather bands, alternating worn shades. */}
      {WARHAMMER_WRAPS.map((y, i) => (
        <mesh key={i} position={[0, y, 0]}>
          <cylinderGeometry args={[0.029, 0.029, 0.04, 10]} />
          <meshStandardMaterial color={i % 2 ? GRIP_WRAP_DARK : GRIP_WRAP} roughness={0.9} />
        </mesh>
      ))}
      {/* Butt cap: steel pommel ring closing the haft. */}
      <mesh position={[0, -0.215, 0]}>
        <cylinderGeometry args={[0.03, 0.026, 0.035, 10]} />
        <meshStandardMaterial color={STEEL} metalness={0.4} roughness={0.5} />
      </mesh>
      {/* Langets: worn steel straps running down the haft from the head. */}
      <mesh position={[0, 0.64, 0.028]}>
        <boxGeometry args={[0.018, 0.22, 0.012]} />
        <meshStandardMaterial color={STEEL_DARK} metalness={0.35} roughness={0.6} />
      </mesh>
      <mesh position={[0, 0.64, -0.028]}>
        <boxGeometry args={[0.018, 0.22, 0.012]} />
        <meshStandardMaterial color={STEEL_DARK} metalness={0.35} roughness={0.6} />
      </mesh>
      {/* Collar: steel socket where the haft enters the head. */}
      <mesh position={[0, 0.755, 0]}>
        <cylinderGeometry args={[0.034, 0.03, 0.055, 10]} />
        <meshStandardMaterial color={STEEL_LIGHT} metalness={0.45} roughness={0.45} />
      </mesh>
      {/* Head: the huge rectangular mass, worn steel. */}
      <mesh position={[0, 0.84, -0.02]}>
        <boxGeometry args={[0.13, 0.13, 0.2]} />
        <meshStandardMaterial color={STEEL} metalness={0.5} roughness={0.55} />
      </mesh>
      {/* Strike face: proud lighter block at the -Z end… */}
      <mesh position={[0, 0.84, -0.135]}>
        <boxGeometry args={[0.145, 0.145, 0.035]} />
        <meshStandardMaterial color={STEEL_LIGHT} metalness={0.5} roughness={0.4} />
      </mesh>
      {/* …with a dark hammered face plate. */}
      <mesh position={[0, 0.84, -0.155]}>
        <boxGeometry args={[0.12, 0.12, 0.008]} />
        <meshStandardMaterial color={STEEL_DARK} metalness={0.55} roughness={0.35} />
      </mesh>
      {/* Back spike: tapered spike off the +Z end of the head. */}
      <mesh position={[0, 0.84, 0.16]} rotation={[Math.PI / 2, 0, 0]}>
        <coneGeometry args={[0.045, 0.17, 6]} />
        <meshStandardMaterial color={STEEL_DARK} metalness={0.5} roughness={0.45} />
      </mesh>
      {/* Top cap: worn strap over the head's crown. */}
      <mesh position={[0, 0.912, -0.02]}>
        <boxGeometry args={[0.06, 0.018, 0.15]} />
        <meshStandardMaterial color={STEEL_DARK} metalness={0.4} roughness={0.55} />
      </mesh>
    </group>
  )
}

/**
 * Chunky canister grenade, body centered on the origin (that's the palm),
 * fuze head up top with the safety lever strapped down the +Z flank and the
 * pull-pin ring poking out toward -Z.
 */
export function GrenadeModel() {
  return (
    <group>
      {/* Canister body. */}
      <mesh position={[0, 0, 0]}>
        <cylinderGeometry args={[0.034, 0.034, 0.095, 12]} />
        <meshStandardMaterial color={OLIVE} roughness={0.6} />
      </mesh>
      {/* Rolled ribs: darker rings around the can. */}
      <mesh position={[0, 0.022, 0]}>
        <cylinderGeometry args={[0.0355, 0.0355, 0.011, 12]} />
        <meshStandardMaterial color={OLIVE_DARK} roughness={0.7} />
      </mesh>
      <mesh position={[0, -0.022, 0]}>
        <cylinderGeometry args={[0.0355, 0.0355, 0.011, 12]} />
        <meshStandardMaterial color={OLIVE_DARK} roughness={0.7} />
      </mesh>
      {/* Bottom crimp cap. */}
      <mesh position={[0, -0.053, 0]}>
        <cylinderGeometry args={[0.028, 0.026, 0.014, 12]} />
        <meshStandardMaterial color={OLIVE_DARK} roughness={0.7} />
      </mesh>
      {/* Fuze housing + cap. */}
      <mesh position={[0, 0.062, 0]}>
        <cylinderGeometry args={[0.017, 0.019, 0.03, 10]} />
        <meshStandardMaterial color={STEEL} metalness={0.4} roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.081, 0]}>
        <cylinderGeometry args={[0.02, 0.02, 0.01, 10]} />
        <meshStandardMaterial color={STEEL_LIGHT} metalness={0.45} roughness={0.4} />
      </mesh>
      {/* Safety lever: shoulder plate off the fuze, strap down the flank. */}
      <mesh position={[0, 0.074, 0.024]} rotation={[-0.4, 0, 0]}>
        <boxGeometry args={[0.017, 0.01, 0.045]} />
        <meshStandardMaterial color={STEEL_LIGHT} metalness={0.45} roughness={0.4} />
      </mesh>
      <mesh position={[0, 0.012, 0.041]} rotation={[0.06, 0, 0]}>
        <boxGeometry args={[0.017, 0.095, 0.007]} />
        <meshStandardMaterial color={STEEL_LIGHT} metalness={0.45} roughness={0.4} />
      </mesh>
      {/* Pull pin: stub through the fuze… */}
      <mesh position={[0, 0.062, -0.02]}>
        <boxGeometry args={[0.008, 0.008, 0.02]} />
        <meshStandardMaterial color={STEEL_DARK} metalness={0.5} roughness={0.4} />
      </mesh>
      {/* …and the ring hanging off it. */}
      <mesh position={[0, 0.062, -0.044]}>
        <torusGeometry args={[0.016, 0.0035, 6, 14]} />
        <meshStandardMaterial color={STEEL_DARK} metalness={0.55} roughness={0.35} />
      </mesh>
    </group>
  )
}

/** One work boot, toe toward -Z; `side` mirrors it left/right of the pair. */
function boot(side: -1 | 1) {
  return (
    <group position={[side * 0.078, 0, 0]} rotation={[0, side * -0.07, 0]}>
      {/* Sole: dark rubber slab flat on y=0. */}
      <mesh position={[0, 0.014, -0.02]}>
        <boxGeometry args={[0.105, 0.028, 0.3]} />
        <meshStandardMaterial color={SOLE_RUBBER} roughness={0.9} />
      </mesh>
      {/* Heel block: proud step under the shaft. */}
      <mesh position={[0, 0.038, 0.085]}>
        <boxGeometry args={[0.108, 0.02, 0.1]} />
        <meshStandardMaterial color={SOLE_RUBBER} roughness={0.9} />
      </mesh>
      {/* Vamp: tan leather over the foot. */}
      <mesh position={[0, 0.063, -0.045]}>
        <boxGeometry args={[0.095, 0.07, 0.21]} />
        <meshStandardMaterial color={LEATHER} roughness={0.75} />
      </mesh>
      {/* Toe cap: darker scuffed leather nose. */}
      <mesh position={[0, 0.054, -0.135]}>
        <boxGeometry args={[0.088, 0.052, 0.07]} />
        <meshStandardMaterial color={LEATHER_DARK} roughness={0.8} />
      </mesh>
      {/* Shaft: ankle-high upper at the rear. */}
      <mesh position={[0, 0.148, 0.055]}>
        <boxGeometry args={[0.095, 0.13, 0.12]} />
        <meshStandardMaterial color={LEATHER} roughness={0.75} />
      </mesh>
      {/* Padded collar rim. */}
      <mesh position={[0, 0.218, 0.055]}>
        <boxGeometry args={[0.1, 0.024, 0.126]} />
        <meshStandardMaterial color={LEATHER_DARK} roughness={0.85} />
      </mesh>
      {/* Tongue: leans forward off the shaft, under the laces. */}
      <mesh position={[0, 0.14, -0.012]} rotation={[0.35, 0, 0]}>
        <boxGeometry args={[0.052, 0.11, 0.014]} />
        <meshStandardMaterial color={LEATHER_DARK} roughness={0.8} />
      </mesh>
      {/* Laces: thin cross bars climbing the tongue line. */}
      <mesh position={[0, 0.092, -0.038]} rotation={[0.35, 0, 0]}>
        <boxGeometry args={[0.062, 0.007, 0.011]} />
        <meshStandardMaterial color={LACE} roughness={0.85} />
      </mesh>
      <mesh position={[0, 0.122, -0.027]} rotation={[0.35, 0, 0]}>
        <boxGeometry args={[0.062, 0.007, 0.011]} />
        <meshStandardMaterial color={LACE} roughness={0.85} />
      </mesh>
      <mesh position={[0, 0.152, -0.016]} rotation={[0.35, 0, 0]}>
        <boxGeometry args={[0.062, 0.007, 0.011]} />
        <meshStandardMaterial color={LACE} roughness={0.85} />
      </mesh>
      <mesh position={[0, 0.182, -0.005]} rotation={[0.35, 0, 0]}>
        <boxGeometry args={[0.062, 0.007, 0.011]} />
        <meshStandardMaterial color={LACE} roughness={0.85} />
      </mesh>
      {/* Pull tab off the back of the collar. */}
      <mesh position={[0, 0.222, 0.122]} rotation={[0.2, 0, 0]}>
        <boxGeometry args={[0.024, 0.035, 0.008]} />
        <meshStandardMaterial color={LEATHER_DARK} roughness={0.85} />
      </mesh>
    </group>
  )
}

/**
 * A pair of tan leather work boots, toes toward -Z, soles flat on y=0 —
 * sized (~0.3m long, ~0.23m tall) to sit on a tabletop as a display prop.
 */
export function BootsPairModel() {
  return (
    <group>
      {boot(-1)}
      {boot(1)}
    </group>
  )
}

/**
 * Small police-style rotating beacon, base flat on y=0. The dome is
 * translucent red; the inner light bar lives in a child group tagged
 * userData={{ role: 'beacon-light' }} whose origin is the spin axis —
 * consumers find it by that tag and drive rotation.y.
 */
export function SirenBeaconModel() {
  return (
    <group>
      {/* Base: dark squat cylinder with a steel trim ring. */}
      <mesh position={[0, 0.02, 0]}>
        <cylinderGeometry args={[0.075, 0.082, 0.04, 14]} />
        <meshStandardMaterial color={POLYMER_DARK} roughness={0.7} />
      </mesh>
      <mesh position={[0, 0.044, 0]}>
        <cylinderGeometry args={[0.06, 0.062, 0.012, 14]} />
        <meshStandardMaterial color={STEEL} metalness={0.4} roughness={0.5} />
      </mesh>
      {/* Inner light bar: rotates about this group's y axis. */}
      <group position={[0, 0.095, 0]} userData={{ role: 'beacon-light' }}>
        {/* Hub the bar rides on. */}
        <mesh position={[0, 0, 0]}>
          <cylinderGeometry args={[0.012, 0.012, 0.055, 8]} />
          <meshStandardMaterial color={STEEL_DARK} metalness={0.45} roughness={0.4} />
        </mesh>
        {/* The bar itself: hot red, glows through the dome. */}
        <mesh position={[0, 0, 0]}>
          <boxGeometry args={[0.078, 0.032, 0.02]} />
          <meshStandardMaterial
            color={BEACON_GLOW}
            emissive={BEACON_GLOW}
            emissiveIntensity={1.4}
            roughness={0.4}
          />
        </mesh>
        {/* Lamp faces at both ends: brightest spots of the sweep. */}
        <mesh position={[0.042, 0, 0]}>
          <boxGeometry args={[0.008, 0.028, 0.026]} />
          <meshStandardMaterial
            color="#ffd9d4"
            emissive="#ffb3aa"
            emissiveIntensity={1.8}
            roughness={0.3}
          />
        </mesh>
        <mesh position={[-0.042, 0, 0]}>
          <boxGeometry args={[0.008, 0.028, 0.026]} />
          <meshStandardMaterial
            color="#ffd9d4"
            emissive="#ffb3aa"
            emissiveIntensity={1.8}
            roughness={0.3}
          />
        </mesh>
      </group>
      {/* Dome: translucent red shell over the light bar. */}
      <mesh position={[0, 0.093, 0]}>
        <cylinderGeometry args={[0.055, 0.058, 0.086, 14]} />
        <meshStandardMaterial
          color={BEACON_RED}
          transparent
          opacity={0.45}
          metalness={0.1}
          roughness={0.25}
        />
      </mesh>
      <mesh position={[0, 0.136, 0]}>
        <sphereGeometry args={[0.055, 14, 10]} />
        <meshStandardMaterial
          color={BEACON_RED}
          transparent
          opacity={0.45}
          metalness={0.1}
          roughness={0.25}
        />
      </mesh>
    </group>
  )
}
