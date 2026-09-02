'use client'

import { useMemo } from 'react'
import { BoxGeometry, MeshStandardMaterial } from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import type { ToolId } from './viewmodel'

/**
 * FIRST-PERSON HANDS — the arms holding the viewmodel weapon.
 *
 * The guns render grip-at-origin with the barrel down −Z (weapon-models.tsx),
 * and until now nothing held them: a rifle floated at the bottom of the screen
 * with no hands on it, which reads as broken ("the hands look weird around the
 * gun"). This mounts a right forearm+fist ON the grip and, for a two-handed
 * weapon, a left forearm+fist on the foregrip — jacket sleeve into a bare hand,
 * the same charcoal-and-skin stack as the Pascaline avatar so a player's own
 * hands match the body teammates see in the mirror.
 *
 * All model space, under the viewmodel's pose group: a forearm points from the
 * grip back toward the shoulder (down-right, off-screen), and the fist wraps
 * the grip. Per-weapon placement is a small table — a pistol is cupped in two
 * hands at the grip, a rifle's support hand rides the handguard, a tool is one
 * relaxed hand on the haft. Pure primitives, shared geometry and material, so a
 * whole session is a handful of draw calls and zero per-frame allocation.
 */

const SKIN = new MeshStandardMaterial({ color: '#e8b48f', roughness: 0.65 })
const SLEEVE = new MeshStandardMaterial({ color: '#22242a', roughness: 0.7 })

// Shared, disposed with the module (never per-instance).
const FIST_GEO = new RoundedBoxGeometry(0.085, 0.08, 0.1, 3, 0.024)
const THUMB_GEO = new RoundedBoxGeometry(0.03, 0.055, 0.045, 2, 0.014)
const FOREARM_GEO = new BoxGeometry(0.075, 0.075, 0.26)

/** A forearm + fist at the origin, sleeve running back toward the shoulder
 * (−Z here is "into the screen"; the arm comes from +Z/down/right). `mirror`
 * flips it for the left hand. */
function Hand({ mirror = false }: { mirror?: boolean }) {
  const s = mirror ? -1 : 1
  return (
    <group scale={[s, 1, 1]}>
      {/* the fist wrapping the grip */}
      <mesh geometry={FIST_GEO} material={SKIN} />
      {/* thumb over the top */}
      <mesh geometry={THUMB_GEO} material={SKIN} position={[0.045, 0.02, 0.01]} rotation={[0.3, 0, -0.4]} />
      {/* forearm in the jacket sleeve, angled back to the shoulder */}
      <group position={[0.04, -0.03, 0.06]} rotation={[0.55, -0.2, 0.15]}>
        <mesh geometry={FOREARM_GEO} material={SLEEVE} position={[0, 0, 0.14]} />
        {/* a sliver of wrist between fist and sleeve */}
        <mesh geometry={FIST_GEO} material={SKIN} position={[0, 0, 0.02]} scale={[0.7, 0.7, 0.5]} />
      </group>
    </group>
  )
}

/** Where each hand sits for a given weapon, in the weapon's model space
 * (grip at origin, barrel −Z). `left` is null for a one-handed hold. */
type HandPose = { position: [number, number, number]; rotation: [number, number, number] }
type Grip = { right: HandPose; left: HandPose | null }

const GRIPS: Record<ToolId, Grip> = {
  // Knife: one hand on the handle.
  knife: { right: { position: [0, -0.02, 0.03], rotation: [0.2, 0, 0] }, left: null },
  // Pistol: both hands cupped on the grip.
  pistol: {
    right: { position: [0, -0.03, 0.02], rotation: [0.15, 0, 0] },
    left: { position: [-0.05, -0.06, 0.03], rotation: [0.15, 0.3, 0.2] },
  },
  // Rifle: right on the grip, left forward on the handguard.
  rifle: {
    right: { position: [0, -0.03, 0.02], rotation: [0.1, 0, 0] },
    left: { position: [0, -0.02, -0.2], rotation: [0.1, 0, 0] },
  },
  // Minigun: right on the rear grip, left on the front housing.
  minigun: {
    right: { position: [0, -0.05, 0.05], rotation: [0.1, 0, 0] },
    left: { position: [0, -0.08, -0.28], rotation: [0.1, 0, 0] },
  },
  // Warhammer: two hands down the haft.
  hammer: {
    right: { position: [0, -0.02, 0.04], rotation: [0.2, 0, 0] },
    left: { position: [0, 0.14, 0.02], rotation: [0.2, 0, 0] },
  },
  // Builder claw hammer: one hand on the haft.
  builder: { right: { position: [0, -0.02, 0.03], rotation: [0.2, 0, 0] }, left: null },
  // Spray can: one hand around the can, finger on the nozzle.
  paint: { right: { position: [0, -0.05, 0.02], rotation: [0.25, 0, 0] }, left: null },
}

/**
 * The hands for the currently-shown viewmodel weapon. Mounted once per weapon
 * group in the viewmodel (its own `visible` gates it), so switching weapons
 * shows the matching hold with no per-frame cost.
 */
export function WeaponHands({ weapon }: { weapon: ToolId }) {
  const grip = useMemo(() => GRIPS[weapon] ?? GRIPS.rifle!, [weapon]) as { right: HandPose; left: HandPose | null }
  return (
    <>
      <group position={grip.right.position} rotation={grip.right.rotation}>
        <Hand />
      </group>
      {grip.left ? (
        <group position={grip.left.position} rotation={grip.left.rotation}>
          <Hand mirror />
        </group>
      ) : null}
    </>
  )
}
